import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const aiSettingsSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
    },
    enabled: { type: Boolean, default: false },
    autoReplyEnabled: { type: Boolean, default: false },
    autoReplyMode: {
      type: String,
      enum: ["none", "all", "after_hours_only", "business_hours_only"],
      default: "none",
    },
    afterHoursEnabled: { type: Boolean, default: false },
    confidenceThreshold: { type: Number, default: 0.7 },
    fallbackMessage: {
      type: String,
      default: "Thanks for your message. A teammate will follow up soon.",
    },
    assistantInstructions: {
      type: String,
      default: "",
    },
    geminiApiKey: { type: String, default: "" },
    geminiModel: { type: String, default: "" },
    // Legacy assistant override fields retained so partially migrated workspaces
    // do not lose access if they already saved values during the failed swap.
    assistantProvider: { type: String, default: "" },
    assistantApiKey: { type: String, default: "" },
    assistantModel: { type: String, default: "" },
    supportedChannels: {
      facebook: { type: Boolean, default: true },
      instagram: { type: Boolean, default: true },
      telegram: { type: Boolean, default: true },
      viber: { type: Boolean, default: true },
      tiktok: { type: Boolean, default: true },
      line: { type: Boolean, default: true },
      website: { type: Boolean, default: true },
    },
  },
  {
    collection: "ai_settings",
    timestamps: true,
  }
);

export type AISettingsDocument = HydratedDocument<
  InferSchemaType<typeof aiSettingsSchema>
>;

export const AISettingsModel = model("AISettings", aiSettingsSchema);
