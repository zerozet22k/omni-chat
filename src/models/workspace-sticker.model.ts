import { InferSchemaType, HydratedDocument, Schema, model } from "mongoose";
import { CHANNELS } from "../channels/types";

const workspaceStickerSchema = new Schema(
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
    channel: {
      type: String,
      enum: ["telegram", "viber", "line"] satisfies Array<(typeof CHANNELS)[number]>,
      required: true,
    },
    providerRef: {
      type: String,
      required: true,
      trim: true,
    },
    platformStickerId: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    emoji: {
      type: String,
      trim: true,
      default: "",
    },
    providerMeta: {
      telegram: {
        fileId: { type: String, trim: true },
        thumbnailFileId: { type: String, trim: true },
        isAnimated: { type: Boolean, default: false },
        isVideo: { type: Boolean, default: false },
      },
      viber: {
        previewUrl: { type: String, trim: true },
      },
      line: {
        packageId: { type: String, trim: true },
        stickerResourceType: { type: String, trim: true },
        storeUrl: { type: String, trim: true },
        packTitle: { type: String, trim: true },
      },
    },
  },
  {
    collection: "workspace_stickers",
    timestamps: true,
  }
);

workspaceStickerSchema.index(
  { workspaceId: 1, channel: 1, providerRef: 1 },
  { unique: true }
);
workspaceStickerSchema.index({ workspaceId: 1, channel: 1, updatedAt: -1 });

export type WorkspaceStickerDocument = HydratedDocument<
  InferSchemaType<typeof workspaceStickerSchema>
>;

export const WorkspaceStickerModel = model(
  "WorkspaceSticker",
  workspaceStickerSchema
);
