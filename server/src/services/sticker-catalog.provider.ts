import { StickerCatalogLookup, StickerCatalogSource } from "./sticker-catalog.types";

export interface StickerCatalogProvider {
  getCatalog(lookup: StickerCatalogLookup): Promise<StickerCatalogSource>;
}
