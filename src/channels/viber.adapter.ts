import axios from "axios";
import { BaseChannelAdapter } from "./base.adapter";
import { CanonicalMedia, CanonicalMessage, ChannelCapabilities } from "./types";
import { mediaAssetService } from "../services/media-asset.service";

const VIBER_INBOUND_MEDIA_TTL_MS = 60 * 60 * 1000;

const GIF_URL_REGEX = /https?:\/\/[^\s]+\.gif(?:\?[^\s]*)?/gi;

const buildTemporaryMediaMeta = () => ({
  isTemporary: true,
  expirySource: "provider_ttl" as const,
  expiresAt: new Date(Date.now() + VIBER_INBOUND_MEDIA_TTL_MS),
  lastValidatedAt: null,
});

const extractGifUrls = (text?: string) => {
  if (!text) {
    return [];
  }

  const matches = text.match(GIF_URL_REGEX);
  return matches ? Array.from(new Set(matches)) : [];
};

const stripGifUrls = (text?: string) => {
  if (!text) {
    return "";
  }

  return text.replace(GIF_URL_REGEX, " ").replace(/\s+/g, " ").trim();
};

type ViberPayload = {
  event?: string;
  timestamp?: number;
  message_token?: string | number;
  sender?: {
    id: string;
    name?: string;
    avatar?: string;
  };
  message?: {
    type?: string;
    text?: string;
    media?: string;
    thumbnail?: string;
    duration?: number;
    size?: number;
    file_name?: string;
    location?: {
      lat: number;
      lon: number;
    };
    contact?: {
      name?: string;
      phone_number?: string;
    };
  };
  user?: {
    id: string;
    name?: string;
    avatar?: string;
  };
};

export class ViberAdapter extends BaseChannelAdapter {
  channel = "viber" as const;

  private resolveOutboundMediaUrl(media?: CanonicalMedia) {
    const storedAssetId = String(media?.storedAssetId ?? "").trim();
    if (storedAssetId) {
      return mediaAssetService.createSignedContentUrl(storedAssetId, {
        absolute: true,
      });
    }

    return media?.storedAssetUrl ?? media?.url;
  }

  async verifyWebhook(input: {
    rawBody?: string;
    headers: Record<string, string>;
    connection?: {
      credentials: Record<string, unknown>;
    };
  }) {
    return this.matchesSignature({
      algorithm: "sha256",
      secret: String(input.connection?.credentials.authToken ?? ""),
      rawBody: input.rawBody,
      provided: input.headers["x-viber-content-signature"],
    });
  }

  getCapabilities(): ChannelCapabilities {
    return {
      inbound: {
        text: true,
        image: true,
        video: true,
        audio: false,
        file: true,
        location: true,
        contact: true,
        interactive: true,
      },
      outbound: {
        text: true,
        image: true,
        video: true,
        audio: false,
        file: true,
        sticker: true,
        location: true,
        contact: true,
        interactive: true,
      },
    };
  }

