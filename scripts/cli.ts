#!/usr/bin/env npx tsx

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { EasyPostShippingClient } from "./easypost-client.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const manualDestinationFields = [
  "toName",
  "toStreet1",
  "toStreet2",
  "toCity",
  "toState",
  "toZip",
  "toCountry",
  "toPhone",
  "toEmail",
] as const;

const createShipmentSchema = z.object({
  orderId: z.string().optional().describe("Shopify order ID (fetches address automatically)"),
  toName: z.string().optional().describe("Recipient name (manual entry)"),
  toStreet1: z.string().optional().describe("Street address line 1"),
  toStreet2: z.string().optional().describe("Street address line 2"),
  toCity: z.string().optional().describe("City"),
  toState: z.string().optional().describe("State/County"),
  toZip: z.string().optional().describe("Postal code"),
  toCountry: z.string().optional().describe("Country code (default: GB for manual address)"),
  toPhone: z.string().optional().describe("Phone number"),
  toEmail: z.string().optional().describe("Email"),

  fromName: z.string().optional().describe("Sender name (return labels)"),
  fromStreet1: z.string().optional().describe("Sender street address line 1"),
  fromStreet2: z.string().optional().describe("Sender street address line 2"),
  fromCity: z.string().optional().describe("Sender city"),
  fromState: z.string().optional().describe("Sender state/county"),
  fromZip: z.string().optional().describe("Sender postal code"),
  fromCountry: z.string().optional().describe("Sender country code"),
  fromPhone: z.string().optional().describe("Sender phone number"),

  isReturn: z.boolean().optional().describe("Create a return label (swap label print direction)"),

  contentDescription: z.string().trim().max(50).optional().describe("Package contents description (max 50 chars)"),
  reference: z.string().trim().max(35).optional().describe("Order reference printed on label (max 35 chars, UPS limit)"),

  weight: cliTypes.float(0.1).describe("Parcel weight in kg (required)"),
  length: cliTypes.float(1).optional().describe("Parcel length in cm"),
  width: cliTypes.float(1).optional().describe("Parcel width in cm"),
  height: cliTypes.float(1).optional().describe("Parcel height in cm"),

  carrier: z.string().optional().describe("Filter rates to carrier (e.g., UPS)"),
  labelSize: z.string().optional().describe("Label size (default: 4x6)"),
  labelFormat: z.string().optional().describe("Label format (default: PNG)"),
  saturdayDelivery: z.boolean().optional().describe("Request Saturday delivery (filters to Saturday-eligible rates only)"),
}).refine(
  (data) => data.orderId || (data.toStreet1 && data.toCity && data.toZip),
  {
    message: "Either --order-id or manual address (--to-street1, --to-city, --to-zip) is required",
  }
).refine(
  (data) => !data.orderId || manualDestinationFields.every((field) => data[field] === undefined),
  {
    message: "--order-id cannot be combined with manual destination fields (--to-*)",
  }
).refine(
  (data) => !data.fromStreet1 || (data.fromCity && data.fromZip),
  {
    message: "When using --from-street1, --from-city and --from-zip are also required",
  }
);

