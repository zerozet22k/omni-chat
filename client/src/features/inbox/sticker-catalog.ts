import { Channel } from "../../types/models";

export type StickerPreview = {
  kind: "image" | "video" | "tgs" | "fallback";
  url?: string;
  mimeType?: string;
};

export type StickerCatalogItem = {
  id: string;
  label: string;
  description?: string;
  emoji?: string;
  preview?: StickerPreview;
};

export type StickerCatalog = {
  channel: Channel;
  supported: boolean;
  items: StickerCatalogItem[];
};
