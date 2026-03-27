import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const connectedAccountsUsedByPlatformSchema = new Schema(
  {
    website: { type: Number, default: 0 },
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

const usageSummarySchema = new Schema(
  {
    billingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      required: true,
      index: true,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },
    workspacesUsed: {
      type: Number,
      default: 0,
    },
    seatsUsed: {
      type: Number,
      default: 0,
    },
    connectedAccountsUsedByPlatform: {
      type: connectedAccountsUsedByPlatformSchema,
      required: true,
    },
  },
  {
    collection: "billing_usage_summaries",
    timestamps: true,
  }
);

usageSummarySchema.index(
  { billingAccountId: 1, periodStart: 1, periodEnd: 1 },
  { unique: true }
);

export type UsageSummaryDocument = HydratedDocument<
  InferSchemaType<typeof usageSummarySchema>
>;

export const UsageSummaryModel = model("UsageSummary", usageSummarySchema);
