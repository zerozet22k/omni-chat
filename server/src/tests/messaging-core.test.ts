import axios from "axios";
import { createHmac } from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
let adapterRegistry: typeof import("../channels/adapter.registry")["adapterRegistry"];
let inboundBufferService: typeof import("../services/inbound-buffer.service")["inboundBufferService"];
const testDbName = `chatbot_test_${Date.now()}`;

const fixedTelegramDate = Math.floor(
  new Date("2026-03-08T02:00:00.000Z").getTime() / 1000
);

const buildTelegramTextUpdate = (messageId: number, text: string) => ({
  update_id: messageId,
  message: {
    message_id: messageId,
    date: fixedTelegramDate,
    chat: { id: 5001 },
    from: {
      id: 7001,
      first_name: "Mina",
      username: "mina_shop",
    },
    text,
  },
});

const buildTelegramUnsupportedUpdate = (messageId: number) => ({
  update_id: messageId,
  message: {
    message_id: messageId,
    date: fixedTelegramDate,
    chat: { id: 5001 },
    from: {
      id: 7001,
      first_name: "Mina",
      username: "mina_shop",
    },
    sticker: {
      file_id: "sticker-1",
    },
  },
});

const buildFacebookTextWebhook = (messageId: string, text: string) => ({
  object: "page",
  entry: [
    {
      id: "fb-page-1",
      messaging: [
        {
          sender: { id: "fb-user-1" },
          recipient: { id: "fb-page-1" },
          timestamp: 1714430514000,
          message: {
            mid: messageId,
            text,
          },
        },
      ],
    },
  ],
});

const buildTikTokTextWebhook = (messageId: string, text: string) => ({
  client_key: "tiktok-app-id",
  event: "im_receive_msg",
  create_time: 1714430514,
  user_openid: "tiktok-business-1",
  content: JSON.stringify({
    from: "mina_tiktok",
    to: "seller_account",
    unique_identifier: "tiktok-user-1",
    from_user: {
      id: "tiktok-user-1",
      role: "personal_account",
    },
    to_user: {
      id: "tiktok-business-1",
      role: "business_account",
    },
    conversation_id: "tiktok-conversation-1",
    message_id: messageId,
    timestamp: 1714430514000,
    type: "text",
    text: {
      body: text,
    },
    message_tag: {
      source: "APP",
    },
  }),
});

const signTikTokPayload = (payload: unknown, secret: string, timestamp: number) => {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},s=${signature}`;
};

const signFacebookPayload = (payload: unknown, secret: string) => {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${signature}`;
};

const createWorkspace = async () => {
  return models.WorkspaceModel.create({
    name: "Seller Workspace",
    slug: `seller-${Math.random().toString(36).slice(2, 8)}`,
    timeZone: "UTC",
  });
};

const createAuthHeaders = async (workspaceId: string, role: "owner" | "admin" | "staff" = "owner") => {
  const user = await models.UserModel.create({
    email: `user_${Math.random().toString(36).slice(2, 8)}@test.local`,
    name: "Test User",
    passwordHash: "hashed-password",
    role,
    workspaceIds: [workspaceId],
  });

  await models.WorkspaceMembershipModel.create({
    workspaceId,
    userId: user._id,
    role,
    status: "active",
  });

  const token = jwt.sign(
    {
      userId: String(user._id),
      email: user.email,
    },
    process.env.JWT_SECRET || "test-secret"
  );

  return {
    Authorization: `Bearer ${token}`,
    "x-workspace-id": workspaceId,
  };
};

const createTelegramConnection = async (workspaceId: string) => {
  return models.ChannelConnectionModel.create({
    workspaceId,
    channel: "telegram",
    displayName: "Telegram Bot",
    externalAccountId: "12345",
    credentials: {
      webhookSecret: "telegram-secret",
      botToken: "telegram-token",
    },
    webhookConfig: {},
    webhookUrl: "https://unit.test/webhooks/telegram",
    webhookVerified: true,
    verificationState: "verified",
    status: "active",
    capabilities: adapterRegistry.get("telegram").getCapabilities(),
  });
};

