import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import {
  CHANNELS,
  CONVERSATION_ROUTING_STATES,
  CONVERSATION_STATUSES,
} from "../channels/types";
import { normalizeConversationRoutingState } from "../lib/conversation-ai-state";

const conversationSchema = new Schema(
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
    channelAccountId: { type: String, required: true },
    externalChatId: { type: String, required: true },
    externalUserId: { type: String },
    contactId: { type: Schema.Types.ObjectId, ref: "Contact" },
    assigneeUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      default: "open",
    },
    unreadCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: null },
    lastMessageText: { type: String, default: "" },
    aiEnabled: { type: Boolean, default: true },
    routingState: {
      type: String,
      enum: CONVERSATION_ROUTING_STATES,
      default: "bot_active",
    },
    botPausedAt: { type: Date, default: null },
    botPausedUntil: { type: Date, default: null },
    botPausedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    tags: { type: [String], default: [] },
  },
  {
    collection: "conversations",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

conversationSchema.index(
  { workspaceId: 1, channel: 1, channelAccountId: 1, externalChatId: 1 },
  { unique: true }
);

conversationSchema.pre("validate", function normalizeAIState(next) {
  this.routingState = normalizeConversationRoutingState(this.routingState);
  next();
});

conversationSchema.index({ workspaceId: 1, lastMessageAt: -1 });

export type ConversationDocument = HydratedDocument<
  InferSchemaType<typeof conversationSchema>
>;

export const ConversationModel = model("Conversation", conversationSchema);
