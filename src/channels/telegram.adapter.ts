import { promises as fs } from "fs";
import axios from "axios";
import { BaseChannelAdapter } from "./base.adapter";
import { CanonicalMedia, CanonicalMessage, ChannelCapabilities } from "./types";
import { MediaAssetModel } from "../models";

const GIF_URL_REGEX = /https?:\/\/[^\s]+\.gif(?:\?[^\s]*)?/gi;

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

type TelegramPhoto = {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramMessagePayload = {
  message_id: number;
  date?: number;
  media_group_id?: string;
  chat: { id: number | string };
  from?: {
    id: number | string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];
  video?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    width?: number;
    height?: number;
    thumbnail?: { file_id: string };
  };
  voice?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  audio?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
  };
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    thumbnail?: { file_id: string };
  };
  poll?: {
    id?: string;
    question?: string;
    options?: Array<{
      text?: string;
      voter_count?: number;
    }>;
    total_voter_count?: number;
    is_closed?: boolean;
    is_anonymous?: boolean;
    type?: string;
    allows_multiple_answers?: boolean;
  };
  location?: {
    latitude: number;
    longitude: number;
  };
  contact?: {
    first_name?: string;
    last_name?: string;
    phone_number?: string;
  };
  sticker?: {
    file_id: string;
    width?: number;
    height?: number;
    file_size?: number;
    emoji?: string;
    is_animated?: boolean;
    is_video?: boolean;
    thumbnail?: {
      file_id: string;
      width?: number;
      height?: number;
      file_size?: number;
    };
    thumb?: {
      file_id: string;
      width?: number;
      height?: number;
      file_size?: number;
    };
  };
  animation?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    width?: number;
    height?: number;
    thumbnail?: { file_id: string };
  };
};

