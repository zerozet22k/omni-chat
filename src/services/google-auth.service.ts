import axios from "axios";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ValidationError } from "../lib/errors";

type GoogleAuthStatePayload = {
  purpose: "google-auth";
  uiOrigin?: string;
};

type GoogleUserProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const resolveServerBaseUrl = () => {
  if (env.PUBLIC_WEBHOOK_BASE_URL.trim()) {
    return env.PUBLIC_WEBHOOK_BASE_URL.trim().replace(/\/+$/, "");
  }

  return `http://localhost:${env.PORT}`;
};

class GoogleAuthService {
  isConfigured() {
    return (
      env.GOOGLE_CLIENT_ID.trim().length > 0 &&
      env.GOOGLE_CLIENT_SECRET.trim().length > 0
    );
  }

  private getRedirectUri() {
    return `${resolveServerBaseUrl()}/oauth/google/callback`;
  }

  createAuthorizationUrl(params?: { uiOrigin?: string }) {
    if (!this.isConfigured()) {
      throw new ValidationError(
        "Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
      );
    }

    const state = jwt.sign(
      {
        purpose: "google-auth",
        uiOrigin: trimString(params?.uiOrigin) || undefined,
      } satisfies GoogleAuthStatePayload,
      env.JWT_SECRET,
      {
        expiresIn: "10m",
      }
    );

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID.trim());
    authUrl.searchParams.set("redirect_uri", this.getRedirectUri());
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("include_granted_scopes", "true");

    return {
      state,
      authUrl: authUrl.toString(),
      callbackOrigin: new URL(resolveServerBaseUrl()).origin,
    };
  }

  verifyState(state: string) {
    try {
      const decoded = jwt.verify(state, env.JWT_SECRET) as Partial<GoogleAuthStatePayload>;
      if (decoded.purpose !== "google-auth") {
        return null;
      }

      return {
        purpose: "google-auth" as const,
        uiOrigin: trimString(decoded.uiOrigin) || undefined,
      };
    } catch {
      return null;
    }
  }

  async exchangeCodeForProfile(params: { code: string; state: string }) {
    if (!this.isConfigured()) {
      throw new ValidationError(
        "Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
      );
    }

    if (!this.verifyState(params.state)) {
      throw new ValidationError("Google login session is invalid or expired.");
    }

    const body = new URLSearchParams({
      code: params.code,
      client_id: env.GOOGLE_CLIENT_ID.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
      redirect_uri: this.getRedirectUri(),
      grant_type: "authorization_code",
    });

    const tokenResponse = await axios
      .post("https://oauth2.googleapis.com/token", body.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "Google token exchange failed.",
          error instanceof Error ? error.message : error
        );
      });

    const accessToken = trimString(tokenResponse.data?.access_token);
    if (!accessToken) {
      throw new ValidationError("Google did not return an access token.");
    }

    const profileResponse = await axios
      .get("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      .catch((error) => {
        throw new ValidationError(
          "Google profile lookup failed.",
          error instanceof Error ? error.message : error
        );
      });

    const profile = profileResponse.data as Record<string, unknown>;
    const email = trimString(profile.email).toLowerCase();
    const name = trimString(profile.name);
    const sub = trimString(profile.sub);

    if (!sub || !email || !name) {
      throw new ValidationError("Google profile data is incomplete.");
    }

    return {
      sub,
      email,
      emailVerified: profile.email_verified === true,
      name,
      picture: trimString(profile.picture) || undefined,
    } satisfies GoogleUserProfile;
  }
}

export const googleAuthService = new GoogleAuthService();
