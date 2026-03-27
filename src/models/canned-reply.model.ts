import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const cannedReplySchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: { type: String, required: true },
    category: { type: String, default: "general" },
    triggers: { type: [String], default: [] },
    body: { type: String, default: "" },
    blocks: { type: [Schema.Types.Mixed], default: [] },
    isActive: { type: Boolean, default: true },
  },
  {
    collection: "canned_replies",
    timestamps: true,
  }
);

cannedReplySchema.index({ workspaceId: 1, isActive: 1 });

export type CannedReplyDocument = HydratedDocument<
  InferSchemaType<typeof cannedReplySchema>
>;

export const CannedReplyModel = model("CannedReply", cannedReplySchema);
