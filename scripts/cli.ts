#!/usr/bin/env npx tsx
/**
 * EasyPost Shipping CLI
 *
 * Zod-validated CLI for EasyPost shipping label creation (two-stage workflow).
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { EasyPostShippingClient } from "./easypost-client.js";

// Create-shipment schema with conditional validation
const createShipmentSchema = z.object({
  // Either orderId or manual address
  orderId: z.string().optional().describe("Shopify order ID (fetches address automatically)"),
  toName: z.string().optional().describe("Recipient name (manual entry)"),
  toStreet1: z.string().optional().describe("Street address line 1"),
  toStreet2: z.string().optional().describe("Street address line 2"),
  toCity: z.string().optional().describe("City"),
  toState: z.string().optional().describe("State/County"),
  toZip: z.string().optional().describe("Postal code"),
  toCountry: z.string().default("GB").describe("Country code"),
  toPhone: z.string().optional().describe("Phone number"),
  toEmail: z.string().optional().describe("Email"),

  // Parcel dimensions
  weight: cliTypes.float(0.1).describe("Parcel weight in kg (required)"),
  length: cliTypes.float(1).optional().describe("Parcel length in cm"),
  width: cliTypes.float(1).optional().describe("Parcel width in cm"),
  height: cliTypes.float(1).optional().describe("Parcel height in cm"),

  // Rate filtering
  carrier: z.string().optional().describe("Filter rates to carrier (e.g., UPS)"),
}).refine(
  (data) => data.orderId || (data.toStreet1 && data.toCity && data.toZip),
  {
    message: "Either --order-id or manual address (--to-street1, --to-city, --to-zip) is required",
  }
);

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: EasyPostShippingClient) => client.getTools(),
    "List all available CLI commands"
  ),

  // Shipment commands (Two-Stage Workflow)
  "create-shipment": createCommand(
    createShipmentSchema,
    async (args, client: EasyPostShippingClient) => {
      const {
        orderId, toName, toStreet1, toStreet2, toCity, toState, toZip, toCountry,
        toPhone, toEmail, weight, length, width, height, carrier,
      } = args as {
        orderId?: string;
        toName?: string;
        toStreet1?: string;
        toStreet2?: string;
        toCity?: string;
        toState?: string;
        toZip?: string;
        toCountry: string;
        toPhone?: string;
        toEmail?: string;
        weight: number;
        length?: number;
        width?: number;
        height?: number;
        carrier?: string;
      };

      const createOptions: Parameters<typeof client.createShipment>[0] = {
        parcel: {
          weight,
          ...(length && { length }),
          ...(width && { width }),
          ...(height && { height }),
        },
        ...(carrier && { carrier }),
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
          country: toCountry,
          phone: toPhone,
          email: toEmail,
        };
      }

      return client.createShipment(createOptions);
    },
    "Create shipment, get rates (Stage 1)"
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
    "Purchase label for pending shipment (Stage 2)"
  ),

  "cancel-shipment": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.cancelShipment(shipmentId);
    },
    "Cancel unpurchased shipment"
  ),

  // Query commands
  "get-shipment": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.getShipment(shipmentId);
    },
    "Get shipment details from EasyPost"
  ),

  "list-pending": createCommand(
    z.object({}),
    async (_args, client: EasyPostShippingClient) => client.listPending(),
    "List all pending (unpurchased) shipments"
  ),

  "get-rates": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.getRates(shipmentId);
    },
    "Get rates for a pending shipment"
  ),

  // Refunds
  "void-label": createCommand(
    z.object({
      shipmentId: z.string().min(1).describe("EasyPost shipment ID"),
    }),
    async (args, client: EasyPostShippingClient) => {
      const { shipmentId } = args as { shipmentId: string };
      return client.voidLabel(shipmentId);
    },
    "Request refund for purchased label"
  ),

  // Pre-built cache commands
  ...cacheCommands<EasyPostShippingClient>(),
};

// Run CLI
runCli(commands, EasyPostShippingClient, {
  programName: "easypost-cli",
  description: "EasyPost shipping label creation (two-stage workflow)",
});
