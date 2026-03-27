process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";

import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AISettingsModel,
  AttentionItemModel,
  AuditLogModel,
  ConversationModel,
  InboundBufferModel,
  MessageModel,
  WorkspaceModel,
} from "../models";
import { attentionItemService } from "../services/attention-item.service";
import { automationService } from "../services/automation.service";
import { inboundBufferService } from "../services/inbound-buffer.service";
import { aiReplyService } from "../services/ai-reply.service";
import { outboundContentExecutorService } from "../services/outbound-content-executor.service";

describe("attention item service", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), {
      dbName: "attention-item-service-test",
    });
  }, 120000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    await Promise.all([
      AISettingsModel.deleteMany({}),
      AttentionItemModel.deleteMany({}),
      AuditLogModel.deleteMany({}),
      ConversationModel.deleteMany({}),
      InboundBufferModel.deleteMany({}),
      MessageModel.deleteMany({}),
      WorkspaceModel.deleteMany({}),
    ]);
  });

  async function createConversation() {
    const workspace = await WorkspaceModel.create({
      name: `Workspace ${new mongoose.Types.ObjectId()}`,
      slug: `workspace-${new mongoose.Types.ObjectId()}`,
      timeZone: "UTC",
    });

    return ConversationModel.create({
      workspaceId: workspace._id,
      channel: "website",
      channelAccountId: "acct-1",
      externalChatId: `chat-${new mongoose.Types.ObjectId()}`,
      externalUserId: `user-${new mongoose.Types.ObjectId()}`,
      routingState: "bot_active",
      status: "open",
      tags: [],
      aiEnabled: true,
    });
  }

  async function createMessage(params: {
    workspaceId?: string;
    conversationId: string;
    direction: "inbound" | "outbound";
    senderType: "customer" | "agent" | "automation" | "system" | "ai";
    kind?: "text" | "system";
    body?: string;
    status?: "received" | "queued" | "sent";
    occurredAt?: Date;
  }) {
    const occurredAt = params.occurredAt ?? new Date();
    return MessageModel.create({
      workspaceId: params.workspaceId ?? new mongoose.Types.ObjectId(),
      conversationId: params.conversationId,
      channel: "website",
      channelAccountId: "acct-1",
      externalMessageId: `${params.direction}-${new mongoose.Types.ObjectId()}`,
      externalChatId: "chat-1",
      externalSenderId: params.direction === "inbound" ? "customer-1" : null,
      direction: params.direction,
      senderType: params.senderType,
      kind: params.kind ?? "text",
      text:
        params.kind === "system"
          ? { body: params.body ?? "system", plain: params.body ?? "system" }
          : { body: params.body ?? "hello", plain: params.body ?? "hello" },
      media: [],
      status: params.status ?? (params.direction === "inbound" ? "received" : "sent"),
      raw: { createdInTest: true },
      meta: {},
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
  }

  it("bot reply resolves inbound", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "What are your hours?",
    });
    const attentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(inbound._id),
      openedAt: inbound.createdAt,
    });
    const botReply = await createMessage({
      conversationId: String(conversation._id),
      direction: "outbound",
      senderType: "automation",
      body: "We open from 9 to 5.",
    });

    await attentionItemService.markBotReply({
      attentionItemId: attentionItem!._id,
      messageId: String(botReply._id),
      actorRunId: "run-123",
      occurredAt: botReply.createdAt,
    });

    const updatedItem = await AttentionItemModel.findById(attentionItem!._id).lean();
    const updatedMessage = await MessageModel.findById(botReply._id).lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();

    expect(updatedItem?.state).toBe("bot_replied");
    expect(updatedItem?.needsHuman).toBe(false);
    expect(String(updatedItem?.botReplyMessageId)).toBe(String(botReply._id));
    expect(updatedItem?.resolutionType).toBe("bot_reply");
    expect(updatedItem?.resolvedAt).not.toBeNull();
    expect(updatedMessage?.meta).toMatchObject({
      attentionItemId: attentionItem!._id,
      actorRunId: "run-123",
      inReplyToMessageId: String(inbound._id),
    });
    expect(updatedConversation?.routingState).toBe("bot_active");
  });

  it("bot escalates to human without resolving inbound", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "I need special approval",
    });
    const attentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(inbound._id),
      openedAt: inbound.createdAt,
    });

    await attentionItemService.markAwaitingHuman({
      attentionItemId: attentionItem!._id,
      needsHumanReason: "low_confidence",
      occurredAt: new Date(inbound.createdAt.getTime() + 1000),
    });

    const updatedItem = await AttentionItemModel.findById(attentionItem!._id).lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();

    expect(updatedItem?.state).toBe("awaiting_human");
    expect(updatedItem?.needsHuman).toBe(true);
    expect(updatedItem?.needsHumanReason).toBe("low_confidence");
    expect(updatedItem?.claimedAt).toBeNull();
    expect(updatedItem?.resolvedAt).toBeNull();
    expect(updatedConversation?.routingState).toBe("human_pending");
  });

  it("claim pauses bot for one hour", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Need a person",
    });
    const attentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(inbound._id),
      openedAt: inbound.createdAt,
    });
    const claimedAt = new Date(inbound.createdAt.getTime() + 5000);
    const userId = String(new mongoose.Types.ObjectId());

    await attentionItemService.claimByUser({
      attentionItemId: attentionItem!._id,
      userId,
      claimedAt,
    });

    const updatedItem = await AttentionItemModel.findById(attentionItem!._id).lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();
    const expectedPausedUntil = new Date(claimedAt.getTime() + 60 * 60 * 1000).toISOString();

    expect(updatedItem?.claimedAt?.toISOString()).toBe(claimedAt.toISOString());
    expect(updatedItem?.botPausedAt?.toISOString()).toBe(claimedAt.toISOString());
    expect(updatedItem?.botPausedUntil?.toISOString()).toBe(expectedPausedUntil);
    expect(String(updatedItem?.botPausedByUserId)).toBe(userId);
    expect(updatedConversation?.routingState).toBe("human_active");
    expect(updatedConversation?.botPausedAt?.toISOString()).toBe(claimedAt.toISOString());
    expect(updatedConversation?.botPausedUntil?.toISOString()).toBe(expectedPausedUntil);
    expect(String(updatedConversation?.botPausedByUserId)).toBe(userId);
  });

  it("acknowledgement while awaiting human does not resolve inbound", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Can a person help me?",
    });
    const attentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(inbound._id),
      openedAt: inbound.createdAt,
    });
    await attentionItemService.markAwaitingHuman({
      attentionItemId: attentionItem!._id,
      needsHumanReason: "manual_request",
    });
    const acknowledgement = await createMessage({
      conversationId: String(conversation._id),
      direction: "outbound",
      senderType: "automation",
      body: "A teammate will follow up shortly.",
    });

    await attentionItemService.recordAcknowledgementOnly({
      attentionItemId: attentionItem!._id,
      messageId: String(acknowledgement._id),
      actorRunId: "run-ack",
      occurredAt: acknowledgement.createdAt,
    });

    const updatedItem = await AttentionItemModel.findById(attentionItem!._id).lean();
    const updatedMessage = await MessageModel.findById(acknowledgement._id).lean();

    expect(updatedItem?.state).toBe("awaiting_human");
    expect(updatedItem?.needsHuman).toBe(true);
    expect(updatedItem?.resolutionType).toBeNull();
    expect(updatedItem?.resolvedAt).toBeNull();
    expect(String(updatedItem?.acknowledgementMessageId)).toBe(String(acknowledgement._id));
    expect(updatedMessage?.meta).toMatchObject({
      attentionItemId: attentionItem!._id,
      actorRunId: "run-ack",
      inReplyToMessageId: String(inbound._id),
    });
  });

  it("human reply records actor user id", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Please connect me to staff",
    });
    const attentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(inbound._id),
      openedAt: inbound.createdAt,
    });
    const reply = await createMessage({
      conversationId: String(conversation._id),
      direction: "outbound",
      senderType: "agent",
      body: "I can help you with that.",
    });
    const actorUserId = String(new mongoose.Types.ObjectId());

    await attentionItemService.markHumanReply({
      attentionItemId: attentionItem!._id,
      messageId: String(reply._id),
      userId: actorUserId,
      occurredAt: reply.createdAt,
    });

    const updatedItem = await AttentionItemModel.findById(attentionItem!._id).lean();
    const updatedMessage = await MessageModel.findById(reply._id).lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();

    expect(updatedItem?.state).toBe("human_replied");
    expect(updatedItem?.resolutionType).toBe("human_reply");
    expect(String(updatedItem?.humanReplyMessageId)).toBe(String(reply._id));
    expect(String(updatedItem?.resolvedByUserId)).toBe(actorUserId);
    expect(updatedMessage?.meta).toMatchObject({
      actorUserId,
      attentionItemId: attentionItem!._id,
      inReplyToMessageId: String(inbound._id),
    });
    expect(updatedConversation?.routingState).toBe("human_active");
  });

  it("buffered inbound messages map to one attention item", async () => {
    const conversation = await createConversation();
    const firstInbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Hello",
      occurredAt: new Date(),
    });
    const secondInbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "I have another question",
      occurredAt: new Date(Date.now() + 1000),
    });

    await inboundBufferService.enqueueInboundText({
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      conversationRoutingState: conversation.routingState,
      message: {
        channel: "website",
        channelAccountId: "acct-1",
        externalChatId: conversation.externalChatId,
        externalSenderId: conversation.externalUserId,
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: { body: "Hello", plain: "Hello" },
        raw: { test: 1 },
        occurredAt: firstInbound.createdAt,
      },
      messageId: String(firstInbound._id),
    });

    await inboundBufferService.enqueueInboundText({
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      conversationRoutingState: conversation.routingState,
      message: {
        channel: "website",
        channelAccountId: "acct-1",
        externalChatId: conversation.externalChatId,
        externalSenderId: conversation.externalUserId,
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: { body: "I have another question", plain: "I have another question" },
        raw: { test: 2 },
        occurredAt: secondInbound.createdAt,
      },
      messageId: String(secondInbound._id),
    });

    const buffer = await InboundBufferModel.findOne({
      conversationId: conversation._id,
      status: "pending",
    }).lean();
    const attentionItem = await AttentionItemModel.findById(buffer?.attentionItemId).lean();
    const firstMessage = await MessageModel.findById(firstInbound._id).lean();
    const secondMessage = await MessageModel.findById(secondInbound._id).lean();

    expect(buffer).not.toBeNull();
    expect(buffer?.bufferedMessageIds.map(String)).toEqual([
      String(firstInbound._id),
      String(secondInbound._id),
    ]);
    expect(attentionItem?.openedByInboundMessageIds.map(String)).toEqual([
      String(firstInbound._id),
      String(secondInbound._id),
    ]);
    expect(String(attentionItem?.lastInboundMessageId)).toBe(String(secondInbound._id));
    expect(firstMessage?.meta?.attentionItemId).toBe(String(attentionItem?._id));
    expect(secondMessage?.meta?.attentionItemId).toBe(String(attentionItem?._id));
  });

  it("resume bot clears all unresolved attention items for the conversation", async () => {
    const conversation = await createConversation();
    const firstInbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "First issue",
      occurredAt: new Date(),
    });
    const secondInbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Second issue",
      occurredAt: new Date(Date.now() + 1000),
    });

    const firstAttentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(firstInbound._id),
      openedAt: firstInbound.createdAt,
    });
    const secondAttentionItem = await attentionItemService.openForInbound({
      conversationId: String(conversation._id),
      inboundMessageId: String(secondInbound._id),
      openedAt: secondInbound.createdAt,
    });

    await attentionItemService.markAwaitingHuman({
      attentionItemId: firstAttentionItem!._id,
      needsHumanReason: "manual_request",
    });
    await attentionItemService.claimByUser({
      attentionItemId: secondAttentionItem!._id,
      userId: String(new mongoose.Types.ObjectId()),
      claimedAt: new Date(secondInbound.createdAt.getTime() + 5000),
    });

    await attentionItemService.resumeBot({
      attentionItemId: secondAttentionItem!._id,
      occurredAt: new Date(secondInbound.createdAt.getTime() + 10000),
    });

    const updatedItems = await AttentionItemModel.find({
      conversationId: conversation._id,
    })
      .sort({ openedAt: 1 })
      .lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();
    const currentAttentionItem = await attentionItemService.getCurrentByConversation(
      String(conversation._id)
    );

    expect(updatedItems).toHaveLength(2);
    expect(updatedItems.every((item) => item.state === "closed")).toBe(true);
    expect(updatedItems.every((item) => item.needsHuman === false)).toBe(true);
    expect(updatedItems.every((item) => item.resolutionType === "ignored")).toBe(true);
    expect(updatedItems.every((item) => item.resolvedAt != null)).toBe(true);
    expect(updatedItems.every((item) => item.botPausedAt == null)).toBe(true);
    expect(updatedItems.every((item) => item.botPausedUntil == null)).toBe(true);
    expect(updatedItems.every((item) => item.botPausedByUserId == null)).toBe(true);
    expect(updatedConversation?.routingState).toBe("bot_active");
    expect(updatedConversation?.status).toBe("open");
    expect(updatedConversation?.botPausedAt).toBeNull();
    expect(updatedConversation?.botPausedUntil).toBeNull();
    expect(updatedConversation?.botPausedByUserId).toBeNull();
    expect(updatedConversation?.assigneeUserId).toBeUndefined();
    expect(currentAttentionItem).toBeNull();
  });

  it("conversation-level pause creates and claims an attention item when none is open", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Need help",
      occurredAt: new Date(),
    });
    const claimedAt = new Date(inbound.createdAt.getTime() + 3000);
    const userId = String(new mongoose.Types.ObjectId());

    const attentionItem = await attentionItemService.pauseBotForConversation({
      conversationId: String(conversation._id),
      userId,
      occurredAt: claimedAt,
    });

    const storedItems = await AttentionItemModel.find({
      conversationId: conversation._id,
    }).lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();
    const updatedInbound = await MessageModel.findById(inbound._id).lean();

    expect(storedItems).toHaveLength(1);
    expect(attentionItem?._id).toBeDefined();
    expect(storedItems[0]?.state).toBe("awaiting_human");
    expect(storedItems[0]?.needsHuman).toBe(true);
    expect(String(storedItems[0]?.lastInboundMessageId)).toBe(String(inbound._id));
    expect(String(storedItems[0]?.assignedUserId)).toBe(userId);
    expect(storedItems[0]?.claimedAt?.toISOString()).toBe(claimedAt.toISOString());
    expect(updatedConversation?.routingState).toBe("human_active");
    expect(updatedConversation?.status).toBe("pending");
    expect(String(updatedConversation?.assigneeUserId)).toBe(userId);
    expect(updatedInbound?.meta?.attentionItemId).toBe(attentionItem?._id);
  });

  it("conversation-level request help creates a pending attention item when none is open", async () => {
    const conversation = await createConversation();
    const inbound = await createMessage({
      conversationId: String(conversation._id),
      direction: "inbound",
      senderType: "customer",
      body: "Can someone review this?",
      occurredAt: new Date(),
    });
    const occurredAt = new Date(inbound.createdAt.getTime() + 2000);

    const attentionItem = await attentionItemService.requestHumanForConversation({
      conversationId: String(conversation._id),
      occurredAt,
    });

    const storedItems = await AttentionItemModel.find({
      conversationId: conversation._id,
    }).lean();
    const updatedConversation = await ConversationModel.findById(conversation._id).lean();

    expect(storedItems).toHaveLength(1);
    expect(attentionItem?._id).toBeDefined();
    expect(storedItems[0]?.state).toBe("awaiting_human");
    expect(storedItems[0]?.needsHuman).toBe(true);
    expect(storedItems[0]?.needsHumanReason).toBe("manual_request");
    expect(storedItems[0]?.claimedAt).toBeNull();
    expect(updatedConversation?.routingState).toBe("human_pending");
    expect(updatedConversation?.status).toBe("pending");
    expect(updatedConversation?.assigneeUserId).toBeNull();
  });

  it("human_pending still allows automation replies", async () => {
    const conversation = await createConversation();
    await AISettingsModel.create({
      workspaceId: conversation.workspaceId,
      enabled: true,
      autoReplyEnabled: true,
      autoReplyMode: "all",
      afterHoursEnabled: false,
      confidenceThreshold: 0.7,
    });

    await ConversationModel.findByIdAndUpdate(conversation._id, {
      $set: {
        routingState: "human_pending",
        status: "pending",
      },
    });

    const inboundOccurredAt = new Date();
    const sendBlocksSpy = vi
      .spyOn(outboundContentExecutorService, "sendBlocks")
      .mockResolvedValue({
        messages: [
          {
            _id: new mongoose.Types.ObjectId(),
          },
        ] as never[],
        deliveries: [],
      });

    const generateReplySpy = vi
      .spyOn(aiReplyService, "generateReply")
      .mockResolvedValue({
        kind: "knowledge",
        confidence: 0.91,
        sourceHints: ["help-center"],
        reason: "Confident answer available",
        blocks: [
          {
            kind: "text",
            text: {
              body: "Here is the helpful answer.",
              plain: "Here is the helpful answer.",
            },
          },
        ],
      } as never);

    await automationService.handleInbound({
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      message: {
        channel: "website",
        channelAccountId: "acct-1",
        externalChatId: conversation.externalChatId,
        externalSenderId: conversation.externalUserId ?? "user-1",
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: {
          body: "Can you still help before staff joins?",
          plain: "Can you still help before staff joins?",
        },
        raw: { test: true },
        occurredAt: inboundOccurredAt,
      },
    });

    expect(generateReplySpy).toHaveBeenCalledTimes(1);
    expect(sendBlocksSpy).toHaveBeenCalledTimes(1);

    const updatedConversation = await ConversationModel.findById(conversation._id).lean();
    expect(updatedConversation?.routingState).toBe("bot_active");
  });

  it("human_active still blocks automation and sends only acknowledgement", async () => {
    const conversation = await createConversation();
    await AISettingsModel.create({
      workspaceId: conversation.workspaceId,
      enabled: true,
      autoReplyEnabled: true,
      autoReplyMode: "all",
      afterHoursEnabled: false,
      confidenceThreshold: 0.7,
    });

    await ConversationModel.findByIdAndUpdate(conversation._id, {
      $set: {
        routingState: "human_active",
        status: "pending",
        assigneeUserId: new mongoose.Types.ObjectId(),
      },
    });

    const sendBlocksSpy = vi
      .spyOn(outboundContentExecutorService, "sendBlocks")
      .mockResolvedValue({
        messages: [
          {
            _id: new mongoose.Types.ObjectId(),
          },
        ] as never[],
        deliveries: [],
      });

    const generateReplySpy = vi.spyOn(aiReplyService, "generateReply");

    await automationService.handleInbound({
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      message: {
        channel: "website",
        channelAccountId: "acct-1",
        externalChatId: conversation.externalChatId,
        externalSenderId: conversation.externalUserId ?? "user-1",
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: {
          body: "Need a follow-up",
          plain: "Need a follow-up",
        },
        raw: { test: true },
        occurredAt: new Date(),
      },
    });

    expect(generateReplySpy).not.toHaveBeenCalled();
    expect(sendBlocksSpy).toHaveBeenCalledTimes(1);

    const skipAudit = await AuditLogModel.findOne({
      conversationId: conversation._id,
      eventType: "automation.decision.skipped",
    }).sort({ createdAt: -1 });

    expect(skipAudit?.reason).toBe("Conversation is actively owned by a human");
  });
});