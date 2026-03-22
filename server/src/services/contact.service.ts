import {
  AuditLogModel,
  ContactDocument,
  ContactModel,
  ConversationModel,
  InboundBufferModel,
  MessageDeliveryModel,
  MessageModel,
} from "../models";
import { CanonicalMessage } from "../channels/types";

class ContactService {
  async upsertFromMessage(
    workspaceId: string,
    message: CanonicalMessage
  ): Promise<ContactDocument | null> {
    if (!message.externalSenderId) {
      return null;
    }

    const identity = {
      channel: message.channel,
      externalUserId: message.externalSenderId,
    };

    const existing = await ContactModel.findOne({
      workspaceId,
      channelIdentities: {
        $elemMatch: identity,
      },
    });

    const displayName =
      message.senderProfile?.displayName ?? message.contact?.name ?? "Unknown";
    const username = message.senderProfile?.username;
    const avatar = message.senderProfile?.avatar;
    const phone = message.contact?.phone;

    if (existing) {
      const identities = existing.channelIdentities.map((current) => {
        if (
          current.channel === identity.channel &&
          current.externalUserId === identity.externalUserId
        ) {
          return {
            ...current.toObject(),
            displayName: displayName || current.displayName,
            username: username || current.username,
            avatar: avatar || current.avatar,
          };
        }

        return current.toObject();
      });

      existing.set("channelIdentities", identities);
      if (displayName && existing.primaryName === "Unknown contact") {
        existing.primaryName = displayName;
      }
      if (phone && !existing.phones.includes(phone)) {
        existing.phones.push(phone);
      }
      await existing.save();
      return existing;
    }

    return ContactModel.create({
      workspaceId,
      channelIdentities: [
        {
          ...identity,
          displayName,
          username,
          avatar,
        },
      ],
      primaryName: displayName,
      phones: phone ? [phone] : [],
    });
  }

  async getById(id: string) {
    return ContactModel.findById(id);
  }

  async deleteWithHistory(params: { workspaceId: string; contactId: string }) {
    const contact = await ContactModel.findOne({
      _id: params.contactId,
      workspaceId: params.workspaceId,
    });

    if (!contact) {
      return null;
    }

    const conversations = await ConversationModel.find(
      {
        workspaceId: params.workspaceId,
        contactId: params.contactId,
      },
      { _id: 1 }
    );

    const conversationIds = conversations.map((conversation) => conversation._id);

    let deletedMessages = 0;
    let deletedDeliveries = 0;
    let deletedBuffers = 0;
    let deletedConversations = 0;
    let deletedAuditLogs = 0;

    if (conversationIds.length > 0) {
      const [
        messageDeleteResult,
        deliveryDeleteResult,
        bufferDeleteResult,
        conversationDeleteResult,
        auditDeleteResult,
      ] = await Promise.all([
        MessageModel.deleteMany({ conversationId: { $in: conversationIds } }),
        MessageDeliveryModel.deleteMany({ conversationId: { $in: conversationIds } }),
        InboundBufferModel.deleteMany({ conversationId: { $in: conversationIds } }),
        ConversationModel.deleteMany({ _id: { $in: conversationIds } }),
        AuditLogModel.deleteMany({
          workspaceId: params.workspaceId,
          conversationId: { $in: conversationIds },
        }),
      ]);

      deletedMessages = messageDeleteResult.deletedCount ?? 0;
      deletedDeliveries = deliveryDeleteResult.deletedCount ?? 0;
      deletedBuffers = bufferDeleteResult.deletedCount ?? 0;
      deletedConversations = conversationDeleteResult.deletedCount ?? 0;
      deletedAuditLogs = auditDeleteResult.deletedCount ?? 0;
    }

    await ContactModel.deleteOne({
      _id: params.contactId,
      workspaceId: params.workspaceId,
    });

    return {
      deletedContactId: params.contactId,
      deletedConversations,
      deletedMessages,
      deletedDeliveries,
      deletedBuffers,
      deletedAuditLogs,
    };
  }
}

export const contactService = new ContactService();
