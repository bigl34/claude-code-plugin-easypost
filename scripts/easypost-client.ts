
import { readFileSync, existsSync } from "fs";
import { secureStatePath, secureWrite } from "./vendor/secure-state/index.js";
import EasyPost from "@easypost/api";
import { loadServiceConfig, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { invokeServiceCli } from "./vendor/service-cli-invoker/index.js";

const STATE_PATH = secureStatePath("easypost", "pending-shipments.json");

const EasyPostConfigSchema = z.object({
  easypost: z.object({
    apiKey: z.string().min(1),
    upsAccountId: z.string().optional(),
  }),
});

type EasyPostConfig = z.infer<typeof EasyPostConfigSchema>;

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
  length?: number;
  width?: number;
  height?: number;
  weight: number;
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
  saturdayDelivery?: boolean;
  saturdayFallback?: boolean;
}

interface ShipmentState {
  shipments: Record<string, PendingShipment>;
  lastUpdated: string;
}

interface CreateShipmentOptions {
  orderId?: string;
  toAddress?: Address;
  fromAddress?: Address;
  parcel: Parcel;
  carrier?: string;
  labelSize?: string;
  labelFormat?: string;
  isReturn?: boolean;
  contentDescription?: string;
  reference?: string;
  saturdayDelivery?: boolean;
}

interface PurchasedLabel {
  trackingCode: string;
  labelUrl: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
}

