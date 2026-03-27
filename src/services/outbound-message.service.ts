import { randomUUID } from "crypto";
import { adapterRegistry } from "../channels/adapter.registry";
import {
  type CanonicalContactPayload,
  type CanonicalInteractivePayload,
  type CanonicalLocation,
  type CanonicalMedia,
  type CanonicalTextPayload,
  CanonicalMessage,
  OutboundCommand,
  SendOutboundResult,
} from "../channels/types";
import { CapabilityError, NotFoundError, ValidationError } from "../lib/errors";
import { env } from "../config/env";
import { auditLogService } from "./audit-log.service";
import { channelConnectionService } from "./channel-connection.service";
import { channelSupportService } from "./channel-support.service";
import { conversationService } from "./conversation.service";
import { messageService } from "./message.service";
import { tiktokBusinessMessagingService } from "./tiktok-business-messaging.service";
import { emitRealtimeEvent } from "../lib/realtime";
import { addOutboundSendJob, waitForOutboundSendJob, type OutboundSendJobPayload, type OutboundSendJobResult } from "../lib/queues";
import { withRedisLock } from "../lib/redis-lock";
import {
  type ChannelConnectionDocument,
  type ConversationDocument,
  type MessageDeliveryDocument,
  type MessageDocument,
  MessageDeliveryModel,
  MessageModel,
} from "../models";

type OutboundSendContext = {
  conversation: ConversationDocument;
  connection: ChannelConnectionDocument;
};

type PreparedQueuedSend = OutboundSendContext & {
  queuedMessage: MessageDocument;
  canonicalMessage: CanonicalMessage;
};

class OutboundMessageService {
  private validateProviderOutboundCommand(channel: string, command: OutboundCommand) {
    if (channel === "telegram") {
      if (command.kind === "sticker") {
        const platformStickerId = String(command.meta?.platformStickerId ?? "").trim();
        if (!platformStickerId) {
          throw new ValidationError("Telegram sticker outbound requires meta.platformStickerId");
        }

        if (/^AgAD[A-Za-z0-9_-]+$/.test(platformStickerId)) {
          throw new ValidationError(
            "Telegram rejected this sticker identifier. Use sticker file_id (usually starts with CAAC), not file_unique_id (starts with AgAD)."
          );
        }

        if (!/^[A-Za-z0-9_-]{16,}$/.test(platformStickerId)) {
          throw new ValidationError(
            "Telegram sticker ID looks invalid. Use a full Telegram file_id from a real sticker message."
          );
        }
      }

      return;
    }

    if (channel === "viber") {
      if (command.kind === "image") {
        const media = command.media?.[0];
        const mimeType = String(media?.mimeType ?? "").toLowerCase();

        if (
          mimeType &&
          mimeType !== "image/jpeg" &&
          mimeType !== "image/jpg" &&
          mimeType !== "image/png" &&
          mimeType !== "image/gif"
        ) {
          throw new ValidationError(
            "Viber image outbound currently supports JPG, PNG, and GIF files only"
          );
        }
      }

      if (command.kind === "video") {
        const media = command.media?.[0];
        if (!media?.size) {
          throw new ValidationError("Viber video outbound requires media[0].size");
        }
        if (!media.durationMs) {
          throw new ValidationError("Viber video outbound requires media[0].durationMs");
        }
      }

      if (command.kind === "file") {
        const media = command.media?.[0];
        if (!media?.size) {
          throw new ValidationError("Viber file outbound requires media[0].size");
        }
        if (!media.filename) {
          throw new ValidationError("Viber file outbound requires media[0].filename");
        }
      }

      if (command.kind === "sticker") {
        const platformStickerId = String(command.meta?.platformStickerId ?? "").trim();
        if (!platformStickerId) {
          throw new ValidationError("Viber sticker outbound requires meta.platformStickerId");
        }
        if (!/^\d+$/.test(platformStickerId)) {
          throw new ValidationError(
            "Viber sticker outbound requires numeric meta.platformStickerId"
          );
        }
      }

      return;
    }

    if (channel === "line") {
      if (command.kind === "sticker") {
        const platformStickerId = String(command.meta?.platformStickerId ?? "").trim();
        const stickerPackageId = String(command.meta?.stickerPackageId ?? "").trim();

        if (!platformStickerId) {
          throw new ValidationError("LINE sticker outbound requires meta.platformStickerId");
        }

        if (!stickerPackageId) {
          throw new ValidationError("LINE sticker outbound requires meta.stickerPackageId");
        }
      }

      return;
    }

    if (channel === "tiktok" && command.kind === "image") {
      const media = command.media?.[0];
      const mimeType = String(media?.mimeType ?? "").toLowerCase();
      if (command.text?.body?.trim()) {
        throw new ValidationError(
          "TikTok image outbound does not support text and image in the same message. Send separate blocks."
        );
      }
      if (media?.size && media.size > 3 * 1024 * 1024) {
        throw new ValidationError("TikTok image outbound exceeds the 3 MB limit");
      }
      if (
        mimeType &&
        mimeType !== "image/jpeg" &&
        mimeType !== "image/png" &&
        mimeType !== "image/jpg"
      ) {
        throw new ValidationError("TikTok image outbound only supports JPG and PNG files");
      }
    }
  }

