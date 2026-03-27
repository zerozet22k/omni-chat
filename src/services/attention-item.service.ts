import {
  AttentionItemModel,
  ConversationModel,
  MessageModel,
} from "../models";
import {
  AttentionItemState,
  AttentionNeedsHumanReason,
  AttentionResolutionType,
  MessageMetadata,
} from "../channels/types";
import {
  BOT_ACTIVE_ROUTING_STATE,
  HUMAN_ACTIVE_ROUTING_STATE,
  HUMAN_PENDING_ROUTING_STATE,
} from "../lib/conversation-ai-state";
import { buildBotPauseWindow, serializeBotPause } from "../lib/bot-pause";

function toOptionalString(value: unknown) {
  return value == null ? null : String(value);
}

class AttentionItemService {
  private async getLatestInboundMessage(conversationId: string) {
    return MessageModel.findOne({
      conversationId,
      direction: "inbound",
    }).sort({ createdAt: -1, _id: -1 });
  }

  private async getOrCreateConversationAttentionItem(params: {
    conversationId: string;
    occurredAt?: Date;
  }) {
    const currentItem = await AttentionItemModel.findOne({
      conversationId: params.conversationId,
      resolvedAt: null,
    }).sort({ updatedAt: -1, openedAt: -1 });

    if (currentItem) {
      return currentItem;
    }

    const latestInbound = await this.getLatestInboundMessage(params.conversationId);
    if (!latestInbound) {
      return null;
    }

    const openedAt = params.occurredAt ?? latestInbound.createdAt ?? new Date();
    const createdItem = await AttentionItemModel.create({
      conversationId: params.conversationId,
      openedByInboundMessageIds: [latestInbound._id],
      lastInboundMessageId: latestInbound._id,
      state: "open",
      needsHuman: false,
      openedAt,
      updatedAt: openedAt,
    });

    await this.attachMessageMeta(String(latestInbound._id), {
      attentionItemId: String(createdItem._id),
    });

    return createdItem;
  }

  private serialize(item: { toObject(): any } | null) {
    if (!item) {
      return null;
    }

    const value = item.toObject();
    return {
      ...value,
      _id: String(value._id),
      conversationId: String(value.conversationId),
      openedByInboundMessageIds: value.openedByInboundMessageIds.map((messageId: unknown) =>
        String(messageId)
      ),
      lastInboundMessageId: String(value.lastInboundMessageId),
      assignedUserId: toOptionalString(value.assignedUserId),
      acknowledgementMessageId: toOptionalString(value.acknowledgementMessageId),
      botReplyMessageId: toOptionalString(value.botReplyMessageId),
      humanReplyMessageId: toOptionalString(value.humanReplyMessageId),
      resolvedByUserId: toOptionalString(value.resolvedByUserId),
      claimedAt: value.claimedAt?.toISOString() ?? null,
      ...serializeBotPause(value),
      openedAt: value.openedAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
      resolvedAt: value.resolvedAt?.toISOString() ?? null,
    };
  }

  private async attachMessageMeta(
    messageId: string,
    patch: Partial<MessageMetadata>
  ) {
    const message = await MessageModel.findById(messageId);
    if (!message) {
      return null;
    }

    message.meta = {
      ...(message.meta ?? {}),
      ...patch,
    };
    await message.save();
    return message;
  }

  async getCurrentByConversation(conversationId: string) {
    const item = await AttentionItemModel.findOne({
      conversationId,
      resolvedAt: null,
    }).sort({ updatedAt: -1, openedAt: -1 });

    return this.serialize(item);
  }

  async getById(attentionItemId: string) {
    const item = await AttentionItemModel.findById(attentionItemId);
    return this.serialize(item);
  }

  async listByConversation(conversationId: string) {
    const items = await AttentionItemModel.find({ conversationId }).sort({ openedAt: -1 });
    return items.map((item) => this.serialize(item));
  }

  async pauseBotForConversation(params: {
    conversationId: string;
    userId: string;
    occurredAt?: Date;
  }) {
    const item = await this.getOrCreateConversationAttentionItem({
      conversationId: params.conversationId,
      occurredAt: params.occurredAt,
    });
    if (!item) {
      return null;
    }

    const serializedItem = await this.claimByUser({
      attentionItemId: String(item._id),
      userId: params.userId,
      claimedAt: params.occurredAt,
    });

    return serializedItem;
  }

  async requestHumanForConversation(params: {
    conversationId: string;
    occurredAt?: Date;
  }) {
    const item = await this.getOrCreateConversationAttentionItem({
      conversationId: params.conversationId,
      occurredAt: params.occurredAt,
    });
    if (!item) {
      return null;
    }

    const hasHumanOwner = !!(item.botPausedAt || item.claimedAt || item.assignedUserId);
    return this.markAwaitingHuman({
      attentionItemId: String(item._id),
      needsHumanReason: "manual_request",
      occurredAt: params.occurredAt,
      routingState: hasHumanOwner ? HUMAN_ACTIVE_ROUTING_STATE : HUMAN_PENDING_ROUTING_STATE,
      assignedUserId: item.assignedUserId ? String(item.assignedUserId) : null,
      botPausedAt: item.botPausedAt ? new Date(item.botPausedAt) : null,
      botPausedUntil: item.botPausedUntil ? new Date(item.botPausedUntil) : null,
      botPausedByUserId: item.botPausedByUserId ? String(item.botPausedByUserId) : null,
    });
  }

