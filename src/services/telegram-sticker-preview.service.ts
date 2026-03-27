import axios from "axios";
import { Response } from "express";
import { channelConnectionService } from "./channel-connection.service";
import { conversationService } from "./conversation.service";
import { stickerPreviewTokenService } from "./sticker-preview-token.service";
import {
  StickerCatalogItem,
  StickerPreview,
  StickerCatalogSourceItem,
  TelegramStickerCatalogItemMeta,
} from "./sticker-catalog.types";

type TelegramConversationContext = {
  _id: string;
  workspaceId: string;
  channel: "telegram";
  channelAccountId: string;
};

type TelegramFileInfo = {
  fileId: string;
  filePath: string;
};

export type ResolvedTelegramStickerPreview = {
  preview?: StickerPreview;
  previewFileId?: string;
  originalFileId: string;
  isAnimated: boolean;
  isVideo: boolean;
  previewFromThumbnail: boolean;
  mimeType?: string;
};

const inferMimeType = (filePath?: string) => {
  const normalized = String(filePath ?? "").toLowerCase();
  if (normalized.endsWith(".webm")) {
    return "video/webm";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  if (normalized.endsWith(".tgs")) {
    return "application/x-tgsticker";
  }
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return undefined;
};

class TelegramStickerPreviewService {
  private readonly fileInfoCache = new Map<string, TelegramFileInfo | null>();

  async buildCatalogItems(
    conversation: TelegramConversationContext,
    items: StickerCatalogSourceItem[]
  ): Promise<StickerCatalogItem[]> {
    return Promise.all(
      items.map(async (item) => {
        const descriptor = await this.resolveStickerDescriptor(
          conversation,
          item.providerMeta?.telegram
        );

        return {
          id: item.id,
          platformStickerId: item.platformStickerId,
          label: item.label,
          description: item.description,
          emoji: item.emoji,
          preview: descriptor?.preview,
          providerMeta: item.providerMeta,
        };
      })
    );
  }

  async resolveStickerDescriptor(
    conversation: TelegramConversationContext,
    meta?: TelegramStickerCatalogItemMeta
  ): Promise<ResolvedTelegramStickerPreview | null> {
    if (!meta?.fileId) {
      return null;
    }

    const botToken = await this.resolveBotToken(conversation);
    return this.resolveStickerDescriptorWithBotToken(conversation, meta, botToken);
  }

  createSignedPreviewUrl(conversationId: string, fileId: string) {
    return this.buildPreviewUrl(conversationId, fileId);
  }

  async streamPreviewFromToken(token: string, res: Response) {
    const payload = stickerPreviewTokenService.verify(token);
    if (!payload) {
      return false;
    }

    const conversation = await conversationService.getById(payload.conversationId);
    if (!conversation || conversation.channel !== "telegram") {
      return false;
    }

    const botToken = await this.resolveBotToken({
      _id: String(conversation._id),
      workspaceId: String(conversation.workspaceId),
      channel: "telegram",
      channelAccountId: conversation.channelAccountId,
    });
    if (!botToken) {
      return false;
    }

    const fileInfo = await this.resolveTelegramFileInfo(botToken, payload.fileId);
    if (!fileInfo) {
      return false;
    }

    try {
      const response = await axios.get(
        `https://api.telegram.org/file/bot${botToken}/${fileInfo.filePath}`,
        {
          responseType: "stream",
          timeout: 15000,
        }
      );

      res.setHeader(
        "Content-Type",
        inferMimeType(fileInfo.filePath) ??
          response.headers["content-type"] ??
          "application/octet-stream"
      );
      res.setHeader("Cache-Control", "private, max-age=300");

      await new Promise<void>((resolve, reject) => {
        response.data.on("error", reject);
        res.on("finish", resolve);
        res.on("close", resolve);
        response.data.pipe(res);
      });

      return true;
    } catch {
      return false;
    }
  }

  private async resolveStickerDescriptorWithBotToken(
    conversation: TelegramConversationContext,
    meta: TelegramStickerCatalogItemMeta,
    botToken: string | null
  ): Promise<ResolvedTelegramStickerPreview> {
    const stickerFileInfo = botToken
      ? await this.resolveTelegramFileInfo(botToken, meta.fileId)
      : null;
    const stickerMimeType = inferMimeType(stickerFileInfo?.filePath);
    const isVideo = meta.isVideo || stickerMimeType === "video/webm";
    const isAnimated =
      meta.isAnimated || (!isVideo && stickerMimeType === "application/x-tgsticker");

    if (isVideo) {
      return {
        preview: {
          kind: "video",
          url: this.buildPreviewUrl(conversation._id, meta.fileId),
          mimeType: "video/webm",
        },
        previewFileId: meta.fileId,
        originalFileId: meta.fileId,
        isAnimated,
        isVideo,
        previewFromThumbnail: false,
        mimeType: "video/webm",
      };
    }

    if (!isAnimated) {
      return {
        preview: {
          kind: "image",
          url: this.buildPreviewUrl(conversation._id, meta.fileId),
          mimeType: stickerMimeType ?? "image/webp",
        },
        previewFileId: meta.fileId,
        originalFileId: meta.fileId,
        isAnimated,
        isVideo,
        previewFromThumbnail: false,
        mimeType: stickerMimeType ?? "image/webp",
      };
    }

    if (meta.thumbnailFileId) {
      const thumbnailInfo = botToken
        ? await this.resolveTelegramFileInfo(botToken, meta.thumbnailFileId)
        : null;

      return {
        preview: {
          kind: "fallback",
          url: this.buildPreviewUrl(conversation._id, meta.thumbnailFileId),
          mimeType: inferMimeType(thumbnailInfo?.filePath) ?? "image/webp",
        },
        previewFileId: meta.thumbnailFileId,
        originalFileId: meta.fileId,
        isAnimated,
        isVideo,
        previewFromThumbnail: true,
        mimeType: inferMimeType(thumbnailInfo?.filePath) ?? "image/webp",
      };
    }

    return {
      preview: {
        kind: "tgs",
        mimeType: "application/x-tgsticker",
      },
      originalFileId: meta.fileId,
      isAnimated,
      isVideo,
      previewFromThumbnail: false,
      mimeType: "application/x-tgsticker",
    };
  }

  private buildPreviewUrl(conversationId: string, fileId: string) {
    const token = stickerPreviewTokenService.sign({
      conversationId,
      fileId,
    });

    return `/api/sticker-previews/${encodeURIComponent(token)}`;
  }

  private async resolveBotToken(conversation: TelegramConversationContext) {
    try {
      const connection = await channelConnectionService.getConnectionByWorkspaceAndChannel({
        workspaceId: conversation.workspaceId,
        channel: "telegram",
        externalAccountId: conversation.channelAccountId,
        requireActive: false,
      });

      const botToken = String(connection.credentials.botToken ?? "").trim();
      return botToken || null;
    } catch {
      return null;
    }
  }

  private async resolveTelegramFileInfo(botToken: string, fileId: string) {
    const normalizedFileId = fileId.trim();
    if (!normalizedFileId) {
      return null;
    }

    const cacheKey = `${botToken}:${normalizedFileId}`;
    if (this.fileInfoCache.has(cacheKey)) {
      return this.fileInfoCache.get(cacheKey) ?? null;
    }

    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${botToken}/getFile`,
        {
          params: {
            file_id: normalizedFileId,
          },
          timeout: 10000,
        }
      );

      const filePath = response.data?.result?.file_path;
      if (!filePath || typeof filePath !== "string") {
        this.fileInfoCache.set(cacheKey, null);
        return null;
      }

      const result = {
        fileId: normalizedFileId,
        filePath,
      } satisfies TelegramFileInfo;
      this.fileInfoCache.set(cacheKey, result);
      return result;
    } catch {
      this.fileInfoCache.set(cacheKey, null);
      return null;
    }
  }
}

export const telegramStickerPreviewService = new TelegramStickerPreviewService();
