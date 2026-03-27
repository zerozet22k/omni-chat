import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { BILLING_INTERVALS, PLATFORM_FAMILIES } from "../billing/constants";

const maxConnectedAccountsPerPlatformSchema = new Schema(
  {
    website: { type: Number, default: 1 },
    meta: { type: Number, default: 0 },
    telegram: { type: Number, default: 0 },
    viber: { type: Number, default: 0 },
    tiktok: { type: Number, default: 0 },
    line: { type: Number, default: 0 },
  },
  {
    _id: false,
  }
);

const entitlementsSchema = new Schema(
  {
    maxWorkspaces: {
      type: Number,
      required: true,
      min: 0,
    },
    maxSeats: {
      type: Number,
      required: true,
      min: 0,
    },
    allowedPlatformFamilies: {
      type: [String],
      enum: PLATFORM_FAMILIES,
      default: ["website"],
    },
    maxExternalPlatformFamilies: {
      type: Number,
      required: true,
      min: 0,
    },
    maxConnectedAccountsPerPlatform: {
      type: maxConnectedAccountsPerPlatformSchema,
      required: true,
    },
    allowWebsiteChat: {
      type: Boolean,
      default: true,
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
    allowCustomDomain: {
      type: Boolean,
      default: false,
    },
    allowExtraSeats: {
      type: Boolean,
      default: false,
    },
    allowExtraWorkspaces: {
      type: Boolean,
      default: false,
    },
    allowExtraConnections: {
      type: Boolean,
      default: false,
    },
  },
  {
    _id: false,
  }
);

const planVersionSchema = new Schema(
  {
    planCatalogId: {
      type: Schema.Types.ObjectId,
      ref: "PlanCatalog",
      required: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
    },
    active: {
      type: Boolean,
      default: true,
    },
    billingInterval: {
      type: String,
      enum: BILLING_INTERVALS,
      required: true,
    },
    priceAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    currency: {
      type: String,
      required: true,
      default: "USD",
    },
    stripeProductId: {
      type: String,
      default: "",
    },
    stripePriceId: {
      type: String,
      default: "",
    },
    entitlements: {
      type: entitlementsSchema,
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    collection: "plan_versions",
    timestamps: true,
  }
);

planVersionSchema.index({ planCatalogId: 1, version: 1 }, { unique: true });

export type PlanVersionDocument = HydratedDocument<
  InferSchemaType<typeof planVersionSchema>
>;

export const PlanVersionModel = model("PlanVersion", planVersionSchema);
