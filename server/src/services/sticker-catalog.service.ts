import { CanonicalChannel, CanonicalMedia, CanonicalTextPayload } from "../channels/types";
import { ConversationDocument } from "../models";
import { FixtureStickerCatalogProvider } from "./fixture-sticker-catalog.provider";
import { StickerCatalogProvider } from "./sticker-catalog.provider";
import {
  StickerCatalog,
  StickerCatalogItem,
  StickerPreview,
  StickerCatalogSourceItem,
} from "./sticker-catalog.types";
import { telegramStickerPreviewService } from "./telegram-sticker-preview.service";

const isStickerSupportedChannel = (channel: CanonicalChannel) =>
  channel === "telegram" || channel === "viber";

const buildUnsupportedCatalog = (channel: CanonicalChannel): StickerCatalog => ({
  channel,
  supported: false,
  items: [],
});

type StickerConversationContext = {
  _id: string | ConversationDocument["_id"];
  workspaceId: string | ConversationDocument["workspaceId"];
  channel: ConversationDocument["channel"];
  channelAccountId: string;
};

export type ResolvedStickerMessageContent = {
  text?: CanonicalTextPayload;
  media?: CanonicalMedia[];
  meta: Record<string, unknown>;
};

class StickerCatalogService {
  constructor(private readonly provider: StickerCatalogProvider) {}

  async getStickerCatalogForConversation(
    conversation: StickerConversationContext
  ): Promise<StickerCatalog> {
    if (!isStickerSupportedChannel(conversation.channel)) {
      return buildUnsupportedCatalog(conversation.channel);
    }

    const sourceCatalog = await this.provider.getCatalog({
      channel: conversation.channel,
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
    });

    return {
      channel: sourceCatalog.channel,
      supported: sourceCatalog.supported,
      items: await this.buildCatalogItems(conversation, sourceCatalog.items),
    };
  }

  async resolveStickerMessageContent(
    conversation: StickerConversationContext,
    input: {
      platformStickerId: string;
      label?: string;
      description?: string;
      emoji?: string;
      preview?: StickerPreview;
    }
  ): Promise<ResolvedStickerMessageContent> {
    const platformStickerId = input.platformStickerId.trim();
    const baseMeta: Record<string, unknown> = {
      platformStickerId,
    };

    if (!platformStickerId) {
      return {
        meta: baseMeta,
      };
    }

    if (!isStickerSupportedChannel(conversation.channel)) {
      return {
        text: input.emoji
          ? {
              body: input.emoji,
              plain: input.emoji,
            }
          : undefined,
        meta: {
          ...baseMeta,
          stickerLabel: input.label,
          stickerDescription: input.description,
          stickerEmoji: input.emoji,
        },
      };
    }

    const sourceCatalog = await this.provider.getCatalog({
      channel: conversation.channel,
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
    });
    const sourceItem = sourceCatalog.items.find((item) => item.id === platformStickerId);

    if (conversation.channel === "telegram") {
      const sourceMeta = sourceItem?.providerMeta?.telegram ?? {
        fileId: platformStickerId,
      };
      const descriptor = await telegramStickerPreviewService.resolveStickerDescriptor(
        {
          _id: String(conversation._id),
          workspaceId: String(conversation.workspaceId),
          channel: "telegram",
          channelAccountId: conversation.channelAccountId,
        },
        sourceMeta
      );
      const stickerEmoji = input.emoji ?? sourceItem?.emoji;
      const stickerLabel = input.label ?? sourceItem?.label ?? "Telegram sticker";
      const stickerDescription = input.description ?? sourceItem?.description;

      return {
        text: stickerEmoji
          ? {
              body: stickerEmoji,
              plain: stickerEmoji,
            }
          : undefined,
        media: descriptor?.previewFileId
          ? [
              {
                providerFileId: descriptor.previewFileId,
                mimeType: descriptor.mimeType,
              },
            ]
          : [],
        meta: {
          ...baseMeta,
          stickerLabel,
          stickerDescription,
          stickerEmoji,
          stickerPreviewKind: descriptor?.preview?.kind,
          stickerPreviewMimeType: descriptor?.mimeType,
          originalStickerFileId: descriptor?.originalFileId ?? platformStickerId,
          telegramStickerPreviewFileId: descriptor?.previewFileId ?? null,
          isAnimated: descriptor?.isAnimated ?? sourceMeta.isAnimated ?? false,
          isVideo: descriptor?.isVideo ?? sourceMeta.isVideo ?? false,
          previewFromThumbnail: descriptor?.previewFromThumbnail ?? false,
        },
      };
    }

    if (conversation.channel === "viber") {
      const stickerLabel = input.label ?? sourceItem?.label ?? "Viber sticker";
      const stickerDescription = input.description ?? sourceItem?.description;
      const stickerEmoji = input.emoji ?? sourceItem?.emoji;
      const previewUrl =
        sourceItem?.providerMeta?.viber?.previewUrl ?? input.preview?.url ?? undefined;

      return {
        text: stickerEmoji
          ? {
              body: stickerEmoji,
              plain: stickerEmoji,
            }
          : undefined,
        media: previewUrl
          ? [
              {
                url: previewUrl,
                mimeType: "image/png",
              },
            ]
          : [],
        meta: {
          ...baseMeta,
          stickerLabel,
          stickerDescription,
          stickerEmoji,
          stickerPreviewKind: previewUrl ? "image" : input.preview?.kind,
          stickerPreviewMimeType: previewUrl ? "image/png" : input.preview?.mimeType,
          viberPreviewUrl: previewUrl ?? null,
        },
      };
    }

    return {
      meta: baseMeta,
    };
  }

  private async buildCatalogItems(
    conversation: StickerConversationContext,
    items: StickerCatalogSourceItem[]
  ): Promise<StickerCatalogItem[]> {
    if (conversation.channel === "telegram") {
      return telegramStickerPreviewService.buildCatalogItems(
        {
          _id: String(conversation._id),
          workspaceId: String(conversation.workspaceId),
          channel: "telegram",
          channelAccountId: conversation.channelAccountId,
        },
        items
      );
    }

    if (conversation.channel === "viber") {
      return items.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        emoji: item.emoji,
        preview: item.providerMeta?.viber?.previewUrl
          ? {
              kind: "image",
              url: item.providerMeta.viber.previewUrl,
              mimeType: "image/png",
            }
          : undefined,
      }));
    }

    return items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      emoji: item.emoji,
    }));
  }
}

// Temporary default provider. Swap this when a real Telegram/Viber catalog
// source is available.
const defaultStickerCatalogProvider = new FixtureStickerCatalogProvider();

export const stickerCatalogService = new StickerCatalogService(
  defaultStickerCatalogProvider
);
