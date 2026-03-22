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
    afterHoursEnabled: { type: Boolean, default: false },
    confidenceThreshold: { type: Number, default: 0.7 },
    fallbackMessage: {
      type: String,
      default: "Thanks for your message. A teammate will follow up soon.",
    },
    // Workspace-owned AI provider overrides (stored encrypted at rest).
    // Use the AI settings API to set/remove; the raw value is never returned to clients.
    geminiApiKey: { type: String, default: "" },
    geminiModel: { type: String, default: "" },
    supportedChannels: {
      facebook: { type: Boolean, default: true },
      telegram: { type: Boolean, default: true },
      viber: { type: Boolean, default: true },
      tiktok: { type: Boolean, default: true },
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
