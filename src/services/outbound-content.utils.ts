import { CanonicalChannel, CanonicalMedia } from "../channels/types";
import { OutboundContentBlock } from "./outbound-content.types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeChannel = (value: unknown): CanonicalChannel | "any" => {
  if (
    value === "facebook" ||
    value === "instagram" ||
    value === "telegram" ||
    value === "viber" ||
    value === "tiktok" ||
    value === "line" ||
    value === "website"
  ) {
    return value;
  }

  return "any";
};

export function isOutboundBlockCompatibleWithChannel(
  block: OutboundContentBlock,
  channel: CanonicalChannel
) {
  return !block.channel || block.channel === "any" || block.channel === channel;
}

export function filterOutboundBlocksForChannel(
  blocks: OutboundContentBlock[],
  channel: CanonicalChannel
) {
  return blocks.filter((block) => isOutboundBlockCompatibleWithChannel(block, channel));
}

export function describeOutboundBlock(block: OutboundContentBlock) {
  switch (block.kind) {
    case "text":
      return block.text.body.trim();
    case "sticker":
      return block.sticker.label?.trim() || block.sticker.emoji?.trim() || "[Sticker]";
    case "attachment":
      return block.attachment.text?.body?.trim() || `[${block.attachment.kind}]`;
    default:
      return "";
  }
}

export function deriveLegacyBodyFromBlocks(blocks: OutboundContentBlock[]) {
  return blocks
    .map((block) => describeOutboundBlock(block))
    .filter((value) => value.length > 0)
    .join("\n\n")
    .trim();
}

export function normalizeStoredOutboundBlocks(params: {
  blocks?: unknown;
  body?: unknown;
}): OutboundContentBlock[] {
  if (Array.isArray(params.blocks) && params.blocks.length > 0) {
    const normalizedBlocks = params.blocks
      .map((block) => normalizeStoredOutboundBlock(block))
      .filter((block): block is OutboundContentBlock => block !== null);

    if (normalizedBlocks.length > 0) {
      return normalizedBlocks;
    }
  }

  const fallbackBody = typeof params.body === "string" ? params.body.trim() : "";
  if (!fallbackBody) {
    return [];
  }

  return [
    {
      kind: "text",
      channel: "any",
      text: {
        body: fallbackBody,
        plain: fallbackBody,
      },
    },
  ];
}

function normalizeStoredOutboundBlock(value: unknown): OutboundContentBlock | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }

  const channel = normalizeChannel(value.channel);
  const meta = isRecord(value.meta) ? value.meta : undefined;

  if (value.kind === "text") {
    const text = isRecord(value.text) ? value.text : null;
    const body = typeof text?.body === "string" ? text.body.trim() : "";
    if (!body) {
      return null;
    }

    return {
      kind: "text",
      channel,
      text: {
        body,
        plain:
          typeof text?.plain === "string" && text.plain.trim().length > 0
            ? text.plain
            : body,
      },
      meta,
    };
  }

  if (value.kind === "sticker") {
    const sticker = isRecord(value.sticker) ? value.sticker : null;
    const platformStickerId =
      typeof sticker?.platformStickerId === "string"
        ? sticker.platformStickerId.trim()
        : "";
    if (!platformStickerId) {
      return null;
    }

    return {
      kind: "sticker",
      channel,
      sticker: {
        platformStickerId,
        packageId:
          typeof sticker?.packageId === "string" ? sticker.packageId.trim() || undefined : undefined,
        stickerResourceType:
          typeof sticker?.stickerResourceType === "string"
            ? sticker.stickerResourceType.trim() || undefined
            : undefined,
        label: typeof sticker?.label === "string" ? sticker.label : undefined,
        description:
          typeof sticker?.description === "string" ? sticker.description : undefined,
        emoji: typeof sticker?.emoji === "string" ? sticker.emoji : undefined,
        preview: isRecord(sticker?.preview)
          ? {
              kind:
                sticker.preview.kind === "image" ||
                sticker.preview.kind === "video" ||
                sticker.preview.kind === "tgs" ||
                sticker.preview.kind === "fallback"
                  ? sticker.preview.kind
                  : "fallback",
              url:
                typeof sticker.preview.url === "string"
                  ? sticker.preview.url
                  : undefined,
              mimeType:
                typeof sticker.preview.mimeType === "string"
                  ? sticker.preview.mimeType
                  : undefined,
            }
          : undefined,
      },
      meta,
    };
  }

  if (value.kind === "attachment") {
    const attachment = isRecord(value.attachment) ? value.attachment : null;
    if (
      attachment?.kind !== "image" &&
      attachment?.kind !== "video" &&
      attachment?.kind !== "audio" &&
      attachment?.kind !== "file"
    ) {
      return null;
    }

    const media = Array.isArray(attachment.media)
      ? attachment.media.filter((item) => isRecord(item))
      : [];

    if (!media.length) {
      return null;
    }

    const text = isRecord(attachment.text) ? attachment.text : undefined;
    const body =
      typeof text?.body === "string" && text.body.trim().length > 0 ? text.body : undefined;

    return {
      kind: "attachment",
      channel,
      attachment: {
        kind: attachment.kind,
        text: body
          ? {
              body,
              plain:
                typeof text?.plain === "string" && text.plain.trim().length > 0
                  ? text.plain
                  : body,
            }
          : undefined,
        media: media as CanonicalMedia[],
      },
      meta,
    } as OutboundContentBlock;
  }

  return null;
}
