import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { BILLING_ACCOUNT_STATUSES } from "../billing/constants";

const billingAccountSchema = new Schema(
  {
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      default: "Billing account",
    },
    companyLegalName: {
      type: String,
      default: "",
    },
    billingEmail: {
      type: String,
      default: "",
    },
    billingContactName: {
      type: String,
      default: "",
    },
    billingPhone: {
      type: String,
      default: "",
    },
    billingAddress: {
      line1: {
        type: String,
        default: "",
      },
      line2: {
        type: String,
        default: "",
      },
      city: {
        type: String,
        default: "",
      },
      state: {
        type: String,
        default: "",
      },
      postalCode: {
        type: String,
        default: "",
      },
      country: {
        type: String,
        default: "",
      },
    },
    taxId: {
      type: String,
      default: "",
    },
    paymentProviderCustomerId: {
      type: String,
      default: "",
    },
    paymentMethodSummary: {
      provider: {
        type: String,
        default: "",
      },
      brand: {
        type: String,
        default: "",
      },
      last4: {
        type: String,
        default: "",
      },
      expMonth: {
        type: Number,
        default: null,
      },
      expYear: {
        type: Number,
        default: null,
      },
    },
    status: {
      type: String,
      enum: BILLING_ACCOUNT_STATUSES,
      default: "active",
    },
    // Legacy seed only. New billing resolution comes from BillingSubscription.planVersionId.
    planCode: {
      type: String,
      default: undefined,
    },
  },
  {
    collection: "billing_accounts",
    timestamps: true,
  }
);

export type BillingAccountDocument = HydratedDocument<
  InferSchemaType<typeof billingAccountSchema>
>;

export const BillingAccountModel = model("BillingAccount", billingAccountSchema);
