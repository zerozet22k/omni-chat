import { CanonicalChannel } from "../channels/types";

export type StickerPreviewKind = "image" | "video" | "tgs" | "fallback";

export interface StickerPreview {
  kind: StickerPreviewKind;
  url?: string;
  mimeType?: string;
}

export interface StickerCatalogItem {
  id: string;
  label: string;
  description?: string;
  emoji?: string;
  preview?: StickerPreview;
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

export interface StickerCatalogSourceItem {
  id: string;
  label: string;
  description?: string;
  emoji?: string;
  providerMeta?: {
    telegram?: TelegramStickerCatalogItemMeta;
    viber?: ViberStickerCatalogItemMeta;
  };
}

export interface StickerCatalogSource {
  channel: CanonicalChannel;
  supported: boolean;
  items: StickerCatalogSourceItem[];
}
