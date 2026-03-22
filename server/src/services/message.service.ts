import {
  MessageDeliveryModel,
  MessageDocument,
  MessageModel,
} from "../models";
import { CanonicalMessage, SendOutboundResult } from "../channels/types";
import { telegramStickerPreviewService } from "./telegram-sticker-preview.service";
import { tiktokBusinessMessagingService } from "./tiktok-business-messaging.service";

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
      media: params.message.media ?? [],
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

    return Promise.all(
      serializedMessages.map(async (message) =>
        this.enrichTikTokMediaPresentation(
          this.enrichStickerPresentation(message)
        )
      )
    );
  }

  async listRecentCanonicalByConversation(
    conversationId: string,
    limit = 12
  ): Promise<Array<{
    senderType: string;
    kind: string;
    text?: { body?: string };
    media?: Array<{ url?: string; filename?: string }>;
    createdAt: Date;
  }>> {
    const messages = await MessageModel.find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("senderType kind text media createdAt")
      .lean();

    return messages
      .reverse()
      .map((message) => ({
        senderType: message.senderType,
        kind: message.kind,
        text: message.text as { body?: string } | undefined,
        media: (message.media as Array<{ url?: string; filename?: string }> | undefined) ?? [],
        createdAt: message.createdAt,
      }));
  }

  private enrichStickerPresentation(message: Record<string, unknown>) {
    if (message.channel !== "telegram" || message.kind !== "sticker") {
      return message;
    }

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
