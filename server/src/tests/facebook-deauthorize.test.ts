import { createHmac } from "crypto";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let app: import("express").Express;
const testDbName = `chatbot_facebook_deauthorize_test_${Date.now()}`;

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

describe("facebook deauthorize callback", () => {
  it("accepts a signed request", async () => {
    const signedRequest = buildSignedRequest(
      {
        algorithm: "HMAC-SHA256",
        issued_at: 1710000000,
        user_id: "facebook-app-user-123",
      },
      process.env.META_APP_SECRET || ""
    );

    const response = await request(app)
      .post("/meta/deauthorize/facebook")
      .type("form")
      .send({ signed_request: signedRequest });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
  });
});
