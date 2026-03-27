import jwt from "jsonwebtoken";
import { env } from "../config/env";

type MediaAssetTokenPayload = {
  purpose: "media-asset";
  assetId: string;
};

class MediaAssetTokenService {
  sign(payload: Omit<MediaAssetTokenPayload, "purpose">) {
    return jwt.sign(
      {
        purpose: "media-asset",
        ...payload,
      } satisfies MediaAssetTokenPayload,
      env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );
  }

  verify(token: string): MediaAssetTokenPayload | null {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as Partial<MediaAssetTokenPayload>;
      if (decoded.purpose !== "media-asset" || typeof decoded.assetId !== "string") {
        return null;
      }

      return {
        purpose: "media-asset",
        assetId: decoded.assetId,
      };
    } catch {
      return null;
    }
  }
}

export const mediaAssetTokenService = new MediaAssetTokenService();
