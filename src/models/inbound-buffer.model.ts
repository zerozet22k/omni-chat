import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const inboundBufferSchema = new Schema(
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
    attentionItemId: {
      type: Schema.Types.ObjectId,
      ref: "AttentionItem",
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "processed", "cancelled"],
      default: "pending",
    },
    firstBufferedAt: {
      type: Date,
      required: true,
    },
    lastBufferedAt: {
      type: Date,
      required: true,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    bufferedMessageIds: {
      type: [Schema.Types.ObjectId],
      default: [],
    },
    combinedText: {
      type: String,
      default: "",
    },
    reason: {
      type: String,
      default: "",
    },
  },
  {
    collection: "inbound_buffers",
    timestamps: true,
  }
);

inboundBufferSchema.index({ conversationId: 1, status: 1 });
inboundBufferSchema.index({ attentionItemId: 1, status: 1 });
inboundBufferSchema.index({ workspaceId: 1, status: 1 });

export type InboundBufferDocument = HydratedDocument<InferSchemaType<typeof inboundBufferSchema>>;

export const InboundBufferModel = model("InboundBuffer", inboundBufferSchema);
