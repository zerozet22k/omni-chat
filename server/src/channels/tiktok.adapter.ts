import { BaseChannelAdapter } from "./base.adapter";
import { CanonicalMessage, ChannelCapabilities } from "./types";
import { tiktokBusinessMessagingService } from "../services/tiktok-business-messaging.service";

type TikTokWebhookEnvelope = {
  client_key?: string;
  event?: string;
  create_time?: number;
  user_openid?: string;
  content?: string;
};

type TikTokWebhookContent = {
  from?: string;
  to?: string;
  unique_identifier?: string;
  conversation_id?: string;
  message_id?: string;
  timestamp?: number;
  type?: string;
  text?: {
    body?: string;
  };
  image?: {
    media_id?: string;
  };
  video?: {
    media_id?: string;
  };
  emoji?: {
    url?: string;
  };
  sticker?: {
    url?: string;
  };
  share_post?: {
    embed_url?: string;
    video_id?: string;
  };
  template?: {
    type?: string;
    title?: string;
    buttons?: Array<{
      type?: string;
      title?: string;
      id?: string;
    }>;
  };
  reaction?: Array<{
    emoji?: string;
    type?: string;
    ai_emoji_url?: string;
    operation?: string;
  }>;
  referenced_message_info?: {
    referenced_message_id?: string;
  };
  from_user?: {
    id?: string;
    role?: string;
  };
  to_user?: {
    id?: string;
    role?: string;
  };
  scene_type?: number;
  is_follower?: boolean;
  auto_message_type?: string;
  message_tag?: {
    source?: string;
  };
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const parseContent = (value: unknown): TikTokWebhookContent | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as TikTokWebhookContent;
  } catch {
    return null;
  }
};

const normalizeRole = (value: unknown) => trimString(value).toLowerCase();

export class TikTokAdapter extends BaseChannelAdapter {
  channel = "tiktok" as const;

