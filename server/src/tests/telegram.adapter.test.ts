import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
let adapterRegistry: typeof import("../channels/adapter.registry")["adapterRegistry"];
const testDbName = `chatbot_telegram_adapter_test_${Date.now()}`;

const createWorkspace = async () => {
  return models.WorkspaceModel.create({
    name: "Telegram Workspace",
    slug: `tg-${Math.random().toString(36).slice(2, 8)}`,
    timeZone: "UTC",
  });
};

const createAuthHeaders = async (workspaceId: string) => {
  const user = await models.UserModel.create({
    email: `tg_${Math.random().toString(36).slice(2, 8)}@test.local`,
    name: "Telegram Owner",
    passwordHash: "hashed-password",
    role: "owner",
    workspaceIds: [workspaceId],
  });

  await models.WorkspaceMembershipModel.create({
    workspaceId,
    userId: user._id,
    role: "owner",
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

const createConversation = async (workspaceId: string, channelAccountId = "12345") => {
  return models.ConversationModel.create({
    workspaceId,
    channel: "telegram",
    channelAccountId,
    externalChatId: "5001",
    externalUserId: "7001",
    status: "open",
    unreadCount: 0,
    aiEnabled: true,
    aiState: "idle",
    tags: [],
  });
};

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";

  models = await import("../models");
  ({ adapterRegistry } = await import("../channels/adapter.registry"));

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

describe("telegram outbound media", () => {
  it("sends image outbound successfully", async () => {
    const workspace = await createWorkspace();
    const headers = await createAuthHeaders(String(workspace._id));
    await createTelegramConnection(String(workspace._id));
    const conversation = await createConversation(String(workspace._id));

    const axiosSpy = vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 8001,
        },
      },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(headers)
      .send({
        senderType: "agent",
        kind: "image",
        media: [{ url: "https://assets.example/pic.jpg" }],
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");

    const [url, payload] = axiosSpy.mock.calls[0];
    expect(String(url)).toContain("/sendPhoto");
    expect(payload).toMatchObject({
      chat_id: "5001",
      photo: "https://assets.example/pic.jpg",
    });
  });

  it("sends video outbound successfully", async () => {
    const workspace = await createWorkspace();
    const headers = await createAuthHeaders(String(workspace._id));
    await createTelegramConnection(String(workspace._id));
    const conversation = await createConversation(String(workspace._id));

    const axiosSpy = vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 8002,
        },
      },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(headers)
      .send({
        senderType: "agent",
        kind: "video",
        media: [{ url: "https://assets.example/video.mp4", size: 1200000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");

    const [url, payload] = axiosSpy.mock.calls[0];
    expect(String(url)).toContain("/sendVideo");
    expect(payload).toMatchObject({
      chat_id: "5001",
      video: "https://assets.example/video.mp4",
    });
  });

  it("sends file outbound successfully", async () => {
    const workspace = await createWorkspace();
    const headers = await createAuthHeaders(String(workspace._id));
    await createTelegramConnection(String(workspace._id));
    const conversation = await createConversation(String(workspace._id));

    const axiosSpy = vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 8003,
        },
      },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(headers)
      .send({
        senderType: "agent",
        kind: "file",
        media: [{ url: "https://assets.example/guide.pdf", filename: "guide.pdf", size: 48000 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("sent");

    const [url, payload] = axiosSpy.mock.calls[0];
    expect(String(url)).toContain("/sendDocument");
    expect(payload).toMatchObject({
      chat_id: "5001",
      document: "https://assets.example/guide.pdf",
    });
  });

  it("blocks unsupported interactive kind via capability gate", async () => {
    const workspace = await createWorkspace();
    const headers = await createAuthHeaders(String(workspace._id));
    await createTelegramConnection(String(workspace._id));
    const conversation = await createConversation(String(workspace._id));

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(headers)
      .send({
        senderType: "agent",
        kind: "interactive",
        text: { body: "Choose an option" },
        interactive: {
          subtype: "quick_reply",
          label: "A",
          value: "a",
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain("does not support outbound kind interactive");
  });
});
