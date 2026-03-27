import mongoose from "mongoose";
import { adapterRegistry } from "../channels/adapter.registry";
import { env } from "../config/env";
import {
  AISettingsModel,
  AutomationRuleModel,
  BusinessHoursModel,
  CannedReplyModel,
  ChannelConnectionModel,
  ContactModel,
  ConversationModel,
  KnowledgeItemModel,
  MessageModel,
  UserModel,
  WorkspaceModel,
} from "../models";

type SeedMessage = {
  externalMessageId: string;
  direction: "inbound" | "outbound";
  senderType: "customer" | "agent" | "automation";
  kind:
    | "text"
    | "image"
    | "video"
    | "audio"
    | "file"
    | "location"
    | "contact"
    | "interactive"
    | "unsupported";
  text?: {
    body: string;
    plain?: string;
  };
  unsupportedReason?: string;
  createdAt: Date;
};

type SeedConversationInput = {
  workspaceId: string;
  channel: "facebook" | "telegram" | "viber";
  channelAccountId: string;
  externalChatId: string;
  externalUserId: string;
  primaryName: string;
  status: "open" | "pending" | "resolved";
  unreadCount: number;
  lastMessageText: string;
  lastMessageAt: Date;
  tags?: string[];
  messages: SeedMessage[];
};

const seedDbName = process.env.SEED_MONGO_DB || `${env.MONGO_DB}_seed`;

async function connectSeedDb() {
  await mongoose.connect(`${env.MONGO_URL}/${seedDbName}`);
}

async function disconnectSeedDb() {
  await mongoose.disconnect();
}

