import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
const testDbName = `chatbot_auth_test_${Date.now()}`;

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";

  models = await import("../models");
  await mongoose.connect(`${process.env.MONGO_URL}/${process.env.MONGO_DB}`);
  app = (await import("../app")).createApp();
}, 60000);

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}, 60000);

describe("auth", () => {
  it("register creates user, workspace, owner membership, and bootstrap settings", async () => {
    const response = await request(app).post("/api/auth/register").send({
      name: "Owner",
      email: "owner@test.local",
      password: "SecretPass123",
      workspaceName: "Owner Workspace",
      workspaceSlug: "owner-ws",
      timeZone: "UTC",
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toBeTruthy();
    expect(response.body.workspaces).toHaveLength(1);

    const user = await models.UserModel.findOne({ email: "owner@test.local" });
    const workspace = await models.WorkspaceModel.findOne({ slug: "owner-ws" });
    const membership = await models.WorkspaceMembershipModel.findOne({
      userId: user?._id,
      workspaceId: workspace?._id,
    });
    const aiSettings = await models.AISettingsModel.findOne({ workspaceId: workspace?._id });
    const businessHours = await models.BusinessHoursModel.findOne({ workspaceId: workspace?._id });

    expect(user?.passwordHash).toBeTruthy();
    expect(workspace?.name).toBe("Owner Workspace");
    expect(membership?.role).toBe("owner");
    expect(membership?.status).toBe("active");
    expect(aiSettings).toBeTruthy();
    expect(businessHours).toBeTruthy();
  });

  it("login rejects wrong password", async () => {
    await request(app).post("/api/auth/register").send({
      name: "Owner",
      email: "owner@test.local",
      password: "SecretPass123",
      workspaceName: "Owner Workspace",
      workspaceSlug: "owner-ws",
      timeZone: "UTC",
    });

    const response = await request(app).post("/api/auth/login").send({
      email: "owner@test.local",
      password: "wrong-password",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toContain("Invalid email or password");
  });

  it("authenticated me returns only user workspaces", async () => {
    const registerResponse = await request(app).post("/api/auth/register").send({
      name: "Owner",
      email: "owner@test.local",
      password: "SecretPass123",
      workspaceName: "Owner Workspace",
      workspaceSlug: "owner-ws",
      timeZone: "UTC",
    });

    const ownerUser = await models.UserModel.findOne({ email: "owner@test.local" });
    const anotherWorkspace = await models.WorkspaceModel.create({
      name: "Other",
      slug: "other-ws",
      timeZone: "UTC",
    });
    await models.UserModel.create({
      name: "Another",
      email: "another@test.local",
      passwordHash: "hash",
      workspaceIds: [anotherWorkspace._id],
    });

    const meResponse = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${registerResponse.body.token}`);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body.user._id).toBe(String(ownerUser?._id));
    expect(meResponse.body.workspaces).toHaveLength(1);
    expect(meResponse.body.workspaces[0].slug).toBe("owner-ws");
  });
});
