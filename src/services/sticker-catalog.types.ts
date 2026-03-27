import { CanonicalChannel } from "../channels/types";

export type StickerPreviewKind = "image" | "video" | "tgs" | "fallback";

export interface StickerPreview {
  kind: StickerPreviewKind;
  url?: string;
  mimeType?: string;
}

export interface StickerCatalogItem {
  id: string;
  platformStickerId: string;
  label: string;
  description?: string;
  emoji?: string;
  preview?: StickerPreview;
  providerMeta?: {
    telegram?: TelegramStickerCatalogItemMeta;
    viber?: ViberStickerCatalogItemMeta;
    line?: LineStickerCatalogItemMeta;
  };
}

export interface StickerCatalog {
  channel: CanonicalChannel;
  supported: boolean;
  items: StickerCatalogItem[];
}

export interface StickerCatalogLookup {
  channel: CanonicalChannel;
  workspaceId: string;
  conversationId: string;
}

export interface TelegramStickerCatalogItemMeta {
  fileId: string;
  thumbnailFileId?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
}

export interface ViberStickerCatalogItemMeta {
  previewUrl?: string;
}

export interface LineStickerCatalogItemMeta {
  packageId: string;
  stickerResourceType?: string;
  storeUrl?: string;
  packTitle?: string;
}

export interface StickerCatalogSourceItem {
  id: string;
  platformStickerId: string;
  label: string;
  description?: string;
  emoji?: string;
  providerMeta?: {
    telegram?: TelegramStickerCatalogItemMeta;
    viber?: ViberStickerCatalogItemMeta;
    line?: LineStickerCatalogItemMeta;
  };
}

export interface StickerCatalogSource {
  channel: CanonicalChannel;
  supported: boolean;
  items: StickerCatalogSourceItem[];
}
