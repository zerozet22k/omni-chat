import { createReadStream, promises as fs } from "fs";
import { Response } from "express";
import path from "path";
import { env } from "../config/env";
import { MediaAssetModel } from "../models";
import { mediaAssetTokenService } from "./media-asset-token.service";

const resolvePublicBaseUrl = () => {
  if (env.PUBLIC_WEBHOOK_BASE_URL.trim()) {
    return env.PUBLIC_WEBHOOK_BASE_URL.trim().replace(/\/+$/, "");
  }

  return `http://localhost:${env.PORT}`;
};

class MediaAssetService {
  createSignedContentUrl(assetId: string, options?: { absolute?: boolean }) {
    const token = mediaAssetTokenService.sign({ assetId });
    const relativeUrl = `/api/media-assets/content/${encodeURIComponent(token)}`;

    if (!options?.absolute) {
      return relativeUrl;
    }

    return `${resolvePublicBaseUrl()}${relativeUrl}`;
  }

  async streamFromToken(token: string, res: Response) {
    const payload = mediaAssetTokenService.verify(token);
    if (!payload) {
      return false;
    }

    const asset = await MediaAssetModel.findById(payload.assetId).lean();
    if (!asset?.storagePath) {
      return false;
    }

    try {
      await fs.access(asset.storagePath);
    } catch {
      return false;
    }

    const fileName = path.basename(asset.originalFilename || "attachment");
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(asset.size ?? 0));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileName.replace(/["\\]/g, "_")}"`
    );

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(asset.storagePath);
      stream.on("error", reject);
      res.on("finish", resolve);
      res.on("close", resolve);
      stream.pipe(res);
    });

    return true;
  }
}

export const mediaAssetService = new MediaAssetService();
