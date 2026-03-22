import { InboundBufferModel } from "../models";
import { auditLogService } from "./audit-log.service";
import { automationService } from "./automation.service";
import { conversationService } from "./conversation.service";
import { messageService } from "./message.service";
import { CanonicalMessage } from "../channels/types";

const INBOUND_BUFFER_WINDOW_MS = 8000;

class InboundBufferService {
  private async claimPendingBufferById(bufferId: string) {
    return InboundBufferModel.findOneAndUpdate(
      {
        _id: bufferId,
        status: "pending",
      },
      {
        $set: {
          status: "processing",
          processedAt: new Date(),
        },
      },
      { new: true }
    );
  }

  async enqueueInboundText(params: {
    workspaceId: string;
    conversationId: string;
    conversationAiState?: string;
    message: CanonicalMessage;
    messageId: string;
  }) {
    if (params.message.kind !== "text") {
      return;
    }

    if (
      params.conversationAiState === "human_requested" ||
      params.conversationAiState === "human_active"
    ) {
      return;
    }

    const now = new Date();
    let buffer = await InboundBufferModel.findOne({
      conversationId: params.conversationId,
      status: "pending",
    });

    if (buffer) {
      const timeSinceLast = now.getTime() - buffer.lastBufferedAt.getTime();
      if (timeSinceLast >= INBOUND_BUFFER_WINDOW_MS) {
        await this.flushBuffer(buffer);
        buffer = null;
      }
    }

    if (!buffer) {
      const combinedText = params.message.text?.body?.trim() ?? "";
      const created = await InboundBufferModel.create({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        firstBufferedAt: now,
        lastBufferedAt: now,
        bufferedMessageIds: [params.messageId],
        combinedText,
        status: "pending",
      });

      await auditLogService.record({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        actorType: "automation",
        eventType: "automation.buffer.started",
        reason: "Started inbound text buffering for automation",
        data: {
          bufferId: String(created._id),
          combinedText,
          messageId: params.messageId,
        },
      });
      return;
    }

    const piece = params.message.text?.body?.trim() ?? "";
    const nextCombinedText = buffer.combinedText
      ? `${buffer.combinedText}\n${piece}`
      : piece;

    buffer.lastBufferedAt = now;
    buffer.bufferedMessageIds.push(params.messageId as any);
    buffer.combinedText = nextCombinedText;
    await buffer.save();

    await auditLogService.record({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      actorType: "automation",
      eventType: "automation.buffer.extended",
      reason: "Extended inbound text buffer",
      data: {
        bufferId: String(buffer._id),
        combinedText: nextCombinedText,
        messageId: params.messageId,
      },
    });
  }

  async flushPendingBuffers() {
    const threshold = new Date(Date.now() - INBOUND_BUFFER_WINDOW_MS);
    const due = await InboundBufferModel.find({
      status: "pending",
      lastBufferedAt: { $lte: threshold },
    });

    for (const buffer of due) {
      const claimed = await this.claimPendingBufferById(String(buffer._id));
      if (!claimed) {
        continue;
      }
      await this.flushBuffer(claimed);
    }
  }

  async flushBuffer(buffer: any) {
    const conversation = await conversationService.getById(buffer.conversationId);
    if (!conversation) {
      await InboundBufferModel.findByIdAndUpdate(String(buffer._id), {
        status: "cancelled",
        processedAt: new Date(),
        reason: "Conversation not found during buffer flush",
      });
      return;
    }

    await auditLogService.record({
      workspaceId: buffer.workspaceId,
      conversationId: buffer.conversationId,
      actorType: "automation",
      eventType: "automation.buffer.flushed",
      reason: "Flushed buffered inbound text for automation",
      data: {
        bufferId: String(buffer._id),
        combinedText: buffer.combinedText,
        bufferedMessageIds: buffer.bufferedMessageIds,
      },
    });

    const syntheticMessage: CanonicalMessage = {
      channel: conversation.channel,
      channelAccountId: conversation.channelAccountId,
      externalChatId: conversation.externalChatId,
      direction: "inbound",
      senderType: "customer",
      kind: "text",
      text: {
        body: buffer.combinedText,
        plain: buffer.combinedText,
      },
      raw: {
        bufferedMessageIds: buffer.bufferedMessageIds,
        combined: buffer.combinedText,
      },
      occurredAt: buffer.lastBufferedAt,
    };

    try {
      await automationService.handleInbound({
        workspaceId: buffer.workspaceId,
        conversationId: buffer.conversationId,
        message: syntheticMessage,
      });

      await InboundBufferModel.findByIdAndUpdate(String(buffer._id), {
        status: "processed",
        processedAt: new Date(),
        reason: "",
      });
    } catch (error) {
      await InboundBufferModel.findByIdAndUpdate(String(buffer._id), {
        status: "pending",
        processedAt: null,
        reason: error instanceof Error ? error.message : "Buffer flush failed",
      });
      throw error;
    }
  }

  async flushPendingForConversation(conversationId: string) {
    const pending = await InboundBufferModel.findOne({
      conversationId,
      status: "pending",
    });
    if (!pending) {
      return;
    }

    const claimed = await this.claimPendingBufferById(String(pending._id));
    if (!claimed) {
      return;
    }

    await this.flushBuffer(claimed);
  }

  async cancelPendingForConversation(conversationId: string) {
    const pending = await InboundBufferModel.findOne({
      conversationId,
      status: "pending",
    });
    if (!pending) {
      return;
    }

    await InboundBufferModel.findByIdAndUpdate(String(pending._id), {
      status: "cancelled",
      processedAt: new Date(),
    });

    await auditLogService.record({
      workspaceId: String(pending.workspaceId),
      conversationId,
      actorType: "automation",
      eventType: "automation.buffer.cancelled",
      reason: "Cancelled pending inbound buffer due to conversation state change",
      data: {
        bufferId: String(pending._id),
      },
    });
  }
}

export const inboundBufferService = new InboundBufferService();