  async send(params: {
    conversationId: string;
    command: OutboundCommand;
    source?: string;
  }) {
    const prepared = await this.prepareQueuedSend(params);
    const jobPayload: OutboundSendJobPayload = {
      messageId: String(prepared.queuedMessage._id),
      conversationId: String(prepared.conversation._id),
      source: params.source,
    };

    const job = await addOutboundSendJob(jobPayload, {
      jobId: String(prepared.queuedMessage._id),
    });

    if (!job) {
      const processed = await this.processQueuedMessage(jobPayload);
      return this.loadSendOutcome(processed, prepared.queuedMessage);
    }

    let result: OutboundSendJobResult | null = null;
    try {
      result = await waitForOutboundSendJob(job);
    } catch {
      result = null;
    }

    if (!result) {
      return {
        message: prepared.queuedMessage,
        delivery: null,
      };
    }

    return this.loadSendOutcome(result, prepared.queuedMessage);
  }

  async processQueuedMessage(
    payload: OutboundSendJobPayload
  ): Promise<OutboundSendJobResult> {
    return withRedisLock(
      `lock:conversation:${payload.conversationId}`,
      30,
      async () => {
        const queuedMessage = await MessageModel.findById(payload.messageId);
        if (!queuedMessage) {
          throw new NotFoundError("Queued outbound message not found");
        }

        const existingDelivery = await MessageDeliveryModel.findOne({
          messageId: queuedMessage._id,
        }).sort({ createdAt: -1 });

        if (queuedMessage.status !== "queued") {
          return {
            messageId: String(queuedMessage._id),
            deliveryId: existingDelivery ? String(existingDelivery._id) : null,
            status: queuedMessage.status === "failed" ? "failed" : "sent",
          };
        }

        const conversation = await conversationService.getById(payload.conversationId);
        if (!conversation) {
          throw new NotFoundError("Conversation not found");
        }

        const command = this.buildCommandFromQueuedMessage(queuedMessage);
        const context = await this.loadConversationSendContext({
          conversationId: payload.conversationId,
          command,
        });

        const canonicalMessage = this.buildCanonicalMessageFromQueuedMessage(queuedMessage);
        const result = await this.executePreparedSend({
          conversation: context.conversation,
          connection: context.connection,
          canonicalMessage,
          queuedMessage,
        });

        return {
          messageId: String(result.message._id),
          deliveryId: result.delivery ? String(result.delivery._id) : null,
          status:
            result.message.status === "failed"
              ? "failed"
              : result.message.status === "queued"
                ? "queued"
                : "sent",
        };
      }
    );
  }

