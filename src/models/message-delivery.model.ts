import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { CHANNELS, DELIVERY_STATUSES } from "../channels/types";

const messageDeliverySchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    channelConnectionId: {
      type: Schema.Types.ObjectId,
      ref: "ChannelConnection",
      required: true,
    },
    channel: {
      type: String,
      enum: CHANNELS,
      required: true,
    },
    externalMessageId: { type: String, default: null },
    status: {
      type: String,
      enum: DELIVERY_STATUSES,
      required: true,
    },
    error: { type: String, default: null },
    providerResponse: { type: Schema.Types.Mixed, default: {} },
    request: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "message_deliveries",
    timestamps: true,
  }
);

messageDeliverySchema.index({ messageId: 1, createdAt: -1 });

export type MessageDeliveryDocument = HydratedDocument<
  InferSchemaType<typeof messageDeliverySchema>
>;

export const MessageDeliveryModel = model(
  "MessageDelivery",
  messageDeliverySchema
);