const createFacebookConnection = async (workspaceId: string) => {
  return models.ChannelConnectionModel.create({
    workspaceId,
    channel: "facebook",
    displayName: "Facebook Page",
    externalAccountId: "fb-page-1",
    credentials: {
      pageAccessToken: "facebook-token",
    },
    webhookConfig: {},
    webhookUrl: "https://unit.test/webhooks/facebook",
    webhookVerified: true,
    verificationState: "verified",
    status: "active",
    capabilities: adapterRegistry.get("facebook").getCapabilities(),
  });
};

const createFacebookConversation = async (workspaceId: string) => {
  const connection = await createFacebookConnection(workspaceId);
  const conversation = await models.ConversationModel.create({
    workspaceId,
    channel: "facebook",
    channelAccountId: String(connection.externalAccountId),
    externalChatId: "fb-user-1",
    externalUserId: "fb-page-1:fb-user-1",
    status: "open",
    unreadCount: 0,
    aiEnabled: true,
    aiState: "idle",
    tags: [],
  });

  return { connection, conversation };
};

const createConversationForConnection = async (workspaceId: string) => {
  const inboundResponse = await request(app)
    .post("/webhooks/telegram")
    .set("x-telegram-bot-api-secret-token", "telegram-secret")
    .send(buildTelegramTextUpdate(1001, "Hello"));

  expect(inboundResponse.status).toBe(200);
  const conversation = await models.ConversationModel.findOne();
  expect(conversation).toBeTruthy();
  return conversation!;
};

const createViberConnectionAndConversation = async (workspaceId: string) => {
  const connection = await models.ChannelConnectionModel.create({
    workspaceId,
    channel: "viber",
    displayName: "Viber Bot",
    externalAccountId: "viber-account",
    credentials: { authToken: "viber-token" },
    webhookConfig: {},
    webhookUrl: "https://unit.test/webhooks/viber",
    webhookVerified: true,
    verificationState: "verified",
    status: "active",
    capabilities: adapterRegistry.get("viber").getCapabilities(),
  });

  const conversation = await models.ConversationModel.create({
    workspaceId,
    channel: "viber",
    channelAccountId: String(connection.externalAccountId),
    externalChatId: "9000",
    status: "open",
    unreadCount: 0,
    aiEnabled: true,
    aiState: "idle",
    tags: [],
  });

  return { connection, conversation };
};

const createTikTokConnection = async (workspaceId: string) => {
  return models.ChannelConnectionModel.create({
    workspaceId,
    channel: "tiktok",
    displayName: "TikTok Business",
    externalAccountId: "tiktok-business-1",
    credentials: {
      accessToken: "tiktok-access-token",
      refreshToken: "tiktok-refresh-token",
      businessId: "tiktok-business-1",
      scopes: ["message.list.send", "message.list.read", "message.list.manage"],
    },
    webhookConfig: {},
    webhookUrl: "https://unit.test/webhooks/tiktok",
    webhookVerified: true,
    verificationState: "verified",
    status: "active",
    capabilities: adapterRegistry.get("tiktok").getCapabilities(),
  });
};

const createTikTokConversation = async (workspaceId: string) => {
  const connection = await createTikTokConnection(workspaceId);
  const conversation = await models.ConversationModel.create({
    workspaceId,
    channel: "tiktok",
    channelAccountId: String(connection.externalAccountId),
    externalChatId: "tiktok-conversation-1",
    externalUserId: "tiktok-user-1",
    status: "open",
    unreadCount: 0,
    aiEnabled: true,
    aiState: "idle",
    tags: [],
  });

  return { connection, conversation };
};

