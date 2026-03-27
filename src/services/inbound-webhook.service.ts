import axios from "axios";
import { adapterRegistry } from "../channels/adapter.registry";
import { CanonicalChannel, CanonicalMedia, CanonicalMessage } from "../channels/types";
import { auditLogService } from "./audit-log.service";
import { attentionItemService } from "./attention-item.service";
import { channelConnectionService } from "./channel-connection.service";
import { contactService } from "./contact.service";
import { conversationService } from "./conversation.service";
import { messageService } from "./message.service";
import { automationService } from "./automation.service";
import { inboundBufferService } from "./inbound-buffer.service";
import { lineMediaTokenService } from "./line-media-token.service";
import { ForbiddenError } from "../lib/errors";
import { isHumanActiveRoutingState } from "../lib/conversation-ai-state";
import { emitRealtimeEvent } from "../lib/realtime";
import { logger } from "../lib/logger";
import { addInboundWebhookJob, type InboundWebhookJobPayload } from "../lib/queues";
import { claimEventOnce, hashIdempotencyPayload } from "../lib/redis-idempotency";

type HeaderMap = Record<string, string>;

type FacebookProfileLookup = {
  displayName?: string;
  avatar?: string;
};

type LineProfileLookup = {
  displayName?: string;
  avatar?: string;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const buildFacebookDisplayName = (profile: {
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
}) => {
  const name = typeof profile.name === "string" ? profile.name.trim() : "";
  if (name) {
    return name;
  }

  const firstName =
    typeof profile.first_name === "string" ? profile.first_name.trim() : "";
  const lastName =
    typeof profile.last_name === "string" ? profile.last_name.trim() : "";
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return joined;
};

const normalizeHeaders = (headers: Record<string, unknown>): HeaderMap => {
  return Object.entries(headers).reduce<HeaderMap>((acc, [key, value]) => {
    if (typeof value === "string") {
      acc[key.toLowerCase()] = value;
    }
    return acc;
  }, {});
};

class InboundWebhookService {
  async receive(params: {
    channel: CanonicalChannel;
    body: unknown;
    rawBody?: string;
    headers: Record<string, unknown>;
    query: Record<string, string | string[] | undefined>;
  }) {
    const eventId = this.buildWebhookEventId(params);
    const idempotencyKey = `idem:webhook:${params.channel}:${eventId}`;
    const claimed = await claimEventOnce(idempotencyKey, 60 * 60 * 24 * 7);

    if (!claimed) {
      logger.info("Duplicate inbound webhook ignored", {
        channel: params.channel,
        eventId,
      });

      return {
        duplicate: true,
        queued: false,
        processed: [],
      };
    }

    let job = null;
    try {
      job = await addInboundWebhookJob(
        {
          channel: params.channel,
          body: params.body,
          rawBody: params.rawBody,
          headers: params.headers,
          query: params.query,
          receivedAt: new Date().toISOString(),
        },
        {
          jobId: `inbound-${params.channel}-${eventId}`,
        }
      );
    } catch (error) {
      logger.warn("Inbound webhook queueing failed; falling back to inline processing", {
        channel: params.channel,
        eventId,
        error: error instanceof Error ? error.message : error,
      });
    }

    if (job) {
      return {
        duplicate: false,
        queued: true,
        processed: [],
      };
    }

    const result = await this.process(params);
    return {
      duplicate: false,
      queued: false,
      ...result,
    };
  }

  async process(params: {
    channel: CanonicalChannel;
    body: unknown;
    rawBody?: string;
    headers: Record<string, unknown>;
    query: Record<string, string | string[] | undefined>;
  }) {
    logger.info("Inbound webhook received", {
      channel: params.channel,
      hasRawBody: !!params.rawBody,
      topLevelKeys:
        typeof params.body === "object" && params.body !== null
          ? Object.keys(params.body as Record<string, unknown>).slice(0, 10)
          : [],
    });

    const headers = normalizeHeaders(params.headers);
    const connection = await this.resolveConnection(
      params.channel,
      params.body,
      headers,
      params.query
    );

    logger.info("Inbound webhook connection resolved", {
      channel: params.channel,
      connectionId: String(connection._id),
      workspaceId: String(connection.workspaceId),
      externalAccountId: connection.externalAccountId,
      status: connection.status,
      verificationState: connection.verificationState,
      webhookVerified: connection.webhookVerified,
    });

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
      logger.info("Inbound webhook normalized payload", {
        channel: params.channel,
        normalizedCount: normalized.length,
        messageKinds: normalized.map((m) => m.kind),
      });

      const normalizedWithProfiles =
        params.channel === "facebook"
          ? await this.enrichFacebookSenderProfiles(normalized, connection.credentials ?? {})
          : params.channel === "line"
            ? await this.enrichLineSenderProfiles(normalized, connection.credentials ?? {})
            : normalized;

      const normalizedWithMedia =
        params.channel === "line"
          ? await this.enrichLineMediaUrls(normalizedWithProfiles, {
              workspaceId: String(connection.workspaceId),
              channelAccountId: connection.externalAccountId,
              credentials: connection.credentials ?? {},
            })
          : normalizedWithProfiles;

      const enrichedMessages =
        params.channel === "telegram"
          ? await this.enrichTelegramMediaUrls(
              normalizedWithMedia,
              connection.credentials ?? {}
            )
          : normalizedWithMedia;
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

          const shouldBufferText =
            message.direction === "inbound" &&
            message.senderType === "customer" &&
            message.kind === "text" &&
            !isHumanActiveRoutingState(conversation.routingState);

          if (shouldBufferText) {
            await inboundBufferService.enqueueInboundText({
              workspaceId: String(connection.workspaceId),
              conversationId: String(conversation._id),
              conversationRoutingState: conversation.routingState,
              message,
              messageId: String(stored.message._id),
            });
            await inboundBufferService.flushPendingBuffers();
          } else {
            let attentionItemId: string | undefined;
            if (message.direction === "inbound" && message.senderType === "customer") {
              const attentionItem = await attentionItemService.openForInbound({
                conversationId: String(conversation._id),
                inboundMessageId: String(stored.message._id),
                openedAt: message.occurredAt ?? stored.message.createdAt,
              });
              attentionItemId = attentionItem?._id;
            }

            await inboundBufferService.flushPendingForConversation(String(conversation._id));
            await automationService.handleInbound({
              workspaceId: String(connection.workspaceId),
              conversationId: String(conversation._id),
              message,
              attentionItemId,
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

      logger.info("Inbound webhook processing completed", {
        channel: params.channel,
        connectionId: String(connection._id),
        processedCount: processed.length,
      });

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

      logger.error("Inbound webhook processing failed", {
        channel: params.channel,
        connectionId: String(connection._id),
        error: errorMessage,
      });

      throw error;
    }
  }

  private buildWebhookEventId(params: Pick<InboundWebhookJobPayload, "channel" | "body" | "rawBody">) {
    const body =
      typeof params.body === "object" && params.body !== null
        ? (params.body as Record<string, unknown>)
        : {};

    if (params.channel === "telegram" && typeof body.update_id !== "undefined") {
      return String(body.update_id);
    }

    if (params.channel === "website" && trimString(body.eventId)) {
      return trimString(body.eventId);
    }

    if (params.channel === "line") {
      const events = Array.isArray(body.events)
        ? body.events
        : [];
      const ids = events
        .map((event) => {
          if (!event || typeof event !== "object") {
            return "";
          }

          const typedEvent = event as Record<string, unknown>;
          return (
            trimString(typedEvent.webhookEventId) ||
            trimString(
              typedEvent.message && typeof typedEvent.message === "object"
                ? (typedEvent.message as Record<string, unknown>).id
                : ""
            ) ||
            hashIdempotencyPayload(typedEvent)
          );
        })
        .filter(Boolean);

      if (ids.length) {
        return ids.join(":");
      }
    }

    if (params.channel === "viber") {
      return (
        trimString(body.message_token) ||
        trimString(body.event_id) ||
        (trimString(body.event) && trimString(body.timestamp)
          ? `${trimString(body.event)}:${trimString(body.timestamp)}`
          : "") ||
        hashIdempotencyPayload(params.rawBody ?? params.body)
      );
    }

    if (params.channel === "facebook" || params.channel === "instagram") {
      const entry = Array.isArray(body.entry) ? body.entry : [];
      const fingerprint = entry.map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        const typedItem = item as Record<string, unknown>;
        const eventTime = trimString(typedItem.time);
        const entryId = trimString(typedItem.id);
        return `${entryId}:${eventTime}`.replace(/^:/, "");
      });

      if (fingerprint.some(Boolean)) {
        return fingerprint.join(":");
      }
    }

    if (params.channel === "tiktok") {
      return (
        trimString(body.event_id) ||
        trimString(body.message_id) ||
        trimString(body.server_message_id) ||
        hashIdempotencyPayload(params.rawBody ?? params.body)
      );
    }

    return hashIdempotencyPayload(params.rawBody ?? params.body);
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

  private async enrichFacebookSenderProfiles(
    items: CanonicalMessage[],
    credentials: Record<string, unknown>
  ) {
    const pageAccessToken = String(credentials.pageAccessToken ?? "").trim();
    if (!pageAccessToken || items.length === 0) {
      return items;
    }

    const psids = Array.from(
      new Set(
        items
          .map((item) => {
            const metaPsid = String(item.meta?.senderPsid ?? "").trim();
            return metaPsid || String(item.externalChatId ?? "").trim();
          })
          .filter(Boolean)
      )
    );

    logger.info("Facebook sender PSIDs received", {
      count: psids.length,
      psids,
    });

    if (psids.length === 0) {
      return items;
    }

    const profileMap = new Map<string, FacebookProfileLookup>();

    await Promise.all(
      psids.map(async (psid) => {
        try {
          logger.info("Facebook profile lookup request start", {
            psid,
          });

          const response = await axios.get(`https://graph.facebook.com/v19.0/${psid}`, {
            params: {
              fields: "name,first_name,last_name,profile_pic",
              access_token: pageAccessToken,
            },
            timeout: 10000,
          });

          const displayName = buildFacebookDisplayName(response.data ?? {});
          const avatar =
            typeof response.data?.profile_pic === "string"
              ? response.data.profile_pic.trim()
              : "";

          logger.info("Facebook profile lookup success", {
            psid,
            hasDisplayName: !!displayName,
            hasAvatar: !!avatar,
          });

          if (displayName || avatar) {
            profileMap.set(psid, {
              ...(displayName ? { displayName } : {}),
              ...(avatar ? { avatar } : {}),
            });
          }
        } catch (error) {
          logger.warn("Facebook sender profile lookup failed", {
            psid,
            error: error instanceof Error ? error.message : error,
          });
        }
      })
    );

    if (profileMap.size === 0) {
      return items;
    }

    return items.map((item) => {
      const metaPsid = String(item.meta?.senderPsid ?? "").trim();
      const key = metaPsid || String(item.externalChatId ?? "").trim();
      const profile = key ? profileMap.get(key) : undefined;

      if (!profile?.displayName) {
        return item;
      }

      return {
        ...item,
        senderProfile: {
          ...(item.senderProfile ?? {}),
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.avatar ? { avatar: profile.avatar } : {}),
        },
      };
    });
  }

  private async enrichLineSenderProfiles(
    items: CanonicalMessage[],
    credentials: Record<string, unknown>
  ) {
    const channelAccessToken = trimString(credentials.channelAccessToken);
    if (!channelAccessToken || items.length === 0) {
      return items;
    }

    const profileLookupCandidates = new Map<
      string,
      { userId: string; groupId?: string; roomId?: string }
    >();

    for (const item of items) {
      const userId =
        trimString(item.meta?.lineUserId) || trimString(item.externalSenderId);
      if (!userId) {
        continue;
      }

      const groupId = trimString(item.meta?.lineGroupId) || undefined;
      const roomId = trimString(item.meta?.lineRoomId) || undefined;
      const key = groupId
        ? `group:${groupId}:${userId}`
        : roomId
          ? `room:${roomId}:${userId}`
          : `user:${userId}`;

      if (!profileLookupCandidates.has(key)) {
        profileLookupCandidates.set(key, {
          userId,
          ...(groupId ? { groupId } : {}),
          ...(roomId ? { roomId } : {}),
        });
      }
    }

    if (!profileLookupCandidates.size) {
      return items;
    }

    const profileMap = new Map<string, LineProfileLookup>();

    await Promise.all(
      Array.from(profileLookupCandidates.entries()).map(async ([key, candidate]) => {
        const profile = await this.resolveLineProfile(candidate, channelAccessToken);
        if (profile.displayName || profile.avatar) {
          profileMap.set(key, profile);
        }
      })
    );

    if (!profileMap.size) {
      return items;
    }

    return items.map((item) => {
      const userId =
        trimString(item.meta?.lineUserId) || trimString(item.externalSenderId);
      if (!userId) {
        return item;
      }

      const groupId = trimString(item.meta?.lineGroupId) || undefined;
      const roomId = trimString(item.meta?.lineRoomId) || undefined;
      const key = groupId
        ? `group:${groupId}:${userId}`
        : roomId
          ? `room:${roomId}:${userId}`
          : `user:${userId}`;
      const profile = profileMap.get(key);

      if (!profile?.displayName && !profile?.avatar) {
        return item;
      }

      return {
        ...item,
        senderProfile: {
          ...(item.senderProfile ?? {}),
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.avatar ? { avatar: profile.avatar } : {}),
        },
      };
    });
  }

  private async enrichLineMediaUrls(
    items: CanonicalMessage[],
    params: {
      workspaceId: string;
      channelAccountId: string;
      credentials: Record<string, unknown>;
    }
  ) {
    const channelAccessToken = trimString(params.credentials.channelAccessToken);
    if (!channelAccessToken) {
      return items;
    }

    return items.map((item) => {
      // Sticker content is NOT available on the LINE content API (api-data.line.me).
      // Sticker previews use the public stickershop CDN proxy instead (built at read-time).
      const proxyKind =
        item.kind === "image" ||
        item.kind === "video" ||
        item.kind === "audio" ||
        item.kind === "file"
          ? item.kind
          : null;

      if (!proxyKind) {
        return item;
      }

      const fallbackMessageId = trimString(item.externalMessageId);
      const existingMedia = item.media ?? [];
      const mediaToEnrich =
        existingMedia.length > 0
          ? existingMedia
          : fallbackMessageId
            ? [
                {
                  providerFileId: fallbackMessageId,
                } as CanonicalMedia,
              ]
            : [];

      if (!mediaToEnrich.length) {
        return item;
      }

      const enrichedMedia = mediaToEnrich.map((media) => {
        if (media.url || media.storedAssetUrl || !media.providerFileId) {
          return media;
        }

        const messageId = trimString(media.providerFileId);
        if (!messageId) {
          return media;
        }

        const token = lineMediaTokenService.sign({
          workspaceId: params.workspaceId,
          channelAccountId: params.channelAccountId,
          messageId,
          messageKind: proxyKind,
        });

        return {
          ...media,
          url: `/api/line-media/${encodeURIComponent(token)}`,
          isTemporary: true,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
          expirySource: "provider_ttl" as const,
        };
      });

      if (item.kind !== "sticker") {
        return {
          ...item,
          media: enrichedMedia,
        };
      }

      const firstPreviewUrl = enrichedMedia[0]?.url;
      return {
        ...item,
        media: enrichedMedia,
        meta: {
          ...(item.meta ?? {}),
          lineStickerPreviewImageUrl:
            typeof firstPreviewUrl === "string" && firstPreviewUrl ? firstPreviewUrl : null,
          lineStickerPreviewVerified:
            typeof firstPreviewUrl === "string" && firstPreviewUrl ? true : false,
          lineStickerPreviewSource:
            typeof firstPreviewUrl === "string" && firstPreviewUrl
              ? "line_content_api"
              : "none",
        },
      };
    });
  }

  private async resolveLineProfile(
    params: {
      userId: string;
      groupId?: string;
      roomId?: string;
    },
    channelAccessToken: string
  ): Promise<LineProfileLookup> {
    const headers = {
      Authorization: `Bearer ${channelAccessToken}`,
    };

    const candidateUrls = [
      params.groupId
        ? `https://api.line.me/v2/bot/group/${params.groupId}/member/${params.userId}`
        : null,
      params.roomId
        ? `https://api.line.me/v2/bot/room/${params.roomId}/member/${params.userId}`
        : null,
      `https://api.line.me/v2/bot/profile/${params.userId}`,
    ].filter((value): value is string => typeof value === "string");

    for (const url of candidateUrls) {
      try {
        const response = await axios.get(url, {
          headers,
          timeout: 10000,
        });

        return {
          displayName: trimString(response.data?.displayName) || undefined,
          avatar: trimString(response.data?.pictureUrl) || undefined,
        };
      } catch {
        // Try next profile endpoint.
      }
    }

    return {};
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

    if (channel === "instagram") {
      const payload = body as { entry?: Array<{ id?: string }> };
      const accountId = payload.entry?.[0]?.id;
      if (!accountId) {
        throw new Error("Missing Instagram account id in webhook payload");
      }
      return channelConnectionService.resolveInstagramConnection(accountId);
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

    if (channel === "website") {
      const key = Array.isArray(query.connectionKey)
        ? query.connectionKey[0]
        : query.connectionKey;
      return channelConnectionService.resolveWebsiteConnection(key);
    }

    if (channel === "line") {
      const payload =
        typeof body === "object" && body !== null
          ? (body as { destination?: unknown })
          : {};
      return channelConnectionService.resolveLineConnection(
        typeof payload.destination === "string" ? payload.destination : undefined
      );
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
