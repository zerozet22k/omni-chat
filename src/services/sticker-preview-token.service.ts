import jwt from "jsonwebtoken";
import { env } from "../config/env";

type StickerPreviewTokenPayload = {
  purpose: "sticker-preview";
  conversationId: string;
  fileId: string;
};

class StickerPreviewTokenService {
  sign(payload: Omit<StickerPreviewTokenPayload, "purpose">) {
    return jwt.sign(
      {
        purpose: "sticker-preview",
        ...payload,
      } satisfies StickerPreviewTokenPayload,
      env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );
  }

  verify(token: string): StickerPreviewTokenPayload | null {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as Partial<StickerPreviewTokenPayload>;
      if (
        decoded.purpose !== "sticker-preview" ||
        typeof decoded.conversationId !== "string" ||
        typeof decoded.fileId !== "string"
      ) {
        return null;
      }

      return {
        purpose: "sticker-preview",
        conversationId: decoded.conversationId,
        fileId: decoded.fileId,
      };
    } catch {
      return null;
    }
  }
}

export const stickerPreviewTokenService = new StickerPreviewTokenService();
