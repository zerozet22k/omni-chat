import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import {
  CHANNELS,
  CHANNEL_CONNECTION_STATUSES,
  CHANNEL_CONNECTION_VERIFICATION_STATES,
} from "../channels/types";

const channelConnectionSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    channel: {
      type: String,
      enum: CHANNELS,
      required: true,
    },
    displayName: { type: String, required: true },
    externalAccountId: { type: String, required: true },
    credentials: { type: Schema.Types.Mixed, default: {} },
    webhookConfig: { type: Schema.Types.Mixed, default: {} },
    webhookUrl: { type: String, default: null },
    webhookVerified: { type: Boolean, default: false },
    verificationState: {
      type: String,
      enum: CHANNEL_CONNECTION_VERIFICATION_STATES,
      default: "unverified",
    },
    status: {
      type: String,
      enum: CHANNEL_CONNECTION_STATUSES,
      default: "pending",
    },
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    capabilities: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "channel_connections",
    timestamps: true,
  }
);

channelConnectionSchema.index(
  { workspaceId: 1, channel: 1, externalAccountId: 1 },
  { unique: true }
);

channelConnectionSchema.index(
  { channel: 1, "credentials.webhookSecret": 1 },
  { sparse: true }
);

channelConnectionSchema.index(
  { channel: 1, "credentials.verifyToken": 1 },
  { sparse: true }
);

export type ChannelConnectionDocument = HydratedDocument<
  InferSchemaType<typeof channelConnectionSchema>
>;

export const ChannelConnectionModel = model(
  "ChannelConnection",
  channelConnectionSchema
);
