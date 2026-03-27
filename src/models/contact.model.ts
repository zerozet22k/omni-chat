import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { CHANNELS } from "../channels/types";

const channelIdentitySchema = new Schema(
  {
    channel: {
      type: String,
      enum: CHANNELS,
      required: true,
    },
    externalUserId: { type: String, required: true },
    displayName: { type: String },
    username: { type: String },
    avatar: { type: String },
  },
  { _id: false }
);

const contactSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    channelIdentities: {
      type: [channelIdentitySchema],
      default: [],
    },
    primaryName: { type: String, default: "Unknown contact" },
    phones: { type: [String], default: [] },
    deliveryAddress: { type: String, default: "" },
    notes: { type: String, default: "" },
    aiNotes: { type: String, default: "" },
  },
  {
    collection: "contacts",
    timestamps: true,
  }
);

contactSchema.index({
  workspaceId: 1,
  "channelIdentities.channel": 1,
  "channelIdentities.externalUserId": 1,
});

export type ContactDocument = HydratedDocument<
  InferSchemaType<typeof contactSchema>
>;

export const ContactModel = model("Contact", contactSchema);
