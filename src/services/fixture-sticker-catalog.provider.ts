import { readFile } from "fs/promises";
import { join } from "path";
import { StickerCatalogProvider } from "./sticker-catalog.provider";
import {
  StickerCatalogSource,
  StickerCatalogSourceItem,
  StickerCatalogLookup,
} from "./sticker-catalog.types";

const TELEGRAM_FIXTURE_FILE = "telegram-payloads.txt";
const VIBER_FIXTURE_FILE = "viber-payloads.txt";

type ParsedTelegramPayload = {
  message?: {
    sticker?: ParsedTelegramSticker;
  };
};

type ParsedTelegramSticker = {
  file_id?: string;
  emoji?: string;
  set_name?: string;
  is_animated?: boolean;
  is_video?: boolean;
  thumbnail?: {
    file_id?: string;
  };
  thumb?: {
    file_id?: string;
  };
};

type ParsedViberPayload = {
  message?: {
    type?: string;
    media?: string;
    sticker_id?: number | string;
  };
};

const splitLoggedPayloads = (raw: string) =>
  raw
    .split(/\r?\n===== [^\n]+ =====\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseLoggedPayloads = <TPayload>(raw: string) => {
  const payloads: TPayload[] = [];

  for (const entry of splitLoggedPayloads(raw)) {
    try {
      payloads.push(JSON.parse(entry) as TPayload);
    } catch {
      // Ignore malformed fixture entries so temporary test data does not break the UI.
    }
  }

  return payloads;
};

const humanizeSetName = (value?: string) =>
  String(value ?? "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

const getTelegramStickerDescription = (sticker?: ParsedTelegramSticker) => {
  if (!sticker) {
    return undefined;
  }

  if (sticker.is_video) {
    return "Video sticker";
  }

  if (sticker.is_animated) {
    return "Animated sticker";
  }

  return "Sticker";
};

const normalizePreviewUrl = (value?: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith("http://")) {
    return `https://${normalized.slice("http://".length)}`;
  }

  return normalized;
};

const parseTelegramFixtureCatalog = (raw: string): StickerCatalogSourceItem[] => {
  const payloads = parseLoggedPayloads<ParsedTelegramPayload>(raw).reverse();
  const items: StickerCatalogSourceItem[] = [];
  const seen = new Set<string>();

  for (const payload of payloads) {
    const sticker = payload.message?.sticker;
    const id = String(sticker?.file_id ?? "").trim();
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    items.push({
      id,
      platformStickerId: id,
      label: humanizeSetName(sticker?.set_name) || "Telegram sticker",
      description: getTelegramStickerDescription(sticker),
      emoji: String(sticker?.emoji ?? "").trim() || undefined,
      providerMeta: {
        telegram: {
          fileId: id,
          thumbnailFileId: sticker?.thumbnail?.file_id ?? sticker?.thumb?.file_id,
          isAnimated: sticker?.is_animated ?? false,
          isVideo: sticker?.is_video ?? false,
        },
      },
    });
  }

  return items;
};

const parseViberFixtureCatalog = (raw: string): StickerCatalogSourceItem[] => {
  const payloads = parseLoggedPayloads<ParsedViberPayload>(raw).reverse();
  const items: StickerCatalogSourceItem[] = [];
  const seen = new Set<string>();

  for (const payload of payloads) {
    const message = payload.message;
    if (message?.type !== "sticker") {
      continue;
    }

    const id = String(message.sticker_id ?? "").trim();
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    items.push({
      id,
      platformStickerId: id,
      label: `Sticker ${id}`,
      description: "Viber sticker",
      providerMeta: {
        viber: {
          previewUrl: normalizePreviewUrl(message.media),
        },
      },
    });
  }

  return items;
};

const readFixtureFile = async (fileName: string) => {
  try {
    return await readFile(join(process.cwd(), fileName), "utf8");
  } catch {
    return "";
  }
};

/**
 * Temporary dev/test provider that derives sticker catalogs from local webhook
 * fixture files. This is not a production source of truth and is intended to
 * be swapped for a real provider-backed catalog later.
 */
export class FixtureStickerCatalogProvider implements StickerCatalogProvider {
  async getCatalog(lookup: StickerCatalogLookup): Promise<StickerCatalogSource> {
    if (lookup.channel === "telegram") {
      const raw = await readFixtureFile(TELEGRAM_FIXTURE_FILE);
      return {
        channel: lookup.channel,
        supported: true,
        items: parseTelegramFixtureCatalog(raw),
      };
    }

    if (lookup.channel === "viber") {
      const raw = await readFixtureFile(VIBER_FIXTURE_FILE);
      return {
        channel: lookup.channel,
        supported: true,
        items: parseViberFixtureCatalog(raw),
      };
    }

    return {
      channel: lookup.channel,
      supported: false,
      items: [],
    };
  }
}
