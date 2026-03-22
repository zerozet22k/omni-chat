import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
const testDbName = `chatbot_membership_test_${Date.now()}`;

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

describe("workspace memberships", () => {
  it("admin can add staff", async () => {
    const workspace = await models.WorkspaceModel.create({
      name: "Workspace",
      slug: "members-admin-add",
      timeZone: "UTC",
    });

    const headers = await createAuthHeaders({
      workspaceId: String(workspace._id),
      role: "admin",
      email: "admin@test.local",
    });

    const response = await request(app)
      .post(`/api/workspaces/${workspace._id}/members`)
      .set(headers)
      .send({
        email: "staff@test.local",
        name: "Staff",
        role: "staff",
      });

    expect(response.status).toBe(201);
    expect(response.body.membership.role).toBe("staff");
  });

  it("owner can promote staff/admin", async () => {
    const workspace = await models.WorkspaceModel.create({
      name: "Workspace",
      slug: "members-owner-promote",
      timeZone: "UTC",
    });

    const ownerHeaders = await createAuthHeaders({
      workspaceId: String(workspace._id),
      role: "owner",
      email: "owner@test.local",
    });

    const added = await request(app)
      .post(`/api/workspaces/${workspace._id}/members`)
      .set(ownerHeaders)
      .send({
        email: "member@test.local",
        role: "staff",
      });

    const patchResponse = await request(app)
      .patch(`/api/workspaces/${workspace._id}/members/${added.body.membership._id}`)
      .set(ownerHeaders)
      .send({ role: "admin" });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.membership.role).toBe("admin");
  });

  it("last owner cannot be removed accidentally", async () => {
    const workspace = await models.WorkspaceModel.create({
      name: "Workspace",
      slug: "members-last-owner",
      timeZone: "UTC",
    });

    const ownerHeaders = await createAuthHeaders({
      workspaceId: String(workspace._id),
      role: "owner",
      email: "owner@test.local",
    });

    const ownerMembership = await models.WorkspaceMembershipModel.findOne({
      workspaceId: workspace._id,
      role: "owner",
    });

    const response = await request(app)
      .delete(`/api/workspaces/${workspace._id}/members/${ownerMembership?._id}`)
      .set(ownerHeaders);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("last active owner");
  });
});
