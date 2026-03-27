import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import {
  BILLING_ACCOUNT_STATUSES,
  BILLING_INTERVALS,
  SUBSCRIPTION_PROVIDERS,
} from "../billing/constants";

const SCHEDULED_CHANGE_KINDS = ["downgrade", "cancel"] as const;

const subscriptionSchema = new Schema(
  {
    billingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      required: true,
      unique: true,
    },
    provider: {
      type: String,
      enum: SUBSCRIPTION_PROVIDERS,
      default: "manual",
    },
    providerSubscriptionId: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: BILLING_ACCOUNT_STATUSES,
      default: "active",
    },
    planCatalogId: {
      type: Schema.Types.ObjectId,
      ref: "PlanCatalog",
      default: null,
    },
    planVersionId: {
      type: Schema.Types.ObjectId,
      ref: "PlanVersion",
      default: null,
    },
    // Legacy seed only. New billing resolution uses planCatalogId + planVersionId.
    planCode: {
      type: String,
      default: undefined,
    },
    billingInterval: {
      type: String,
      enum: BILLING_INTERVALS,
      default: "manual",
    },
    // Legacy seed only.
    billingCycle: {
      type: String,
      enum: BILLING_INTERVALS,
      default: undefined,
    },
    currentPeriodStart: {
      type: Date,
      default: null,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    trialEndsAt: {
      type: Date,
      default: null,
    },
    trialPlanCode: {
      type: String,
      default: null,
    },
    scheduledPlanCatalogId: {
      type: Schema.Types.ObjectId,
      ref: "PlanCatalog",
      default: null,
    },
    scheduledPlanVersionId: {
      type: Schema.Types.ObjectId,
      ref: "PlanVersion",
      default: null,
    },
    scheduledPlanCode: {
      type: String,
      default: null,
    },
    scheduledChangeKind: {
      type: String,
      enum: SCHEDULED_CHANGE_KINDS,
      default: null,
    },
    scheduledChangeEffectiveAt: {
      type: Date,
      default: null,
    },
    renewsAt: {
      type: Date,
      default: null,
    },
    gracePeriodEndsAt: {
      type: Date,
      default: null,
    },
  },
  {
    collection: "subscriptions",
    timestamps: true,
  }
);

export type BillingSubscriptionDocument = HydratedDocument<
  InferSchemaType<typeof subscriptionSchema>
>;

export const BillingSubscriptionModel = model("BillingSubscription", subscriptionSchema);
export const SubscriptionModel = BillingSubscriptionModel;
export type SubscriptionDocument = BillingSubscriptionDocument;