  private async prepareQueuedSend(params: {
    conversationId: string;
    command: OutboundCommand;
    source?: string;
  }): Promise<PreparedQueuedSend> {
    const context = await this.loadConversationSendContext(params);

    const canonicalMessage: CanonicalMessage = {
      channel: context.conversation.channel,
      channelAccountId: context.conversation.channelAccountId,
      externalChatId: context.conversation.externalChatId,
      externalSenderId: undefined,
      direction: "outbound",
      senderType: params.command.senderType,
      kind: params.command.kind,
      text: params.command.text,
      media: params.command.media,
      location: params.command.location,
      contact: params.command.contact,
      interactive: params.command.interactive,
      occurredAt: params.command.occurredAt ?? new Date(),
      raw: {
        queuedAt: new Date().toISOString(),
        correlationId: randomUUID(),
      },
      meta: {
        source: params.source ?? "api",
        ...(params.command.meta ?? {}),
      },
    };

    const queuedMessage = await messageService.createOutboundQueuedMessage({
      workspaceId: String(context.conversation.workspaceId),
      conversationId: String(context.conversation._id),
      message: canonicalMessage,
    });

    return {
      conversation: context.conversation,
      connection: context.connection,
      queuedMessage,
      canonicalMessage,
    };
  }

  private async loadConversationSendContext(params: {
    conversationId: string;
    command: OutboundCommand;
  }): Promise<OutboundSendContext> {
    const conversation = await conversationService.getById(params.conversationId);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }

    const channelEnabled = await channelSupportService.isChannelEnabled(
      String(conversation.workspaceId),
      conversation.channel
    );

    const connection = await channelConnectionService.getConnectionByWorkspaceAndChannel({
      workspaceId: String(conversation.workspaceId),
      channel: conversation.channel,
      externalAccountId: conversation.channelAccountId,
      requireActive: false,
    });
    const effectiveConnectionState =
      await channelConnectionService.getEffectiveConnectionState(connection);

    if (!channelEnabled && effectiveConnectionState.status === "active") {
      throw new ValidationError(
        `Channel ${conversation.channel} is disabled in workspace admin settings.`
      );
    }

    // Check if outbound is enabled for this channel via environment configuration
    const outboundChannelsEnabled = env.OUTBOUND_CHANNELS_ENABLED.split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const isOutboundEnabled = outboundChannelsEnabled.includes(conversation.channel);
    if (!isOutboundEnabled) {
      throw new ValidationError(
        `Outbound messaging is not enabled for ${conversation.channel}. Configure OUTBOUND_CHANNELS_ENABLED environment variable.`
      );
    }

    if (effectiveConnectionState.status !== "active") {
      throw new ValidationError(
        effectiveConnectionState.lastError ||
          `Channel connection is ${effectiveConnectionState.status}. Complete provider setup before sending.`,
        {
          channelStatus: effectiveConnectionState.status,
        }
      );
    }

    const adapter = adapterRegistry.get(conversation.channel);
    const capabilities = adapter.getCapabilities();
    if (!capabilities.outbound[params.command.kind]) {
      throw new CapabilityError(
        `Channel ${conversation.channel} does not support outbound kind ${params.command.kind} in the current adapter.`
      );
    }

    this.validateProviderOutboundCommand(conversation.channel, params.command);

    if (conversation.channel === "tiktok") {
      const refreshedCredentials =
        await tiktokBusinessMessagingService.ensureValidConnectionCredentials(
          tiktokBusinessMessagingService.normalizeConnectionCredentials(
            (connection.credentials ?? {}) as Record<string, unknown>,
            conversation.channelAccountId
          )
        );
      connection.credentials =
        tiktokBusinessMessagingService.serializeCredentials(refreshedCredentials);
      await connection.save();
    }

