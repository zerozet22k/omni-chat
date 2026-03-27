import { CanonicalChannel } from "../channels/types";
import { NotFoundError, ValidationError } from "../lib/errors";
import { WorkspaceStickerModel } from "../models";
import {
  LineStickerCatalogItemMeta,
  StickerCatalogSourceItem,
  TelegramStickerCatalogItemMeta,
  ViberStickerCatalogItemMeta,
} from "./sticker-catalog.types";

const SUPPORTED_WORKSPACE_STICKER_CHANNELS = [
  "telegram",
  "viber",
  "line",
] as const satisfies CanonicalChannel[];

type WorkspaceStickerChannel = (typeof SUPPORTED_WORKSPACE_STICKER_CHANNELS)[number];

export type WorkspaceStickerRecord = {
  _id: string;
  workspaceId: string;
  channel: WorkspaceStickerChannel;
  providerRef: string;
  platformStickerId: string;
  label: string;
  description?: string;
  emoji?: string;
  providerMeta?: {
    telegram?: TelegramStickerCatalogItemMeta;
    viber?: ViberStickerCatalogItemMeta;
    line?: LineStickerCatalogItemMeta;
  };
  createdAt?: Date;
  updatedAt?: Date;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const isWorkspaceStickerChannel = (value: unknown): value is WorkspaceStickerChannel =>
  value === "telegram" || value === "viber" || value === "line";

const buildLineStoreUrl = (packageId: string) =>
  `https://store.line.me/stickershop/product/${packageId}/en`;

class WorkspaceStickerService {
  private normalizeTelegramMeta(meta?: {
    fileId?: string | null;
    thumbnailFileId?: string | null;
    isAnimated?: boolean | null;
    isVideo?: boolean | null;
  } | null) {
    const fileId = trimString(meta?.fileId);
    const thumbnailFileId = trimString(meta?.thumbnailFileId);

    return fileId
      ? {
          fileId,
          ...(thumbnailFileId ? { thumbnailFileId } : {}),
          ...(meta?.isAnimated ? { isAnimated: true } : {}),
          ...(meta?.isVideo ? { isVideo: true } : {}),
        }
      : undefined;
  }

  private normalizeViberMeta(meta?: { previewUrl?: string | null } | null) {
    const previewUrl = trimString(meta?.previewUrl);
    return previewUrl ? { previewUrl } : undefined;
  }

  private normalizeLineMeta(meta?: {
    packageId?: string | null;
    stickerResourceType?: string | null;
    storeUrl?: string | null;
    packTitle?: string | null;
  } | null) {
    const packageId = trimString(meta?.packageId);
    const stickerResourceType = trimString(meta?.stickerResourceType);
    const storeUrl = trimString(meta?.storeUrl) || (packageId ? buildLineStoreUrl(packageId) : "");
    const packTitle = trimString(meta?.packTitle);

    return packageId
      ? {
          packageId,
          ...(stickerResourceType ? { stickerResourceType } : {}),
          ...(storeUrl ? { storeUrl } : {}),
          ...(packTitle ? { packTitle } : {}),
        }
      : undefined;
  }

  private buildProviderRef(params: {
    channel: WorkspaceStickerChannel;
    platformStickerId: string;
    providerMeta?: {
      line?: LineStickerCatalogItemMeta;
    };
  }) {
    if (params.channel === "line") {
      const packageId = trimString(params.providerMeta?.line?.packageId);
      if (!packageId) {
        throw new ValidationError("LINE stickers require packageId");
      }

      return `${packageId}:${params.platformStickerId}`;
    }

    return params.platformStickerId;
  }

  private toRecord(item: {
    _id: unknown;
    workspaceId: unknown;
    channel: WorkspaceStickerChannel;
    providerRef: string;
    platformStickerId: string;
    label: string;
    description?: string;
    emoji?: string;
    providerMeta?: {
      telegram?: TelegramStickerCatalogItemMeta;
      viber?: ViberStickerCatalogItemMeta;
      line?: LineStickerCatalogItemMeta;
    };
    createdAt?: Date;
    updatedAt?: Date;
  }): WorkspaceStickerRecord {
    return {
      _id: String(item._id),
      workspaceId: String(item.workspaceId),
      channel: item.channel,
      providerRef: item.providerRef,
      platformStickerId: item.platformStickerId,
      label: item.label,
      ...(item.description ? { description: item.description } : {}),
      ...(item.emoji ? { emoji: item.emoji } : {}),
      ...(item.providerMeta ? { providerMeta: item.providerMeta } : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async listByWorkspace(params: {
    workspaceId: string;
    channel?: CanonicalChannel;
  }): Promise<WorkspaceStickerRecord[]> {
    const query: Record<string, unknown> = {
      workspaceId: params.workspaceId,
    };

    if (params.channel) {
      if (!isWorkspaceStickerChannel(params.channel)) {
        return [];
      }

      query.channel = params.channel;
    }

    const items = await WorkspaceStickerModel.find(query)
      .sort({ channel: 1, updatedAt: -1, label: 1 })
      .lean();

    return items
      .filter((item): item is typeof item & { channel: WorkspaceStickerChannel } =>
        isWorkspaceStickerChannel(item.channel)
      )
      .map((item) => {
        const telegram = this.normalizeTelegramMeta(item.providerMeta?.telegram ?? undefined);
        const viber = this.normalizeViberMeta(item.providerMeta?.viber ?? undefined);
        const line = this.normalizeLineMeta(item.providerMeta?.line ?? undefined);

        return this.toRecord({
          ...item,
          providerMeta: {
            ...(telegram ? { telegram } : {}),
            ...(viber ? { viber } : {}),
            ...(line ? { line } : {}),
          },
        });
      });
  }

  async create(params: {
    workspaceId: string;
    createdByUserId: string;
    channel: WorkspaceStickerChannel;
    platformStickerId: string;
    label: string;
    description?: string;
    emoji?: string;
    providerMeta?: {
      telegram?: TelegramStickerCatalogItemMeta;
      viber?: ViberStickerCatalogItemMeta;
      line?: LineStickerCatalogItemMeta;
    };
  }): Promise<WorkspaceStickerRecord> {
    const platformStickerId = trimString(params.platformStickerId);
    if (!platformStickerId) {
      throw new ValidationError("platformStickerId is required");
    }

    const label = trimString(params.label) || `${params.channel} sticker`;
    const description = trimString(params.description);
    const emoji = trimString(params.emoji);
    const providerMeta = {
      ...(this.normalizeTelegramMeta(params.providerMeta?.telegram)
        ? { telegram: this.normalizeTelegramMeta(params.providerMeta?.telegram) }
        : {}),
      ...(this.normalizeViberMeta(params.providerMeta?.viber)
        ? { viber: this.normalizeViberMeta(params.providerMeta?.viber) }
        : {}),
      ...(this.normalizeLineMeta(params.providerMeta?.line)
        ? { line: this.normalizeLineMeta(params.providerMeta?.line) }
        : {}),
    };

    const providerRef = this.buildProviderRef({
      channel: params.channel,
      platformStickerId,
      providerMeta,
    });

    const item = await WorkspaceStickerModel.findOneAndUpdate(
      {
        workspaceId: params.workspaceId,
        channel: params.channel,
        providerRef,
      },
      {
        $set: {
          workspaceId: params.workspaceId,
          createdByUserId: params.createdByUserId,
          channel: params.channel,
          providerRef,
          platformStickerId,
          label,
          description,
          emoji,
          providerMeta,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    return this.toRecord({
      ...item,
      channel: params.channel,
      providerMeta,
    });
  }

  async removeInWorkspace(id: string, workspaceId: string) {
    const item = await WorkspaceStickerModel.findById(id);
    if (!item || String(item.workspaceId) !== workspaceId) {
      throw new NotFoundError("Sticker not found");
    }

    await item.deleteOne();
    return {
      _id: String(item._id),
      workspaceId,
    };
  }

  async buildCatalogSource(params: {
    workspaceId: string;
    channel: CanonicalChannel;
  }) {
    if (!isWorkspaceStickerChannel(params.channel)) {
      return {
        channel: params.channel,
        supported: false,
        items: [],
      };
    }

    const items = await this.listByWorkspace(params);
    const catalogItems: StickerCatalogSourceItem[] = items.map((item) => ({
      id: item.providerRef,
      platformStickerId: item.platformStickerId,
      label: item.label,
      description: item.description,
      emoji: item.emoji,
      providerMeta: item.providerMeta,
    }));

    return {
      channel: params.channel,
      supported: true,
      items: catalogItems,
    };
  }
}

export const workspaceStickerService = new WorkspaceStickerService();
