import { randomUUID } from "crypto";
import { BaseChannelAdapter } from "./base.adapter";
import { CanonicalMessage, ChannelCapabilities } from "./types";

type WebsiteInboundPayload = {
  eventId?: string;
  occurredAt?: string | number;
  visitorId?: string;
  sessionId?: string;
  senderName?: string;
  senderEmail?: string;
  text?: string;
  message?: string;
  channelAccountId?: string;
  metadata?: Record<string, unknown>;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export class WebsiteAdapter extends BaseChannelAdapter {
  channel = "website" as const;

  getCapabilities(): ChannelCapabilities {
    return {
      inbound: {
        text: true,
        image: false,
        video: false,
        audio: false,
        file: false,
        location: false,
        contact: true,
        interactive: false,
      },
      outbound: {
        text: true,
        image: false,
        video: false,
        audio: false,
        file: false,
        sticker: false,
        location: false,
        contact: false,
        interactive: false,
      },
    };
  }

  async parseInbound(reqBody: unknown): Promise<CanonicalMessage[]> {
    const body = reqBody as WebsiteInboundPayload;
    const text = trimString(body.text) || trimString(body.message);
    if (!text) {
      return [];
    }

    const sessionId = trimString(body.sessionId);
    const visitorId = trimString(body.visitorId);
    const externalChatId = sessionId || visitorId;
    if (!externalChatId) {
      return [];
    }

    const occurredAtRaw = body.occurredAt;
    const occurredAt =
      typeof occurredAtRaw === "number"
        ? new Date(occurredAtRaw)
        : typeof occurredAtRaw === "string" && occurredAtRaw.trim()
          ? new Date(occurredAtRaw)
          : new Date();

    const senderName = trimString(body.senderName);
    const senderEmail = trimString(body.senderEmail);

    return [
      {
        channel: this.channel,
        channelAccountId: trimString(body.channelAccountId) || undefined,
        externalMessageId: trimString(body.eventId) || randomUUID(),
        externalChatId,
        externalSenderId: visitorId || externalChatId,
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: {
          body: text,
          plain: text,
        },
        contact: senderEmail
          ? {
              name: senderName || undefined,
              phone: senderEmail,
            }
          : senderName
            ? { name: senderName }
            : undefined,
        senderProfile: senderName
          ? {
              displayName: senderName,
            }
          : undefined,
        raw: body,
        meta: {
          visitorId: visitorId || undefined,
          sessionId: sessionId || undefined,
          senderEmail: senderEmail || undefined,
          ...(body.metadata && typeof body.metadata === "object"
            ? { metadata: body.metadata }
            : {}),
        },
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      },
    ];
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
    const text = trimString(input.message.text?.body);
    if (!text) {
      return {
        status: "failed" as const,
        error: "Website outbound currently supports text messages only",
      };
    }

    return {
      status: "sent" as const,
      externalMessageId: randomUUID(),
      raw: {
        channel: "website",
        note: "Website channel send acknowledged. Delivery to browser widget must be implemented by site runtime.",
        externalChatId: input.conversation.externalChatId,
      },
    };
  }
}
