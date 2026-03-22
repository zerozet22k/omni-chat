import jwt from "jsonwebtoken";
import { env } from "../config/env";

type TikTokMediaTokenPayload = {
  purpose: "tiktok-media";
  conversationId: string;
  messageId: string;
  mediaId: string;
  mediaType: "IMAGE" | "VIDEO";
};

class TikTokMediaTokenService {
  sign(payload: Omit<TikTokMediaTokenPayload, "purpose">) {
    return jwt.sign(
      {
        purpose: "tiktok-media",
        ...payload,
      } satisfies TikTokMediaTokenPayload,
      env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );
  }

  verify(token: string): TikTokMediaTokenPayload | null {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as Partial<TikTokMediaTokenPayload>;
      if (
        decoded.purpose !== "tiktok-media" ||
        typeof decoded.conversationId !== "string" ||
        typeof decoded.messageId !== "string" ||
        typeof decoded.mediaId !== "string" ||
        (decoded.mediaType !== "IMAGE" && decoded.mediaType !== "VIDEO")
      ) {
        return null;
      }

      return {
        purpose: "tiktok-media",
        conversationId: decoded.conversationId,
        messageId: decoded.messageId,
        mediaId: decoded.mediaId,
        mediaType: decoded.mediaType,
      };
    } catch {
      return null;
    }
  }
}

export const tiktokMediaTokenService = new TikTokMediaTokenService();