    return {
      conversation,
      connection,
    };
  }

  private buildCommandFromQueuedMessage(
    queuedMessage: MessageDocument
  ): OutboundCommand {
    return {
      senderType: queuedMessage.senderType as OutboundCommand["senderType"],
      kind: queuedMessage.kind as OutboundCommand["kind"],
      text: this.normalizeTextPayload(queuedMessage.text),
      media: this.normalizeMediaItems(queuedMessage.media),
      location: this.normalizeLocationPayload(queuedMessage.location),
      contact: this.normalizeContactPayload(queuedMessage.contact),
      interactive: this.normalizeInteractivePayload(queuedMessage.interactive),
      meta:
        queuedMessage.meta && typeof queuedMessage.meta === "object"
          ? (queuedMessage.meta as Record<string, unknown>)
          : {},
      occurredAt: queuedMessage.createdAt,
    };
  }

  private buildCanonicalMessageFromQueuedMessage(
    queuedMessage: MessageDocument
  ): CanonicalMessage {
    return {
      channel: queuedMessage.channel,
      channelAccountId: queuedMessage.channelAccountId,
      externalChatId: queuedMessage.externalChatId,
      externalSenderId: queuedMessage.externalSenderId ?? undefined,
      direction: "outbound",
      senderType: queuedMessage.senderType,
      kind: queuedMessage.kind,
      text: this.normalizeTextPayload(queuedMessage.text),
      media: this.normalizeMediaItems(queuedMessage.media),
      location: this.normalizeLocationPayload(queuedMessage.location),
      contact: this.normalizeContactPayload(queuedMessage.contact),
      interactive: this.normalizeInteractivePayload(queuedMessage.interactive),
      occurredAt: queuedMessage.createdAt,
      raw:
        queuedMessage.raw && typeof queuedMessage.raw === "object"
          ? (queuedMessage.raw as Record<string, unknown>)
          : {},
      meta:
        queuedMessage.meta && typeof queuedMessage.meta === "object"
          ? (queuedMessage.meta as Record<string, unknown>)
          : {},
    };
  }

  private async executePreparedSend(params: {
    conversation: ConversationDocument;
    connection: ChannelConnectionDocument;
    canonicalMessage: CanonicalMessage;
    queuedMessage: MessageDocument;
  }): Promise<{ message: MessageDocument; delivery: MessageDeliveryDocument }> {
    const adapter = adapterRegistry.get(params.conversation.channel);
    let sendResult: SendOutboundResult;

    try {
      sendResult = await adapter.sendOutbound({
        conversation: {
          externalChatId: params.conversation.externalChatId,
          channel: params.conversation.channel,
        },
        message: params.canonicalMessage,
        connection: {
          externalAccountId: params.connection.externalAccountId,
          credentials: params.connection.credentials ?? {},
          webhookConfig: params.connection.webhookConfig ?? {},
        },
      });
    } catch (error) {
      sendResult = {
        status: "failed",
        error: error instanceof Error ? error.message : "Provider send failed",
        request: {
          queuedMessageId: String(params.queuedMessage._id),
        },
        raw: {
          error: error instanceof Error ? error.message : error,
        },
      };
    }

    const finalizedMessage = await messageService.finalizeOutboundMessage(
      String(params.queuedMessage._id),
      sendResult
    );

    const delivery = await messageService.createDeliveryRecord({
      workspaceId: String(params.conversation.workspaceId),
      conversationId: String(params.conversation._id),
      messageId: String(params.queuedMessage._id),
      channelConnectionId: String(params.connection._id),
      channel: params.conversation.channel,
      sendResult,
    });

    if (finalizedMessage) {
      const updatedConversation = await conversationService.applyOutboundMessage({
        conversationId: String(params.conversation._id),
        message: finalizedMessage,
      });

      emitRealtimeEvent(
        sendResult.status === "failed" ? "message.failed" : "message.sent",
        {
          workspaceId: String(params.conversation.workspaceId),
          conversationId: String(params.conversation._id),
          messageId: String(finalizedMessage._id),
          deliveryStatus: sendResult.status,
          error: sendResult.error,
        }
      );

      emitRealtimeEvent("conversation.updated", {
        workspaceId: String(params.conversation.workspaceId),
        conversationId: String(params.conversation._id),
        status: updatedConversation?.status ?? params.conversation.status,
      });
    }

    if (sendResult.status === "failed") {
      await channelConnectionService.markOutboundFailed(
        String(params.connection._id),
        sendResult.error ?? "Provider send failed"
      );
    } else {
      await channelConnectionService.markOutboundSent(String(params.connection._id));
    }

    await auditLogService.record({
      workspaceId: String(params.conversation.workspaceId),
      conversationId: String(params.conversation._id),
      messageId: String(params.queuedMessage._id),
      actorType: params.canonicalMessage.senderType,
      eventType:
        sendResult.status === "failed"
          ? "message.outbound.failed"
          : "message.outbound.sent",
      reason: sendResult.error,
      data: {
        request: sendResult.request,
        raw: sendResult.raw,
      },
    });

    return {
      message: finalizedMessage ?? params.queuedMessage,
      delivery,
    };
  }

  private async loadSendOutcome(
    result: OutboundSendJobResult,
    fallbackMessage: MessageDocument
  ) {
    const [message, delivery] = await Promise.all([
      MessageModel.findById(result.messageId),
      result.deliveryId ? MessageDeliveryModel.findById(result.deliveryId) : Promise.resolve(null),
    ]);

    return {
      message: message ?? fallbackMessage,
      delivery,
    };
  }

  private normalizeTextPayload(
    value: MessageDocument["text"] | undefined
  ): CanonicalTextPayload | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const body = typeof value.body === "string" ? value.body : "";
    const plain =
      typeof value.plain === "string" && value.plain.trim().length > 0
        ? value.plain
        : body;

    if (!body && !plain) {
      return undefined;
    }

    return {
      body,
      plain,
    };
  }

  private normalizeMediaItems(
    value: MessageDocument["media"] | undefined
  ): CanonicalMedia[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }

    return value.map((item) => ({
      ...(typeof item.url === "string" && item.url ? { url: item.url } : {}),
      ...(typeof item.mimeType === "string" && item.mimeType
        ? { mimeType: item.mimeType }
        : {}),
      ...(typeof item.filename === "string" && item.filename
        ? { filename: item.filename }
        : {}),
      ...(typeof item.size === "number" ? { size: item.size } : {}),
      ...(typeof item.width === "number" ? { width: item.width } : {}),
      ...(typeof item.height === "number" ? { height: item.height } : {}),
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      ...(typeof item.providerFileId === "string" && item.providerFileId
        ? { providerFileId: item.providerFileId }
        : {}),
      ...(typeof item.thumbnailUrl === "string" && item.thumbnailUrl
        ? { thumbnailUrl: item.thumbnailUrl }
        : {}),
      ...(typeof item.isTemporary === "boolean" ? { isTemporary: item.isTemporary } : {}),
      ...(item.expiresAt instanceof Date ? { expiresAt: item.expiresAt } : {}),
      ...(item.expirySource ? { expirySource: item.expirySource } : {}),
      ...(item.lastValidatedAt instanceof Date
        ? { lastValidatedAt: item.lastValidatedAt }
        : {}),
      ...(typeof item.storedAssetId === "string" && item.storedAssetId
        ? { storedAssetId: item.storedAssetId }
        : {}),
      ...(typeof item.storedAssetUrl === "string" && item.storedAssetUrl
        ? { storedAssetUrl: item.storedAssetUrl }
        : {}),
    }));
  }

  private normalizeLocationPayload(
    value: MessageDocument["location"] | undefined
  ): CanonicalLocation | undefined {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.lat !== "number" ||
      typeof value.lng !== "number"
    ) {
      return undefined;
    }

    return {
      lat: value.lat,
      lng: value.lng,
      ...(typeof value.label === "string" && value.label ? { label: value.label } : {}),
    };
  }

  private normalizeContactPayload(
    value: MessageDocument["contact"] | undefined
  ): CanonicalContactPayload | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const name = typeof value.name === "string" ? value.name : "";
    const phone = typeof value.phone === "string" ? value.phone : "";
    if (!name && !phone) {
      return undefined;
    }

    return {
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
    };
  }

  private normalizeInteractivePayload(
    value: MessageDocument["interactive"] | undefined
  ): CanonicalInteractivePayload | undefined {
    if (!value || typeof value !== "object" || typeof value.subtype !== "string") {
      return undefined;
    }

    return {
      subtype: value.subtype,
      ...(typeof value.label === "string" && value.label ? { label: value.label } : {}),
      ...(typeof value.value === "string" && value.value ? { value: value.value } : {}),
      ...(typeof value.payload !== "undefined" ? { payload: value.payload } : {}),
    };
  }
}

export const outboundMessageService = new OutboundMessageService();
