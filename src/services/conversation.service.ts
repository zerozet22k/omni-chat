import { CanonicalMessage, ConversationRoutingState } from "../channels/types";
import {
  AttentionItemModel,
  ContactModel,
  ConversationDocument,
  ConversationModel,
  UserModel,
} from "../models";
import {
  BOT_ACTIVE_ROUTING_STATE,
  HUMAN_ACTIVE_ROUTING_STATE,
  HUMAN_HANDOFF_QUERY_ROUTING_STATES,
  HUMAN_HANDOFF_QUERY_TAGS,
  HUMAN_PENDING_ROUTING_STATE,
  HUMAN_PENDING_TAG,
  normalizeConversationRoutingState,
} from "../lib/conversation-ai-state";
import { serializeBotPause } from "../lib/bot-pause";

const buildPreviewText = (message: {
  kind: string;
  text?: { body?: string | null } | null;
  interactive?: { label?: string | null; value?: string | null } | null;
  unsupportedReason?: string | null;
  meta?: Record<string, unknown> | null;
}) => {
  const providerMessageType = String(message.meta?.providerMessageType ?? "").toUpperCase();

  if (message.kind === "text") {
    return message.text?.body ?? "";
  }

  if (message.kind === "interactive") {
    return message.interactive?.label ?? message.interactive?.value ?? "[Interactive]";
  }

  if (message.kind === "image") {
    if (providerMessageType === "EMOJI") {
      return "[Emoji]";
    }
    return "[Image]";
  }

  if (message.kind === "video") {
    return "[Video]";
  }

  if (message.kind === "audio") {
    return "[Audio]";
  }

  if (message.kind === "file") {
    return "[File]";
  }

  if (message.kind === "location") {
    return "[Location]";
  }

  if (message.kind === "contact") {
    return "[Contact]";
  }

  if (message.kind === "sticker") {
    return message.text?.body ?? "[Sticker]";
  }

  if (message.kind === "unsupported") {
    return `[Unsupported: ${message.unsupportedReason ?? "Unsupported content"}]`;
  }

  return message.text?.body ?? "[System]";
};

