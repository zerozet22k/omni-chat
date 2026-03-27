import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { PLATFORM_FAMILIES } from "../billing/constants";

const entitlementsSchema = new Schema(
  {
    billingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      required: true,
      unique: true,
    },
    maxWorkspaces: {
      type: Number,
      default: 1,
    },
    maxSeats: {
      type: Number,
      default: 1,
    },
    allowedPlatformFamilies: {
      type: [String],
      enum: PLATFORM_FAMILIES,
      default: ["website"],
    },
    maxConnectedAccountsPerPlatform: {
      type: Map,
      of: Number,
      default: {
        website: 1,
        meta: 0,
        telegram: 0,
        viber: 0,
        tiktok: 0,
        line: 0,
      },
    },
    allowWebsiteChat: {
      type: Boolean,
      default: true,
    },
    allowCustomDomain: {
      type: Boolean,
      default: false,
    },
    allowBYOAI: {
      type: Boolean,
      default: false,
    },
    allowAutomation: {
      type: Boolean,
      default: false,
    },
    allowAuditExports: {
      type: Boolean,
      default: false,
    },
    allowExtraSeatPurchase: {
      type: Boolean,
      default: false,
    },
    allowExtraWorkspacePurchase: {
      type: Boolean,
      default: false,
    },
    allowExtraConnectionPurchase: {
      type: Boolean,
      default: false,
    },
  },
  {
    collection: "entitlements",
    timestamps: true,
  }
);

export type EntitlementsDocument = HydratedDocument<
  InferSchemaType<typeof entitlementsSchema>
>;

export const EntitlementsModel = model("Entitlements", entitlementsSchema);
