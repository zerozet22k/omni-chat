import { createHmac } from "crypto";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let app: import("express").Express;
let models: typeof import("../models");
const testDbName = `chatbot_facebook_data_deletion_test_${Date.now()}`;

const encodeBase64Url = (value: string) => Buffer.from(value).toString("base64url");

const buildSignedRequest = (payload: Record<string, unknown>, appSecret: string) => {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", appSecret)
    .update(encodedPayload)
    .digest("base64url");
  return `${signature}.${encodedPayload}`;
};

beforeAll(async () => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGO_URL = "mongodb://localhost:27017";
  process.env.MONGO_DB = testDbName;
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";
  process.env.META_APP_ID = "meta-app-id";
  process.env.META_APP_SECRET = "meta-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "meta-verify-token";

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

describe("facebook data deletion callback", () => {
  it("accepts a signed request and returns a status URL with a confirmation code", async () => {
    const signedRequest = buildSignedRequest(
      {
        algorithm: "HMAC-SHA256",
        issued_at: 1710000000,
        user_id: "facebook-app-user-123",
      },
      process.env.META_APP_SECRET || ""
    );

    const response = await request(app)
      .post("/meta/data-deletion/facebook")
      .type("form")
      .send({ signed_request: signedRequest });

    expect(response.status).toBe(200);
    expect(response.body.confirmation_code).toMatch(/^fbdel_/);
    expect(response.body.url).toBe(
      `https://unit.test/meta/data-deletion/facebook/status/${response.body.confirmation_code}`
    );

    const record = await models.DataDeletionRequestModel.findOne({
      confirmationCode: response.body.confirmation_code,
    }).lean();

    expect(record?.provider).toBe("facebook");
    expect(record?.providerUserId).toBe("facebook-app-user-123");
    expect(record?.status).toBe("completed");
  });

  it("renders a human-readable status page", async () => {
    const record = await models.DataDeletionRequestModel.create({
      provider: "facebook",
      providerUserId: "facebook-app-user-456",
      confirmationCode: "fbdel_test-code",
      status: "completed",
      summary: "Deletion request recorded.",
    });

    const response = await request(app).get(
      `/meta/data-deletion/facebook/status/${record.confirmationCode}`
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain("Deletion Request Received");
    expect(response.text).toContain(record.confirmationCode);
    expect(response.text).toContain("Deletion request recorded.");
  });
});