const configureAfterHoursAutomation = async (workspaceId: string) => {
  await models.AISettingsModel.create({
    workspaceId,
    enabled: true,
    autoReplyEnabled: true,
    afterHoursEnabled: true,
    confidenceThreshold: 0.7,
  });

  await models.BusinessHoursModel.create({
    workspaceId,
    timeZone: "UTC",
    weeklySchedule: [
      {
        dayOfWeek: 1,
        enabled: true,
        windows: [{ start: "09:00", end: "17:00" }],
      },
    ],
  });

  await models.AutomationRuleModel.create({
    workspaceId,
    type: "after_hours_auto_reply",
    name: "After Hours",
    isActive: true,
    action: {
      fallbackText: "We are offline right now. A teammate will review this soon.",
    },
  });
};

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";
  process.env.META_APP_ID = "meta-app-id";
  process.env.META_APP_SECRET = "meta-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "meta-verify-token";
  process.env.GEMINI_API_KEY = "";
  process.env.TIKTOK_APP_ID = "tiktok-app-id";
  process.env.TIKTOK_APP_SECRET = "tiktok-app-secret";

  models = await import("../models");
  ({ adapterRegistry } = await import("../channels/adapter.registry"));
  ({ inboundBufferService } = await import("../services/inbound-buffer.service"));

  await mongoose.connect(`${process.env.MONGO_URL}/${process.env.MONGO_DB}`);
  app = (await import("../app")).createApp();
}, 60000);

beforeEach(async () => {
  vi.restoreAllMocks();
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}, 60000);

