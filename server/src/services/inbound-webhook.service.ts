import axios from "axios";
import { adapterRegistry } from "../channels/adapter.registry";
import { CanonicalChannel, CanonicalMedia, CanonicalMessage } from "../channels/types";
import { auditLogService } from "./audit-log.service";
import { channelConnectionService } from "./channel-connection.service";
import { contactService } from "./contact.service";
import { conversationService } from "./conversation.service";
import { messageService } from "./message.service";
import { automationService } from "./automation.service";
import { inboundBufferService } from "./inbound-buffer.service";
import { ForbiddenError } from "../lib/errors";
import { emitRealtimeEvent } from "../lib/realtime";

type HeaderMap = Record<string, string>;

const normalizeHeaders = (headers: Record<string, unknown>): HeaderMap => {
  return Object.entries(headers).reduce<HeaderMap>((acc, [key, value]) => {
    if (typeof value === "string") {
      acc[key.toLowerCase()] = value;
    }
    return acc;
  }, {});
};

class InboundWebhookService {
  async handle(params: {
    channel: CanonicalChannel;
    body: unknown;
    rawBody?: string;
    headers: Record<string, unknown>;
    query: Record<string, string | string[] | undefined>;
  }) {
    const headers = normalizeHeaders(params.headers);
    const connection = await this.resolveConnection(
      params.channel,
      params.body,
      headers,
      params.query
    );

    const adapter = adapterRegistry.get(params.channel);
    try {
      if (adapter.verifyWebhook) {
        const isValid = await adapter.verifyWebhook({
          body: params.body,
          rawBody: params.rawBody,
          headers,
          query: params.query,
          connection: {
            externalAccountId: connection.externalAccountId,
            credentials: connection.credentials ?? {},
            webhookConfig: connection.webhookConfig ?? {},
            webhookUrl: connection.webhookUrl,
            webhookVerified: connection.webhookVerified,
            verificationState: connection.verificationState,
          },
        });

        if (!isValid) {
          throw new ForbiddenError("Webhook verification failed");
        }
      }

      await auditLogService.record({
        workspaceId: String(connection.workspaceId),
        actorType: "system",
        eventType: "webhook.received",
        data: {
          channel: params.channel,
          raw: params.body as Record<string, unknown>,
          webhookUrl: connection.webhookUrl,
          connectionKey:
            typeof connection.webhookConfig?.connectionKey === "string"
              ? connection.webhookConfig.connectionKey
              : undefined,
        },
      });

      const normalized = await adapter.parseInbound(params.body, headers);
      const enrichedMessages =
        params.channel === "telegram"
          ? await this.enrichTelegramMediaUrls(normalized, connection.credentials ?? {})
          : normalized;
      const processed = [];

      for (const item of enrichedMessages) {
        const message = {
          ...item,
          channel: params.channel,
          channelAccountId: item.channelAccountId ?? connection.externalAccountId,
        };

        const contact = await contactService.upsertFromMessage(
          String(connection.workspaceId),
          message
        );

        const conversation = await conversationService.findOrCreateInbound({
          workspaceId: String(connection.workspaceId),
          connection: {
            channel: connection.channel,
            externalAccountId: connection.externalAccountId,
          },
          message,
          contactId: contact ? String(contact._id) : null,
        });

        const stored = await messageService.createInboundMessage({
          workspaceId: String(connection.workspaceId),
          conversationId: String(conversation._id),
          message,
        });

        if (stored.created) {
          const updatedConversation = await conversationService.applyInboundMessage({
            conversationId: String(conversation._id),
            message: stored.message,
          });

          emitRealtimeEvent("message.received", {
            workspaceId: String(connection.workspaceId),
            conversationId: String(conversation._id),
            messageId: String(stored.message._id),
            direction: stored.message.direction,
            senderType: stored.message.senderType,
            kind: stored.message.kind,
          });

          emitRealtimeEvent("conversation.updated", {
            workspaceId: String(connection.workspaceId),
            conversationId: String(conversation._id),
            status: updatedConversation?.status ?? conversation.status,
          });

          if (
            message.direction === "inbound" &&
            message.senderType === "customer" &&
            message.kind === "text"
          ) {
            await inboundBufferService.enqueueInboundText({
              workspaceId: String(connection.workspaceId),
              conversationId: String(conversation._id),
              conversationAiState: conversation.aiState,
              message,
              messageId: String(stored.message._id),
            });
            await inboundBufferService.flushPendingBuffers();
          } else {
            await inboundBufferService.flushPendingForConversation(String(conversation._id));
            await automationService.handleInbound({
              workspaceId: String(connection.workspaceId),
              conversationId: String(conversation._id),
              message,
            });
          }
        }

        processed.push({
          conversation,
          message: stored.message,
          created: stored.created,
        });
      }

      await channelConnectionService.markInboundReceived(String(connection._id));

      return {
        connection,
        processed,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Inbound webhook processing failed";

      await channelConnectionService.markConnectionError(
        String(connection._id),
        errorMessage
      );

      await auditLogService.record({
        workspaceId: String(connection.workspaceId),
        actorType: "system",
        eventType: "webhook.processing.failed",
        reason: errorMessage,
        data: {
          channel: params.channel,
          webhookUrl: connection.webhookUrl,
          connectionKey:
            typeof connection.webhookConfig?.connectionKey === "string"
              ? connection.webhookConfig.connectionKey
              : undefined,
        },
      });

      throw error;
    }
  }

  private async enrichTelegramMediaUrls(
    items: CanonicalMessage[],
    credentials: Record<string, unknown>
  ) {
    const botToken = String(credentials.botToken ?? "").trim();
    if (!botToken) {
      return items;
    }

    const fileUrlCache = new Map<string, string | null>();

    const resolvedItems = await Promise.all(
      items.map(async (item) => {
        if (!item.media?.length) {
          return item;
        }

        const enrichedMedia = await Promise.all(
          item.media.map((entry) => this.enrichTelegramMediaEntry(entry, botToken, fileUrlCache))
        );

        return {
          ...item,
          media: enrichedMedia,
        };
      })
    );

    return resolvedItems;
  }

  private async enrichTelegramMediaEntry(
    media: CanonicalMedia,
    botToken: string,
    fileUrlCache: Map<string, string | null>
  ): Promise<CanonicalMedia> {
    if (media.url || media.storedAssetUrl || !media.providerFileId) {
      return media;
    }

    const providerFileId = media.providerFileId;
    if (!fileUrlCache.has(providerFileId)) {
      const url = await this.resolveTelegramFileUrl(botToken, providerFileId);
      fileUrlCache.set(providerFileId, url);
    }

    const resolvedUrl = fileUrlCache.get(providerFileId) ?? null;
    if (!resolvedUrl) {
      return media;
    }

    return {
      ...media,
      url: resolvedUrl,
    };
  }

  private async resolveTelegramFileUrl(botToken: string, fileId: string) {
    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${botToken}/getFile`,
        {
          params: {
            file_id: fileId,
          },
          timeout: 10000,
        }
      );

      const filePath = response.data?.result?.file_path;
      if (!filePath || typeof filePath !== "string") {
        return null;
      }

      return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    } catch {
      return null;
    }
  }

  private async resolveConnection(
    channel: CanonicalChannel,
    body: unknown,
    headers: HeaderMap,
    query: Record<string, string | string[] | undefined>
  ) {
    if (channel === "facebook") {
      const payload = body as { entry?: Array<{ id?: string }> };
      const pageId = payload.entry?.[0]?.id;
      if (!pageId) {
        throw new Error("Missing Facebook page id in webhook payload");
      }
      return channelConnectionService.resolveFacebookConnection(pageId);
    }

    if (channel === "telegram") {
      const secret = headers["x-telegram-bot-api-secret-token"];
      if (!secret) {
        throw new Error("Missing Telegram webhook secret");
      }
      return channelConnectionService.resolveTelegramConnection(secret);
    }

    if (channel === "viber") {
      const key = Array.isArray(query.connectionKey)
        ? query.connectionKey[0]
        : query.connectionKey;
      return channelConnectionService.resolveViberConnection(key);
    }

    const payload =
      typeof body === "object" && body !== null
        ? (body as { user_openid?: unknown })
        : {};
    return channelConnectionService.resolveTikTokConnection(
      typeof payload.user_openid === "string" ? payload.user_openid : undefined
    );
  }
}

export const inboundWebhookService = new InboundWebhookService();
