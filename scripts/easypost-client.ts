/**
 * EasyPost Shipping API Client
 *
 * Creates UPS shipping labels via EasyPost API with two-stage confirmation workflow.
 * Integrates with Shopify for automatic address lookup.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import EasyPost from "@easypost/api";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// State file for pending shipments (two-stage workflow)
const STATE_PATH = "/tmp/easypost-pending-shipments.json";

// Shopify CLI path
const SHOPIFY_CLI =
  "/Users/USER/.claude/plugins/local-marketplace/shopify-order-manager/scripts/dist/cli.js";

// Interfaces
interface EasyPostConfig {
  easypost: {
    apiKey: string;
    upsAccountId?: string;
  };
}

interface Address {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

interface Parcel {
  length?: number; // cm
  width?: number; // cm
  height?: number; // cm
  weight: number; // kg
}

interface Rate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days?: number;
  delivery_date?: string;
}

interface PendingShipment {
  id: string;
  createdAt: string;
  orderId?: string;
  toAddress: Address;
  fromAddress: Address;
  parcel: Parcel;
  rates: Rate[];
  status: "pending" | "purchased" | "voided";
  trackingCode?: string;
  labelUrl?: string;
}

interface ShipmentState {
  shipments: Record<string, PendingShipment>;
  lastUpdated: string;
}

interface CreateShipmentOptions {
  orderId?: string;
  toAddress?: Address;
  parcel: Parcel;
  carrier?: string;
}

interface PurchasedLabel {
  trackingCode: string;
  labelUrl: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
}

// Initialize cache
const cache = new PluginCache({
  namespace: "easypost-shipping-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class EasyPostShippingClient {
  private client: InstanceType<typeof EasyPost>;
  private config: EasyPostConfig;
  private cacheDisabled: boolean = false;

  constructor() {
    const configPath = join(__dirname, "..", "config.json");

    if (!existsSync(configPath)) {
      throw new Error(
        `Config file not found at ${configPath}. Ensure credentials are loaded.`
      );
    }

    const configFile: EasyPostConfig = JSON.parse(
      readFileSync(configPath, "utf-8")
    );

    if (!configFile.easypost?.apiKey) {
      throw new Error("Missing required config: easypost.apiKey");
    }

    this.config = configFile;
    this.client = new EasyPost(this.config.easypost.apiKey);
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /** Disables caching for all subsequent requests. */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /** Re-enables caching after it was disabled. */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /** Returns cache statistics including hit/miss counts. */
  getCacheStats() {
    return cache.getStats();
  }

  /** Clears all cached data. @returns Number of cache entries cleared */
  clearCache(): number {
    return cache.clear();
  }

  // ============================================
  // STATE MANAGEMENT (Internal)
  // ============================================

  /** Load pending shipments state from file. */
  private loadState(): ShipmentState {
    if (!existsSync(STATE_PATH)) {
      return { shipments: {}, lastUpdated: new Date().toISOString() };
    }

    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    } catch {
      return { shipments: {}, lastUpdated: new Date().toISOString() };
    }
  }

  /** Save pending shipments state to file. */
  private saveState(state: ShipmentState): void {
    state.lastUpdated = new Date().toISOString();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  }

  /** Get YOUR_CITY warehouse address. */
  private getFromAddress(): Address {
    return {
      company: "YOUR_COMPANY",
      street1: "YOUR_WAREHOUSE_ADDRESS_LINE_1",
      street2: "YOUR_WAREHOUSE_ADDRESS_LINE_2",
      city: "YOUR_CITY",
      state: "",
      zip: "YOUR_POSTCODE",
      country: "GB",
      phone: "YOUR_PHONE_NUMBER",
      email: "YOUR_LOGISTICS_EMAIL",
    };
  }

  // ============================================
  // UNIT CONVERSIONS
  // ============================================

  /** Convert kilograms to ounces (EasyPost format). */
  private kgToOunces(kg: number): number {
    return kg * 35.274;
  }

  /** Convert centimeters to inches (EasyPost format). */
  private cmToInches(cm: number): number {
    return cm * 0.3937;
  }

  // ============================================
  // SHOPIFY INTEGRATION
  // ============================================

  /**
   * Fetches shipping address from a Shopify order.
   *
   * @param orderId - Shopify order ID or order number
   * @returns Parsed address from order
   * @throws {Error} If order not found or has no shipping address
   */
  async fetchShopifyOrderAddress(orderId: string): Promise<Address> {
    if (!existsSync(SHOPIFY_CLI)) {
      throw new Error(`Shopify CLI not found at ${SHOPIFY_CLI}`);
    }

    try {
      // Use execFileSync with arguments array to prevent shell injection
      const result = execFileSync("node", [SHOPIFY_CLI, "get-order", "--id", orderId], {
        encoding: "utf-8",
        timeout: 30000,
      });

      const order = JSON.parse(result);

      if (!order.shippingAddress) {
        throw new Error(`Order ${orderId} has no shipping address`);
      }

      const addr = order.shippingAddress;

      return {
        name: [addr.firstName, addr.lastName].filter(Boolean).join(" ") || addr.name,
        company: addr.company || undefined,
        street1: addr.address1,
        street2: addr.address2 || undefined,
        city: addr.city,
        state: addr.provinceCode || addr.province || "",
        zip: addr.zip,
        country: addr.countryCodeV2 || addr.countryCode || "GB",
        phone: addr.phone || undefined,
      };
    } catch (error: any) {
      if (error.message?.includes("not found")) {
        throw new Error(`Shopify order not found: ${orderId}`);
      }
      throw new Error(
        `Failed to fetch Shopify order: ${error.message || error}`
      );
    }
  }

  // ============================================
  // SHIPMENT OPERATIONS
  // ============================================

  /**
   * Stage 1: Creates shipment and retrieves rates.
   *
   * This is the first step in the two-stage workflow. Creates a pending
   * shipment and returns available rates. No charges until buyLabel() is called.
   *
   * @param options - Shipment options
   * @param options.orderId - Shopify order ID (auto-fetches address)
   * @param options.toAddress - Manual destination address (if no orderId)
   * @param options.parcel - Parcel dimensions and weight
   * @param options.carrier - Optional carrier filter (e.g., "UPS")
   * @returns Pending shipment with available rates
   *
   * @throws {Error} If no rates available or invalid address
   */
  async createShipment(options: CreateShipmentOptions): Promise<PendingShipment> {
    let toAddress: Address;

    // Get destination address
    if (options.orderId) {
      toAddress = await this.fetchShopifyOrderAddress(options.orderId);
    } else if (options.toAddress) {
      toAddress = options.toAddress;
    } else {
      throw new Error("Either orderId or toAddress must be provided");
    }

    const fromAddress = this.getFromAddress();

    // Build EasyPost shipment request
    const shipmentParams: any = {
      to_address: {
        name: toAddress.name,
        company: toAddress.company,
        street1: toAddress.street1,
        street2: toAddress.street2,
        city: toAddress.city,
        state: toAddress.state,
        zip: toAddress.zip,
        country: toAddress.country,
        phone: toAddress.phone,
        email: toAddress.email,
      },
      from_address: {
        name: "YOUR_COMPANY Logistics",
        company: fromAddress.company,
        street1: fromAddress.street1,
        street2: fromAddress.street2,
        city: fromAddress.city,
        state: fromAddress.state,
        zip: fromAddress.zip,
        country: fromAddress.country,
        phone: fromAddress.phone,
        email: fromAddress.email,
      },
      parcel: {
        weight: this.kgToOunces(options.parcel.weight),
        ...(options.parcel.length && {
          length: this.cmToInches(options.parcel.length),
        }),
        ...(options.parcel.width && {
          width: this.cmToInches(options.parcel.width),
        }),
        ...(options.parcel.height && {
          height: this.cmToInches(options.parcel.height),
        }),
      },
    };

    // Filter to specific carrier account if configured
    if (this.config.easypost.upsAccountId) {
      shipmentParams.carrier_accounts = [this.config.easypost.upsAccountId];
    }

    // Create shipment via EasyPost API
    const shipment = await this.client.Shipment.create(shipmentParams);

    // Extract rates
    const rates: Rate[] = (shipment.rates || [])
      .filter((r: any) => !options.carrier || r.carrier?.toLowerCase() === options.carrier.toLowerCase())
      .map((r: any) => ({
        id: r.id,
        carrier: r.carrier,
        service: r.service,
        rate: r.rate,
        currency: r.currency,
        delivery_days: r.delivery_days,
        delivery_date: r.delivery_date,
      }))
      .sort((a: Rate, b: Rate) => parseFloat(a.rate) - parseFloat(b.rate));

    if (rates.length === 0) {
      throw new Error(
        "No shipping rates available for this shipment. Check addresses and carrier configuration."
      );
    }

    // Store pending shipment
    const pendingShipment: PendingShipment = {
      id: shipment.id,
      createdAt: new Date().toISOString(),
      orderId: options.orderId,
      toAddress,
      fromAddress,
      parcel: options.parcel,
      rates,
      status: "pending",
    };

    const state = this.loadState();
    state.shipments[shipment.id] = pendingShipment;
    this.saveState(state);

    return pendingShipment;
  }

  /**
   * Stage 2: Purchases label for a pending shipment.
   *
   * This is the second step - actually purchases the selected rate.
   * Charges apply after this call succeeds.
   *
   * @param shipmentId - EasyPost shipment ID from createShipment()
   * @param rateId - Rate ID to purchase (from available rates)
   * @returns Purchased label with tracking code and label URL
   *
   * @throws {Error} If shipment not found, already purchased, or invalid rate
   */
  async buyLabel(shipmentId: string, rateId: string): Promise<PurchasedLabel> {
    const state = this.loadState();
    const pendingShipment = state.shipments[shipmentId];

    if (!pendingShipment) {
      throw new Error(`Shipment ${shipmentId} not found in pending shipments`);
    }

    if (pendingShipment.status === "purchased") {
      throw new Error(
        `Shipment ${shipmentId} already purchased. Tracking: ${pendingShipment.trackingCode}`
      );
    }

    // Verify rate exists
    const rate = pendingShipment.rates.find((r) => r.id === rateId);
    if (!rate) {
      throw new Error(
        `Rate ${rateId} not found for shipment ${shipmentId}. Available rates: ${pendingShipment.rates.map((r) => r.id).join(", ")}`
      );
    }

    // Purchase the label via EasyPost
    const purchasedShipment = await this.client.Shipment.buy(shipmentId, rateId);

    const label: PurchasedLabel = {
      trackingCode: purchasedShipment.tracking_code,
      labelUrl: purchasedShipment.postage_label?.label_url,
      carrier: rate.carrier,
      service: rate.service,
      rate: rate.rate,
      currency: rate.currency,
    };

    // Update state
    pendingShipment.status = "purchased";
    pendingShipment.trackingCode = label.trackingCode;
    pendingShipment.labelUrl = label.labelUrl;
    this.saveState(state);

    return label;
  }

  /**
   * Cancels an unpurchased pending shipment.
   *
   * @param shipmentId - Shipment ID to cancel
   * @returns Success status and message
   */
  cancelShipment(shipmentId: string): { success: boolean; message: string } {
    const state = this.loadState();
    const shipment = state.shipments[shipmentId];

    if (!shipment) {
      return { success: false, message: `Shipment ${shipmentId} not found` };
    }

    if (shipment.status === "purchased") {
      return {
        success: false,
        message: `Cannot cancel purchased shipment. Use void-label to request refund.`,
      };
    }

    delete state.shipments[shipmentId];
    this.saveState(state);

    return { success: true, message: "Shipment cancelled. No charges incurred." };
  }

  /**
   * Gets shipment details from EasyPost API.
   *
   * @param shipmentId - EasyPost shipment ID
   * @returns Shipment details with tracking info
   *
   * @cached TTL: 1 minute
   */
  async getShipment(shipmentId: string): Promise<any> {
    const cacheKey = createCacheKey("shipment", { id: shipmentId });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const shipment = await this.client.Shipment.retrieve(shipmentId);
        return {
          id: shipment.id,
          status: shipment.status,
          tracking_code: shipment.tracking_code,
          to_address: shipment.to_address,
          from_address: shipment.from_address,
          parcel: shipment.parcel,
          selected_rate: shipment.selected_rate,
          postage_label: shipment.postage_label,
          tracker: shipment.tracker,
          created_at: shipment.created_at,
        };
      },
      { ttl: TTL.MINUTE, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Lists all pending (unpurchased) shipments.
   *
   * @returns Pending shipments sorted by creation date (newest first)
   */
  listPending(): PendingShipment[] {
    const state = this.loadState();
    return Object.values(state.shipments)
      .filter((s) => s.status === "pending")
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }

  /**
   * Gets available rates for a pending shipment.
   *
   * @param shipmentId - Shipment ID
   * @returns Array of available rates
   * @throws {Error} If shipment not found
   */
  getRates(shipmentId: string): Rate[] {
    const state = this.loadState();
    const shipment = state.shipments[shipmentId];

    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    return shipment.rates;
  }

  /**
   * Requests refund for a purchased label.
   *
   * @param shipmentId - Shipment ID to refund
   * @returns Success status and refund details
   */
  async voidLabel(shipmentId: string): Promise<{ success: boolean; message: string }> {
    try {
      const refund = await this.client.Shipment.refund(shipmentId);

      const state = this.loadState();
      if (state.shipments[shipmentId]) {
        state.shipments[shipmentId].status = "voided";
        this.saveState(state);
      }

      return {
        success: true,
        message: `Refund requested. Status: ${refund.status || "submitted"}`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Void failed: ${error.message || error}`,
      };
    }
  }

  // ============================================
  // UTILITY
  // ============================================

  /** Returns list of available CLI commands with descriptions. */
  getTools(): Array<{ name: string; description: string }> {
    return [
      { name: "create-shipment", description: "Create shipment from Shopify order or manual address, get rates" },
      { name: "buy-label", description: "Purchase label for pending shipment (requires rate selection)" },
      { name: "cancel-shipment", description: "Cancel unpurchased shipment (no charges)" },
      { name: "get-shipment", description: "Get shipment details from EasyPost" },
      { name: "list-pending", description: "List all pending (unpurchased) shipments" },
      { name: "get-rates", description: "Get rates for a pending shipment" },
      { name: "void-label", description: "Request refund for purchased label" },
      { name: "cache-stats", description: "Show cache statistics" },
      { name: "cache-clear", description: "Clear all cached data" },
    ];
  }
}

export default EasyPostShippingClient;
