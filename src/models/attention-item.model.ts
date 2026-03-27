import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import {
  ATTENTION_ITEM_STATES,
  ATTENTION_NEEDS_HUMAN_REASONS,
  ATTENTION_RESOLUTION_TYPES,
} from "../channels/types";

const attentionItemSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    openedByInboundMessageIds: {
      type: [Schema.Types.ObjectId],
      ref: "Message",
      default: [],
    },
    lastInboundMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    state: {
      type: String,
      enum: ATTENTION_ITEM_STATES,
      default: "open",
    },
    needsHuman: {
      type: Boolean,
      default: false,
    },
    needsHumanReason: {
      type: String,
      enum: ATTENTION_NEEDS_HUMAN_REASONS,
      default: null,
    },
    assignedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    botPausedAt: {
      type: Date,
      default: null,
    },
    botPausedUntil: {
      type: Date,
      default: null,
    },
    botPausedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    acknowledgementMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    botReplyMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    humanReplyMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    resolvedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resolutionType: {
      type: String,
      enum: ATTENTION_RESOLUTION_TYPES,
      default: null,
    },
    openedAt: {
      type: Date,
      required: true,
    },
    updatedAt: {
      type: Date,
      required: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    collection: "attention_items",
  }
);

attentionItemSchema.index({ conversationId: 1, updatedAt: -1 });
attentionItemSchema.index({ conversationId: 1, openedAt: -1 });
attentionItemSchema.index({ conversationId: 1, resolvedAt: 1, updatedAt: -1 });

export type AttentionItemDocument = HydratedDocument<
  InferSchemaType<typeof attentionItemSchema>
>;

export const AttentionItemModel = model("AttentionItem", attentionItemSchema);