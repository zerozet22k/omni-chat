import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { BILLING_PLAN_GROUPS, BILLING_PRICING_MODES } from "../billing/constants";

const planCatalogSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    displayName: {
      type: String,
      required: true,
    },
    sortOrder: {
      type: Number,
      default: 100,
    },
    showPublicly: {
      type: Boolean,
      default: true,
    },
    selfServe: {
      type: Boolean,
      default: true,
    },
    pricingMode: {
      type: String,
      enum: BILLING_PRICING_MODES,
      default: "fixed",
    },
    planGroup: {
      type: String,
      enum: BILLING_PLAN_GROUPS,
      default: "standard",
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    collection: "plan_catalogs",
    timestamps: true,
  }
);

export type PlanCatalogDocument = HydratedDocument<
  InferSchemaType<typeof planCatalogSchema>
>;

export const PlanCatalogModel = model("PlanCatalog", planCatalogSchema);
