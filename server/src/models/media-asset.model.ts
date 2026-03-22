import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";

const mediaAssetSchema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    storagePath: { type: String, required: true },
    publicUrl: { type: String, required: true },
  },
  {
    collection: "media_assets",
    timestamps: true,
  }
);

mediaAssetSchema.index({ workspaceId: 1, createdAt: -1 });

export type MediaAssetDocument = HydratedDocument<
  InferSchemaType<typeof mediaAssetSchema>
>;

export const MediaAssetModel = model("MediaAsset", mediaAssetSchema);
