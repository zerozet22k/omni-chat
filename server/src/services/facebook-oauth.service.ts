import { randomUUID } from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { IntegrationNotReadyError, ValidationError } from "../lib/errors";

type PendingFacebookOAuthState = {
  workspaceId: string;
  createdAt: number;
};

type FacebookPageAccount = {
  id?: string;
  name?: string;
  access_token?: string;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

class FacebookOAuthService {
  private readonly stateStore = new Map<string, PendingFacebookOAuthState>();

  private readonly stateTtlMs = 10 * 60 * 1000;

  createAuthorizationUrl(workspaceId: string) {
    const appId = trimString(env.META_APP_ID);
    const appSecret = trimString(env.META_APP_SECRET);
    const redirectUrl = this.getRedirectUrl();

    if (!appId || !appSecret || !redirectUrl) {
      throw new IntegrationNotReadyError(
        "Facebook OAuth is not configured. Set META_APP_ID, META_APP_SECRET, and PUBLIC_WEBHOOK_BASE_URL."
      );
    }

    this.pruneExpiredStates();

    const state = randomUUID();
    this.stateStore.set(state, {
      workspaceId,
      createdAt: Date.now(),
    });

    const oauthUrl = new URL("https://www.facebook.com/v19.0/dialog/oauth");
    oauthUrl.searchParams.set("client_id", appId);
    oauthUrl.searchParams.set("redirect_uri", redirectUrl);
    oauthUrl.searchParams.set("state", state);
    oauthUrl.searchParams.set(
      "scope",
      "pages_show_list,pages_manage_metadata,pages_messaging"
    );

    return {
      state,
      authUrl: oauthUrl.toString(),
      callbackOrigin: new URL(redirectUrl).origin,
    };
  }

  async exchangeCodeForPages(params: {
    workspaceId: string;
    state: string;
    code: string;
  }) {
    const appId = trimString(env.META_APP_ID);
    const appSecret = trimString(env.META_APP_SECRET);
    const redirectUrl = this.getRedirectUrl();

    if (!appId || !appSecret || !redirectUrl) {
      throw new IntegrationNotReadyError(
        "Facebook OAuth is not configured. Set META_APP_ID, META_APP_SECRET, and PUBLIC_WEBHOOK_BASE_URL."
      );
    }

    const state = trimString(params.state);
    const code = trimString(params.code);
    if (!state || !code) {
      throw new ValidationError("Facebook OAuth state and code are required");
    }

    this.pruneExpiredStates();

    const pendingState = this.stateStore.get(state);
    if (!pendingState) {
      throw new ValidationError("Facebook OAuth state is invalid or expired");
    }

    if (pendingState.workspaceId !== params.workspaceId) {
      throw new ValidationError("Facebook OAuth state does not match this workspace");
    }

    this.stateStore.delete(state);

    const tokenResponse = await axios
      .get("https://graph.facebook.com/v19.0/oauth/access_token", {
        params: {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUrl,
          code,
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "Facebook OAuth token exchange failed",
          error instanceof Error ? error.message : error
        );
      });

    const userAccessToken = trimString(tokenResponse.data?.access_token);
    if (!userAccessToken) {
      throw new ValidationError("Facebook OAuth token exchange failed");
    }

    const pagesResponse = await axios
      .get("https://graph.facebook.com/v19.0/me/accounts", {
        params: {
          fields: "id,name,access_token",
          access_token: userAccessToken,
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "Unable to fetch Facebook pages for this account",
          error instanceof Error ? error.message : error
        );
      });

    const pages = Array.isArray(pagesResponse.data?.data)
      ? (pagesResponse.data.data as FacebookPageAccount[])
      : [];

    return pages
      .map((page) => ({
        id: trimString(page.id),
        name: trimString(page.name),
        accessToken: trimString(page.access_token),
      }))
      .filter((page) => page.id && page.accessToken);
  }

  getRedirectUrl() {
    const baseUrl = trimString(env.PUBLIC_WEBHOOK_BASE_URL).replace(/\/+$/, "");
    if (!baseUrl) {
      return "";
    }

    return `${baseUrl}/oauth/facebook/callback`;
  }

  private pruneExpiredStates() {
    const now = Date.now();
    for (const [state, value] of this.stateStore.entries()) {
      if (now - value.createdAt > this.stateTtlMs) {
        this.stateStore.delete(state);
      }
    }
  }
}

export const facebookOAuthService = new FacebookOAuthService();