  async resumeBotForConversation(params: {
    conversationId: string;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findOne({
      conversationId: params.conversationId,
      resolvedAt: null,
    }).sort({ updatedAt: -1, openedAt: -1 });

    if (!item) {
      await ConversationModel.findByIdAndUpdate(params.conversationId, {
        $set: {
          routingState: BOT_ACTIVE_ROUTING_STATE,
          status: "open",
          botPausedAt: null,
          botPausedUntil: null,
          botPausedByUserId: null,
        },
        $unset: {
          assigneeUserId: 1,
        },
      });
      return null;
    }

    return this.resumeBot({
      attentionItemId: String(item._id),
      occurredAt: params.occurredAt,
    });
  }

  async openForInbound(params: {
    conversationId: string;
    inboundMessageId: string;
    openedAt?: Date;
  }) {
    const occurredAt = params.openedAt ?? new Date();
    const item = await AttentionItemModel.create({
      conversationId: params.conversationId,
      openedByInboundMessageIds: [params.inboundMessageId],
      lastInboundMessageId: params.inboundMessageId,
      state: "open",
      needsHuman: false,
      openedAt: occurredAt,
      updatedAt: occurredAt,
    });

    await this.attachMessageMeta(String(params.inboundMessageId), {
      attentionItemId: String(item._id),
    });

    return this.serialize(item);
  }

  async mergeBufferedInbound(params: {
    attentionItemId: string;
    inboundMessageId: string;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const nextOccurredAt = params.occurredAt ?? new Date();
    const inboundMessageId = String(params.inboundMessageId);
    if (!item.openedByInboundMessageIds.some((messageId) => String(messageId) === inboundMessageId)) {
      item.openedByInboundMessageIds.push(params.inboundMessageId as never);
    }
    item.lastInboundMessageId = params.inboundMessageId as never;
    item.updatedAt = nextOccurredAt;
    await item.save();

    await this.attachMessageMeta(inboundMessageId, {
      attentionItemId: String(item._id),
    });

    return this.serialize(item);
  }

  async markBotReply(params: {
    attentionItemId: string;
    messageId: string;
    actorRunId?: string | null;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const occurredAt = params.occurredAt ?? new Date();
    await this.attachMessageMeta(params.messageId, {
      attentionItemId: String(item._id),
      actorRunId: params.actorRunId ?? null,
      inReplyToMessageId: String(item.lastInboundMessageId),
    });

    item.state = "bot_replied";
    item.needsHuman = false;
    item.needsHumanReason = null;
    item.botReplyMessageId = params.messageId as never;
    item.resolutionType = "bot_reply";
    item.updatedAt = occurredAt;
    item.resolvedAt = occurredAt;
    item.botPausedAt = null;
    item.botPausedUntil = null;
    item.botPausedByUserId = null;
    await item.save();

    await ConversationModel.findByIdAndUpdate(item.conversationId, {
      $set: {
        routingState: BOT_ACTIVE_ROUTING_STATE,
        status: "open",
        botPausedAt: null,
        botPausedUntil: null,
        botPausedByUserId: null,
      },
      $unset: {
        assigneeUserId: 1,
      },
    });

    return this.serialize(item);
  }

  async markAwaitingHuman(params: {
    attentionItemId: string;
    needsHumanReason: AttentionNeedsHumanReason;
    acknowledgementMessageId?: string | null;
    occurredAt?: Date;
    routingState?: typeof HUMAN_PENDING_ROUTING_STATE | typeof HUMAN_ACTIVE_ROUTING_STATE;
    assignedUserId?: string | null;
    botPausedAt?: Date | null;
    botPausedUntil?: Date | null;
    botPausedByUserId?: string | null;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const occurredAt = params.occurredAt ?? new Date();
    if (params.acknowledgementMessageId) {
      await this.attachMessageMeta(params.acknowledgementMessageId, {
        attentionItemId: String(item._id),
        inReplyToMessageId: String(item.lastInboundMessageId),
      });
      item.acknowledgementMessageId = params.acknowledgementMessageId as never;
    }

    item.state = "awaiting_human";
    item.needsHuman = true;
    item.needsHumanReason = params.needsHumanReason;
    item.updatedAt = occurredAt;
    if (params.assignedUserId) {
      item.assignedUserId = params.assignedUserId as never;
    }
    if (params.botPausedAt) {
      item.botPausedAt = params.botPausedAt as never;
      item.botPausedUntil = (params.botPausedUntil ?? null) as never;
      item.botPausedByUserId = (params.botPausedByUserId ?? null) as never;
    }
    await item.save();

    await ConversationModel.findByIdAndUpdate(item.conversationId, {
      $set: {
        routingState: params.routingState ?? HUMAN_PENDING_ROUTING_STATE,
        status: "pending",
        assigneeUserId: params.assignedUserId ?? null,
        botPausedAt: params.botPausedAt ?? null,
        botPausedUntil: params.botPausedUntil ?? null,
        botPausedByUserId: params.botPausedByUserId ?? null,
      },
    });

    return this.serialize(item);
  }

  async recordAcknowledgementOnly(params: {
    attentionItemId: string;
    messageId: string;
    actorRunId?: string | null;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const occurredAt = params.occurredAt ?? new Date();
    await this.attachMessageMeta(params.messageId, {
      attentionItemId: String(item._id),
      actorRunId: params.actorRunId ?? null,
      inReplyToMessageId: String(item.lastInboundMessageId),
    });

    item.acknowledgementMessageId = params.messageId as never;
    item.updatedAt = occurredAt;
    await item.save();
    return this.serialize(item);
  }

  async claimByUser(params: {
    attentionItemId: string;
    userId: string;
    claimedAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const claimedAt = params.claimedAt ?? new Date();
    const pauseWindow = buildBotPauseWindow(claimedAt);
    item.assignedUserId = params.userId as never;
    item.claimedAt = claimedAt;
    item.updatedAt = claimedAt;
    item.botPausedAt = pauseWindow.botPausedAt as never;
    item.botPausedUntil = pauseWindow.botPausedUntil as never;
    item.botPausedByUserId = params.userId as never;
    if (item.state === "open") {
      item.state = "awaiting_human";
      item.needsHuman = true;
      item.needsHumanReason = item.needsHumanReason ?? "manual_request";
    }
    await item.save();

    await ConversationModel.findByIdAndUpdate(item.conversationId, {
      $set: {
        routingState: HUMAN_ACTIVE_ROUTING_STATE,
        status: "pending",
        assigneeUserId: params.userId,
        botPausedAt: pauseWindow.botPausedAt,
        botPausedUntil: pauseWindow.botPausedUntil,
        botPausedByUserId: params.userId,
      },
    });

    return this.serialize(item);
  }

  async markHumanReply(params: {
    attentionItemId: string;
    messageId: string;
    userId: string;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const occurredAt = params.occurredAt ?? new Date();
    const pauseWindow = buildBotPauseWindow(occurredAt);
    await this.attachMessageMeta(params.messageId, {
      attentionItemId: String(item._id),
      actorUserId: params.userId,
      inReplyToMessageId: String(item.lastInboundMessageId),
    });

    item.assignedUserId = item.assignedUserId ?? (params.userId as never);
    item.claimedAt = item.claimedAt ?? occurredAt;
    item.botPausedAt = pauseWindow.botPausedAt as never;
    item.botPausedUntil = pauseWindow.botPausedUntil as never;
    item.botPausedByUserId = params.userId as never;
    item.state = "human_replied";
    item.needsHuman = false;
    item.humanReplyMessageId = params.messageId as never;
    item.resolvedByUserId = params.userId as never;
    item.resolutionType = "human_reply";
    item.updatedAt = occurredAt;
    item.resolvedAt = occurredAt;
    await item.save();

    await ConversationModel.findByIdAndUpdate(item.conversationId, {
      $set: {
        routingState: HUMAN_ACTIVE_ROUTING_STATE,
        status: "pending",
        assigneeUserId: params.userId,
        botPausedAt: pauseWindow.botPausedAt,
        botPausedUntil: pauseWindow.botPausedUntil,
        botPausedByUserId: params.userId,
      },
    });

    return this.serialize(item);
  }

  async closeAsMergedOrIgnored(params: {
    attentionItemId: string;
    resolutionType: Extract<AttentionResolutionType, "ignored" | "merged_into_newer_item">;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const occurredAt = params.occurredAt ?? new Date();
    item.state = "closed";
    item.needsHuman = false;
    item.resolutionType = params.resolutionType;
    item.updatedAt = occurredAt;
    item.resolvedAt = occurredAt;
    await item.save();
    return this.serialize(item);
  }

  async resumeBot(params: {
    attentionItemId: string;
    occurredAt?: Date;
  }) {
    const item = await AttentionItemModel.findById(params.attentionItemId);
    if (!item) {
      return null;
    }

    const occurredAt = params.occurredAt ?? new Date();
    await AttentionItemModel.updateMany(
      {
        conversationId: item.conversationId,
        resolvedAt: null,
      },
      {
        $set: {
          state: "closed" satisfies AttentionItemState,
          needsHuman: false,
          needsHumanReason: null,
          resolutionType: "ignored" satisfies AttentionResolutionType,
          updatedAt: occurredAt,
          resolvedAt: occurredAt,
          botPausedAt: null,
          botPausedUntil: null,
          botPausedByUserId: null,
        },
      }
    );

    await ConversationModel.findByIdAndUpdate(item.conversationId, {
      $set: {
        routingState: BOT_ACTIVE_ROUTING_STATE,
        status: "open",
        botPausedAt: null,
        botPausedUntil: null,
        botPausedByUserId: null,
      },
      $unset: {
        assigneeUserId: 1,
      },
    });

    const updatedItem = await AttentionItemModel.findById(params.attentionItemId);
    return this.serialize(updatedItem);
  }
}

export const attentionItemService = new AttentionItemService();