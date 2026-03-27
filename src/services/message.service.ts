import {
  MessageDeliveryModel,
  MessageDocument,
  MessageModel,
} from "../models";
import { CanonicalMessage, SendOutboundResult } from "../channels/types";
import { mediaAssetService } from "./media-asset.service";
import { telegramStickerPreviewService } from "./telegram-sticker-preview.service";
import { tiktokBusinessMessagingService } from "./tiktok-business-messaging.service";
import { logger } from "../lib/logger";

const LINE_STICKER_PACKS: Record<string, string> = {
  "11537": "Brown, Cony & Sally: Animated Special",
  "11538": "CHOCO & Friends: Animated Special",
};

const buildLineStickerStoreUrl = (packageId: string) =>
  `https://store.line.me/stickershop/product/${packageId}/en`;

class MessageService {
  async createInboundMessage(params: {
    workspaceId: string;
    conversationId: string;
    message: CanonicalMessage;
  }): Promise<{ message: MessageDocument; created: boolean }> {
    if (params.message.externalMessageId) {
      const existing = await MessageModel.findOne({
        workspaceId: params.workspaceId,
        channel: params.message.channel,
        channelAccountId: params.message.channelAccountId,
        externalMessageId: params.message.externalMessageId,
      });

      if (existing) {
        return { message: existing, created: false };
      }
    }

    let media = params.message.media ?? [];
    const meta = params.message.meta as Record<string, unknown> | undefined;
    
    if (params.message.kind === "sticker" && params.message.channel === "line") {
      const stickerId = typeof meta?.platformStickerId === "string" ? meta.platformStickerId : null;
      const packageId = typeof meta?.stickerPackageId === "string" ? meta.stickerPackageId : null;
      const stickerResourceType =
        typeof meta?.lineStickerResourceType === "string" ? meta.lineStickerResourceType : null;

      if (!stickerId || !packageId) {
        logger.warn("LINE sticker missing stickerId or packageId", { stickerId, packageId });
      } else {
        logger.info("LINE sticker preview decision", {
          packageId,
          stickerId,
          stickerResourceType,
          attemptedUpstreamUrl: null,
          status: null,
          contentType: null,
          fallbackReason: "no_verified_preview_url",
        });
      }
    }

    const created = await MessageModel.create({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      channel: params.message.channel,
      channelAccountId: params.message.channelAccountId,
      externalMessageId: params.message.externalMessageId ?? null,
      externalChatId: params.message.externalChatId,
      externalSenderId: params.message.externalSenderId ?? null,
      direction: params.message.direction,
      senderType: params.message.senderType,
      kind: params.message.kind,
      text: params.message.text,
      media,
      location: params.message.location,
      contact: params.message.contact,
      interactive: params.message.interactive,
      unsupportedReason: params.message.unsupportedReason ?? null,
      status: "received",
      raw: params.message.raw,
      meta: params.message.meta ?? {},
      createdAt: params.message.occurredAt,
      updatedAt: params.message.occurredAt,
    });

    return { message: created, created: true };
  }

  async createOutboundQueuedMessage(params: {
    workspaceId: string;
    conversationId: string;
    message: CanonicalMessage;
  }) {
    return MessageModel.create({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      channel: params.message.channel,
      channelAccountId: params.message.channelAccountId,
      externalMessageId: null,
      externalChatId: params.message.externalChatId,
      externalSenderId: params.message.externalSenderId ?? null,
      direction: params.message.direction,
      senderType: params.message.senderType,
      kind: params.message.kind,
      text: params.message.text,
      media: params.message.media ?? [],
      location: params.message.location,
      contact: params.message.contact,
      interactive: params.message.interactive,
      unsupportedReason: params.message.unsupportedReason ?? null,
      status: "queued",
      raw: params.message.raw,
      meta: params.message.meta ?? {},
      createdAt: params.message.occurredAt ?? new Date(),
      updatedAt: params.message.occurredAt ?? new Date(),
    });
  }

