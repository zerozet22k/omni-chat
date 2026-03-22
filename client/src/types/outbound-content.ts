export type OutboundBlockChannel =
  | "facebook"
  | "telegram"
  | "viber"
  | "tiktok"
  | "any";

export type OutboundStickerPreview = {
  kind: "image" | "video" | "tgs" | "fallback";
  url?: string;
  mimeType?: string;
};

export type OutboundTextBlock = {
  kind: "text";
  channel?: OutboundBlockChannel;
  text: {
    body: string;
    plain?: string;
  };
  meta?: Record<string, unknown>;
};

export type OutboundStickerBlock = {
  kind: "sticker";
  channel?: OutboundBlockChannel;
  sticker: {
    platformStickerId: string;
    label?: string;
    description?: string;
    emoji?: string;
    preview?: OutboundStickerPreview;
  };
  meta?: Record<string, unknown>;
};

export type OutboundAttachmentBlock = {
  kind: "attachment";
  channel?: OutboundBlockChannel;
  attachment: {
    kind: "image" | "video" | "audio" | "file";
    text?: {
      body: string;
      plain?: string;
    };
    media: Array<{
      url?: string;
      mimeType?: string;
      filename?: string;
      size?: number;
      width?: number;
      height?: number;
      durationMs?: number;
      providerFileId?: string;
      thumbnailUrl?: string;
      isTemporary?: boolean;
      expiresAt?: string | null;
      expirySource?: "provider_ttl" | "signed_url" | "unknown" | null;
      lastValidatedAt?: string | null;
      storedAssetId?: string | null;
      storedAssetUrl?: string | null;
    }>;
  };
  meta?: Record<string, unknown>;
};

export type OutboundContentBlock =
  | OutboundTextBlock
  | OutboundStickerBlock
  | OutboundAttachmentBlock;

export function describeOutboundContentBlock(block: OutboundContentBlock) {
  switch (block.kind) {
    case "text":
      return block.text.body.trim();
    case "sticker":
      return block.sticker.label?.trim() || block.sticker.emoji?.trim() || "Sticker";
    case "attachment":
      return (
        block.attachment.text?.body?.trim() ||
        block.attachment.media[0]?.filename?.trim() ||
        `[${block.attachment.kind}]`
      );
    default:
      return "";
  }
}

export function summarizeOutboundContentBlocks(blocks: OutboundContentBlock[]) {
  return blocks
    .map((block) => describeOutboundContentBlock(block))
    .filter((value) => value.length > 0)
    .join("\n\n")
    .trim();
}
