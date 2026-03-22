import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
const testDbName = `chatbot_authorization_test_${Date.now()}`;

const createAuthHeaders = async (params: {
  workspaceId: string;
  role: "owner" | "admin" | "staff";
  email: string;
}) => {
  const user = await models.UserModel.create({
    email: params.email,
    name: params.email.split("@")[0],
    passwordHash: "hashed",
    role: params.role,
    workspaceIds: [params.workspaceId],
  });

  await models.WorkspaceMembershipModel.create({
    workspaceId: params.workspaceId,
    userId: user._id,
    role: params.role,
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
    "x-workspace-id": params.workspaceId,
  };
};

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";

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

describe("authorization", () => {
  it("non-member cannot access workspace resources", async () => {
    const workspaceA = await models.WorkspaceModel.create({
      name: "A",
      slug: "authz-a",
      timeZone: "UTC",
    });
    const workspaceB = await models.WorkspaceModel.create({
      name: "B",
      slug: "authz-b",
      timeZone: "UTC",
    });

    const ownerHeaders = await createAuthHeaders({
      workspaceId: String(workspaceA._id),
      role: "owner",
      email: "owner@test.local",
    });

    const response = await request(app)
      .get("/api/ai-settings")
      .set({
        ...ownerHeaders,
        "x-workspace-id": String(workspaceB._id),
      })
      .query({ workspaceId: String(workspaceB._id) });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("do not have access");
  });

  it("staff cannot access admin-only routes", async () => {
    const workspace = await models.WorkspaceModel.create({
      name: "Workspace",
      slug: "authz-staff",
      timeZone: "UTC",
    });

    const staffHeaders = await createAuthHeaders({
      workspaceId: String(workspace._id),
      role: "staff",
      email: "staff@test.local",
    });

    const response = await request(app)
      .get("/api/channels")
      .set(staffHeaders)
      .query({ workspaceId: String(workspace._id) });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("permission");
  });
});