  async createInternalSystemMessage(params: {
    workspaceId: string;
    conversationId: string;
    channel: CanonicalMessage["channel"];
    channelAccountId: string;
    externalChatId: string;
    text: string;
    meta?: Record<string, unknown>;
    occurredAt?: Date;
  }) {
    const occurredAt = params.occurredAt ?? new Date();

    return MessageModel.create({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      channel: params.channel,
      channelAccountId: params.channelAccountId,
      externalMessageId: null,
      externalChatId: params.externalChatId,
      externalSenderId: null,
      direction: "outbound",
      senderType: "system",
      kind: "system",
      text: {
        body: params.text,
        plain: params.text,
      },
      media: [],
      status: "sent",
      raw: {
        internal: true,
        createdAt: occurredAt.toISOString(),
      },
      meta: {
        internal: true,
        ...(params.meta ?? {}),
      },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
  }

  async finalizeOutboundMessage(
    messageId: string,
    sendResult: SendOutboundResult
  ) {
    const message = await MessageModel.findById(messageId);
    if (!message) {
      return null;
    }

    const newMeta = {
      ...(message.meta ?? {}),
      deliveryError: sendResult.error ?? null,
    };

    message.externalMessageId = sendResult.externalMessageId ?? null;
    message.status =
      sendResult.status === "sent"
        ? "sent"
        : sendResult.status === "queued"
        ? "queued"
        : "failed";
    message.raw = {
      request: sendResult.request,
      response: sendResult.raw,
    };
    message.meta = newMeta;

    await message.save();
    return message;
  }

  async createDeliveryRecord(params: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    channelConnectionId: string;
    channel: string;
    sendResult: SendOutboundResult;
  }) {
    return MessageDeliveryModel.create({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      channelConnectionId: params.channelConnectionId,
      channel: params.channel,
      externalMessageId: params.sendResult.externalMessageId ?? null,
      status:
        params.sendResult.status === "sent"
          ? "sent"
          : params.sendResult.status === "queued"
            ? "queued"
            : "failed",
      error: params.sendResult.error ?? null,
      providerResponse: params.sendResult.raw ?? {},
      request: params.sendResult.request ?? {},
    });
  }

  async listByConversation(conversationId: string) {
    const messages = await MessageModel.find({ conversationId }).sort({ createdAt: 1 });
    const messageIds = messages.map((message) => message._id);
    const deliveries = messageIds.length
      ? await MessageDeliveryModel.find({ messageId: { $in: messageIds } }).sort({
        createdAt: -1,
      })
      : [];

    const latestDeliveryByMessageId = new Map<string, (typeof deliveries)[number]>();
    for (const delivery of deliveries) {
      const messageId = String(delivery.messageId);
      if (!latestDeliveryByMessageId.has(messageId)) {
        latestDeliveryByMessageId.set(messageId, delivery);
      }
    }

    const serializedMessages = messages.map((message) => ({
      ...message.toObject(),
      delivery: latestDeliveryByMessageId.get(String(message._id))?.toObject() ?? null,
    }));

    logger.debug("Listing messages for conversation", {
      conversationId,
      count: serializedMessages.length,
      kinds: serializedMessages.map((m) => m.kind),
    });

    const enrichedMessages = await Promise.all(
      serializedMessages.map(async (message) => {
        if (message.kind === "sticker" && message.channel === "line") {
          const mediaArray = Array.isArray(message.media)
            ? (message.media as unknown as Array<Record<string, unknown>>)
            : [];
          const mediaUrls = mediaArray.map((mediaItem) => mediaItem.url);
          logger.info("BEFORE enrichment - LINE sticker", {
            messageId: message._id,
            mediaLength: mediaArray.length,
            mediaUrls,
            metaKeys: Object.keys(message.meta ?? {}),
          });
        }

      const enriched = await this.enrichTikTokMediaPresentation(
          this.enrichStickerPresentation(this.enrichStoredAssetMedia(message))
        );

        if (enriched.kind === "sticker" && enriched.channel === "line") {
          const mediaArray = Array.isArray(enriched.media)
            ? (enriched.media as Array<Record<string, unknown>>)
            : [];
          const mediaUrls = mediaArray.map((mediaItem) => mediaItem.url);
          logger.info("AFTER enrichment - LINE sticker", {
            messageId: enriched._id,
            mediaLength: mediaArray.length,
            mediaUrls,
            metaKeys: Object.keys(enriched.meta ?? {}),
          });
        }

        return enriched;
      })
    );

    logger.debug("Messages enriched", {
      conversationId,
      count: enrichedMessages.length,
      withMedia: enrichedMessages.filter((m) => Array.isArray(m.media) && m.media.length > 0).length,
    });

    return enrichedMessages;
  }

  async listRecentCanonicalByConversation(
    conversationId: string,
    limit = 12
  ): Promise<Array<{
    senderType: string;
    direction?: string;
    kind: string;
    text?: { body?: string };
    media?: Array<{ url?: string; filename?: string }>;
    meta?: Record<string, unknown>;
    createdAt: Date;
  }>> {
    const messages = await MessageModel.find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("senderType direction kind text media meta createdAt")
      .lean();

    return messages
      .reverse()
      .map((message) => ({
        senderType: message.senderType,
        direction: message.direction,
        kind: message.kind,
        text: message.text as { body?: string } | undefined,
        media: (message.media as Array<{ url?: string; filename?: string }> | undefined) ?? [],
        meta:
          typeof message.meta === "object" && message.meta !== null
            ? (message.meta as Record<string, unknown>)
            : undefined,
        createdAt: message.createdAt,
      }));
  }

  private enrichStickerPresentation(message: Record<string, unknown>) {
    if (message.kind !== "sticker") {
      return message;
    }

    logger.debug("Enriching sticker presentation", {
      channel: message.channel,
      kind: message.kind,
      conversationId: message.conversationId,
      hasMedia: Array.isArray(message.media) && message.media.length > 0,
    });

    // Handle Telegram stickers
    if (message.channel === "telegram") {
      const meta =
        typeof message.meta === "object" && message.meta !== null
          ? (message.meta as Record<string, unknown>)
          : {};
      const media = Array.isArray(message.media)
        ? [...(message.media as Array<Record<string, unknown>>)]
        : [];
      const firstMedia =
        media.length > 0 && typeof media[0] === "object" && media[0] !== null
          ? { ...media[0] }
          : {};

      const previewFileId =
        (typeof meta.telegramStickerPreviewFileId === "string" &&
          meta.telegramStickerPreviewFileId) ||
        (typeof firstMedia.providerFileId === "string" && firstMedia.providerFileId) ||
        (typeof meta.originalStickerFileId === "string" && meta.originalStickerFileId) ||
        (typeof meta.platformStickerId === "string" && meta.platformStickerId) ||
        null;

      if (!previewFileId) {
        return message;
      }

      const mimeType =
        (typeof firstMedia.mimeType === "string" && firstMedia.mimeType) ||
        (typeof meta.stickerPreviewMimeType === "string" && meta.stickerPreviewMimeType) ||
        undefined;

      const enrichedMediaItem = {
        ...firstMedia,
        providerFileId:
          typeof firstMedia.providerFileId === "string" && firstMedia.providerFileId
            ? firstMedia.providerFileId
            : previewFileId,
        url: telegramStickerPreviewService.createSignedPreviewUrl(
          String(message.conversationId),
          previewFileId
        ),
        mimeType,
      };

      return {
        ...message,
        media: media.length > 0 ? [enrichedMediaItem, ...media.slice(1)] : [enrichedMediaItem],
      };
    }

      // Handle LINE stickers using the unofficial stickershop CDN proxy.
      // The LINE content API (api-data.line.me) does NOT serve sticker binaries;
      // only user-uploaded images/video/audio/files can be fetched that way.
    if (message.channel === "line") {
      const meta =
        typeof message.meta === "object" && message.meta !== null
          ? (message.meta as Record<string, unknown>)
          : {};
      const media = Array.isArray(message.media)
        ? [...(message.media as Array<Record<string, unknown>>)]
        : [];
      const stickerId = typeof meta.platformStickerId === "string" ? meta.platformStickerId : null;
      const packageId = typeof meta.stickerPackageId === "string" ? meta.stickerPackageId : null;
      const stickerResourceType =
        typeof meta.lineStickerResourceType === "string" ? meta.lineStickerResourceType : null;

      // Stable CDN proxy URL — no JWT, no expiry; proxy tries stickershop.line-scdn.net candidates
      const cdnProxyUrl =
        stickerId && packageId
          ? `/api/stickers/proxy/${encodeURIComponent(stickerId)}/${encodeURIComponent(packageId)}${stickerResourceType ? `?stickerResourceType=${encodeURIComponent(stickerResourceType)}` : ""}`
          : null;

      const existingPreviewImageUrl = cdnProxyUrl;
      const existingPreviewVerified = !!cdnProxyUrl;
        const existingStoreUrl =
          typeof meta.lineStickerStoreUrl === "string" && meta.lineStickerStoreUrl
            ? meta.lineStickerStoreUrl
            : null;
        const storeUrl = packageId
          ? existingStoreUrl ?? buildLineStickerStoreUrl(packageId)
          : existingStoreUrl;
        const packTitle =
          typeof meta.lineStickerPackTitle === "string" && meta.lineStickerPackTitle
            ? meta.lineStickerPackTitle
            : packageId
              ? LINE_STICKER_PACKS[packageId]
              : undefined;
        const stickerLabel =
          packageId && stickerId
            ? `${packTitle ?? `Sticker pack ${packageId}`} • #${stickerId}`
            : packageId
              ? packTitle ?? `Sticker pack ${packageId}`
              : stickerId
                ? `LINE sticker #${stickerId}`
                : "LINE sticker";

      logger.info("Processing LINE sticker message", {
        stickerId,
        packageId,
        stickerResourceType,
        messageId: message._id,
        hasStickerId: !!stickerId,
        hasPackageId: !!packageId,
          storeUrl,
      });

      logger.info("LINE sticker preview decision", {
        packageId,
        stickerId,
        stickerResourceType,
        attemptedUpstreamUrl: existingPreviewImageUrl,
        status: null,
        contentType: null,
        fallbackReason: existingPreviewVerified
          ? "verified_preview_available"
          : "metadata_only_no_verified_preview",
      });

      const cdnMediaItem = cdnProxyUrl
        ? {
            providerFileId: stickerId ?? undefined,
            url: cdnProxyUrl,
            mimeType: "image/png",
            isTemporary: false as const,
          }
        : null;

      const nextMedia = cdnMediaItem
        ? [cdnMediaItem, ...media.slice(1)]
        : media;

        return {
          ...message,
          media: nextMedia,
          meta: {
            ...meta,
            lineStickerStoreUrl: storeUrl ?? undefined,
            lineStickerPackTitle: packTitle,
            lineStickerPreviewImageUrl: existingPreviewImageUrl,
            lineStickerPreviewVerified: existingPreviewVerified,
            lineStickerPreviewSource: cdnProxyUrl ? "stickershop_cdn" : "none",
            stickerLabel,
          },
        };
    }

    return message;
  }

  private enrichStoredAssetMedia(message: Record<string, unknown>) {
    if (!Array.isArray(message.media) || !message.media.length) {
      return message;
    }

    const media = (message.media as Array<Record<string, unknown>>).map((item) => {
      if (typeof item !== "object" || item === null) {
        return item;
      }

      const storedAssetId = typeof item.storedAssetId === "string" ? item.storedAssetId.trim() : "";
      if (!storedAssetId) {
        return item;
      }

      return {
        ...item,
        url: mediaAssetService.createSignedContentUrl(storedAssetId),
      };
    });

    return {
      ...message,
      media,
    };
  }

  private async enrichTikTokMediaPresentation(message: Record<string, unknown>) {
    if (message.channel !== "tiktok" || !Array.isArray(message.media) || !message._id) {
      return message;
    }

    const meta =
      typeof message.meta === "object" && message.meta !== null
        ? (message.meta as Record<string, unknown>)
        : {};
    const mediaType =
      String(meta.providerMessageType ?? "").toUpperCase() === "VIDEO" ||
      message.kind === "video"
        ? "VIDEO"
        : "IMAGE";

    const media = (message.media as Array<Record<string, unknown>>).map((item) => {
      if (typeof item !== "object" || item === null) {
        return item;
      }

      const hasUrl =
        typeof item.url === "string" && item.url.trim().length > 0;
      const providerFileId =
        typeof item.providerFileId === "string" ? item.providerFileId.trim() : "";

      if (hasUrl || !providerFileId) {
        return item;
      }

      return {
        ...item,
        url: tiktokBusinessMessagingService.createSignedMediaUrl({
          conversationId: String(message.conversationId),
          messageId: String(message._id),
          mediaId: providerFileId,
          mediaType,
        }),
      };
    });

    return {
      ...message,
      media,
    };
  }
}

export const messageService = new MessageService();
