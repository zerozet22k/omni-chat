import { promises as fs } from "fs";
import path from "path";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { ValidationError } from "../../lib/errors";
import { requireWorkspace } from "../../middleware/require-workspace";
import { MediaAssetModel } from "../../models";
import { mediaAssetService } from "../../services/media-asset.service";

const router = Router();

const uploadAssetSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
});

const sanitizeFilename = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

const decodeBase64Payload = (value: string) => {
  const maybeDataUrl = value.match(/^data:([^;]+);base64,(.+)$/);
  if (maybeDataUrl) {
    return {
      mimeTypeFromDataUrl: maybeDataUrl[1],
      buffer: Buffer.from(maybeDataUrl[2], "base64"),
    };
  }

  return {
    mimeTypeFromDataUrl: null,
    buffer: Buffer.from(value, "base64"),
  };
};

router.use(requireWorkspace);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = uploadAssetSchema.parse(req.body);
    const decoded = decodeBase64Payload(payload.dataBase64);
    const mimeType = decoded.mimeTypeFromDataUrl || payload.mimeType;
    const size = decoded.buffer.byteLength;

    if (!size) {
      throw new ValidationError("Attachment payload is empty");
    }

    if (size > 10 * 1024 * 1024) {
      throw new ValidationError("Attachment size exceeds 10 MB limit");
    }

    const assetsDir = path.resolve(process.cwd(), "uploads");
    await fs.mkdir(assetsDir, { recursive: true });

    const extension =
      path.extname(payload.fileName) ||
      (mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : "");
    const fileBase = sanitizeFilename(path.basename(payload.fileName, extension));

    const asset = await MediaAssetModel.create({
      workspaceId: req.workspace?._id,
      createdByUserId: req.auth?.user?._id,
      originalFilename: payload.fileName,
      mimeType,
      size,
      storagePath: "",
      publicUrl: "",
    });

    const storedFilename = `${asset._id}-${fileBase}${extension}`;
    const storedPath = path.resolve(assetsDir, storedFilename);
    await fs.writeFile(storedPath, decoded.buffer);

    asset.storagePath = storedPath;
    await asset.save();

    res.status(201).json({
      asset: {
        _id: String(asset._id),
        url: mediaAssetService.createSignedContentUrl(String(asset._id)),
        mimeType: asset.mimeType,
        size: asset.size,
        fileName: asset.originalFilename,
      },
    });
  })
);

export default router;
