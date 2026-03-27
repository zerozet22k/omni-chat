import jwt from "jsonwebtoken";
import { env } from "../config/env";

type LineMediaTokenPayload = {
  purpose: "line-media";
  workspaceId: string;
  channelAccountId: string;
  messageId: string;
  messageKind: "image" | "video" | "audio" | "file" | "sticker";
};

class LineMediaTokenService {
  sign(payload: Omit<LineMediaTokenPayload, "purpose">) {
    return jwt.sign(
      {
        purpose: "line-media",
        ...payload,
      } satisfies LineMediaTokenPayload,
      env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );
  }

  verify(token: string): LineMediaTokenPayload | null {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as Partial<LineMediaTokenPayload>;
      if (
        decoded.purpose !== "line-media" ||
        typeof decoded.workspaceId !== "string" ||
        typeof decoded.channelAccountId !== "string" ||
        typeof decoded.messageId !== "string" ||
        (decoded.messageKind !== "image" &&
          decoded.messageKind !== "video" &&
          decoded.messageKind !== "audio" &&
          decoded.messageKind !== "file" &&
          decoded.messageKind !== "sticker")
      ) {
        return null;
      }

      return {
        purpose: "line-media",
        workspaceId: decoded.workspaceId,
        channelAccountId: decoded.channelAccountId,
        messageId: decoded.messageId,
        messageKind: decoded.messageKind,
      };
    } catch {
      return null;
    }
  }
}

export const lineMediaTokenService = new LineMediaTokenService();
