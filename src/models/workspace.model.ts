import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const workspaceSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    timeZone: { type: String, default: "Asia/Bangkok" },
    bio: { type: String, default: "" },
    publicDescription: { type: String, default: "" },
    publicWebsiteUrl: { type: String, default: "" },
    publicSupportEmail: { type: String, default: "" },
    publicSupportPhone: { type: String, default: "" },
    publicLogoUrl: { type: String, default: "" },
    publicWelcomeMessage: { type: String, default: "" },
    publicChatEnabled: { type: Boolean, default: true },
    billingAccountId: {
      type: Schema.Types.ObjectId,
      ref: "BillingAccount",
      default: null,
      index: true,
    },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    collection: "workspaces",
    timestamps: true,
  }
);

export type WorkspaceDocument = HydratedDocument<
  InferSchemaType<typeof workspaceSchema>
>;

export const WorkspaceModel = model("Workspace", workspaceSchema);
