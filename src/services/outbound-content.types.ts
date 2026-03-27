import {
  CanonicalChannel,
  CanonicalMedia,
  CanonicalTextPayload,
  OutboundMessageKind,
} from "../channels/types";
import { StickerPreview } from "./sticker-catalog.types";

export type OutboundContentBlockChannel = CanonicalChannel | "any";
export type OutboundAttachmentKind = Extract<
  OutboundMessageKind,
  "image" | "video" | "audio" | "file"
>;

export interface OutboundTextBlock {
  kind: "text";
  channel?: OutboundContentBlockChannel;
  text: CanonicalTextPayload;
  meta?: Record<string, unknown>;
}

export interface OutboundStickerBlock {
  kind: "sticker";
  channel?: OutboundContentBlockChannel;
  sticker: {
    platformStickerId: string;
    packageId?: string;
    stickerResourceType?: string;
    label?: string;
    description?: string;
    emoji?: string;
    preview?: StickerPreview;
  };
  meta?: Record<string, unknown>;
}

export interface OutboundAttachmentBlock {
  kind: "attachment";
  channel?: OutboundContentBlockChannel;
  attachment: {
    kind: OutboundAttachmentKind;
    text?: CanonicalTextPayload;
    media: CanonicalMedia[];
  };
  meta?: Record<string, unknown>;
}

export type OutboundContentBlock =
  | OutboundTextBlock
  | OutboundStickerBlock
  | OutboundAttachmentBlock;
