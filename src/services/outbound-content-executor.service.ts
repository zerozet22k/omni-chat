import { CanonicalSenderType, OutboundCommand } from "../channels/types";
import { NotFoundError, ValidationError } from "../lib/errors";
import { conversationService } from "./conversation.service";
import { outboundMessageService } from "./outbound-message.service";
import { stickerCatalogService } from "./sticker-catalog.service";
import { OutboundContentBlock } from "./outbound-content.types";
import { filterOutboundBlocksForChannel } from "./outbound-content.utils";

type SupportedOutboundSender = Exclude<CanonicalSenderType, "customer">;

class OutboundContentExecutorService {
  async sendBlocks(params: {
    conversationId: string;
    senderType: SupportedOutboundSender;
    blocks: OutboundContentBlock[];
    source?: string;
    meta?: Record<string, unknown>;
    occurredAt?: Date;
  }) {
    const conversation = await conversationService.getById(params.conversationId);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }

    const compatibleBlocks = filterOutboundBlocksForChannel(
      params.blocks,
      conversation.channel
    );

    if (!compatibleBlocks.length) {
      throw new ValidationError(
        `No outbound content blocks are compatible with channel ${conversation.channel}`
      );
    }

    const baseOccurredAt = params.occurredAt ?? new Date();
    const messages = [];
    const deliveries = [];

    for (const [index, block] of compatibleBlocks.entries()) {
      const command = await this.buildCommand({
        conversation: {
          _id: String(conversation._id),
          workspaceId: String(conversation.workspaceId),
          channel: conversation.channel,
          channelAccountId: conversation.channelAccountId,
        },
        senderType: params.senderType,
        block,
        meta: params.meta,
      });

      const result = await outboundMessageService.send({
        conversationId: params.conversationId,
        command: {
          ...command,
          occurredAt: new Date(baseOccurredAt.getTime() + index * 1000),
        },
        source: params.source,
      });

      messages.push(result.message);
      deliveries.push(result.delivery);
    }

    return {
      messages,
      deliveries,
    };
  }

  private async buildCommand(params: {
    conversation: {
      _id: string;
      workspaceId: string;
      channel:
        | "facebook"
        | "instagram"
        | "telegram"
        | "viber"
        | "tiktok"
        | "line"
        | "website";
      channelAccountId: string;
    };
    senderType: SupportedOutboundSender;
    block: OutboundContentBlock;
    meta?: Record<string, unknown>;
  }): Promise<OutboundCommand> {
    const baseMeta = {
      ...(params.meta ?? {}),
      ...(params.block.meta ?? {}),
      outboundContentBlock: params.block,
    };

    if (params.block.kind === "text") {
      return {
        senderType: params.senderType,
        kind: "text",
        text: {
          body: params.block.text.body,
          plain: params.block.text.plain ?? params.block.text.body,
        },
        meta: baseMeta,
      };
    }

    if (params.block.kind === "attachment") {
      return {
        senderType: params.senderType,
        kind: params.block.attachment.kind,
        text: params.block.attachment.text,
        media: params.block.attachment.media,
        meta: baseMeta,
      };
    }

    const sticker = await stickerCatalogService.resolveStickerMessageContent(
      params.conversation,
      params.block.sticker
    );

    return {
      senderType: params.senderType,
      kind: "sticker",
      text: sticker.text,
      media: sticker.media,
      meta: {
        ...baseMeta,
        ...sticker.meta,
      },
    };
  }
}

export const outboundContentExecutorService = new OutboundContentExecutorService();
