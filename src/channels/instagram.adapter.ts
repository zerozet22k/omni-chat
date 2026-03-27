import axios from "axios";
import { BaseChannelAdapter } from "./base.adapter";
import { CanonicalMessage, ChannelCapabilities } from "./types";
import { env } from "../config/env";
import { logger } from "../lib/logger";

type InstagramWebhook = {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        quick_reply?: { payload?: string };
        attachments?: Array<{
          type?: string;
          payload?: Record<string, unknown> & {
            url?: string;
            coordinates?: {
              lat?: number;
              long?: number;
            };
          };
        }>;
      };
      postback?: {
        title?: string;
        payload?: string;
      };
      delivery?: Record<string, unknown>;
      read?: Record<string, unknown>;
    }>;
  }>;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const buildSyntheticMessageId = (
  prefix: string,
  accountId: string,
  senderId: string,
  timestamp?: number,
  payload?: string
) => {
  const normalizedPayload = trimString(payload) || "event";
  return `${prefix}:${accountId}:${senderId}:${timestamp ?? Date.now()}:${normalizedPayload}`;
};

export class InstagramAdapter extends BaseChannelAdapter {
  channel = "instagram" as const;

  async verifyWebhook(input: {
    rawBody?: string;
    headers: Record<string, string>;
  }) {
    const appSecret = trimString(env.META_APP_SECRET);
    if (!appSecret || !input.rawBody) {
      return false;
    }

    return this.matchesSignature({
      algorithm: "sha256",
      secret: appSecret,
      rawBody: input.rawBody,
      provided: input.headers["x-hub-signature-256"],
      prefix: "sha256=",
    });
  }

  getCapabilities(): ChannelCapabilities {
    return {
      inbound: {
        text: true,
        image: true,
        video: true,
        audio: true,
        file: true,
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
        location: false,
        contact: false,
        interactive: false,
      },
    };
  }

  async parseInbound(reqBody: unknown): Promise<CanonicalMessage[]> {
    const body = reqBody as InstagramWebhook;
    if (body.object !== "instagram") {
      logger.warn("Instagram inbound ignored due to unexpected object type", {
        object: body.object || null,
      });
      return [];
    }

    const messages: CanonicalMessage[] = [];

    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const senderId = trimString(event.sender?.id);
        const recipientAccountId = trimString(event.recipient?.id);
        const accountId = trimString(entry.id) || recipientAccountId;

        if (!senderId || !recipientAccountId || !accountId) {
          continue;
        }

        if (event.delivery || event.read || event.message?.is_echo) {
          continue;
        }

        const externalMessageId =
          trimString(event.message?.mid) ||
          (event.postback
            ? buildSyntheticMessageId(
                "ig-postback",
                accountId,
                senderId,
                event.timestamp,
                event.postback.payload ?? event.postback.title
              )
            : event.message?.quick_reply?.payload
              ? buildSyntheticMessageId(
                  "ig-quick-reply",
                  accountId,
                  senderId,
                  event.timestamp,
                  event.message.quick_reply.payload
                )
              : undefined);

        const base = {
          channel: this.channel,
          channelAccountId: accountId,
          direction: "inbound" as const,
          senderType: "customer" as const,
          externalMessageId,
          externalChatId: senderId,
          externalSenderId: senderId,
          raw: event,
          occurredAt: event.timestamp ? new Date(event.timestamp) : new Date(),
          meta: {
            accountId,
            recipientAccountId,
            senderId,
          },
        };

        if (event.message?.quick_reply?.payload) {
          messages.push({
            ...base,
            kind: "interactive",
            text: {
              body: event.message.text ?? event.message.quick_reply.payload,
              plain: event.message.text ?? event.message.quick_reply.payload,
            },
            interactive: {
              subtype: "quick_reply",
              label: event.message.text,
              value: event.message.quick_reply.payload,
              payload: event.message.quick_reply.payload,
            },
          });
          continue;
        }

        if (event.postback?.payload) {
          messages.push({
            ...base,
            kind: "interactive",
            text: {
              body: event.postback.title ?? event.postback.payload,
              plain: event.postback.title ?? event.postback.payload,
            },
            interactive: {
              subtype: "postback",
              label: event.postback.title,
              value: event.postback.payload,
              payload: event.postback.payload,
            },
          });
          continue;
        }

        if (event.message?.text) {
          messages.push({
            ...base,
            kind: "text",
            text: {
              body: event.message.text,
              plain: event.message.text,
            },
          });
          continue;
        }

        const attachments = event.message?.attachments ?? [];
        if (!attachments.length) {
          continue;
        }

        if (
          attachments.length === 1 &&
          trimString(attachments[0]?.type).toLowerCase() === "location" &&
          attachments[0].payload?.coordinates?.lat !== undefined &&
          attachments[0].payload?.coordinates?.long !== undefined
        ) {
          messages.push({
            ...base,
            kind: "location",
            location: {
              lat: attachments[0].payload.coordinates.lat,
              lng: attachments[0].payload.coordinates.long,
            },
          });
          continue;
        }

        const attachmentType = trimString(attachments[0]?.type).toLowerCase();
        const allSameType = attachments.every(
          (attachment) => trimString(attachment.type).toLowerCase() === attachmentType
        );

        if (
          allSameType &&
          (attachmentType === "image" ||
            attachmentType === "video" ||
            attachmentType === "audio" ||
            attachmentType === "file")
        ) {
          const kind =
            attachmentType === "image"
              ? "image"
              : attachmentType === "video"
                ? "video"
                : attachmentType === "audio"
                  ? "audio"
                  : "file";

          messages.push({
            ...base,
            kind,
            media: attachments
              .map((attachment) => ({
                url: trimString(attachment.payload?.url) || undefined,
              }))
              .filter((item) => item.url),
          });
          continue;
        }

        messages.push(
          this.buildUnsupportedMessage(
            base,
            allSameType
              ? `Instagram attachment type ${attachmentType || "unknown"} is not mapped`
              : "Instagram attachment batch mixes unsupported media types"
          )
        );
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
    const request = {
      messaging_type: "RESPONSE",
      recipient: { id: input.conversation.externalChatId },
      message: {
        text: input.message.text?.body ?? "",
      },
    };

    const accessToken = trimString(input.connection.credentials.instagramAccessToken);
    if (!accessToken) {
      return {
        status: "failed" as const,
        error: "Missing Instagram access token",
        request,
      };
    }

    try {
      const response = await axios.post(
        "https://graph.facebook.com/v19.0/me/messages",
        request,
        {
          params: {
            access_token: accessToken,
          },
        }
      );

      return {
        externalMessageId: trimString(response.data?.message_id) || undefined,
        status: "sent" as const,
        raw: response.data,
        request,
      };
    } catch (error) {
      return this.buildFailedSendResult(error, request);
    }
  }
}