describe("functional messaging core", () => {
  it("telegram connection validation persists an active verified connection", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          id: 12345,
          first_name: "Shop Bot",
          username: "shop_bot",
        },
      },
    });
    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: true,
      },
    });

    const response = await request(app)
      .post("/api/channels/telegram/connect")
      .set(authHeaders)
      .send({
        workspaceId: String(workspace._id),
        displayName: "Primary Telegram",
        credentials: {
          botToken: "telegram-token",
          webhookSecret: "telegram-secret",
        },
        webhookConfig: {},
      });

    expect(response.status).toBe(201);
    expect(response.body.connection.status).toBe("active");
    expect(response.body.connection.webhookVerified).toBe(true);
    expect(response.body.connection.externalAccountId).toBe("12345");

    const connection = await models.ChannelConnectionModel.findOne({
      workspaceId: workspace._id,
      channel: "telegram",
    });
    expect(connection?.credentials).toMatchObject({
      botToken: "telegram-token",
      webhookSecret: "telegram-secret",
    });
    expect(connection?.webhookUrl).toContain("/webhooks/telegram");
  });

  it("viber connection validation persists an active verified connection", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    vi.spyOn(axios, "post")
      .mockResolvedValueOnce({
        data: {
          status: 0,
          id: "viber-bot-1",
          name: "Seller Viber",
        },
      })
      .mockResolvedValueOnce({
        data: {
          status: 0,
          status_message: "ok",
        },
      });

    const response = await request(app)
      .post("/api/channels/viber/connect")
      .set(authHeaders)
      .send({
        workspaceId: String(workspace._id),
        displayName: "Primary Viber",
        credentials: {
          authToken: "viber-token",
        },
        webhookConfig: {
          connectionKey: "viber-main",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.connection.status).toBe("active");
    expect(response.body.connection.webhookVerified).toBe(true);
    expect(response.body.connection.externalAccountId).toBe("viber-bot-1");
  });

  it("facebook config starts pending and verify endpoint promotes it to active", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      data: {
        id: "fb-page-1",
        name: "Seller Page",
      },
    });

    const connectResponse = await request(app)
      .post("/api/channels/facebook/connect")
      .set(authHeaders)
      .send({
        workspaceId: String(workspace._id),
        displayName: "Messenger",
        credentials: {
          pageAccessToken: "facebook-token",
        },
        webhookConfig: {},
      });

    expect(connectResponse.status).toBe(201);
    expect(connectResponse.body.connection.status).toBe("pending");
    expect(connectResponse.body.connection.webhookVerified).toBe(false);

    const verifyResponse = await request(app)
      .get("/webhooks/facebook/verify")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "meta-verify-token",
        "hub.challenge": "123456",
      });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.text).toBe("123456");

    const connection = await models.ChannelConnectionModel.findOne({
      workspaceId: workspace._id,
      channel: "facebook",
    });
    expect(connection?.status).toBe("active");
    expect(connection?.webhookVerified).toBe(true);
  });

  it("facebook inbound webhook verifies signature and persists a text message", async () => {
    const workspace = await createWorkspace();
    await createFacebookConnection(String(workspace._id));
    const payload = buildFacebookTextWebhook("fb-mid-1", "Hello from Messenger");
    const signature = signFacebookPayload(payload, "meta-app-secret");

    const response = await request(app)
      .post("/webhooks/facebook")
      .set("x-hub-signature-256", signature)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body.processed).toBe(1);

    const conversation = await models.ConversationModel.findOne({ channel: "facebook" });
    const message = await models.MessageModel.findOne({ channel: "facebook" });
    const contact = await models.ContactModel.findOne({
      "channelIdentities.channel": "facebook",
      "channelIdentities.externalUserId": "fb-page-1:fb-user-1",
    });

    expect(conversation?.lastMessageText).toBe("Hello from Messenger");
    expect(message?.kind).toBe("text");
    expect(message?.text?.body).toBe("Hello from Messenger");
    expect(contact).toBeTruthy();
  });

  it("tiktok connection validation persists an active verified connection", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    vi.spyOn(axios, "post")
      .mockResolvedValueOnce({
        data: {
          code: 0,
          message: "OK",
          data: {
            app_id: "tiktok-app-id",
            creator_id: "tiktok-business-1",
            scope: "message.list.send,message.list.read,message.list.manage",
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          message: "OK",
          data: {
            app_id: "tiktok-app-id",
            event_type: "DIRECT_MESSAGE",
            callback_url: "https://unit.test/webhooks/tiktok",
          },
        },
      });

    const response = await request(app)
      .post("/api/channels/tiktok/connect")
      .set(authHeaders)
      .send({
        workspaceId: String(workspace._id),
        displayName: "TikTok DM",
        credentials: {
          accessToken: "tiktok-access-token",
          refreshToken: "tiktok-refresh-token",
          businessId: "tiktok-business-1",
        },
        webhookConfig: {},
      });

    expect(response.status).toBe(201);
    expect(response.body.connection.status).toBe("active");
    expect(response.body.connection.webhookVerified).toBe(true);
    expect(response.body.connection.externalAccountId).toBe("tiktok-business-1");
  });

  it("inbound webhook persists canonical message, updates conversation, and records lastInboundAt", async () => {
    const workspace = await createWorkspace();
    const connection = await createTelegramConnection(String(workspace._id));

    const response = await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(1002, "Do you have blue?"));

    expect(response.status).toBe(200);
    expect(response.body.processed).toBe(1);

    const conversation = await models.ConversationModel.findOne();
    const message = await models.MessageModel.findOne();
    const refreshedConnection = await models.ChannelConnectionModel.findById(
      connection._id
    );

    expect(message?.kind).toBe("text");
    expect(message?.text?.body).toBe("Do you have blue?");
    expect(message?.raw).toBeDefined();
    expect(conversation?.unreadCount).toBe(1);
    expect(conversation?.lastMessageText).toBe("Do you have blue?");
    expect(refreshedConnection?.lastInboundAt).toBeTruthy();
  });

  it("unsupported inbound payload maps to unsupported and does not crash", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));

    const response = await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramUnsupportedUpdate(2001));

    expect(response.status).toBe(200);

    const message = await models.MessageModel.findOne();
    expect(message?.kind).toBe("unsupported");
    expect(message?.unsupportedReason).toContain("not mapped");
  });

  it("tiktok inbound webhook verifies signature and persists a text message", async () => {
    const workspace = await createWorkspace();
    await createTikTokConnection(String(workspace._id));
    const payload = buildTikTokTextWebhook("tt-msg-1", "Hello from TikTok");
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signTikTokPayload(payload, "tiktok-app-secret", timestamp);

    const response = await request(app)
      .post("/webhooks/tiktok")
      .set("tiktok-signature", signature)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body.processed).toBe(1);

    const conversation = await models.ConversationModel.findOne({ channel: "tiktok" });
    const message = await models.MessageModel.findOne({ channel: "tiktok" });
    const contact = await models.ContactModel.findOne({
      "channelIdentities.channel": "tiktok",
      "channelIdentities.externalUserId": "tiktok-user-1",
    });

    expect(conversation?.lastMessageText).toBe("Hello from TikTok");
    expect(message?.kind).toBe("text");
    expect(message?.text?.body).toBe("Hello from TikTok");
    expect(contact).toBeTruthy();
  });

  it("outbound send success updates delivery status and connection.lastOutboundAt", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const connection = await createTelegramConnection(String(workspace._id));
    const conversation = await createConversationForConnection(String(workspace._id));

    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 9001,
        },
      },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "text",
        text: {
          body: "We have it in stock.",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");

    const refreshedConnection = await models.ChannelConnectionModel.findById(
      connection._id
    );
    const delivery = await models.MessageDeliveryModel.findOne();

    expect(refreshedConnection?.lastOutboundAt).toBeTruthy();
    expect(delivery?.status).toBe("sent");
    expect(delivery?.providerResponse).toMatchObject({
      ok: true,
    });
  });

  it("supports outbound text via tiktok adapter", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const { connection, conversation } = await createTikTokConversation(
      String(workspace._id)
    );

    vi.spyOn(axios, "post")
      .mockResolvedValueOnce({
        data: {
          code: 0,
          message: "OK",
          data: {
            app_id: "tiktok-app-id",
            creator_id: "tiktok-business-1",
            scope: "message.list.send,message.list.read,message.list.manage",
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          message: "OK",
          data: {
            message: {
              message_id: "tiktok-out-1",
            },
          },
        },
      });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "text",
        text: {
          body: "Thanks for your TikTok DM",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");
    expect(response.body.message.externalMessageId).toBe("tiktok-out-1");

    const refreshedConnection = await models.ChannelConnectionModel.findById(connection._id);
    expect(refreshedConnection?.lastOutboundAt).toBeTruthy();
  });

  it("supports outbound text via facebook send api", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const { connection, conversation } = await createFacebookConversation(
      String(workspace._id)
    );

    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        recipient_id: "fb-user-1",
        message_id: "fb-out-1",
      },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "text",
        text: {
          body: "Thanks for messaging us on Facebook",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");
    expect(response.body.message.externalMessageId).toBe("fb-out-1");

    const refreshedConnection = await models.ChannelConnectionModel.findById(connection._id);
    expect(refreshedConnection?.lastOutboundAt).toBeTruthy();
  });

  it("outbound send failure records message delivery error and marks connection error", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const connection = await createTelegramConnection(String(workspace._id));
    const conversation = await createConversationForConnection(String(workspace._id));

    vi.spyOn(axios, "post").mockRejectedValueOnce(
      new Error("Telegram send_message failed")
    );

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "text",
        text: {
          body: "This send will fail.",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("failed");

    const refreshedConnection = await models.ChannelConnectionModel.findById(
      connection._id
    );
    const failedMessage = await models.MessageModel.findOne({ direction: "outbound" });

    expect(refreshedConnection?.status).toBe("error");
    expect(refreshedConnection?.lastError).toContain("Telegram send_message failed");
    expect(failedMessage?.status).toBe("failed");
  });

  it("send is blocked when no active channel connection exists", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const conversation = await models.ConversationModel.create({
      workspaceId: workspace._id,
      channel: "telegram",
      channelAccountId: "12345",
      externalChatId: "5001",
      externalUserId: "7001",
      status: "open",
      unreadCount: 0,
      aiEnabled: true,
      aiState: "idle",
      tags: [],
    });

    await models.ChannelConnectionModel.create({
      workspaceId: workspace._id,
      channel: "telegram",
      displayName: "Telegram Bot",
      externalAccountId: "12345",
      credentials: {
        botToken: "telegram-token",
        webhookSecret: "telegram-secret",
      },
      webhookConfig: {},
      webhookUrl: "https://unit.test/webhooks/telegram",
      webhookVerified: false,
      verificationState: "pending",
      status: "pending",
      capabilities: adapterRegistry.get("telegram").getCapabilities(),
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "text",
        text: {
          body: "Can I send now?",
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("Channel connection is pending");
  });

  it("after-hours automation sends an automation reply instead of ai", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));
    await configureAfterHoursAutomation(String(workspace._id));
    await models.CannedReplyModel.create({
      workspaceId: String(workspace._id),
      title: "Availability reply",
      body: "Yes, this item is available.",
      triggers: ["available"],
      category: "sales",
    });
    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 9101,
        },
      },
    });

    const response = await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(3001, "Is this available?"));

    expect(response.status).toBe(200);
    await models.InboundBufferModel.updateMany({}, { lastBufferedAt: new Date(0) });
    await inboundBufferService.flushPendingBuffers();

    const messages = await models.MessageModel.find().sort({ createdAt: 1 });
    const automationAudit = await models.AuditLogModel.findOne({
      eventType: "automation.reply.sent",
    });
    const aiAudit = await models.AuditLogModel.findOne({
      eventType: /^ai\./,
    });

    const outboundMessage = messages.find((m) => m.direction === "outbound");
    expect(outboundMessage?.senderType).toBe("automation");
    expect(outboundMessage?.text?.body).toBe("Yes, this item is available.");
    expect(automationAudit).toBeTruthy();
    expect(aiAudit).toBeNull();
  });

  it("canned reply override beats retrieval during after-hours automation", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));
    await configureAfterHoursAutomation(String(workspace._id));
    await models.KnowledgeItemModel.create({
      workspaceId: String(workspace._id),
      title: "Availability article",
      content: "Knowledge says the item is available and ships tomorrow.",
      tags: ["available", "shipping"],
    });
    await models.CannedReplyModel.create({
      workspaceId: String(workspace._id),
      title: "Priority canned availability",
      body: "Canned reply wins for availability questions.",
      triggers: ["available"],
      category: "sales",
    });
    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 9102,
        },
      },
    });

    const response = await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(3501, "Is this available today?"));

    expect(response.status).toBe(200);
    await models.InboundBufferModel.updateMany({}, { lastBufferedAt: new Date(0) });
    await inboundBufferService.flushPendingBuffers();

    const messages = await models.MessageModel.find().sort({ createdAt: 1 });
    const outboundMessage = messages.find((m) => m.direction === "outbound");
    const decisionAudit = await models.AuditLogModel.findOne({
      eventType: "automation.decision.evaluated",
    });

    expect(outboundMessage?.text?.body).toBe("Canned reply wins for availability questions.");
    expect(decisionAudit?.reason).toContain("Matched canned reply trigger");
  });

  it("low-confidence automation escalates to human review and keeps senderType non-ai", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));
    await configureAfterHoursAutomation(String(workspace._id));

    const response = await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(4001, "Can you compare three fabrics and suggest one?"));

    expect(response.status).toBe(200);
    await models.InboundBufferModel.updateMany({}, { lastBufferedAt: new Date(0) });
    await inboundBufferService.flushPendingBuffers();

    const conversation = await models.ConversationModel.findOne();
    const messages = await models.MessageModel.find().sort({ createdAt: 1 });
    const handoffAudit = await models.AuditLogModel.findOne({
      eventType: "automation.handoff.requested",
    });

    expect(conversation?.status).toBe("pending");
    expect(conversation?.tags).toContain("needs_human");
    expect(messages).toHaveLength(1);
    expect(messages[0].senderType).toBe("customer");
    expect(handoffAudit?.reason).toContain("Workspace Gemini API key is not configured");
  });

  it("buffers quick inbound text messages and flushes as one combined AI input", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));
    await configureAfterHoursAutomation(String(workspace._id));
    await models.CannedReplyModel.create({
      workspaceId: String(workspace._id),
      title: "Combine reply",
      body: "Combined reply.",
      triggers: ["combined"],
      category: "sales",
    });

    vi.spyOn(axios, "post").mockResolvedValueOnce({ data: { ok: true, result: { message_id: 9901 } } });

    await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(5001, "Hello"));

    await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(5002, "I need combined"));

    await models.InboundBufferModel.updateMany({}, { lastBufferedAt: new Date(0) });
    await inboundBufferService.flushPendingBuffers();

    const messages = await models.MessageModel.find({}).sort({ createdAt: 1 });
    const outbound = messages.find((msg) => msg.direction === "outbound");
    expect(outbound?.senderType).toBe("automation");
    expect(outbound?.text?.body).toBe("Combined reply.");
  });

  it("extends buffer with new text before expiry", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));
    await configureAfterHoursAutomation(String(workspace._id));

    await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(6001, "part one"));

    await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(6002, "part two"));

    const pending = await models.InboundBufferModel.findOne({ status: "pending" });
    expect(pending).toBeTruthy();
    expect(pending?.combinedText).toContain("part one\npart two");
  });

  it("does not merge non-text inbound messages into text buffer", async () => {
    const workspace = await createWorkspace();
    await createTelegramConnection(String(workspace._id));
    await configureAfterHoursAutomation(String(workspace._id));

    await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send(buildTelegramTextUpdate(7001, "first text"));

    await request(app)
      .post("/webhooks/telegram")
      .set("x-telegram-bot-api-secret-token", "telegram-secret")
      .send({
        update_id: 7002,
        message: {
          message_id: 7002,
          date: fixedTelegramDate,
          chat: { id: 5001 },
          from: { id: 7001, first_name: "Mina" },
          photo: [{ file_id: "photo1", width: 100, height: 100 }],
        },
      });

    const pending = await models.InboundBufferModel.findOne({ status: "pending" });
    expect(pending).toBeFalsy();
  });

  it("supports outbound image via telegram adapter", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const connection = await createTelegramConnection(String(workspace._id));
    const conversation = await createConversationForConnection(String(workspace._id));

    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: { ok: true, result: { message_id: 8801 } },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "image",
        media: [{ url: "https://example.com/img.jpg" }],
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");
  });

  it("marks viber inbound media as temporary with provider ttl expiry", async () => {
    const adapter = adapterRegistry.get("viber");
    const parsed = await adapter.parseInbound({
      event: "message",
      timestamp: Date.now(),
      message_token: "vtok-1",
      sender: { id: "sender-1", name: "Mina" },
      message: {
        type: "picture",
        media: "https://media.viber.example/img.jpg",
        size: 1024,
      },
    });

    expect(parsed).toHaveLength(1);
    const media = parsed[0].media?.[0];
    expect(parsed[0].kind).toBe("image");
    expect(media?.isTemporary).toBe(true);
    expect(media?.expirySource).toBe("provider_ttl");
    expect(media?.expiresAt).toBeInstanceOf(Date);
  });

  it("validates viber outbound image requires url", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const { conversation } = await createViberConnectionAndConversation(String(workspace._id));

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "image",
        media: [{}],
      });

    expect(response.status).toBe(400);
  });

  it("validates viber outbound video requires size", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const { conversation } = await createViberConnectionAndConversation(String(workspace._id));

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "video",
        media: [{ url: "https://assets.example/video.mp4", durationMs: 4000 }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates viber outbound file requires size", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const { conversation } = await createViberConnectionAndConversation(String(workspace._id));

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "file",
        media: [{ url: "https://assets.example/doc.pdf", filename: "doc.pdf" }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("blocks unsupported outbound media kind honestly", async () => {
    const workspace = await createWorkspace();
    const authHeaders = await createAuthHeaders(String(workspace._id));
    const { conversation } = await createViberConnectionAndConversation(String(workspace._id));

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(authHeaders)
      .send({
        senderType: "agent",
        kind: "audio",
        media: [{ url: "https://assets.example/audio.mp3" }],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain("does not support outbound kind audio");
  });
});
