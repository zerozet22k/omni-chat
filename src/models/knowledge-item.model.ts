import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const knowledgeItemSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: { type: String, required: true },
    content: { type: String, required: true },
    tags: { type: [String], default: [] },
    sourceType: { type: String, default: "manual" },
    isActive: { type: Boolean, default: true },
  },
  {
    collection: "knowledge_items",
    timestamps: true,
  }
);

knowledgeItemSchema.index({ workspaceId: 1, isActive: 1 });

export type KnowledgeItemDocument = HydratedDocument<
  InferSchemaType<typeof knowledgeItemSchema>
>;

export const KnowledgeItemModel = model("KnowledgeItem", knowledgeItemSchema);
