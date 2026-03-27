import crypto from "crypto";
import { env } from "../config/env";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class WorkspaceInviteService {
  createInviteToken() {
    return crypto.randomBytes(24).toString("hex");
  }

  hashInviteToken(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  buildInviteExpiry(from = new Date()) {
    return new Date(from.getTime() + INVITE_TTL_MS);
  }

  buildInviteUrl(token: string) {
    const baseUrl = env.CLIENT_URL.trim();
    if (!baseUrl) {
      return `/accept-invite?token=${encodeURIComponent(token)}`;
    }

    const url = new URL("/accept-invite", baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
  }
}

export const workspaceInviteService = new WorkspaceInviteService();
