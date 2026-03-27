import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { BILLING_OVERRIDE_TYPES } from "../billing/constants";

const billingOverrideSchema = new Schema(
  {
    billingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: BILLING_OVERRIDE_TYPES,
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      default: {},
    },
    effectiveFrom: {
      type: Date,
      default: () => new Date(),
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
    reason: {
      type: String,
      default: "",
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    collection: "billing_overrides",
    timestamps: true,
  }
);

billingOverrideSchema.index({ billingAccountId: 1, effectiveFrom: -1 });

export type BillingOverrideDocument = HydratedDocument<
  InferSchemaType<typeof billingOverrideSchema>
>;

export const BillingOverrideModel = model("BillingOverride", billingOverrideSchema);
