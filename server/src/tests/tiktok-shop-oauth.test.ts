import axios from "axios";
import mongoose from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let app: import("express").Express;

const loadApp = async () => {
  mongoose.deleteModel(/.+/);
  vi.resetModules();
  app = (await import("../app")).createApp();
};

beforeEach(() => {
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.JWT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-secret";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://unit.test";
  delete process.env.TIKTOK_SHOP_APP_KEY;
  delete process.env.TIKTOK_SHOP_APP_SECRET;
  delete process.env.TIKTOK_SHOP_AUTH_BASE_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tiktok shop oauth callback", () => {
  it("captures the auth code even when token exchange is not configured", async () => {
    await loadApp();

    const response = await request(app)
      .get("/oauth/tiktok-shop/callback")
      .query({
        code: "test-auth-code",
        state: "workspace-1",
        format: "json",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      stage: "callback_received",
      state: "workspace-1",
      code: "test-auth-code",
      redirectUrl: "https://unit.test/oauth/tiktok-shop/callback",
      tokenExchange: {
        configured: false,
        message:
          "Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET on the server to exchange this code automatically.",
      },
    });
  });

  it("returns a clear authorization error payload", async () => {
    await loadApp();

    const response = await request(app)
      .get("/oauth/tiktok-shop/callback")
      .query({
        error: "auth_denied",
        state: "workspace-1",
        format: "json",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      stage: "authorization_denied",
      error: "auth_denied",
      errorDescription: "TikTok Shop authorization was rejected.",
      state: "workspace-1",
      code: null,
      redirectUrl: "https://unit.test/oauth/tiktok-shop/callback",
    });
  });

  it("exchanges the auth code when TikTok Shop app credentials are configured", async () => {
    process.env.TIKTOK_SHOP_APP_KEY = "shop-app-key";
    process.env.TIKTOK_SHOP_APP_SECRET = "shop-app-secret";
    await loadApp();

    const getSpy = vi.spyOn(axios, "get").mockResolvedValueOnce({
      data: {
        code: 0,
        message: "success",
        request_id: "req-1",
        data: {
          access_token: "access-token-1",
          access_token_expire_in: 1735689600,
          refresh_token: "refresh-token-1",
          refresh_token_expire_in: 1738291200,
          open_id: "open-id-1",
          seller_name: "Test Seller",
          seller_base_region: "US",
          user_type: 0,
          granted_scopes: ["seller.order.read"],
        },
      },
    } as never);

    const response = await request(app)
      .get("/oauth/tiktok-shop/callback")
      .query({
        code: "test-auth-code",
        state: "workspace-1",
        format: "json",
      });

    expect(response.status).toBe(200);
    expect(getSpy).toHaveBeenCalledWith(
      "https://auth.tiktok-shops.com/api/v2/token/get",
      {
        params: {
          app_key: "shop-app-key",
          app_secret: "shop-app-secret",
          auth_code: "test-auth-code",
          grant_type: "authorized_code",
        },
        timeout: 15000,
      }
    );
    expect(response.body).toEqual({
      ok: true,
      stage: "token_exchanged",
      state: "workspace-1",
      code: "test-auth-code",
      redirectUrl: "https://unit.test/oauth/tiktok-shop/callback",
      tokenExchange: {
        configured: true,
      },
      tokens: {
        accessToken: "access-token-1",
        accessTokenExpiresAt: "2025-01-01T00:00:00.000Z",
        refreshToken: "refresh-token-1",
        refreshTokenExpiresAt: "2025-01-31T02:40:00.000Z",
        openId: "open-id-1",
        sellerName: "Test Seller",
        sellerBaseRegion: "US",
        userType: 0,
        grantedScopes: ["seller.order.read"],
      },
    });
  });
});
