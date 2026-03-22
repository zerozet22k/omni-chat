import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import {
  CHANNELS,
  DELIVERY_STATUSES,
  DIRECTIONS,
  MESSAGE_KINDS,
  SENDER_TYPES,
} from "../channels/types";

const mediaSchema = new Schema(
  {
    url: { type: String },
    mimeType: { type: String },
    filename: { type: String },
    size: { type: Number },
    width: { type: Number },
    height: { type: Number },
    durationMs: { type: Number },
    providerFileId: { type: String },
    thumbnailUrl: { type: String },
    isTemporary: { type: Boolean, default: false },
    expiresAt: { type: Date, default: null },
    expirySource: {
      type: String,
      enum: ["provider_ttl", "signed_url", "unknown"],
      default: null,
    },
    lastValidatedAt: { type: Date, default: null },
    storedAssetId: { type: String, default: null },
    storedAssetUrl: { type: String, default: null },
  },
  { _id: false }
);

const locationSchema = new Schema(
  {
    lat: { type: Number },
    lng: { type: Number },
    label: { type: String },
  },
  { _id: false }
);

const contactPayloadSchema = new Schema(
  {
    name: { type: String },
    phone: { type: String },
  },
  { _id: false }
);

const interactiveSchema = new Schema(
  {
    subtype: { type: String },
    label: { type: String },
    value: { type: String },
    payload: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const textSchema = new Schema(
  {
    body: { type: String },
    plain: { type: String },
  },
  { _id: false }
);

const messageSchema = new Schema(
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
    channel: {
      type: String,
      enum: CHANNELS,
      required: true,
    },
    channelAccountId: { type: String, required: true },
    externalMessageId: { type: String, default: null },
    externalChatId: { type: String, required: true },
    externalSenderId: { type: String, default: null },
    direction: {
      type: String,
      enum: DIRECTIONS,
      required: true,
    },
    senderType: {
      type: String,
      enum: SENDER_TYPES,
      required: true,
    },
    kind: {
      type: String,
      enum: MESSAGE_KINDS,
      required: true,
    },
    text: { type: textSchema, default: undefined },
    media: { type: [mediaSchema], default: [] },
    location: { type: locationSchema, default: undefined },
    contact: { type: contactPayloadSchema, default: undefined },
    interactive: { type: interactiveSchema, default: undefined },
    unsupportedReason: { type: String, default: null },
    status: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: "received",
    },
    raw: { type: Schema.Types.Mixed, required: true },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "messages",
    timestamps: true,
  }
);

messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index(
  {
    workspaceId: 1,
    channel: 1,
    channelAccountId: 1,
    externalMessageId: 1,
  },
  {
    unique: true,
    partialFilterExpression: { externalMessageId: { $type: "string" } },
  }
);

export type MessageDocument = HydratedDocument<InferSchemaType<typeof messageSchema>>;

export const MessageModel = model("Message", messageSchema);
