import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const auditLogSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace" },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation" },
    messageId: { type: Schema.Types.ObjectId, ref: "Message" },
    actorType: { type: String, required: true },
    actorId: { type: String, default: null },
    eventType: { type: String, required: true },
    reason: { type: String, default: null },
    confidence: { type: Number, default: null },
    sourceHints: { type: [String], default: [] },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "audit_logs",
    timestamps: true,
  }
);

auditLogSchema.index({ workspaceId: 1, createdAt: -1 });

export type AuditLogDocument = HydratedDocument<
  InferSchemaType<typeof auditLogSchema>
>;

export const AuditLogModel = model("AuditLog", auditLogSchema);
