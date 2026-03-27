import { StickerCatalogProvider } from "./sticker-catalog.provider";
import { StickerCatalogLookup } from "./sticker-catalog.types";
import { workspaceStickerService } from "./workspace-sticker.service";

export class WorkspaceStickerCatalogProvider implements StickerCatalogProvider {
  async getCatalog(lookup: StickerCatalogLookup) {
    return workspaceStickerService.buildCatalogSource({
      workspaceId: lookup.workspaceId,
      channel: lookup.channel,
    });
  }
}