  async parseInbound(reqBody: unknown): Promise<CanonicalMessage[]> {
    const body = reqBody as ViberPayload;
    const sender = body.sender ?? body.user;
    if (!sender?.id) {
      return [];
    }

    const base = {
      channel: this.channel,
      direction: "inbound" as const,
      senderType: body.event === "conversation_started" ? ("system" as const) : ("customer" as const),
      externalMessageId: body.message_token ? String(body.message_token) : undefined,
      externalChatId: sender.id,
      externalSenderId: sender.id,
      senderProfile: {
        displayName: sender.name,
        avatar: sender.avatar,
      },
      raw: body,
      occurredAt: body.timestamp ? new Date(body.timestamp) : new Date(),
    };

    if (body.event === "conversation_started") {
      return [
        {
          ...base,
          kind: "system",
          text: {
            body: `${sender.name ?? "Customer"} started a Viber conversation`,
            plain: `${sender.name ?? "Customer"} started a Viber conversation`,
          },
        },
      ];
    }

    const message = body.message;
    if (!message) {
      return [];
    }

    if (message.type === "text" && message.text) {
      const gifUrls = extractGifUrls(message.text);
      if (gifUrls.length > 0) {
        const caption = stripGifUrls(message.text);
        return [
          {
            ...base,
            senderType: "customer",
            kind: "image",
            ...(caption
              ? {
                  text: {
                    body: caption,
                    plain: caption,
                  },
                }
              : {}),
            media: gifUrls.map((url) => ({
              url,
              mimeType: "image/gif",
              ...buildTemporaryMediaMeta(),
            })),
          },
        ];
      }

      return [
        {
          ...base,
          senderType: "customer",
          kind: "text",
          text: {
            body: message.text,
            plain: message.text,
          },
        },
      ];
    }

    if (message.type === "picture") {
      return [
        {
          ...base,
          senderType: "customer",
          kind: "image",
          media: [
            {
              url: message.media,
              thumbnailUrl: message.thumbnail,
              size: message.size,
              ...buildTemporaryMediaMeta(),
            },
          ],
        },
      ];
    }

    if (message.type === "video") {
      return [
        {
          ...base,
          senderType: "customer",
          kind: "video",
          media: [
            {
              url: message.media,
              thumbnailUrl: message.thumbnail,
              size: message.size,
              ...buildTemporaryMediaMeta(),
              durationMs: message.duration ? message.duration * 1000 : undefined,
            },
          ],
        },
      ];
    }

    if (message.type === "file") {
      return [
        {
          ...base,
          senderType: "customer",
          kind: "file",
          media: [
            {
              url: message.media,
              ...buildTemporaryMediaMeta(),
              filename: message.file_name,
              size: message.size,
            },
          ],
        },
      ];
    }

    if (message.type === "location" && message.location) {
      return [
        {
          ...base,
          senderType: "customer",
          kind: "location",
          location: {
            lat: message.location.lat,
            lng: message.location.lon,
          },
        },
      ];
    }

    if (message.type === "contact" && message.contact) {
      return [
        {
          ...base,
          senderType: "customer",
          kind: "contact",
          contact: {
            name: message.contact.name,
            phone: message.contact.phone_number,
          },
        },
      ];
    }

    if (message.type === "sticker" && message.media) {
      return [
        {
          ...base,
          senderType: "customer",
          kind: "image",
          media: [
            {
              url: message.media,
              size: message.size,
              ...buildTemporaryMediaMeta(),
            },
          ],
        },
      ];
    }

    return [
      this.buildUnsupportedMessage(
        {
          ...base,
          senderType: "customer",
        },
        "Viber payload type is not mapped in MVP"
      ),
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
    let request: Record<string, unknown> = {
      receiver: input.conversation.externalChatId,
      type: "text",
      text: input.message.text?.body ?? "",
    };

    if (input.message.kind === "image") {
      const mediaUrl = this.resolveOutboundMediaUrl(input.message.media?.[0]);
      request = {
        receiver: input.conversation.externalChatId,
        type: "picture",
        text: input.message.text?.body ?? "",
        media: mediaUrl,
        thumbnail: input.message.media?.[0]?.thumbnailUrl ?? mediaUrl,
      };
    } else if (input.message.kind === "video") {
      request = {
        receiver: input.conversation.externalChatId,
        type: "video",
        text: input.message.text?.body,
        media: this.resolveOutboundMediaUrl(input.message.media?.[0]),
        size: input.message.media?.[0]?.size,
        duration: input.message.media?.[0]?.durationMs
          ? Math.round(input.message.media[0].durationMs / 1000)
          : undefined,
        thumbnail: input.message.media?.[0]?.thumbnailUrl,
      };
    } else if (input.message.kind === "file") {
      request = {
        receiver: input.conversation.externalChatId,
        type: "file",
        media: this.resolveOutboundMediaUrl(input.message.media?.[0]),
        size: input.message.media?.[0]?.size,
        file_name: input.message.media?.[0]?.filename,
      };
    } else if (input.message.kind === "location") {
      request = {
        receiver: input.conversation.externalChatId,
        type: "location",
        location: {
          lat: input.message.location?.lat,
          lon: input.message.location?.lng,
        },
      };
    } else if (input.message.kind === "contact") {
      request = {
        receiver: input.conversation.externalChatId,
        type: "contact",
        contact: {
          name: input.message.contact?.name,
          phone_number: input.message.contact?.phone,
        },
      };
    } else if (input.message.kind === "interactive") {
      if (input.message.interactive?.subtype === "rich_media") {
        request = {
          receiver: input.conversation.externalChatId,
          type: "rich_media",
          rich_media: input.message.interactive.payload,
        };
      } else {
        request = {
          receiver: input.conversation.externalChatId,
          type: "url",
          media:
            input.message.interactive?.value ??
            input.message.text?.body ??
            this.resolveOutboundMediaUrl(input.message.media?.[0]),
        };
      }
    } else if (input.message.kind === "sticker") {
      const stickerId = Number(String(input.message.meta?.platformStickerId ?? "").trim());
      request = {
        receiver: input.conversation.externalChatId,
        type: "sticker",
        sticker_id: Number.isFinite(stickerId) ? stickerId : undefined,
      };
    }

    const authToken = String(input.connection.credentials.authToken ?? "");
    if (!authToken) {
      return {
        status: "failed" as const,
        error: "Missing Viber auth token",
        request,
      };
    }

    try {
      const response = await axios.post(
        "https://chatapi.viber.com/pa/send_message",
        request,
        {
          headers: {
            "X-Viber-Auth-Token": authToken,
          },
        }
      );

      const providerStatus = response.data?.status;
      const providerMessage = response.data?.status_message;
      return {
        externalMessageId: String(response.data?.message_token ?? ""),
        status: providerStatus === 0 ? ("sent" as const) : ("failed" as const),
        raw: response.data,
        error:
          providerStatus === 0
            ? undefined
            : `Viber send_message failed (status=${typeof providerStatus === "number" ? providerStatus : "unknown"}): ${providerMessage || "unknown error"}`,
        request,
      };
    } catch (error) {
      return this.buildFailedSendResult(error, request);
    }
  }
}
