/**
 * Tests for workspace-owned Gemini AI config override.
 *
 * Covers:
 *   1. Workspace Gemini key is required for generateReply
 *   2. Workspace Gemini override is used when provided
 *   3. Feature is unavailable when no workspace key exists
 *   4. GET /api/ai-settings never exposes raw geminiApiKey — only hasGeminiApiKey
 *   5. PATCH /api/ai-settings encrypts the key before storing
 *   6. Stored ciphertext is not the same as the plaintext key
 */

import axios from "axios";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../config/env";
import { encryptField, decryptField } from "../lib/crypto";
import { aiReplyService } from "../services/ai-reply.service";

const testDbName = `chatbot_ai_override_test_${Date.now()}`;

let app: import("express").Express;
let models: typeof import("../models");

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";
  process.env.FIELD_ENCRYPTION_KEY = "test-encryption-key-32-bytes!!!";
  process.env.APP_TENANT_MODE = "multi";

  models = await import("../models");
  await mongoose.connect(`${process.env.MONGO_URL}/${process.env.MONGO_DB}`);
  app = (await import("../app")).createApp();
}, 60000);

beforeEach(async () => {
  vi.restoreAllMocks();
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((col) => col.deleteMany({}))
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}, 60000);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const registerAndLogin = async () => {
  const reg = await request(app).post("/api/auth/register").send({
    name: "Owner",
    email: "owner@ai-test.local",
    password: "SecretPass123",
    workspaceName: "AI Test Workspace",
    workspaceSlug: "ai-test-ws",
    timeZone: "UTC",
  });
  expect(reg.status).toBe(200);
  return reg.body as {
    token: string;
    activeWorkspaceId: string;
    workspaces: Array<{ _id: string; slug: string }>;
  };
};

// ---------------------------------------------------------------------------
// encryption utility
// ---------------------------------------------------------------------------

describe("encryptField / decryptField", () => {
  it("round-trips plaintext correctly", () => {
    const secret = "test-encryption-key-32-bytes!!!";
    const plaintext = "super-secret-gemini-api-key";
    const ciphertext = encryptField(plaintext, secret);

    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);

    const decrypted = decryptField(ciphertext, secret);
    expect(decrypted).toBe(plaintext);
  });

  it("returns empty string for empty inputs", () => {
    expect(encryptField("", "secret")).toBe("");
    expect(encryptField("plaintext", "")).toBe("");
    expect(decryptField("", "secret")).toBe("");
    expect(decryptField("ciphertext", "")).toBe("");
  });

  it("returns empty string when decrypting with wrong key", () => {
    const ciphertext = encryptField("secret-key", "correct-secret-key-long-enough");
    const result = decryptField(ciphertext, "wrong-secret-key-long-enough!!!!");
    expect(result).toBe("");
  });

  it("stores different ciphertext each call (random IV)", () => {
    const secret = "test-encryption-key-32-bytes!!!";
    const plaintext = "same-plaintext";
    const ct1 = encryptField(plaintext, secret);
    const ct2 = encryptField(plaintext, secret);
    expect(ct1).not.toBe(ct2);
  });
});

// ---------------------------------------------------------------------------
// AI settings API — key masking
// ---------------------------------------------------------------------------

