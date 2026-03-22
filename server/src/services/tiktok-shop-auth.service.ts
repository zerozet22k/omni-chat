import axios, { AxiosResponse } from "axios";
import { env } from "../config/env";
import { ValidationError } from "../lib/errors";

type TikTokShopEnvelope<T> = {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
};

type TikTokShopTokenData = {
  access_token?: string;
  access_token_expire_in?: number;
  refresh_token?: string;
  refresh_token_expire_in?: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
  user_type?: number;
  granted_scopes?: string[];
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const normalizeScopes = (value: unknown) =>
  Array.isArray(value)
    ? value.map((item) => trimString(item)).filter(Boolean)
    : [];

const extractApiMessage = (
  payload: TikTokShopEnvelope<unknown> | undefined,
  fallback: string
) => {
  const message = trimString(payload?.message);
  return message || fallback;
};

class TikTokShopAuthService {
  getRedirectUrl() {
    const baseUrl = trimString(env.PUBLIC_WEBHOOK_BASE_URL).replace(/\/+$/, "");
    if (!baseUrl) {
      return "";
    }

    return `${baseUrl}/oauth/tiktok-shop/callback`;
  }

  hasAppConfig() {
    return !!trimString(env.TIKTOK_SHOP_APP_KEY) && !!trimString(env.TIKTOK_SHOP_APP_SECRET);
  }

  async exchangeAuthorizationCode(authCode: string) {
    const normalizedCode = trimString(authCode);
    if (!normalizedCode || normalizedCode.toLowerCase() === "null") {
      throw new ValidationError("TikTok Shop authorization code is missing.");
    }

    const data = await this.getJson<TikTokShopTokenData>("/api/v2/token/get", {
      app_key: this.getAppKeyOrThrow(),
      app_secret: this.getAppSecretOrThrow(),
      auth_code: normalizedCode,
      grant_type: "authorized_code",
    });

    return this.normalizeTokenData(data);
  }

  async refreshAccessToken(refreshToken: string) {
    const normalizedRefreshToken = trimString(refreshToken);
    if (!normalizedRefreshToken) {
      throw new ValidationError("TikTok Shop refresh token is missing.");
    }

    const data = await this.getJson<TikTokShopTokenData>("/api/v2/token/refresh", {
      app_key: this.getAppKeyOrThrow(),
      app_secret: this.getAppSecretOrThrow(),
      refresh_token: normalizedRefreshToken,
      grant_type: "refresh_token",
    });

    return this.normalizeTokenData(data);
  }

  private normalizeTokenData(data: TikTokShopTokenData) {
    return {
      accessToken: trimString(data.access_token),
      accessTokenExpiresAt:
        typeof data.access_token_expire_in === "number"
          ? new Date(data.access_token_expire_in * 1000).toISOString()
          : null,
      refreshToken: trimString(data.refresh_token),
      refreshTokenExpiresAt:
        typeof data.refresh_token_expire_in === "number"
          ? new Date(data.refresh_token_expire_in * 1000).toISOString()
          : null,
      openId: trimString(data.open_id),
      sellerName: trimString(data.seller_name),
      sellerBaseRegion: trimString(data.seller_base_region),
      userType: typeof data.user_type === "number" ? data.user_type : null,
      grantedScopes: normalizeScopes(data.granted_scopes),
    };
  }

  private async getJson<T>(path: string, params: Record<string, string>) {
    const response = await axios.get<
      TikTokShopEnvelope<T>,
      AxiosResponse<TikTokShopEnvelope<T>>
    >(`${this.getAuthBaseUrl()}${path}`, {
      params,
      timeout: 15000,
    });

    if (response.data?.code !== 0) {
      throw new ValidationError(
        extractApiMessage(response.data, "TikTok Shop token exchange failed"),
        {
          requestId: response.data?.request_id,
          responseCode: response.data?.code,
        }
      );
    }

    return (response.data?.data ?? {}) as T;
  }

  private getAuthBaseUrl() {
    return trimString(env.TIKTOK_SHOP_AUTH_BASE_URL).replace(/\/+$/, "");
  }

  private getAppKeyOrThrow() {
    const appKey = trimString(env.TIKTOK_SHOP_APP_KEY);
    if (!appKey) {
      throw new ValidationError(
        "TikTok Shop OAuth is not configured on the server. Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET."
      );
    }

    return appKey;
  }

  private getAppSecretOrThrow() {
    const appSecret = trimString(env.TIKTOK_SHOP_APP_SECRET);
    if (!appSecret) {
      throw new ValidationError(
        "TikTok Shop OAuth is not configured on the server. Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET."
      );
    }

    return appSecret;
  }
}

export const tiktokShopAuthService = new TikTokShopAuthService();
