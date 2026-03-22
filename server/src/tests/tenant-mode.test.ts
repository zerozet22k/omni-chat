/**
 * Tests for single-tenant and multi-tenant deployment policy enforcement.
 *
 * Phase 3 of the deployment config refactor:
 *   - single-tenant bootstrap: first workspace creation succeeds
 *   - single-tenant block: second workspace creation is rejected
 *   - single-tenant with DEFAULT_WORKSPACE_SLUG: /me returns only pinned workspace
 *   - multi-tenant: multiple workspace registrations succeed
 *   - ALLOW_SELF_SIGNUP=false blocks registration in multi-tenant mode
 *   - ALLOW_WORKSPACE_CREATION=false blocks workspace creation in multi-tenant mode
 */

import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const testDbName = `chatbot_tenant_test_${Date.now()}`;

/**
 * Reset env and re-import the app so each test group can exercise a different
 * tenant-mode configuration.  We use dynamic import + module invalidation via
 * a unique DB name so tests run in full isolation.
 */
const buildApp = async (extraEnv: Record<string, string> = {}) => {
  // Apply env overrides BEFORE any module under test reads env.
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";
  process.env.FIELD_ENCRYPTION_KEY = "test-encryption-key-32-bytes!!!";

  for (const [key, value] of Object.entries(extraEnv)) {
    process.env[key] = value;
  }

  return (await import("../app")).createApp();
};

beforeAll(async () => {
  await mongoose.connect(
    `mongodb://localhost:27017/${testDbName}`
  );
}, 60000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((col) => col.deleteMany({}))
  );
  // Reset tenant-mode env between tests.
  delete process.env.APP_TENANT_MODE;
  delete process.env.ALLOW_SELF_SIGNUP;
  delete process.env.ALLOW_WORKSPACE_CREATION;
  delete process.env.DEFAULT_WORKSPACE_SLUG;
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}, 60000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const registerPayload = (suffix: string) => ({
  name: `Owner ${suffix}`,
  email: `owner-${suffix}@test.local`,
  password: "SecretPass123",
  workspaceName: `Workspace ${suffix}`,
  workspaceSlug: `ws-${suffix}`,
  timeZone: "UTC",
});

// ---------------------------------------------------------------------------
// single-tenant mode
// ---------------------------------------------------------------------------

describe("single-tenant mode", () => {
  it("allows first workspace bootstrap", async () => {
    const app = await buildApp({ APP_TENANT_MODE: "single" });

    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("alpha"));

    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].slug).toBe("ws-alpha");
  });

  it("blocks a second workspace registration after bootstrap", async () => {
    const app = await buildApp({ APP_TENANT_MODE: "single" });

    // Bootstrap first workspace.
    await request(app).post("/api/auth/register").send(registerPayload("first"));

    // Attempt a second registration.
    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("second"));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/single-tenant/i);
  });

  it("forces DEFAULT_WORKSPACE_SLUG in /me response", async () => {
    const app = await buildApp({ APP_TENANT_MODE: "single" });

    const reg = await request(app)
      .post("/api/auth/register")
      .send({ ...registerPayload("pin"), workspaceSlug: "pinned-ws" });

    expect(reg.status).toBe(200);

    // Set the default slug env and re-build the app.
    const app2 = await buildApp({
      APP_TENANT_MODE: "single",
      DEFAULT_WORKSPACE_SLUG: "pinned-ws",
    });

    const me = await request(app2)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${reg.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.workspaces).toHaveLength(1);
    expect(me.body.workspaces[0].slug).toBe("pinned-ws");
    expect(me.body.deployment.tenantMode).toBe("single");
  });
});

// ---------------------------------------------------------------------------
// multi-tenant mode
// ---------------------------------------------------------------------------

describe("multi-tenant mode (default)", () => {
  it("allows multiple distinct workspace registrations", async () => {
    const app = await buildApp({ APP_TENANT_MODE: "multi" });

    const res1 = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("mx1"));
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("mx2"));
    expect(res2.status).toBe(200);
    expect(res2.body.workspaces[0].slug).toBe("ws-mx2");
  });

  it("blocks registration when ALLOW_SELF_SIGNUP=false", async () => {
    const app = await buildApp({
      APP_TENANT_MODE: "multi",
      ALLOW_SELF_SIGNUP: "false",
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("blocked"));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/self-registration is disabled/i);
  });

  it("blocks registration when ALLOW_WORKSPACE_CREATION=false", async () => {
    const app = await buildApp({
      APP_TENANT_MODE: "multi",
      ALLOW_WORKSPACE_CREATION: "false",
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("blockedws"));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/workspace creation is disabled/i);
  });

  it("exposes deployment config in /me response", async () => {
    const app = await buildApp({ APP_TENANT_MODE: "multi" });

    const reg = await request(app)
      .post("/api/auth/register")
      .send(registerPayload("depconf"));

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${reg.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.deployment.tenantMode).toBe("multi");
    expect(me.body.deployment.allowSignup).toBe(true);
  });
});
