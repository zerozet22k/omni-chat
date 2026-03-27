import { randomUUID } from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { IntegrationNotReadyError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";

type PendingFacebookOAuthState = {
  workspaceId: string;
  redirectUrl: string;
  uiOrigin: string;
  attemptId: string;
  createdAt: number;
};

type FacebookPageAccount = {
  id?: string;
  name?: string;
  access_token?: string;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const summarizeError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    return {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
  };
};

class FacebookOAuthService {
  private readonly stateStore = new Map<string, PendingFacebookOAuthState>();

  private readonly stateTtlMs = 10 * 60 * 1000;

  createAuthorizationUrl(params: { workspaceId: string; uiOrigin?: string }) {
    const workspaceId = trimString(params.workspaceId);
    const uiOrigin = trimString(params.uiOrigin);
    const appId = trimString(env.META_APP_ID);
    const appSecret = trimString(env.META_APP_SECRET);
    const redirectUrl = this.getRedirectUrl();
    const loginConfigId = trimString(env.META_LOGIN_CONFIG_ID);

    if (!appId || !appSecret || !redirectUrl) {
      throw new IntegrationNotReadyError(
        "Facebook OAuth is not configured. Set META_APP_ID, META_APP_SECRET, and PUBLIC_WEBHOOK_BASE_URL."
      );
    }

    this.pruneExpiredStates();

    const state = randomUUID();
    const attemptId = randomUUID();
    this.stateStore.set(state, {
      workspaceId,
      redirectUrl,
      uiOrigin,
      attemptId,
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
    // Support Facebook Login for Business when configured. This repo can run
    // with plain OAuth scopes only, and optionally include config_id.
    if (loginConfigId) {
      oauthUrl.searchParams.set("config_id", loginConfigId);
    }

    logger.info("Facebook OAuth start URL generated", {
      workspaceId,
      state,
      attemptId,
      redirectUrl,
      callbackOrigin: new URL(redirectUrl).origin,
      hasLoginConfigId: !!loginConfigId,
      uiOrigin: uiOrigin || null,
      scopes: "pages_show_list,pages_manage_metadata,pages_messaging",
    });

    return {
      state,
      attemptId,
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
    const configuredRedirectUrl = this.getRedirectUrl();

    if (!appId || !appSecret || !configuredRedirectUrl) {
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
      logger.warn("Facebook OAuth exchange rejected due to invalid/expired state", {
        workspaceId: params.workspaceId,
        state,
      });
      throw new ValidationError("Facebook OAuth state is invalid or expired");
    }

    if (pendingState.workspaceId !== params.workspaceId) {
      logger.warn("Facebook OAuth exchange workspace mismatch", {
        expectedWorkspaceId: pendingState.workspaceId,
        actualWorkspaceId: params.workspaceId,
        state,
        attemptId: pendingState.attemptId,
      });
      throw new ValidationError("Facebook OAuth state does not match this workspace");
    }

    const redirectUrl = pendingState.redirectUrl || configuredRedirectUrl;

    logger.info("Facebook OAuth state verified", {
      workspaceId: params.workspaceId,
      state,
      attemptId: pendingState.attemptId,
      redirectUrl,
    });

    this.stateStore.delete(state);

    let tokenResponse;
    try {
      tokenResponse = await axios.get(
        "https://graph.facebook.com/v19.0/oauth/access_token",
        {
          params: {
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: redirectUrl,
            code,
          },
        }
      );
    } catch (error) {
      logger.error("Facebook OAuth token exchange failed", {
        workspaceId: params.workspaceId,
        state,
        attemptId: pendingState.attemptId,
        redirectUrl,
        error: summarizeError(error),
      });
      throw new ValidationError(
        "Facebook OAuth token exchange failed",
        summarizeError(error)
      );
    }

    logger.info("Facebook OAuth token exchange succeeded", {
      workspaceId: params.workspaceId,
      state,
      attemptId: pendingState.attemptId,
      redirectUrl,
      hasUserAccessToken: !!trimString(tokenResponse.data?.access_token),
    });

    const userAccessToken = trimString(tokenResponse.data?.access_token);
    if (!userAccessToken) {
      throw new ValidationError("Facebook OAuth token exchange failed");
    }

    let pagesResponse;
    try {
      pagesResponse = await axios.get("https://graph.facebook.com/v19.0/me/accounts", {
        params: {
          fields: "id,name,access_token",
          access_token: userAccessToken,
        },
      });
    } catch (error) {
      logger.error("Facebook OAuth page fetch failed", {
        workspaceId: params.workspaceId,
        state,
        attemptId: pendingState.attemptId,
        error: summarizeError(error),
      });
      throw new ValidationError(
        "Unable to fetch Facebook pages for this account",
        summarizeError(error)
      );
    }

    const pages = Array.isArray(pagesResponse.data?.data)
      ? (pagesResponse.data.data as FacebookPageAccount[])
      : [];

    logger.info("Facebook OAuth pages response received", {
      workspaceId: params.workspaceId,
      state,
      attemptId: pendingState.attemptId,
      returnedPages: pages.length,
      pagesWithPageToken: pages.filter((page) => !!trimString(page.access_token)).length,
    });

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