describe("GET /api/ai-settings — key masking", () => {
  it("returns hasGeminiApiKey=false when no key is set", async () => {
    const { token, activeWorkspaceId } = await registerAndLogin();

    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId);

    expect(res.status).toBe(200);
    expect(res.body.settings.hasGeminiApiKey).toBe(false);
    expect(res.body.settings).not.toHaveProperty("geminiApiKey");
  });

  it("returns hasGeminiApiKey=true after setting a key, without exposing the raw key", async () => {
    const { token, activeWorkspaceId } = await registerAndLogin();

    await request(app)
      .patch("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId)
      .send({ geminiApiKey: "workspace-secret-key" });

    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId);

    expect(res.status).toBe(200);
    expect(res.body.settings.hasGeminiApiKey).toBe(true);
    // The raw key must never appear in the API response.
    expect(res.body.settings).not.toHaveProperty("geminiApiKey");
    expect(JSON.stringify(res.body)).not.toContain("workspace-secret-key");
  });

  it("stores the key encrypted (ciphertext !== plaintext)", async () => {
    const { token, activeWorkspaceId } = await registerAndLogin();
    const workspaceId = activeWorkspaceId;

    await request(app)
      .patch("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId)
      .send({ geminiApiKey: "my-raw-gemini-key" });

    const dbRecord = await models.AISettingsModel.findOne({ workspaceId });
    expect(dbRecord?.geminiApiKey).toBeTruthy();
    expect(dbRecord?.geminiApiKey).not.toBe("my-raw-gemini-key");
  });

  it("clears the key when an empty string is patched", async () => {
    const { token, activeWorkspaceId } = await registerAndLogin();

    await request(app)
      .patch("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId)
      .send({ geminiApiKey: "temporary-key" });

    await request(app)
      .patch("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId)
      .send({ geminiApiKey: "" });

    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId);

    expect(res.body.settings.hasGeminiApiKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AI settings API — geminiModel override
// ---------------------------------------------------------------------------

describe("PATCH /api/ai-settings — model override", () => {
  it("stores and returns geminiModel", async () => {
    const { token, activeWorkspaceId } = await registerAndLogin();

    await request(app)
      .patch("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId)
      .send({ geminiModel: "gemini-workspace-model" });

    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", activeWorkspaceId);

    expect(res.body.settings.geminiModel).toBe("gemini-workspace-model");
  });
});

// ---------------------------------------------------------------------------
// aiReplyService — key resolution
// ---------------------------------------------------------------------------

describe("aiReplyService — workspace override priority", () => {
  it("uses the default model when a workspace key is provided without a model override", async () => {
    const encryptionSecret = env.FIELD_ENCRYPTION_KEY || env.SESSION_SECRET;
    const encryptedKey = encryptField("workspace-only-key", encryptionSecret);

    const axiosSpy = vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    replyText: "Hello there.",
                    confidence: 0.82,
                    sourceHints: [],
                    reason: "Generated from conversation context",
                  }),
                },
              ],
            },
          },
        ],
      },
    });

    const result = await aiReplyService.generateReply({
      workspaceId: new mongoose.Types.ObjectId().toString(),
      message: {
        channel: "telegram",
        externalChatId: "test-chat",
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: { body: "Hello" },
        raw: {},
        occurredAt: new Date(),
      },
      workspaceAiOverride: {
        encryptedApiKey: encryptedKey,
      },
    });

    expect(result.kind).toBe("knowledge");
    if (result.kind !== "knowledge") {
      throw new Error(`Expected knowledge reply, got ${result.kind}`);
    }
    expect(result.text).toBe("Hello there.");
    expect(String(axiosSpy.mock.calls[0]?.[0])).toContain(`models/${env.GEMINI_MODEL}:generateContent`);
  });

  it("uses workspace override key when provided (raises past key-missing check)", async () => {
    const encryptionSecret = env.FIELD_ENCRYPTION_KEY || env.SESSION_SECRET;
    const encryptedKey = encryptField("workspace-override-key", encryptionSecret);

    const axiosSpy = vi.spyOn(axios, "post").mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    replyText: "Thanks, can you share a bit more detail?",
                    confidence: 0.76,
                    sourceHints: [],
                    reason: "Generated from workspace override",
                  }),
                },
              ],
            },
          },
        ],
      },
    });

    const result = await aiReplyService.generateReply({
      workspaceId: new mongoose.Types.ObjectId().toString(),
      message: {
        channel: "telegram",
        externalChatId: "test-chat",
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: { body: "Hello" },
        raw: {},
        occurredAt: new Date(),
      },
      workspaceAiOverride: {
        encryptedApiKey: encryptedKey,
        modelOverride: "workspace-model",
      },
    });

    expect(result.kind).toBe("knowledge");
    if (result.kind !== "knowledge") {
      throw new Error(`Expected knowledge reply, got ${result.kind}`);
    }
    expect(result.text).toContain("share a bit more detail");
    expect(String(axiosSpy.mock.calls[0]?.[0])).toContain("models/workspace-model:generateContent");
  });

  it("returns key-missing reason when no workspace key is present", async () => {
    const axiosSpy = vi.spyOn(axios, "post");

    const result = await aiReplyService.generateReply({
      workspaceId: new mongoose.Types.ObjectId().toString(),
      message: {
        channel: "telegram",
        externalChatId: "test-chat",
        direction: "inbound",
        senderType: "customer",
        kind: "text",
        text: { body: "Hello" },
        raw: {},
        occurredAt: new Date(),
      },
      workspaceAiOverride: undefined,
    });

    expect(result.kind).toBe("low_confidence");
    expect(result.reason).toMatch(/Workspace Gemini API key is not configured/i);
    expect(axiosSpy).not.toHaveBeenCalled();
  });
});
