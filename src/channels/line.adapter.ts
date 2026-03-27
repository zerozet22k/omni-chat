import { createHmac, timingSafeEqual } from "crypto";
import axios from "axios";
import { BaseChannelAdapter } from "./base.adapter";
import { CanonicalMessage, ChannelCapabilities } from "./types";
import { logger } from "../lib/logger";

type LineWebhook = {
  destination?: string;
  events?: Array<{
    type?: string;
    timestamp?: number;
    mode?: string;
    source?: {
      type?: "user" | "group" | "room";
      userId?: string;
      groupId?: string;
      roomId?: string;
    };
    replyToken?: string;
    message?: {
      id?: string;
      type?: string;
      text?: string;
      emojis?: Array<{
        index?: number;
        length?: number;
        productId?: string;
        emojiId?: string;
      }>;
      fileName?: string;
      fileSize?: number;
      title?: string;
      address?: string;
      latitude?: number;
      longitude?: number;
      stickerId?: string;
      packageId?: string;
      stickerResourceType?: string;
      keywords?: string[];
      duration?: number;
      contentProvider?: {
        type?: string;
      };
    };
    postback?: {
      data?: string;
      params?: Record<string, unknown>;
    };
  }>;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const sourceToExternalChatId = (source?: {
  type?: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}) => {
  if (!source) {
    return "";
  }

  if (source.type === "user") {
    return trimString(source.userId);
  }

  if (source.type === "group") {
    return trimString(source.groupId);
  }

  if (source.type === "room") {
    return trimString(source.roomId);
  }

  return "";
};

const LINE_STICKER_PACKS: Record<string, string> = {
  "11537": "Brown, Cony & Sally: Animated Special",
  "11538": "CHOCO & Friends: Animated Special",
};

const buildLineStickerStoreUrl = (packageId: string) =>
  `https://store.line.me/stickershop/product/${packageId}/en`;

export class LineAdapter extends BaseChannelAdapter {
  channel = "line" as const;

  async verifyWebhook(input: {
    rawBody?: string;
    headers: Record<string, string>;
    connection?: {
      credentials: Record<string, unknown>;
    };
  }) {
    const channelSecret = trimString(input.connection?.credentials.channelSecret);
    const providedSignature = trimString(input.headers["x-line-signature"]);

    if (!channelSecret || !providedSignature || !input.rawBody) {
      return false;
    }

    const expected = createHmac("sha256", channelSecret)
      .update(input.rawBody)
      .digest("base64");

    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(providedSignature);
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
  }

  getCapabilities(): ChannelCapabilities {
    return {
      inbound: {
        text: true,
        image: true,
        video: true,
        audio: true,
        file: true,
        sticker: true,
        location: true,
        contact: false,
        interactive: true,
      },
      outbound: {
        text: true,
        image: false,
        video: false,
        audio: false,
        file: false,
        sticker: true,
        location: false,
        contact: false,
        interactive: false,
      },
    };
  }

  async parseInbound(reqBody: unknown): Promise<CanonicalMessage[]> {
    const body = reqBody as LineWebhook;
    const destination = trimString(body.destination);
    const messages: CanonicalMessage[] = [];

    for (const event of body.events ?? []) {
      const source = event.source;
      const externalChatId = sourceToExternalChatId(source);
      if (!destination || !externalChatId) {
        continue;
      }

      const externalSenderId = trimString(source?.userId) || externalChatId;
      const occurredAt = event.timestamp ? new Date(event.timestamp) : new Date();
      const base = {
        channel: this.channel,
        channelAccountId: destination,
        direction: "inbound" as const,
        senderType: "customer" as const,
        externalMessageId: trimString(event.message?.id) || undefined,
        externalChatId,
        externalSenderId,
        raw: event,
        occurredAt,
        meta: {
          destination,
          sourceType: source?.type,
          lineUserId: trimString(source?.userId) || undefined,
          lineGroupId: trimString(source?.groupId) || undefined,
          lineRoomId: trimString(source?.roomId) || undefined,
          replyToken: trimString(event.replyToken) || undefined,
          mode: trimString(event.mode) || undefined,
        },
      };

      if (event.type === "message") {
        const messageType = trimString(event.message?.type).toLowerCase();
        const hasStickerId = !!trimString(event.message?.stickerId);
        const hasPackageId = !!trimString(event.message?.packageId);

        logger.debug("LINE message type received", {
          messageType,
          stickerId: event.message?.stickerId,
          packageId: event.message?.packageId,
          hasStickerId,
          hasPackageId,
        });

        // If message has sticker identification fields, treat as sticker regardless of type
        if (hasStickerId || hasPackageId) {
          const lineMessageId = trimString(event.message?.id);
          const stickerId = trimString(event.message?.stickerId);
          const packageId = trimString(event.message?.packageId);
          const stickerResourceType = trimString(event.message?.stickerResourceType);
          const keywords = (event.message?.keywords ?? [])
            .filter((keyword): keyword is string => typeof keyword === "string")
            .map((keyword) => keyword.trim())
            .filter(Boolean);
          const stickerStoreUrl = packageId ? buildLineStickerStoreUrl(packageId) : undefined;
          const stickerPackTitle = packageId ? LINE_STICKER_PACKS[packageId] : undefined;
          
          logger.info("LINE sticker message received (detected by stickerId/packageId)", {
            lineMessageId,
            stickerId,
            packageId,
            stickerResourceType,
            keywordCount: keywords.length,
            declaredType: messageType,
            lineStickerPreviewVerified: false,
            lineStickerPreviewImageUrl: null,
          });

          const parsed = {
            ...base,
            kind: "sticker" as const,
            media: [
              {
                providerFileId: lineMessageId || undefined,
                mimeType: "image/webp",
              },
            ],
            meta: {
              ...(base.meta ?? {}),
              lineMessageId: lineMessageId || undefined,
              platformStickerId: stickerId || undefined,
              stickerPackageId: packageId || undefined,
              lineStickerResourceType: stickerResourceType || undefined,
              lineStickerKeywords: keywords,
              lineStickerStoreUrl: stickerStoreUrl,
              lineStickerPackTitle: stickerPackTitle,
              lineStickerPreviewImageUrl: null,
              lineStickerPreviewVerified: false,
            },
          };

          logger.debug("Parsed LINE sticker message object", {
            kind: parsed.kind,
            mediaLength: parsed.media.length,
            metaKeys: Object.keys(parsed.meta),
            platformStickerId: (parsed.meta as Record<string, unknown>).platformStickerId,
            stickerPackageId: (parsed.meta as Record<string, unknown>).stickerPackageId,
          });

          messages.push(parsed);
          continue;
        }

        if (messageType === "text") {
          const text = trimString(event.message?.text);
          if (!text) {
            continue;
          }

          const emojis = (event.message?.emojis ?? [])
            .filter((emoji) => {
              return (
                typeof emoji === "object" &&
                emoji !== null &&
                typeof emoji.productId === "string" &&
                typeof emoji.emojiId === "string"
              );
            })
            .map((emoji) => ({
              index: typeof emoji.index === "number" ? emoji.index : undefined,
              length: typeof emoji.length === "number" ? emoji.length : undefined,
              productId: trimString(emoji.productId),
              emojiId: trimString(emoji.emojiId),
            }))
            .filter((emoji) => emoji.productId && emoji.emojiId);

          messages.push({
            ...base,
            kind: "text",
            text: {
              body: text,
              plain: text,
            },
            meta: {
              ...(base.meta ?? {}),
              lineTextEmojis: emojis,
            },
          });
          continue;
        }

        if (
          messageType === "image" ||
          messageType === "video" ||
          messageType === "audio" ||
          messageType === "file"
        ) {
          const kind =
            messageType === "image"
              ? "image"
              : messageType === "video"
                ? "video"
                : messageType === "audio"
                  ? "audio"
                  : "file";

          logger.warn("LINE media message received", {
            kind,
            messageType,
            messageId: event.message?.id,
          });

          messages.push({
            ...base,
            kind,
            media: [
              {
                providerFileId: trimString(event.message?.id) || undefined,
                filename: trimString(event.message?.fileName) || undefined,
                size:
                  typeof event.message?.fileSize === "number"
                    ? event.message.fileSize
                    : undefined,
                durationMs:
                  typeof event.message?.duration === "number"
                    ? event.message.duration
                    : undefined,
              },
            ],
            meta: {
              ...(base.meta ?? {}),
              lineContentProviderType: trimString(event.message?.contentProvider?.type) || undefined,
            },
          });
          continue;
        }

        if (messageType === "location") {
          const lat = event.message?.latitude;
          const lng = event.message?.longitude;
          if (typeof lat !== "number" || typeof lng !== "number") {
            continue;
          }

          messages.push({
            ...base,
            kind: "location",
            location: {
              lat,
              lng,
              label:
                trimString(event.message?.title) || trimString(event.message?.address) ||
                undefined,
            },
          });
          continue;
        }

        messages.push(
          this.buildUnsupportedMessage(base, `LINE message type ${messageType || "unknown"} is not mapped`)
        );
        continue;
      }

      if (event.type === "postback") {
        const payload = trimString(event.postback?.data);
        if (!payload) {
          continue;
        }

        messages.push({
          ...base,
          kind: "interactive",
          text: {
            body: payload,
            plain: payload,
          },
          interactive: {
            subtype: "postback",
            label: payload,
            value: payload,
            payload: {
              data: payload,
              params: event.postback?.params,
            },
          },
        });
      }
    }

    return messages;
  }

  async sendOutbound(input: {
    conversation: { externalChatId: string };
    message: CanonicalMessage;
    connection: {
      credentials: Record<string, unknown>;
      externalAccountId: string;
      webhookConfig: Record<string, unknown>;
    };
  }) {
    const channelAccessToken = trimString(input.connection.credentials.channelAccessToken);

    if (!channelAccessToken) {
      return {
        status: "failed" as const,
        error: "Missing LINE channel access token",
      };
    }

    let messages: unknown[] = [];

    if (input.message.kind === "text" && trimString(input.message.text?.body)) {
      messages = [
        {
          type: "text",
          text: input.message.text?.body ?? "",
        },
      ];
    } else if (input.message.kind === "sticker") {
      const stickerId = String(input.message.meta?.platformStickerId ?? "").trim();
      const packageId = String(input.message.meta?.stickerPackageId ?? "").trim();

      if (!stickerId || !packageId) {
        return {
          status: "failed" as const,
          error: "LINE sticker outbound requires meta.platformStickerId and meta.stickerPackageId",
        };
      }

      messages = [
        {
          type: "sticker",
          stickerId,
          packageId,
        },
      ];
    } else {
      return {
        status: "failed" as const,
        error: `LINE outbound does not support kind ${input.message.kind}`,
      };
    }

    const request = {
      to: input.conversation.externalChatId,
      messages,
    };

    try {
      await axios.post("https://api.line.me/v2/bot/message/push", request, {
        headers: {
          Authorization: `Bearer ${channelAccessToken}`,
        },
      });

      return {
        status: "sent" as const,
        request,
      };
    } catch (error) {
      return this.buildFailedSendResult(error, request);
    }
  }
}