export const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: EasyPostShippingClient) => client.getTools(),
    "List all available CLI commands",
    { sideEffect: "read" }
  ),

  "create-shipment": createCommand(
    createShipmentSchema,
    async (args, client: EasyPostShippingClient) => {
      const {
        orderId, toName, toStreet1, toStreet2, toCity, toState, toZip, toCountry,
        toPhone, toEmail, fromName, fromStreet1, fromStreet2, fromCity, fromState,
        fromZip, fromCountry, fromPhone, isReturn,
        weight, length, width, height, carrier, labelSize, labelFormat,
        contentDescription, reference, saturdayDelivery,
      } = args as {
        orderId?: string;
        toName?: string;
        toStreet1?: string;
        toStreet2?: string;
        toCity?: string;
        toState?: string;
        toZip?: string;
        toCountry?: string;
        toPhone?: string;
        toEmail?: string;
        fromName?: string;
        fromStreet1?: string;
        fromStreet2?: string;
        fromCity?: string;
        fromState?: string;
        fromZip?: string;
        fromCountry?: string;
        fromPhone?: string;
        isReturn?: boolean;
        weight: number;
        length?: number;
        width?: number;
        height?: number;
        carrier?: string;
        labelSize?: string;
        labelFormat?: string;
        contentDescription?: string;
        reference?: string;
        saturdayDelivery?: boolean;
      };

      const createOptions: Parameters<typeof client.createShipment>[0] = {
        parcel: {
          weight,
          ...(length && { length }),
          ...(width && { width }),
          ...(height && { height }),
        },
        ...(carrier && { carrier }),
        ...(labelSize && { labelSize }),
        ...(labelFormat && { labelFormat }),
        ...(isReturn && { isReturn }),
        ...(contentDescription && { contentDescription }),
        ...(reference && { reference }),
        ...(saturdayDelivery && { saturdayDelivery }),
      };

      if (orderId) {
        createOptions.orderId = orderId;
      } else {
        createOptions.toAddress = {
          name: toName,
          street1: toStreet1!,
          street2: toStreet2,
          city: toCity!,
          state: toState || "",
          zip: toZip!,
          country: toCountry || "GB",
          phone: toPhone,
          email: toEmail,
        };
      }

      if (fromStreet1) {
        createOptions.fromAddress = {
          name: fromName,
          street1: fromStreet1,
          street2: fromStreet2,
          city: fromCity!,
          state: fromState || "",
          zip: fromZip!,
          country: fromCountry || "GB",
          phone: fromPhone,
        };
      }

      const result = await client.createShipment(createOptions);
      if (result.saturdayFallback) {
        process.stderr.write("⚠️ Saturday delivery was unavailable for this route — falling back to standard scheduling.\n");
      }
      return result;
    },
    "Create shipment, get rates (Stage 1)",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "buy-label": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
      rateId: z.string().min(1).describe("Rate ID to purchase"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId, rateId } = args as { shipmentId: string; rateId: string };
      return client.buyLabel(shipmentId, rateId);
    },
    "Purchase label for pending shipment (Stage 2)",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "cancel-shipment": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.cancelShipment(shipmentId);
    },
    "Cancel unpurchased shipment",
    {
      sideEffect: "destructive",
      requiresConfirmation: true,
      operationResultExit: true,
    }
  ),

  "get-shipment": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.getShipment(shipmentId);
    },
    "Get shipment details from EasyPost",
    { sideEffect: "read" }
  ),

  "list-pending": createCommand(
    z.object({}),
    async (_args, client: EasyPostShippingClient) => client.listPending(),
    "List all pending (unpurchased) shipments",
    { sideEffect: "read" }
  ),

  "get-rates": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.getRates(shipmentId);
    },
    "Get rates for a pending shipment",
    { sideEffect: "read" }
  ),

  "void-label": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.voidLabel(shipmentId);
    },
    "Request refund for purchased label",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "check-saturday": createCommand(
    z.object({
      toZip: z.string().min(1).describe("Destination postal code"),
      toCountry: z.string().default("GB").describe("Destination country code"),
      weight: cliTypes.float(0.1).describe("Parcel weight in kg"),
      length: cliTypes.float(1).optional().describe("Parcel length in cm"),
      width: cliTypes.float(1).optional().describe("Parcel width in cm"),
      height: cliTypes.float(1).optional().describe("Parcel height in cm"),
      service: z.string().optional().describe("UPS service to check (e.g., UPSStandard)"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { toZip, toCountry, weight, length, width, height, service } = args as {
        toZip: string;
        toCountry: string;
        weight: number;
        length?: number;
        width?: number;
        height?: number;
        service?: string;
      };
      return client.checkSaturdayAvailability({
        toZip,
        toCountry,
        parcel: {
          weight,
          ...(length && { length }),
          ...(width && { width }),
          ...(height && { height }),
        },
        service,
      });
    },
    "Check if Saturday delivery is available for a route (no charge)",
    { sideEffect: "read" }
  ),

  ...cacheCommands<EasyPostShippingClient>(),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, EasyPostShippingClient, {
    programName: "easypost-cli",
    description: "EasyPost shipping label creation (two-stage workflow)",
  });
}

