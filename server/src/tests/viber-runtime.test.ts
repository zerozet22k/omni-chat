import { createHmac } from "crypto";
import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
let adapterRegistry: typeof import("../channels/adapter.registry")["adapterRegistry"];
const testDbName = `chatbot_viber_runtime_test_${Date.now()}`;

const createWorkspace = async () => {
  return models.WorkspaceModel.create({
    name: "Viber Workspace",
    slug: `viber-${Math.random().toString(36).slice(2, 8)}`,
    timeZone: "UTC",
  });
};

const createAuthHeaders = async (workspaceId: string) => {
  const user = await models.UserModel.create({
    email: `viber_${Math.random().toString(36).slice(2, 8)}@test.local`,
    name: "Viber Owner",
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

const signViberPayload = (rawBody: string, token: string) =>
  createHmac("sha256", token).update(rawBody).digest("hex");

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

describe("viber runtime", () => {
  it("successful connect persists webhookUrl with matching connectionKey", async () => {
    const workspace = await createWorkspace();
    const headers = await createAuthHeaders(String(workspace._id));

    vi.spyOn(axios, "post")
      .mockResolvedValueOnce({
        data: {
          status: 0,
          id: "viber-account-1",
          name: "Viber Bot",
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
      .set(headers)
      .send({
        credentials: {
          authToken: "viber-token",
        },
        webhookConfig: {
          connectionKey: "viber-main",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.connection.webhookUrl).toContain(
      "connectionKey=viber-main"
    );

    const stored = await models.ChannelConnectionModel.findOne({
      workspaceId: workspace._id,
      channel: "viber",
    });
    expect(stored?.webhookConfig?.connectionKey).toBe("viber-main");
    expect(stored?.webhookUrl).toContain("connectionKey=viber-main");
  });

  it("inbound webhook resolves connection by connectionKey and returns 200", async () => {
    const workspace = await createWorkspace();

    await models.ChannelConnectionModel.create({
      workspaceId: workspace._id,
      channel: "viber",
      displayName: "Primary Viber",
      externalAccountId: "viber-account-1",
      credentials: { authToken: "viber-token" },
      webhookConfig: { connectionKey: "viber-main" },
      webhookUrl: "https://unit.test/webhooks/viber?connectionKey=viber-main",
      webhookVerified: true,
      verificationState: "verified",
      status: "active",
      capabilities: adapterRegistry.get("viber").getCapabilities(),
    });

    const payload = {
      event: "message",
      timestamp: Date.now(),
      message_token: "m-100",
      sender: {
        id: "user-1",
        name: "Mina",
      },
      message: {
        type: "text",
        text: "Hello from Viber",
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = signViberPayload(rawBody, "viber-token");

    const response = await request(app)
      .post("/webhooks/viber?connectionKey=viber-main")
      .set("content-type", "application/json")
      .set("x-viber-content-signature", signature)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body.processed).toBe(1);

    const message = await models.MessageModel.findOne({
      channel: "viber",
      direction: "inbound",
    });
    expect(message?.text?.body).toBe("Hello from Viber");
  });

  it("missing connectionKey webhook path fails with a clear runtime error", async () => {
    const workspace = await createWorkspace();

    await models.ChannelConnectionModel.create({
      workspaceId: workspace._id,
      channel: "viber",
      displayName: "Primary Viber",
      externalAccountId: "viber-account-1",
      credentials: { authToken: "viber-token" },
      webhookConfig: { connectionKey: "viber-main" },
      webhookUrl: "https://unit.test/webhooks/viber?connectionKey=viber-main",
      webhookVerified: true,
      verificationState: "verified",
      status: "active",
      capabilities: adapterRegistry.get("viber").getCapabilities(),
    });

    const payload = {
      event: "message",
      timestamp: Date.now(),
      message_token: "m-101",
      sender: {
        id: "user-1",
        name: "Mina",
      },
      message: {
        type: "text",
        text: "Hello without key",
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = signViberPayload(rawBody, "viber-token");

    const response = await request(app)
      .post("/webhooks/viber")
      .set("content-type", "application/json")
      .set("x-viber-content-signature", signature)
      .send(rawBody);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("connectionKey is required");
  });

  it("runtime outbound failure persists exact provider status/message in lastError and audit log", async () => {
    const workspace = await createWorkspace();
    const headers = await createAuthHeaders(String(workspace._id));

    const connection = await models.ChannelConnectionModel.create({
      workspaceId: workspace._id,
      channel: "viber",
      displayName: "Primary Viber",
      externalAccountId: "viber-account-1",
      credentials: { authToken: "viber-token" },
      webhookConfig: { connectionKey: "viber-main" },
      webhookUrl: "https://unit.test/webhooks/viber?connectionKey=viber-main",
      webhookVerified: true,
      verificationState: "verified",
      status: "active",
      capabilities: adapterRegistry.get("viber").getCapabilities(),
    });

    const conversation = await models.ConversationModel.create({
      workspaceId: workspace._id,
      channel: "viber",
      channelAccountId: String(connection.externalAccountId),
      externalChatId: "chat-1",
      status: "open",
      unreadCount: 0,
      aiEnabled: true,
      aiState: "idle",
      tags: [],
    });

    vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        status: 5,
        status_message: "receiver is not subscribed",
      },
    });

    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/messages`)
      .set(headers)
      .send({
        senderType: "agent",
        kind: "text",
        text: { body: "Hello there" },
      });

    expect(response.status).toBe(201);
    expect(response.body.delivery.status).toBe("failed");

    const refreshed = await models.ChannelConnectionModel.findById(connection._id);
    expect(refreshed?.lastError).toContain("status=5");
    expect(refreshed?.lastError).toContain("receiver is not subscribed");

    const audit = await models.AuditLogModel.findOne({
      eventType: "message.outbound.failed",
    });
    expect(audit?.reason).toContain("status=5");
    expect(audit?.reason).toContain("receiver is not subscribed");
  });
});