  async verifyWebhook(input: {
    rawBody?: string;
    headers: Record<string, string>;
  }) {
    return tiktokBusinessMessagingService.verifyWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.headers["tiktok-signature"],
    });
  }

  getCapabilities(): ChannelCapabilities {
    return {
      inbound: {
        text: true,
        image: true,
        video: true,
        audio: false,
        file: false,
        sticker: true,
        location: false,
        contact: false,
        interactive: true,
      },
      outbound: {
        text: true,
        image: true,
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
    const body = reqBody as TikTokWebhookEnvelope;
    const event = trimString(body.event);
    if (!event || !body.user_openid) {
      return [];
    }

    if (event === "im_receive_msg_eu") {
      return [];
    }

    if (event !== "im_receive_msg") {
      return [];
    }

    const content = parseContent(body.content);
    if (!content?.conversation_id || !content.message_id) {
      return [];
    }

    const fromRole = normalizeRole(content.from_user?.role);
    const toRole = normalizeRole(content.to_user?.role);
    const isInboundFromCustomer =
      fromRole === "personal_account" || toRole === "business_account";
    const occurredAt = content.timestamp ? new Date(content.timestamp) : new Date();
    const referencedMessageId = trimString(
      content.referenced_message_info?.referenced_message_id
    );
    const baseMeta = {
      providerEvent: event,
      providerMessageType: trimString(content.type).toUpperCase() || "TEXT",
      providerSource: trimString(content.message_tag?.source).toUpperCase() || null,
      sceneType:
        typeof content.scene_type === "number" ? content.scene_type : undefined,
      isFollower:
        typeof content.is_follower === "boolean" ? content.is_follower : undefined,
      autoMessageType: trimString(content.auto_message_type).toUpperCase() || null,
      ...(referencedMessageId ? { referencedMessageId } : {}),
    };

    const baseMessage = {
      channel: this.channel,
      direction: "inbound" as const,
      senderType: "customer" as const,
      externalMessageId: content.message_id,
      externalChatId: content.conversation_id,
      externalSenderId:
        trimString(content.unique_identifier) ||
        (isInboundFromCustomer ? trimString(content.from_user?.id) : "") ||
        undefined,
      senderProfile: {
        displayName: trimString(content.from) || "TikTok user",
        username: trimString(content.from) || undefined,
      },
      raw: reqBody,
      occurredAt,
      meta: {
        ...baseMeta,
        businessId: trimString(body.user_openid),
      },
    };

    const messageType = trimString(content.type).toLowerCase();
    if (messageType === "text") {
      const textBody = trimString(content.text?.body);
      return [
        {
          ...baseMessage,
          kind: "text",
          text: {
            body: textBody,
            plain: textBody,
          },
        },
      ];
    }

    if (messageType === "image") {
      return [
        {
          ...baseMessage,
          kind: "image",
          media: [
            {
              providerFileId: trimString(content.image?.media_id),
            },
          ],
        },
      ];
    }

    if (messageType === "video") {
      return [
        {
          ...baseMessage,
          kind: "video",
          media: [
            {
              providerFileId: trimString(content.video?.media_id),
              mimeType: "video/mp4",
            },
          ],
        },
      ];
    }

    if (messageType === "emoji") {
      return [
        {
          ...baseMessage,
          kind: "image",
          media: [
            {
              url: trimString(content.emoji?.url),
            },
          ],
          meta: {
            ...baseMeta,
            providerMessageType: "EMOJI",
            businessId: trimString(body.user_openid),
          },
        },
      ];
    }

    if (messageType === "sticker") {
      return [
        {
          ...baseMessage,
          kind: "sticker",
          media: [
            {
              url: trimString(content.sticker?.url),
            },
          ],
        },
      ];
    }

    if (messageType === "share_post") {
      const embedUrl = trimString(content.share_post?.embed_url);
      const label = embedUrl
        ? `Shared a TikTok post\n${embedUrl}`
        : "Shared a TikTok post";

      return [
        {
          ...baseMessage,
          kind: "interactive",
          text: {
            body: label,
            plain: label,
          },
          interactive: {
            subtype: "tiktok_share_post",
            label: "Shared a TikTok post",
            value: embedUrl || trimString(content.share_post?.video_id),
            payload: content.share_post,
          },
        },
      ];
    }

    if (messageType === "template") {
      const title = trimString(content.template?.title) || "TikTok template";
      const buttonTitles = (content.template?.buttons ?? [])
        .map((button) => trimString(button.title))
        .filter((value) => value.length > 0);
      const bodyText = buttonTitles.length
        ? `${title}\n${buttonTitles.join(" | ")}`
        : title;

      return [
        {
          ...baseMessage,
          kind: "interactive",
          text: {
            body: bodyText,
            plain: bodyText,
          },
          interactive: {
            subtype: "tiktok_template",
            label: title,
            value: trimString(content.template?.type),
            payload: content.template,
          },
        },
      ];
    }

    if (messageType === "reaction") {
      const reactions = (content.reaction ?? [])
        .map((item) => trimString(item.emoji))
        .filter((value) => value.length > 0);
      const bodyText = reactions.length
        ? `Reacted with ${reactions.join(" ")}`
        : "Reacted to a message";

      return [
        {
          ...baseMessage,
          kind: "system",
          text: {
            body: bodyText,
            plain: bodyText,
          },
          meta: {
            ...baseMeta,
            businessId: trimString(body.user_openid),
            reactions: content.reaction ?? [],
          },
        },
      ];
    }

    return [
      this.buildUnsupportedMessage(baseMessage, "TikTok message type is not mapped"),
    ];
  }

  async sendOutbound(input: {
    conversation: { externalChatId: string; channel: "tiktok" };
    message: CanonicalMessage;
    connection: {
      externalAccountId: string;
      credentials: Record<string, unknown>;
      webhookConfig: Record<string, unknown>;
    };
  }) {
    return tiktokBusinessMessagingService.sendOutbound({
      externalChatId: input.conversation.externalChatId,
      message: input.message,
      credentials: input.connection.credentials,
    });
  }
}
