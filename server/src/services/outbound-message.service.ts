import { randomUUID } from "crypto";
import { adapterRegistry } from "../channels/adapter.registry";
import { CanonicalMessage, OutboundCommand } from "../channels/types";
import { CapabilityError, NotFoundError, ValidationError } from "../lib/errors";
import { auditLogService } from "./audit-log.service";
import { channelConnectionService } from "./channel-connection.service";
import { channelSupportService } from "./channel-support.service";
import { conversationService } from "./conversation.service";
import { messageService } from "./message.service";
import { tiktokBusinessMessagingService } from "./tiktok-business-messaging.service";
import { emitRealtimeEvent } from "../lib/realtime";

class OutboundMessageService {
  private validateProviderOutboundCommand(channel: string, command: OutboundCommand) {
    if (channel === "viber") {
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
    const conversation = await conversationService.getById(params.conversationId);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }

    const channelEnabled = await channelSupportService.isChannelEnabled(
      String(conversation.workspaceId),
      conversation.channel
    );
    if (!channelEnabled) {
      throw new ValidationError(
        `Channel ${conversation.channel} is disabled in workspace admin settings.`
      );
    }

    const connection = await channelConnectionService.getConnectionByWorkspaceAndChannel({
      workspaceId: String(conversation.workspaceId),
      channel: conversation.channel,
      externalAccountId: conversation.channelAccountId,
      requireActive: false,
    });

    if (connection.status !== "active") {
      throw new ValidationError(
        `Channel connection is ${connection.status}. Complete provider setup before sending.`
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

    const canonicalMessage: CanonicalMessage = {
      channel: conversation.channel,
      channelAccountId: conversation.channelAccountId,
      externalChatId: conversation.externalChatId,
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
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      message: canonicalMessage,
    });

    const sendResult = await adapter.sendOutbound({
      conversation: {
        externalChatId: conversation.externalChatId,
        channel: conversation.channel,
      },
      message: canonicalMessage,
      connection: {
        externalAccountId: connection.externalAccountId,
        credentials: connection.credentials ?? {},
        webhookConfig: connection.webhookConfig ?? {},
      },
    });

    const finalizedMessage = await messageService.finalizeOutboundMessage(
      String(queuedMessage._id),
      sendResult
    );

    const delivery = await messageService.createDeliveryRecord({
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      messageId: String(queuedMessage._id),
      channelConnectionId: String(connection._id),
      channel: conversation.channel,
      sendResult,
    });

    if (finalizedMessage) {
      const updatedConversation = await conversationService.applyOutboundMessage({
        conversationId: String(conversation._id),
        message: finalizedMessage,
      });

      emitRealtimeEvent(
        sendResult.status === "failed" ? "message.failed" : "message.sent",
        {
          workspaceId: String(conversation.workspaceId),
          conversationId: String(conversation._id),
          messageId: String(finalizedMessage._id),
          deliveryStatus: sendResult.status,
          error: sendResult.error,
        }
      );

      emitRealtimeEvent("conversation.updated", {
        workspaceId: String(conversation.workspaceId),
        conversationId: String(conversation._id),
        status: updatedConversation?.status ?? conversation.status,
      });
    }

    if (sendResult.status === "failed") {
      await channelConnectionService.markConnectionError(
        String(connection._id),
        sendResult.error ?? "Provider send failed"
      );
    } else {
      await channelConnectionService.markOutboundSent(String(connection._id));
    }

    await auditLogService.record({
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      messageId: String(queuedMessage._id),
      actorType: params.command.senderType,
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
      message: finalizedMessage ?? queuedMessage,
      delivery,
    };
  }
}

export const outboundMessageService = new OutboundMessageService();
