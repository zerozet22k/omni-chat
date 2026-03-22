import { Message } from "../../types/models";
import { API_BASE_URL } from "../../services/api-base";

export type RenderableMediaItem = {
  preferredUrl: string | null;
  isExpired: boolean;
  hasDurableCopy: boolean;
  filename?: string;
  size?: number;
};

export type RenderableMedia = {
  preferredUrl: string | null;
  isExpired: boolean;
  hasDurableCopy: boolean;
  items: RenderableMediaItem[];
};

const resolveMediaUrl = (url?: string | null) => {
  if (!url) {
    return null;
  }

  try {
    return new URL(url, API_BASE_URL).toString();
  } catch {
    return url;
  }
};

export function resolveRenderableMedia(message: Message): RenderableMedia {
  const items: RenderableMediaItem[] = (message.media ?? []).map((media) => {
    const hasDurableCopy = Boolean(media.storedAssetUrl);
    const expiresAtMillis = media.expiresAt ? new Date(media.expiresAt).getTime() : null;
    const isExpired =
      Boolean(media.isTemporary) &&
      Boolean(expiresAtMillis) &&
      Number.isFinite(expiresAtMillis) &&
      (expiresAtMillis as number) <= Date.now();

    if (hasDurableCopy) {
      return {
        preferredUrl: resolveMediaUrl(media.storedAssetUrl),
        isExpired,
        hasDurableCopy,
        filename: media.filename,
        size: media.size,
      };
    }

    if (isExpired) {
      return {
        preferredUrl: null,
        isExpired,
        hasDurableCopy,
        filename: media.filename,
        size: media.size,
      };
    }

    return {
      preferredUrl: resolveMediaUrl(media.url),
      isExpired,
      hasDurableCopy,
      filename: media.filename,
      size: media.size,
    };
  });

  const first = items[0];

  return {
    preferredUrl: first?.preferredUrl ?? null,
    isExpired: Boolean(first?.isExpired),
    hasDurableCopy: Boolean(first?.hasDurableCopy),
    items,
  };
}
