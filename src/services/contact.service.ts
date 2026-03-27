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
import { logger } from "../lib/logger";

class ContactService {
  private isUnknownName(value: unknown) {
    if (typeof value !== "string") {
      return true;
    }

    const normalized = value.trim().toLowerCase();
    return !normalized || normalized === "unknown" || normalized === "unknown contact";
  }

  private normalizePhone(value: string) {
    return value.replace(/\s+/g, " ").trim();
  }

  private normalizePhoneList(values: string[]) {
    return [...new Set(values.map((value) => this.normalizePhone(value)).filter(Boolean))];
  }

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

    const resolvedDisplayName =
      message.senderProfile?.displayName?.trim() || message.contact?.name?.trim() || "";
    const displayName = resolvedDisplayName || "Unknown";
    const username = message.senderProfile?.username;
    const avatar = message.senderProfile?.avatar;
    const phone = message.contact?.phone;

    if (existing) {
      const identities = existing.channelIdentities.map((current) => {
        if (
          current.channel === identity.channel &&
          current.externalUserId === identity.externalUserId
        ) {
          const currentDisplayName =
            typeof current.displayName === "string" ? current.displayName : "";
          return {
            ...current.toObject(),
            displayName:
              resolvedDisplayName ||
              (!this.isUnknownName(currentDisplayName) ? currentDisplayName : "Unknown"),
            username: username || current.username,
            avatar: avatar || current.avatar,
          };
        }

        return current.toObject();
      });

      existing.set("channelIdentities", identities);
      if (resolvedDisplayName && this.isUnknownName(existing.primaryName)) {
        existing.primaryName = resolvedDisplayName;
      }
      if (phone && !existing.phones.includes(phone)) {
        existing.phones = this.normalizePhoneList([...existing.phones, phone]);
      }

      await existing.save();

      logger.info("Contact identity persisted from inbound message", {
        contactId: String(existing._id),
        workspaceId,
        channel: message.channel,
        externalUserId: message.externalSenderId,
        displayName: resolvedDisplayName || null,
        avatarPersisted: !!avatar,
      });

      return existing;
    }

    const created = await ContactModel.create({
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
      phones: phone ? this.normalizePhoneList([phone]) : [],
    });

    logger.info("Contact created from inbound message", {
      contactId: String(created._id),
      workspaceId,
      channel: message.channel,
      externalUserId: message.externalSenderId,
      displayName: resolvedDisplayName || null,
      avatarPersisted: !!avatar,
    });

    return created;
  }

  async getById(id: string) {
    return ContactModel.findById(id);
  }

  async updateById(params: {
    workspaceId: string;
    contactId: string;
    patch: {
      phones?: string[];
      deliveryAddress?: string;
      notes?: string;
      aiNotes?: string;
    };
    mergePhones?: boolean;
  }) {
    const contact = await ContactModel.findOne({
      _id: params.contactId,
      workspaceId: params.workspaceId,
    });

    if (!contact) {
      return null;
    }

    if (params.patch.phones) {
      const nextPhones = this.normalizePhoneList(params.patch.phones);
      contact.phones = params.mergePhones
        ? this.normalizePhoneList([...contact.phones, ...nextPhones])
        : nextPhones;
    }

    if (typeof params.patch.deliveryAddress === "string") {
      contact.deliveryAddress = params.patch.deliveryAddress.trim();
    }

    if (typeof params.patch.notes === "string") {
      contact.notes = params.patch.notes.trim();
    }

    if (typeof params.patch.aiNotes === "string") {
      contact.aiNotes = params.patch.aiNotes.trim();
    }

    await contact.save();
    return contact;
  }

  async applyAIProfileUpdate(params: {
    workspaceId: string;
    contactId: string;
    update: {
      phones?: string[];
      deliveryAddress?: string;
      aiNotes?: string;
    };
  }) {
    return this.updateById({
      workspaceId: params.workspaceId,
      contactId: params.contactId,
      patch: params.update,
      mergePhones: true,
    });
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