class ConversationService {
  private serializeAttentionItem(
    item: { toObject(): any } | null
  ) {
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
      assignedUserId: value.assignedUserId ? String(value.assignedUserId) : null,
      acknowledgementMessageId: value.acknowledgementMessageId
        ? String(value.acknowledgementMessageId)
        : null,
      botReplyMessageId: value.botReplyMessageId ? String(value.botReplyMessageId) : null,
      humanReplyMessageId: value.humanReplyMessageId
        ? String(value.humanReplyMessageId)
        : null,
      resolvedByUserId: value.resolvedByUserId ? String(value.resolvedByUserId) : null,
      claimedAt: value.claimedAt?.toISOString() ?? null,
      ...serializeBotPause(value),
      openedAt: value.openedAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
      resolvedAt: value.resolvedAt?.toISOString() ?? null,
    };
  }

  private normalizeConversationDocument(
    conversation: ConversationDocument | null
  ) {
    if (!conversation) {
      return null;
    }

    conversation.routingState = normalizeConversationRoutingState(conversation.routingState);
    return conversation;
  }

  async findOrCreateInbound(params: {
    workspaceId: string;
    connection: {
      channel: CanonicalMessage["channel"];
      externalAccountId: string;
    };
    message: CanonicalMessage;
    contactId?: string | null;
  }): Promise<ConversationDocument> {
    const lookup = {
      workspaceId: params.workspaceId,
      channel: params.connection.channel,
      channelAccountId: params.connection.externalAccountId,
      externalChatId: params.message.externalChatId,
    };

    const conversation = await ConversationModel.findOneAndUpdate(
      lookup,
      {
        $setOnInsert: {
          ...lookup,
          externalUserId: params.message.externalSenderId,
          contactId: params.contactId ?? null,
          aiEnabled: true,
          routingState: BOT_ACTIVE_ROUTING_STATE,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    if (!conversation) {
      throw new Error("Failed to create or fetch conversation");
    }

    if (
      params.contactId &&
      (!conversation.contactId || String(conversation.contactId) !== params.contactId)
    ) {
      conversation.contactId = params.contactId as never;
    }

    if (params.message.externalSenderId && !conversation.externalUserId) {
      conversation.externalUserId = params.message.externalSenderId;
    }

    conversation.routingState = normalizeConversationRoutingState(conversation.routingState);

    await conversation.save();
    return conversation;
  }

  async applyInboundMessage(params: {
    conversationId: string;
    message: {
      createdAt?: Date;
      kind: string;
      text?: { body?: string | null } | null;
      interactive?: { label?: string | null; value?: string | null } | null;
      unsupportedReason?: string | null;
      meta?: Record<string, unknown> | null;
    };
  }) {
    return ConversationModel.findByIdAndUpdate(
      params.conversationId,
      {
        $set: {
          lastMessageAt: params.message.createdAt ?? new Date(),
          lastMessageText: buildPreviewText(params.message),
        },
        $inc: {
          unreadCount: 1,
        },
      },
      { new: true }
    );
  }

  async applyOutboundMessage(params: {
    conversationId: string;
    message: {
      createdAt?: Date;
      kind: string;
      text?: { body?: string | null } | null;
      interactive?: { label?: string | null; value?: string | null } | null;
      unsupportedReason?: string | null;
      meta?: Record<string, unknown> | null;
    };
  }) {
    return ConversationModel.findByIdAndUpdate(
      params.conversationId,
      {
        $set: {
          lastMessageAt: params.message.createdAt ?? new Date(),
          lastMessageText: buildPreviewText(params.message),
        },
      },
      { new: true }
    );
  }

  async list(filters: {
    workspaceId: string;
    status?: string;
    channel?: string;
    assigneeUserId?: string;
    needsHuman?: boolean;
    search?: string;
  }) {
    const query: Record<string, unknown> = {
      workspaceId: filters.workspaceId,
    };

    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.channel) {
      query.channel = filters.channel;
    }
    if (filters.assigneeUserId) {
      query.assigneeUserId = filters.assigneeUserId;
    }
    if (filters.needsHuman) {
      query.$or = [
        { routingState: { $in: HUMAN_HANDOFF_QUERY_ROUTING_STATES } },
        { tags: { $in: HUMAN_HANDOFF_QUERY_TAGS } },
      ];
    }
    if (filters.search) {
      query.lastMessageText = { $regex: filters.search, $options: "i" };
    }

    const conversations = await ConversationModel.find(query).sort({
      lastMessageAt: -1,
    });
    const conversationIds = conversations.map((conversation) => String(conversation._id));

    const currentAttentionItems = conversationIds.length
      ? await AttentionItemModel.find({
          conversationId: { $in: conversationIds },
          resolvedAt: null,
        }).sort({ updatedAt: -1, openedAt: -1 })
      : [];
    const currentAttentionItemMap = new Map<string, (typeof currentAttentionItems)[number]>();
    for (const item of currentAttentionItems) {
      const conversationId = String(item.conversationId);
      if (!currentAttentionItemMap.has(conversationId)) {
        currentAttentionItemMap.set(conversationId, item);
      }
    }

    const contactIds = conversations
      .map((item) => item.contactId)
      .filter(Boolean)
      .map((value) => String(value));

    const contacts = contactIds.length
      ? await ContactModel.find({ _id: { $in: contactIds } })
      : [];
    const contactMap = new Map(
      contacts.map((contact) => [String(contact._id), contact])
    );

    const assigneeIds = conversations
      .flatMap((item) => {
        const attentionItem = currentAttentionItemMap.get(String(item._id));
        return [attentionItem?.assignedUserId ?? null, item.assigneeUserId ?? null];
      })
      .filter(Boolean)
      .map((value) => String(value));

    const assignees = assigneeIds.length
      ? await UserModel.find({ _id: { $in: assigneeIds } }).select("_id name avatarUrl")
      : [];
    const assigneeMap = new Map(
      assignees.map((user) => [String(user._id), user])
    );

    return conversations.map((conversation) => ({
      ...conversation.toObject(),
      routingState: normalizeConversationRoutingState(conversation.routingState),
      ...serializeBotPause(conversation),
      currentAttentionItemId: currentAttentionItemMap.get(String(conversation._id))
        ? String(currentAttentionItemMap.get(String(conversation._id))!._id)
        : null,
      currentAttentionItem: this.serializeAttentionItem(
        currentAttentionItemMap.get(String(conversation._id)) ?? null
      ),
      contact: conversation.contactId
        ? contactMap.get(String(conversation.contactId))?.toObject()
        : null,
      contactName: conversation.contactId
        ? contactMap.get(String(conversation.contactId))?.primaryName ?? "Unknown contact"
        : "Unknown contact",
      assignee: (() => {
        const currentAttentionItem = currentAttentionItemMap.get(
          String(conversation._id)
        );
        const resolvedAssigneeId = currentAttentionItem?.assignedUserId ?? conversation.assigneeUserId;
        if (!resolvedAssigneeId) {
          return null;
        }

        const assignee = assigneeMap.get(String(resolvedAssigneeId));
        return assignee
          ? {
              _id: String(assignee._id),
              name: assignee.name,
              avatarUrl: assignee.avatarUrl,
            }
          : null;
      })(),
    }));
  }

  async getById(id: string) {
    const conversation = await ConversationModel.findById(id);
    return this.normalizeConversationDocument(conversation);
  }

  async updateById(id: string, patch: Record<string, unknown>) {
    const conversation = await ConversationModel.findById(id);
    if (!conversation) {
      return null;
    }

    const normalizedPatch = { ...patch };
    if ("routingState" in normalizedPatch) {
      normalizedPatch.routingState = normalizeConversationRoutingState(
        normalizedPatch.routingState
      );
    } else {
      normalizedPatch.routingState = normalizeConversationRoutingState(
        conversation.routingState
      );
    }

    const updatedConversation = await ConversationModel.findByIdAndUpdate(
      id,
      { $set: normalizedPatch },
      { new: true, runValidators: true }
    );

    return this.normalizeConversationDocument(updatedConversation);
  }

  async setRoutingState(id: string, routingState: ConversationRoutingState | string) {
    const updatedConversation = await ConversationModel.findByIdAndUpdate(
      id,
      { $set: { routingState: normalizeConversationRoutingState(routingState) } },
      { new: true, runValidators: true }
    );

    return this.normalizeConversationDocument(updatedConversation);
  }

  async requestHumanHandoff(id: string) {
    const conversation = await ConversationModel.findById(id);
    if (!conversation) {
      return null;
    }

    conversation.status = "pending";
    conversation.routingState = HUMAN_PENDING_ROUTING_STATE;

    await conversation.save();
    return this.normalizeConversationDocument(conversation);
  }
}

export const conversationService = new ConversationService();