type TelegramUpdate = {
  message?: TelegramMessagePayload;
  edited_message?: TelegramMessagePayload;
  callback_query?: {
    id: string;
    data?: string;
    from: {
      id: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    message?: TelegramMessagePayload;
  };
};

export class TelegramAdapter extends BaseChannelAdapter {
  channel = "telegram" as const;

  private async resolveStoredAssetUpload(media?: CanonicalMedia) {
    const storedAssetId = String(media?.storedAssetId ?? "").trim();
    if (!storedAssetId) {
      return null;
    }

    const asset = await MediaAssetModel.findById(storedAssetId).lean();
    if (!asset?.storagePath) {
      return null;
    }

    const buffer = await fs.readFile(asset.storagePath);
    return {
      buffer,
      filename:
        String(media?.filename ?? "").trim() ||
        String(asset.originalFilename ?? "").trim() ||
        "upload.bin",
      mimeType:
        String(media?.mimeType ?? "").trim() ||
        String(asset.mimeType ?? "").trim() ||
        "application/octet-stream",
    };
  }

  private async sendMultipartMedia(params: {
    botToken: string;
    endpoint: string;
    fileField: string;
    file: {
      buffer: Buffer;
      filename: string;
      mimeType: string;
    };
    fields: Record<string, string | number | undefined>;
  }) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(params.fields)) {
      if (value !== undefined && value !== null && value !== "") {
        formData.append(key, String(value));
      }
    }

    formData.append(
      params.fileField,
      new Blob([Uint8Array.from(params.file.buffer)], {
        type: params.file.mimeType,
      }),
      params.file.filename
    );

    const request = {
      ...params.fields,
      [params.fileField]: params.file.filename,
    };

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${params.botToken}/${params.endpoint}`,
        {
          method: "POST",
          body: formData,
        }
      );
      const data = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            description?: string;
            result?: { message_id?: number | string };
          }
        | null;

      if (!response.ok || data?.ok === false) {
        return {
          status: "failed" as const,
          error:
            data?.description ||
            `Telegram ${params.endpoint} failed with HTTP ${response.status}`,
          raw: data,
          request,
        };
      }

      return {
        externalMessageId: String(data?.result?.message_id ?? ""),
        status: "sent" as const,
        raw: data,
        request,
      };
    } catch (error) {
      return this.buildFailedSendResult(error, request);
    }
  }

  private isGifLikeMedia(message: CanonicalMessage) {
    const media = message.media?.[0];
    const mimeType = media?.mimeType?.toLowerCase() ?? "";
    const filename = media?.filename?.toLowerCase() ?? "";
    const url = (media?.storedAssetUrl ?? media?.url ?? "").toLowerCase();
    return (
      mimeType.includes("image/gif") ||
      filename.endsWith(".gif") ||
      /\.gif(\?|$)/i.test(url)
    );
  }

  async verifyWebhook(input: {
    headers: Record<string, string>;
    connection?: {
      credentials: Record<string, unknown>;
    };
  }) {
    const provided = input.headers["x-telegram-bot-api-secret-token"];
    const expected = String(input.connection?.credentials.webhookSecret ?? "");
    return !!provided && !!expected && provided === expected;
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
        contact: true,
        interactive: true,
      },
      outbound: {
        text: true,
        image: true,
        video: true,
        audio: true,
        file: true,
        sticker: true,
        location: true,
        contact: true,
        // Explicit Telegram button/keyboard rendering is not implemented in this adapter yet.
        interactive: false,
      },
    };
  }

  async parseInbound(reqBody: unknown): Promise<CanonicalMessage[]> {
    const body = reqBody as TelegramUpdate;
    if (body.callback_query) {
      const callback = body.callback_query;
      const sourceMessage = callback.message;
      if (!sourceMessage) {
        return [];
      }

      return [
        {
          channel: this.channel,
          direction: "inbound",
          senderType: "customer",
          kind: "interactive",
          externalMessageId: callback.id,
          externalChatId: String(sourceMessage.chat.id),
          externalSenderId: String(callback.from.id),
          interactive: {
            subtype: "callback_query",
            label: callback.data,
            value: callback.data,
            payload: callback.data,
          },
          text: callback.data
            ? {
                body: callback.data,
                plain: callback.data,
              }
            : undefined,
          senderProfile: {
            displayName: [callback.from.first_name, callback.from.last_name]
              .filter(Boolean)
              .join(" ")
              .trim(),
            username: callback.from.username,
          },
          raw: callback,
          occurredAt: sourceMessage.date
            ? new Date(sourceMessage.date * 1000)
            : new Date(),
        },
      ];
    }

    const message = body.message ?? body.edited_message;
    if (!message) {
      return [];
    }

    const base = {
      channel: this.channel,
      direction: "inbound" as const,
      senderType: "customer" as const,
      externalMessageId: String(message.message_id),
      externalChatId: String(message.chat.id),
      externalSenderId: message.from ? String(message.from.id) : undefined,
      senderProfile: message.from
        ? {
            displayName: [message.from.first_name, message.from.last_name]
              .filter(Boolean)
              .join(" ")
              .trim(),
            username: message.from.username,
          }
        : undefined,
      raw: message,
      occurredAt: message.date ? new Date(message.date * 1000) : new Date(),
      text: undefined,
    };

    if (message.text) {
      const gifUrls = extractGifUrls(message.text);
      if (gifUrls.length > 0) {
        const caption = stripGifUrls(message.text);
        return [
          {
            ...base,
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
            })),
          },
        ];
      }

      return [
        {
          ...base,
          kind: "text",
          text: {
            body: message.text,
            plain: message.text,
          },
        },
      ];
    }

    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1];
      return [
        {
          ...base,
          kind: "image",
          text: message.caption
            ? { body: message.caption, plain: message.caption }
            : undefined,
          media: [
            {
              providerFileId: largest.file_id,
              width: largest.width,
              height: largest.height,
              size: largest.file_size,
            },
          ],
          meta: message.media_group_id
            ? { telegramMediaGroupId: message.media_group_id }
            : undefined,
        },
      ];
    }

    if (message.video) {
      return [
        {
          ...base,
          kind: "video",
          text: message.caption
            ? { body: message.caption, plain: message.caption }
            : undefined,
          media: [
            {
              providerFileId: message.video.file_id,
              filename: message.video.file_name,
              mimeType: message.video.mime_type,
              size: message.video.file_size,
              durationMs: message.video.duration
                ? message.video.duration * 1000
                : undefined,
              width: message.video.width,
              height: message.video.height,
            },
          ],
        },
      ];
    }

    if (message.voice) {
      return [
        {
          ...base,
          kind: "audio",
          text: message.caption
            ? { body: message.caption, plain: message.caption }
            : undefined,
          media: [
            {
              providerFileId: message.voice.file_id,
              mimeType: message.voice.mime_type,
              size: message.voice.file_size,
              durationMs: message.voice.duration
                ? message.voice.duration * 1000
                : undefined,
            },
          ],
        },
      ];
    }

    if (message.audio) {
      return [
        {
          ...base,
          kind: "audio",
          text: message.caption
            ? { body: message.caption, plain: message.caption }
            : undefined,
          media: [
            {
              providerFileId: message.audio.file_id,
              filename: message.audio.file_name,
              mimeType: message.audio.mime_type,
              size: message.audio.file_size,
              durationMs: message.audio.duration
                ? message.audio.duration * 1000
                : undefined,
            },
          ],
        },
      ];
    }

    if (message.location) {
      return [
        {
          ...base,
          kind: "location",
          location: {
            lat: message.location.latitude,
            lng: message.location.longitude,
          },
        },
      ];
    }

    if (message.contact) {
      return [
        {
          ...base,
          kind: "contact",
          contact: {
            name: [message.contact.first_name, message.contact.last_name]
              .filter(Boolean)
              .join(" ")
              .trim(),
            phone: message.contact.phone_number,
          },
        },
      ];
    }

    if (message.poll) {
      const question = message.poll.question?.trim() ?? "Untitled poll";
      const options = (message.poll.options ?? [])
        .map((option) => option.text?.trim())
        .filter((option): option is string => !!option);
      const pollText = options.length
        ? `Poll: ${question}\nOptions: ${options.join(" | ")}`
        : `Poll: ${question}`;

      return [
        {
          ...base,
          kind: "interactive",
          text: {
            body: pollText,
            plain: pollText,
          },
          interactive: {
            subtype: "poll",
            label: question,
            value: message.poll.id,
            payload: {
              id: message.poll.id,
              question,
              options: message.poll.options ?? [],
              totalVoterCount: message.poll.total_voter_count,
              isClosed: message.poll.is_closed,
              isAnonymous: message.poll.is_anonymous,
              type: message.poll.type,
              allowsMultipleAnswers: message.poll.allows_multiple_answers,
            },
          },
        },
      ];
    }

    if (message.sticker) {
      const sticker = message.sticker;
      const stickerThumbnail = sticker.thumbnail ?? sticker.thumb;
      const isAnimatedSticker = !!sticker.is_animated && !sticker.is_video;
      const useThumbnailPreview = isAnimatedSticker && !!stickerThumbnail?.file_id;
      const selectedFileId = useThumbnailPreview
        ? (stickerThumbnail?.file_id as string)
        : sticker.file_id;
      return [
        {
          ...base,
          kind: "sticker" as const,
          text: sticker.emoji ? { body: sticker.emoji, plain: sticker.emoji } : undefined,
          meta: {
            isAnimated: sticker.is_animated ?? false,
            isVideo: sticker.is_video ?? false,
            previewFromThumbnail: useThumbnailPreview,
            originalStickerFileId: sticker.file_id,
          },
          media: [
            {
              providerFileId: selectedFileId,
              width: useThumbnailPreview
                ? stickerThumbnail?.width ?? sticker.width
                : sticker.width,
              height: useThumbnailPreview
                ? stickerThumbnail?.height ?? sticker.height
                : sticker.height,
              size: useThumbnailPreview
                ? stickerThumbnail?.file_size ?? sticker.file_size
                : sticker.file_size,
              mimeType: sticker.is_video ? "video/webm" : "image/webp",
            },
          ],
        },
      ];
    }

    if (message.animation) {
      const anim = message.animation;
      return [
        {
          ...base,
          kind: "video" as const,
          text: message.caption
            ? { body: message.caption, plain: message.caption }
            : undefined,
          media: [
            {
              providerFileId: anim.file_id,
              filename: anim.file_name,
              mimeType: anim.mime_type ?? "video/mp4",
              size: anim.file_size,
              durationMs: anim.duration ? anim.duration * 1000 : undefined,
              width: anim.width,
              height: anim.height,
            },
          ],
        },
      ];
    }

    if (message.document) {
      return [
        {
          ...base,
          kind: "file",
          text: message.caption
            ? { body: message.caption, plain: message.caption }
            : undefined,
          media: [
            {
              providerFileId: message.document.file_id,
              filename: message.document.file_name,
              mimeType: message.document.mime_type,
              size: message.document.file_size,
            },
          ],
        },
      ];
    }

    return [
      this.buildUnsupportedMessage(base, "Telegram payload type is not mapped in MVP"),
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
    const botToken = String(input.connection.credentials.botToken ?? "");
    if (!botToken) {
      return {
        status: "failed" as const,
        error: "Missing Telegram bot token",
      };
    }

    const media = input.message.media?.[0];
    const mediaUrl = media?.storedAssetUrl ?? media?.url;
    const storedAssetUpload = media
      ? await this.resolveStoredAssetUpload(media)
      : null;

    let request: unknown;
    let endpoint = "sendMessage";

    if (input.message.kind === "text") {
      endpoint = "sendMessage";
      request = {
        chat_id: input.conversation.externalChatId,
        text: input.message.text?.body ?? "",
      };
    } else if (input.message.kind === "image") {
      const outboundMedia = input.message.media ?? [];
      if (!outboundMedia.length) {
        return {
          status: "failed" as const,
          error: "Telegram image outbound requires at least one media item",
        };
      }

      if (outboundMedia.length === 1 && this.isGifLikeMedia(input.message)) {
        if (storedAssetUpload) {
          return this.sendMultipartMedia({
            botToken,
            endpoint: "sendAnimation",
            fileField: "animation",
            file: storedAssetUpload,
            fields: {
              chat_id: input.conversation.externalChatId,
              caption: input.message.text?.body,
            },
          });
        }

        if (!mediaUrl) {
          return {
            status: "failed" as const,
            error: "Telegram GIF outbound requires media[0].url or media[0].storedAssetUrl",
          };
        }
        endpoint = "sendAnimation";
        request = {
          chat_id: input.conversation.externalChatId,
          animation: mediaUrl,
          caption: input.message.text?.body,
        };
      } else if (outboundMedia.length > 1) {
        const mediaGroup = outboundMedia.map((item, index) => {
          const url = item.storedAssetUrl ?? item.url;
          if (!url) {
            throw new Error(
              `Telegram image media item at index ${index} is missing url/storedAssetUrl`
            );
          }
          return {
            type: "photo",
            media: url,
            caption: index === 0 ? input.message.text?.body : undefined,
          };
        });

        endpoint = "sendMediaGroup";
        request = {
          chat_id: input.conversation.externalChatId,
          media: mediaGroup,
        };
      } else {
        if (storedAssetUpload) {
          return this.sendMultipartMedia({
            botToken,
            endpoint: "sendPhoto",
            fileField: "photo",
            file: storedAssetUpload,
            fields: {
              chat_id: input.conversation.externalChatId,
              caption: input.message.text?.body,
            },
          });
        }

        if (!mediaUrl) {
          return {
            status: "failed" as const,
            error: "Telegram image outbound requires media[0].url or media[0].storedAssetUrl",
          };
        }
        endpoint = "sendPhoto";
        request = {
          chat_id: input.conversation.externalChatId,
          photo: mediaUrl,
          caption: input.message.text?.body,
        };
      }
    } else if (input.message.kind === "video") {
      if (storedAssetUpload) {
        return this.sendMultipartMedia({
          botToken,
          endpoint: "sendVideo",
          fileField: "video",
          file: storedAssetUpload,
          fields: {
            chat_id: input.conversation.externalChatId,
            caption: input.message.text?.body,
          },
        });
      }

      if (!mediaUrl) {
        return {
          status: "failed" as const,
          error: "Telegram video outbound requires media[0].url or media[0].storedAssetUrl",
        };
      }
      endpoint = "sendVideo";
      request = {
        chat_id: input.conversation.externalChatId,
        video: mediaUrl,
        caption: input.message.text?.body,
      };
    } else if (input.message.kind === "audio") {
      if (storedAssetUpload) {
        return this.sendMultipartMedia({
          botToken,
          endpoint: "sendAudio",
          fileField: "audio",
          file: storedAssetUpload,
          fields: {
            chat_id: input.conversation.externalChatId,
            caption: input.message.text?.body,
          },
        });
      }

      if (!mediaUrl) {
        return {
          status: "failed" as const,
          error: "Telegram audio outbound requires media[0].url or media[0].storedAssetUrl",
        };
      }
      endpoint = "sendAudio";
      request = {
        chat_id: input.conversation.externalChatId,
        audio: mediaUrl,
        caption: input.message.text?.body,
      };
    } else if (input.message.kind === "file") {
      if (storedAssetUpload) {
        return this.sendMultipartMedia({
          botToken,
          endpoint: "sendDocument",
          fileField: "document",
          file: storedAssetUpload,
          fields: {
            chat_id: input.conversation.externalChatId,
            caption: input.message.text?.body,
          },
        });
      }

      if (!mediaUrl) {
        return {
          status: "failed" as const,
          error: "Telegram file outbound requires media[0].url or media[0].storedAssetUrl",
        };
      }
      endpoint = "sendDocument";
      request = {
        chat_id: input.conversation.externalChatId,
        document: mediaUrl,
        caption: input.message.text?.body,
      };
    } else if (input.message.kind === "location") {
      endpoint = "sendLocation";
      request = {
        chat_id: input.conversation.externalChatId,
        latitude: input.message.location?.lat,
        longitude: input.message.location?.lng,
      };
    } else if (input.message.kind === "contact") {
      endpoint = "sendContact";
      request = {
        chat_id: input.conversation.externalChatId,
        phone_number: input.message.contact?.phone,
        first_name: input.message.contact?.name ?? "Contact",
      };
    } else if (input.message.kind === "interactive") {
      endpoint = "sendMessage";
      request = {
        chat_id: input.conversation.externalChatId,
        text: input.message.text?.body ?? "",
      };
    } else if (input.message.kind === "sticker") {
      const stickerInput =
        String(input.message.meta?.originalStickerFileId ?? "").trim() ||
        String(input.message.meta?.platformStickerId ?? "").trim() ||
        String(input.message.media?.[0]?.providerFileId ?? "").trim();

      if (!stickerInput) {
        return {
          status: "failed" as const,
          error: "Telegram sticker outbound requires meta.platformStickerId (or meta.originalStickerFileId)",
        };
      }

      endpoint = "sendSticker";
      request = {
        chat_id: input.conversation.externalChatId,
        sticker: stickerInput,
      };
    } else {
      return {
        status: "failed" as const,
        error: `Telegram does not support outbound kind ${input.message.kind}`,
      };
    }

    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${botToken}/${endpoint}`,
        request
      );

      return {
        externalMessageId: String(response.data?.result?.message_id ?? ""),
        status: "sent" as const,
        raw: response.data,
        request,
      };
    } catch (error) {
      return this.buildFailedSendResult(error, request);
    }
  }
}
