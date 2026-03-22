import { CanonicalMessage } from "../channels/types";
import {
  ContactModel,
  ConversationDocument,
  ConversationModel,
  UserModel,
} from "../models";

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
          aiState: "idle",
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
    if (filters.search) {
      query.lastMessageText = { $regex: filters.search, $options: "i" };
    }

    const conversations = await ConversationModel.find(query).sort({
      lastMessageAt: -1,
    });

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
      .map((item) => item.assigneeUserId)
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
      contact: conversation.contactId
        ? contactMap.get(String(conversation.contactId))?.toObject()
        : null,
      contactName: conversation.contactId
        ? contactMap.get(String(conversation.contactId))?.primaryName ?? "Unknown contact"
        : "Unknown contact",
      assignee: conversation.assigneeUserId
        ? (() => {
            const assignee = assigneeMap.get(String(conversation.assigneeUserId));
            return assignee
              ? {
                  _id: String(assignee._id),
                  name: assignee.name,
                  avatarUrl: assignee.avatarUrl,
                }
              : null;
          })()
        : null,
    }));
  }

  async getById(id: string) {
    return ConversationModel.findById(id);
  }

  async updateById(id: string, patch: Record<string, unknown>) {
    return ConversationModel.findByIdAndUpdate(id, { $set: patch }, { new: true });
  }

  async setAIState(id: string, aiState: string) {
    return ConversationModel.findByIdAndUpdate(
      id,
      { $set: { aiState } },
      { new: true }
    );
  }

  async requestHumanHandoff(id: string) {
    const conversation = await ConversationModel.findById(id);
    if (!conversation) {
      return null;
    }

    conversation.status = "pending";
    if (!conversation.tags.includes("needs_human")) {
      conversation.tags.push("needs_human");
    }

    await conversation.save();
    return conversation;
  }
}

export const conversationService = new ConversationService();
