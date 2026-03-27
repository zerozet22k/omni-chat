import { CanonicalChannel, CanonicalMedia, CanonicalTextPayload } from "../channels/types";
import { ConversationDocument } from "../models";
import { StickerCatalogProvider } from "./sticker-catalog.provider";
import {
  StickerCatalog,
  StickerCatalogItem,
  StickerPreview,
  StickerCatalogSourceItem,
} from "./sticker-catalog.types";
import { telegramStickerPreviewService } from "./telegram-sticker-preview.service";
import { WorkspaceStickerCatalogProvider } from "./workspace-sticker-catalog.provider";

const isStickerSupportedChannel = (channel: CanonicalChannel) =>
  channel === "telegram" || channel === "viber" || channel === "line";

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
      packageId?: string;
      stickerResourceType?: string;
      label?: string;
      description?: string;
      emoji?: string;
      preview?: StickerPreview;
    }
  ): Promise<ResolvedStickerMessageContent> {
    const platformStickerId = input.platformStickerId.trim();
    const linePackageId = String(input.packageId ?? "").trim();
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
    const sourceItem = sourceCatalog.items.find((item) => {
      if (item.platformStickerId !== platformStickerId) {
        return false;
      }

      if (conversation.channel !== "line") {
        return true;
      }

      if (!linePackageId) {
        return true;
      }

      return item.providerMeta?.line?.packageId === linePackageId;
    });

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

    if (conversation.channel === "line") {
      const packageId =
        linePackageId || sourceItem?.providerMeta?.line?.packageId || "";
      const stickerLabel = input.label ?? sourceItem?.label ?? "LINE sticker";
      const stickerDescription = input.description ?? sourceItem?.description;
      const stickerEmoji = input.emoji ?? sourceItem?.emoji;
      const storeUrl = sourceItem?.providerMeta?.line?.storeUrl;
      const packTitle = sourceItem?.providerMeta?.line?.packTitle;
      const stickerResourceType =
        String(input.stickerResourceType ?? "").trim() ||
        sourceItem?.providerMeta?.line?.stickerResourceType;

      return {
        meta: {
          ...baseMeta,
          ...(packageId ? { stickerPackageId: packageId } : {}),
          ...(stickerResourceType ? { lineStickerResourceType: stickerResourceType } : {}),
          ...(storeUrl ? { lineStickerStoreUrl: storeUrl } : {}),
          ...(packTitle ? { lineStickerPackTitle: packTitle } : {}),
          ...(stickerLabel ? { stickerLabel } : {}),
          ...(stickerDescription ? { stickerDescription } : {}),
          ...(stickerEmoji ? { stickerEmoji } : {}),
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
        platformStickerId: item.platformStickerId,
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
        providerMeta: item.providerMeta,
      }));
    }

    if (conversation.channel === "line") {
      return items.map((item) => {
        const packageId = item.providerMeta?.line?.packageId;
        const stickerResourceType = item.providerMeta?.line?.stickerResourceType;
        const previewUrl =
          packageId && item.platformStickerId
            ? `/api/stickers/proxy/${encodeURIComponent(item.platformStickerId)}/${encodeURIComponent(packageId)}${
                stickerResourceType
                  ? `?stickerResourceType=${encodeURIComponent(stickerResourceType)}`
                  : ""
              }`
            : undefined;

        return {
          id: item.id,
          platformStickerId: item.platformStickerId,
          label: item.label,
          description: item.description,
          emoji: item.emoji,
          preview: previewUrl
            ? {
                kind: "image",
                url: previewUrl,
                mimeType: "image/png",
              }
            : undefined,
          providerMeta: item.providerMeta,
        };
      });
    }

    return items.map((item) => ({
      id: item.id,
      platformStickerId: item.platformStickerId,
      label: item.label,
      description: item.description,
      emoji: item.emoji,
      providerMeta: item.providerMeta,
    }));
  }
}

const defaultStickerCatalogProvider = new WorkspaceStickerCatalogProvider();

export const stickerCatalogService = new StickerCatalogService(
  defaultStickerCatalogProvider
);