async function upsertSeedConnection(input: {
  workspaceId: string;
  channel: "facebook" | "telegram" | "viber";
  displayName: string;
  externalAccountId: string;
  verificationState: "pending" | "failed";
  lastError: string;
}) {
  return ChannelConnectionModel.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      channel: input.channel,
      externalAccountId: input.externalAccountId,
    },
    {
      $set: {
        displayName: input.displayName,
        credentials: {},
        webhookConfig: {
          seeded: true,
        },
        webhookUrl: null,
        webhookVerified: false,
        verificationState: input.verificationState,
        status: "pending",
        lastError: input.lastError,
        capabilities: adapterRegistry.get(input.channel).getCapabilities(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function seedConversation(input: SeedConversationInput) {
  const contact = await ContactModel.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      "channelIdentities.channel": input.channel,
      "channelIdentities.externalUserId": input.externalUserId,
    },
    {
      $setOnInsert: {
        workspaceId: input.workspaceId,
        primaryName: input.primaryName,
        channelIdentities: [
          {
            channel: input.channel,
            externalUserId: input.externalUserId,
            displayName: input.primaryName,
          },
        ],
        phones: [],
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const conversation = await ConversationModel.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      channel: input.channel,
      channelAccountId: input.channelAccountId,
      externalChatId: input.externalChatId,
    },
    {
      $set: {
        externalUserId: input.externalUserId,
        contactId: contact._id,
        status: input.status,
        aiEnabled: false,
        routingState: "bot_active",
        unreadCount: input.unreadCount,
        lastMessageText: input.lastMessageText,
        lastMessageAt: input.lastMessageAt,
        tags: input.tags ?? [],
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  for (const message of input.messages) {
    await MessageModel.findOneAndUpdate(
      {
        workspaceId: input.workspaceId,
        channel: input.channel,
        channelAccountId: input.channelAccountId,
        externalMessageId: message.externalMessageId,
      },
      {
        $setOnInsert: {
          workspaceId: input.workspaceId,
          conversationId: conversation._id,
          channel: input.channel,
          channelAccountId: input.channelAccountId,
          externalMessageId: message.externalMessageId,
          externalChatId: input.externalChatId,
          externalSenderId:
            message.senderType === "customer" ? input.externalUserId : null,
          direction: message.direction,
          senderType: message.senderType,
          kind: message.kind,
          text: message.text,
          unsupportedReason: message.unsupportedReason ?? null,
          status: message.direction === "inbound" ? "received" : "sent",
          raw: {
            seeded: true,
            note: "Historical seed data only",
          },
          meta: {
            seeded: true,
          },
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        timestamps: false,
      }
    );
  }

  return conversation;
}

async function seed() {
  await connectSeedDb();

  const workspace = await WorkspaceModel.findOneAndUpdate(
    { slug: "seed-demo-workspace" },
    {
      $setOnInsert: {
        name: "Seed Demo Workspace",
        slug: "seed-demo-workspace",
        timeZone: "UTC",
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const user = await UserModel.findOneAndUpdate(
    { email: "seed-demo@example.com" },
    {
      $setOnInsert: {
        email: "seed-demo@example.com",
        name: "Seed Workspace Owner",
        workspaceIds: [workspace._id],
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  await Promise.all([
    upsertSeedConnection({
      workspaceId: String(workspace._id),
      channel: "telegram",
      displayName: "Seed Telegram Bot",
      externalAccountId: "seed-telegram-bot",
      verificationState: "pending",
      lastError:
        "Seeded history only. Add a real bot token and PUBLIC_WEBHOOK_BASE_URL to activate.",
    }),
    upsertSeedConnection({
      workspaceId: String(workspace._id),
      channel: "facebook",
      displayName: "Seed Messenger Page",
      externalAccountId: "seed-facebook-page",
      verificationState: "pending",
      lastError:
        "Seeded history only. Add a page token and complete Meta webhook verification to activate.",
    }),
    upsertSeedConnection({
      workspaceId: String(workspace._id),
      channel: "viber",
      displayName: "Seed Viber Account",
      externalAccountId: "seed-viber-account",
      verificationState: "pending",
      lastError:
        "Seeded history only. Add a real Viber auth token and webhook URL to activate.",
    }),
  ]);

  const now = new Date();

  await Promise.all([
    seedConversation({
      workspaceId: String(workspace._id),
      channel: "telegram",
      channelAccountId: "seed-telegram-bot",
      externalChatId: "seed-chat-1",
      externalUserId: "seed-user-1",
      primaryName: "Mina",
      status: "open",
      unreadCount: 1,
      lastMessageText: "Do you have this in blue?",
      lastMessageAt: new Date(now.getTime() - 10 * 60 * 1000),
      tags: ["seeded-history"],
      messages: [
        {
          externalMessageId: "seed-telegram-1",
          direction: "inbound",
          senderType: "customer",
          kind: "text",
          text: {
            body: "Do you have this in blue?",
            plain: "Do you have this in blue?",
          },
          createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        },
      ],
    }),
    seedConversation({
      workspaceId: String(workspace._id),
      channel: "facebook",
      channelAccountId: "seed-facebook-page",
      externalChatId: "seed-chat-2",
      externalUserId: "seed-user-2",
      primaryName: "Arun",
      status: "pending",
      unreadCount: 2,
      lastMessageText: "[Unsupported: Messenger attachment type is not mapped in MVP]",
      lastMessageAt: new Date(now.getTime() - 35 * 60 * 1000),
      tags: ["seeded-history", "human_pending"],
      messages: [
        {
          externalMessageId: "seed-facebook-1",
          direction: "inbound",
          senderType: "customer",
          kind: "unsupported",
          unsupportedReason: "Messenger attachment type is not mapped in MVP",
          createdAt: new Date(now.getTime() - 35 * 60 * 1000),
        },
      ],
    }),
    seedConversation({
      workspaceId: String(workspace._id),
      channel: "viber",
      channelAccountId: "seed-viber-account",
      externalChatId: "seed-chat-3",
      externalUserId: "seed-user-3",
      primaryName: "Nok",
      status: "resolved",
      unreadCount: 0,
      lastMessageText: "We are offline right now. A teammate will review this soon.",
      lastMessageAt: new Date(now.getTime() - 90 * 60 * 1000),
      tags: ["seeded-history", "after-hours"],
      messages: [
        {
          externalMessageId: "seed-viber-1",
          direction: "inbound",
          senderType: "customer",
          kind: "text",
          text: {
            body: "What time do you open tomorrow?",
            plain: "What time do you open tomorrow?",
          },
          createdAt: new Date(now.getTime() - 96 * 60 * 1000),
        },
        {
          externalMessageId: "seed-viber-2",
          direction: "outbound",
          senderType: "automation",
          kind: "text",
          text: {
            body: "We are offline right now. A teammate will review this soon.",
            plain: "We are offline right now. A teammate will review this soon.",
          },
          createdAt: new Date(now.getTime() - 90 * 60 * 1000),
        },
      ],
    }),
  ]);

  await Promise.all([
    KnowledgeItemModel.findOneAndUpdate(
      { workspaceId: workspace._id, title: "Delivery timeline" },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          title: "Delivery timeline",
          content: "Standard delivery takes 2 to 3 business days.",
          tags: ["shipping", "delivery"],
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
    CannedReplyModel.findOneAndUpdate(
      { workspaceId: workspace._id, title: "Availability reply" },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          title: "Availability reply",
          body: "Yes, this item is currently available.",
          triggers: ["available", "in stock"],
          category: "sales",
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
    AISettingsModel.findOneAndUpdate(
      { workspaceId: workspace._id },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          enabled: false,
          autoReplyEnabled: false,
          afterHoursEnabled: false,
          confidenceThreshold: 0.7,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
    BusinessHoursModel.findOneAndUpdate(
      { workspaceId: workspace._id },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          timeZone: "UTC",
          weeklySchedule: [
            { dayOfWeek: 1, enabled: true, windows: [{ start: "09:00", end: "18:00" }] },
            { dayOfWeek: 2, enabled: true, windows: [{ start: "09:00", end: "18:00" }] },
            { dayOfWeek: 3, enabled: true, windows: [{ start: "09:00", end: "18:00" }] },
            { dayOfWeek: 4, enabled: true, windows: [{ start: "09:00", end: "18:00" }] },
            { dayOfWeek: 5, enabled: true, windows: [{ start: "09:00", end: "18:00" }] },
          ],
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
    AutomationRuleModel.findOneAndUpdate(
      {
        workspaceId: workspace._id,
        type: "after_hours_auto_reply",
      },
      {
        $setOnInsert: {
          workspaceId: workspace._id,
          type: "after_hours_auto_reply",
          name: "After Hours",
          isActive: true,
          action: {
            fallbackText:
              "We are offline right now. A teammate will review this soon.",
          },
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ),
  ]);

  console.log(
    JSON.stringify({
      seedDatabase: seedDbName,
      workspaceId: String(workspace._id),
      userId: String(user._id),
      note: "Seed data is isolated from the main runtime database.",
    })
  );

  await disconnectSeedDb();
}

seed().catch(async (error) => {
  console.error(error);
  await disconnectSeedDb();
  process.exit(1);
});
