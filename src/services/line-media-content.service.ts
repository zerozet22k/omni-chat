import axios from "axios";
import { Response } from "express";
import { logger } from "../lib/logger";
import { channelConnectionService } from "./channel-connection.service";
import { lineMediaTokenService } from "./line-media-token.service";

const isAllowedContentType = (contentType: string) => {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("image/") ||
    normalized.startsWith("video/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("application/octet-stream")
  );
};

class LineMediaContentService {
  async streamFromToken(token: string, res: Response) {
    const payload = lineMediaTokenService.verify(token);
    if (!payload) {
      return false;
    }

    try {
      const connection = await channelConnectionService.getConnectionByWorkspaceAndChannel({
        workspaceId: payload.workspaceId,
        channel: "line",
        externalAccountId: payload.channelAccountId,
        requireActive: false,
      });

      const channelAccessToken = String(connection.credentials.channelAccessToken ?? "").trim();
      if (!channelAccessToken) {
        return false;
      }

      const endpoint = `https://api-data.line.me/v2/bot/message/${payload.messageId}/content`;
      const response = await axios.get(endpoint, {
        responseType: "stream",
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          Authorization: `Bearer ${channelAccessToken}`,
        },
      });

      const contentTypeHeader = response.headers["content-type"];
      const contentType = Array.isArray(contentTypeHeader)
        ? String(contentTypeHeader[0] ?? "")
        : String(contentTypeHeader ?? "");

      if (response.status < 200 || response.status >= 300 || !isAllowedContentType(contentType)) {
        logger.info("LINE media proxy fallback", {
          messageId: payload.messageId,
          messageKind: payload.messageKind,
          status: response.status,
          contentType,
          fallbackReason:
            response.status < 200 || response.status >= 300
              ? "line_content_api_non_success"
              : "line_content_api_non_media_content_type",
        });
        return false;
      }

      logger.info("LINE media proxy stream verified", {
        messageId: payload.messageId,
        messageKind: payload.messageKind,
        status: response.status,
        contentType,
      });

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=300");

      await new Promise<void>((resolve, reject) => {
        response.data.on("error", reject);
        res.on("finish", resolve);
        res.on("close", resolve);
        response.data.pipe(res);
      });

      return true;
    } catch (error) {
      logger.warn("LINE media proxy fallback", {
        messageId: payload.messageId,
        messageKind: payload.messageKind,
        status: null,
        contentType: null,
        fallbackReason: "line_content_api_request_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export const lineMediaContentService = new LineMediaContentService();
