import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

export const PLATFORM_ROLES = [
  "founder",
  "platform_admin",
  "support",
  "ops",
  "billing",
  "staff",
] as const;

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    platformRole: {
      type: String,
      enum: PLATFORM_ROLES,
      default: null,
    },
    authProvider: {
      type: String,
      enum: ["password", "google", "hybrid"],
      default: "password",
    },
    googleId: { type: String, default: null },
    avatarUrl: { type: String },
    defaultBillingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      default: null,
      index: true,
    },
    hasUsedTrial: {
      type: Boolean,
      default: false,
    },
    trialStartedAt: {
      type: Date,
      default: null,
    },
    trialConsumedAt: {
      type: Date,
      default: null,
    },
    trialUsedByBillingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      default: null,
    },
    trialUsedOnPlanCode: {
      type: String,
      default: null,
    },
    workspaceIds: [{ type: Schema.Types.ObjectId, ref: "Workspace" }],
  },
  {
    collection: "users",
    timestamps: true,
  }
);

userSchema.index({ googleId: 1 }, { unique: true, sparse: true });

export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const UserModel = model("User", userSchema);