const cache = new PluginCache({
  namespace: "easypost-shipping-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

type WrappedField = string | { value?: string | null } | null | undefined;

interface ShopifyShippingAddress {
  name?: WrappedField;
  address1?: WrappedField;
  address2?: WrappedField;
  city?: WrappedField;
  company?: WrappedField;
  province?: string;
  zip?: string;
  country?: string;
  countryCode?: string;
  phone?: string;
}

interface GetOrderEnvelope {
  content?: { shippingAddress?: ShopifyShippingAddress | null };
}

function unwrapField(field: WrappedField): string | undefined {
  if (field == null) return undefined;
  if (typeof field === "string") return field;
  return field.value ?? undefined;
}

export function mapShopifyOrderAddress(envelope: GetOrderEnvelope, orderId: string): Address {
  const addr = envelope.content?.shippingAddress;
  if (!addr) {
    throw new Error(`Order ${orderId} has no shipping address`);
  }
  const street1 = unwrapField(addr.address1);
  const city = unwrapField(addr.city);
  const zip = addr.zip;
  if (!street1 || !city || !zip) {
    const missing = [!street1 && "street1", !city && "city", !zip && "zip"]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Order ${orderId} shipping address is incomplete (missing: ${missing}). ` +
        `The shopify-order-manager get-order envelope shape may have changed.`,
    );
  }
  return {
    name: unwrapField(addr.name),
    company: unwrapField(addr.company) || undefined,
    street1,
    street2: unwrapField(addr.address2) || undefined,
    city,
    state: addr.province || "",
    zip,
    country: addr.countryCode || addr.country || "GB",
    phone: addr.phone || undefined,
  };
}

export class EasyPostShippingClient {
  private client: InstanceType<typeof EasyPost>;
  private config: EasyPostConfig;
  private cacheDisabled: boolean = false;

  constructor() {
    this.config = loadServiceConfig("easypost-shipping-manager", {
      schema: EasyPostConfigSchema,
      remedy: "Ensure credentials are loaded via cred-loader-sync.",
    });
    this.client = new EasyPost(this.config.easypost.apiKey);
  }


  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    return cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }


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

  private saveState(state: ShipmentState): void {
    state.lastUpdated = new Date().toISOString();
    secureWrite(STATE_PATH, JSON.stringify(state, null, 2));
  }

  private getFromAddress(): Address {
    return {
      company: "YOUR_COMPANY",
      street1: "YOUR_WAREHOUSE_STREET",
      street2: "YOUR_WAREHOUSE_CODE",
      city: "YOUR_CITY",
      state: "",
      zip: "YOUR_POSTCODE",
      country: "GB",
      phone: "YOUR_PHONE_NUMBER",
      email: "YOUR_LOGISTICS_EMAIL",
    };
  }


  private kgToOunces(kg: number): number {
    return kg * 35.274;
  }

  private cmToInches(cm: number): number {
    return cm * 0.3937;
  }

  private extractAndFilterRates(rates: any[] = [], carrierFilter?: string): Rate[] {
    return rates
      .filter((r) => !carrierFilter || r.carrier?.toLowerCase() === carrierFilter.toLowerCase())
      .map((r) => ({
        id: r.id,
        carrier: r.carrier,
        service: r.service,
        rate: r.rate,
        currency: r.currency,
        delivery_days: r.delivery_days,
        delivery_date: r.delivery_date,
      }))
      .sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
  }

  private async handleSaturdayFallback(
    shipmentParams: any,
    opts: { carrier?: string; orderId?: string },
    toAddress: Address,
    fromAddress: Address,
    parcel: Parcel,
  ): Promise<PendingShipment> {
    const retryParams = {
      ...shipmentParams,
      options: { ...shipmentParams.options },
    };
    delete retryParams.options.saturday_delivery;
    const retryShipment = await this.client.Shipment.create(retryParams);
    const retryRates = this.extractAndFilterRates(retryShipment.rates, opts.carrier);

    if (retryRates.length === 0) {
      throw new Error(
        "No shipping rates available for this shipment. Check addresses and carrier configuration."
      );
    }

    const fallbackShipment: PendingShipment = {
      id: retryShipment.id,
      createdAt: new Date().toISOString(),
      orderId: opts.orderId,
      toAddress,
      fromAddress,
      parcel,
      rates: retryRates,
      status: "pending",
      saturdayDelivery: true,
      saturdayFallback: true,
    };

    const state = this.loadState();
    state.shipments[retryShipment.id] = fallbackShipment;
    this.saveState(state);

    return fallbackShipment;
  }


  async fetchShopifyOrderAddress(orderId: string): Promise<Address> {
    const result = await invokeServiceCli<GetOrderEnvelope>(
      "shopify-order-manager",
      "get-order",
      { id: orderId },
      { timeoutMs: 30000 },
    );

    if (!result.ok || !result.data) {
      const errMsg = result.error || `exit ${result.exitCode}`;
      if (/not found/i.test(errMsg)) {
        throw new Error(`Shopify order not found: ${orderId}`);
      }
      throw new Error(`Failed to fetch Shopify order: ${errMsg}`);
    }

    return mapShopifyOrderAddress(result.data, orderId);
  }


  async createShipment(options: CreateShipmentOptions): Promise<PendingShipment> {
    let toAddress: Address;

    if (options.orderId) {
      toAddress = await this.fetchShopifyOrderAddress(options.orderId);
    } else if (options.toAddress) {
      toAddress = options.toAddress;
    } else {
      throw new Error("Either orderId or toAddress must be provided");
    }

    const fromAddress = options.fromAddress || this.getFromAddress();

    const effectiveSaturdayDelivery = options.saturdayDelivery && !options.isReturn;

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
        name: fromAddress.name || (options.fromAddress ? undefined : "YOUR_COMPANY Logistics"),
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
      ...(options.isReturn && { is_return: true }),
      options: {
        label_size: options.labelSize || "4x6",
        label_format: options.labelFormat || "PNG",
        ...(options.contentDescription && { content_description: options.contentDescription }),
        ...(options.reference && { print_custom_1: options.reference, print_custom_1_code: "ON" }),
        ...(effectiveSaturdayDelivery && { saturday_delivery: true }),
      },
    };

    if (this.config.easypost.upsAccountId) {
      shipmentParams.carrier_accounts = [this.config.easypost.upsAccountId];
    }

    const fallbackOpts = { carrier: options.carrier, orderId: options.orderId };
    let shipment;
    try {
      shipment = await this.client.Shipment.create(shipmentParams);
    } catch (error: any) {
      const is422 = error.statusCode === 422 || error.status === 422;
      if (is422 && effectiveSaturdayDelivery) {
        return this.handleSaturdayFallback(shipmentParams, fallbackOpts, toAddress, fromAddress, options.parcel);
      }
      throw error;
    }

    const rates = this.extractAndFilterRates(shipment.rates, options.carrier);

    if (rates.length === 0 && effectiveSaturdayDelivery) {
      return this.handleSaturdayFallback(shipmentParams, fallbackOpts, toAddress, fromAddress, options.parcel);
    }

    if (rates.length === 0) {
      throw new Error(
        "No shipping rates available for this shipment. Check addresses and carrier configuration."
      );
    }

    const pendingShipment: PendingShipment = {
      id: shipment.id,
      createdAt: new Date().toISOString(),
      orderId: options.orderId,
      toAddress,
      fromAddress,
      parcel: options.parcel,
      rates,
      status: "pending",
      ...(effectiveSaturdayDelivery && { saturdayDelivery: true }),
    };

    const state = this.loadState();
    state.shipments[shipment.id] = pendingShipment;
    this.saveState(state);

    return pendingShipment;
  }

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

    const rate = pendingShipment.rates.find((r) => r.id === rateId);
    if (!rate) {
      throw new Error(
        `Rate ${rateId} not found for shipment ${shipmentId}. Available rates: ${pendingShipment.rates.map((r) => r.id).join(", ")}`
      );
    }

    const purchasedShipment = await this.client.Shipment.buy(shipmentId, rateId);

    const label: PurchasedLabel = {
      trackingCode: purchasedShipment.tracking_code,
      labelUrl: purchasedShipment.postage_label?.label_url,
      carrier: rate.carrier,
      service: rate.service,
      rate: rate.rate,
      currency: rate.currency,
    };

    pendingShipment.status = "purchased";
    pendingShipment.trackingCode = label.trackingCode;
    pendingShipment.labelUrl = label.labelUrl;
    this.saveState(state);

    return label;
  }

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

  listPending(): PendingShipment[] {
    const state = this.loadState();
    return Object.values(state.shipments)
      .filter((s) => s.status === "pending")
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }

  getRates(shipmentId: string): Rate[] {
    const state = this.loadState();
    const shipment = state.shipments[shipmentId];

    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    return shipment.rates;
  }

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


  async checkSaturdayAvailability(options: {
    toZip: string;
    toCountry: string;
    parcel: Parcel;
    service?: string;
  }): Promise<{ available: boolean; service?: string; rate?: string; currency?: string; message: string }> {
    const fromAddress = this.getFromAddress();

    const shipmentParams: any = {
      to_address: {
        name: "Saturday Check",
        street1: "N/A",
        city: "N/A",
        state: "",
        zip: options.toZip,
        country: options.toCountry,
      },
      from_address: {
        company: fromAddress.company,
        street1: fromAddress.street1,
        street2: fromAddress.street2,
        city: fromAddress.city,
        state: fromAddress.state,
        zip: fromAddress.zip,
        country: fromAddress.country,
        phone: fromAddress.phone,
      },
      parcel: {
        weight: this.kgToOunces(options.parcel.weight),
        ...(options.parcel.length && { length: this.cmToInches(options.parcel.length) }),
        ...(options.parcel.width && { width: this.cmToInches(options.parcel.width) }),
        ...(options.parcel.height && { height: this.cmToInches(options.parcel.height) }),
      },
      options: {
        saturday_delivery: true,
      },
    };

    if (this.config.easypost.upsAccountId) {
      shipmentParams.carrier_accounts = [this.config.easypost.upsAccountId];
    }

    try {
      const shipment = await this.client.Shipment.create(shipmentParams);
      const rates = this.extractAndFilterRates(shipment.rates, "UPS");

      if (rates.length === 0) {
        return { available: false, message: "Saturday delivery is not available for this route." };
      }

      if (options.service) {
        const matchingRate = rates.find((r) => r.service === options.service);
        if (matchingRate) {
          return {
            available: true,
            service: matchingRate.service,
            rate: matchingRate.rate,
            currency: matchingRate.currency,
            message: `Saturday delivery available for ${matchingRate.service} (${matchingRate.currency} ${matchingRate.rate})`,
          };
        }
        const cheapest = rates[0];
        return {
          available: true,
          service: cheapest.service,
          rate: cheapest.rate,
          currency: cheapest.currency,
          message: `Saturday delivery not available for ${options.service}, but available for ${cheapest.service} (${cheapest.currency} ${cheapest.rate})`,
        };
      }

      const cheapest = rates[0];
      return {
        available: true,
        service: cheapest.service,
        rate: cheapest.rate,
        currency: cheapest.currency,
        message: `Saturday delivery available for ${cheapest.service} (${cheapest.currency} ${cheapest.rate})`,
      };
    } catch (error: any) {
      const is422 = error.statusCode === 422 || error.status === 422;
      if (is422) {
        return { available: false, message: "Saturday delivery is not available for this route." };
      }
      throw error;
    }
  }

  getTools(): Array<{ name: string; description: string }> {
    return [
      { name: "create-shipment", description: "Create shipment from Shopify order or manual address, get rates" },
      { name: "buy-label", description: "Purchase label for pending shipment (requires rate selection)" },
      { name: "cancel-shipment", description: "Cancel unpurchased shipment (no charges)" },
      { name: "get-shipment", description: "Get shipment details from EasyPost" },
      { name: "list-pending", description: "List all pending (unpurchased) shipments" },
      { name: "get-rates", description: "Get rates for a pending shipment" },
      { name: "void-label", description: "Request refund for purchased label" },
      { name: "check-saturday", description: "Check if Saturday delivery is available for a route (no charge)" },
      { name: "cache-stats", description: "Show cache statistics" },
      { name: "cache-clear", description: "Clear all cached data" },
    ];
  }
}

export default EasyPostShippingClient;
