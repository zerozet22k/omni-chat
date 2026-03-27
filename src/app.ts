import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { errorHandler } from "./middleware/error-handler";
import { authenticate } from "./middleware/authenticate";
import { logger } from "./lib/logger";
import authRoutes from "./routes/api/auth";
import accountRoutes from "./routes/api/account";
import portalRoutes from "./routes/api/portal";
import aiSettingsRoutes from "./routes/api/ai-settings";
import auditLogsRoutes from "./routes/api/audit-logs";
import automationsRoutes from "./routes/api/automations";
import cannedRepliesRoutes from "./routes/api/canned-replies";
import channelsRoutes from "./routes/api/channels";
import contactsRoutes from "./routes/api/contacts";
import conversationsRoutes from "./routes/api/conversations";
import knowledgeRoutes from "./routes/api/knowledge";
import workspaceMembersRoutes from "./routes/api/workspace-members";
import workspaceProfileRoutes from "./routes/api/workspace-profile";
import billingRequestsRoutes from "./routes/api/billing-requests";
import billingRoutes from "./routes/api/billing";
import mediaAssetsRoutes from "./routes/api/media-assets";
import stickersRoutes from "./routes/api/stickers";
import mediaAssetContentRoutes from "./routes/public/media-assets";
import googleOAuthRoutes from "./routes/public/google-oauth";
import stickerPreviewRoutes from "./routes/public/sticker-previews";
import lineMediaRoutes from "./routes/public/line-media";
import tiktokMediaRoutes from "./routes/public/tiktok-media";
import tiktokShopOAuthRoutes from "./routes/public/tiktok-shop-oauth";
import facebookOAuthRoutes from "./routes/public/facebook-oauth";
import workspacePublicRoutes from "./routes/public/workspace-public";
import metaDataDeletionRoutes from "./routes/public/meta-data-deletion";
import metaDeauthorizeRoutes from "./routes/public/meta-deauthorize";
import facebookWebhookRoutes from "./routes/webhooks/facebook";
import instagramWebhookRoutes from "./routes/webhooks/instagram";
import lineWebhookRoutes from "./routes/webhooks/line";
import stripeWebhookRoutes from "./routes/webhooks/stripe";
import telegramWebhookRoutes from "./routes/webhooks/telegram";
import tiktokWebhookRoutes from "./routes/webhooks/tiktok";
import viberWebhookRoutes from "./routes/webhooks/viber";
import websiteWebhookRoutes from "./routes/webhooks/website";

export const createApp = () => {
  const app = express();

  const localhostHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const extractEmbeddedIpv4Host = (hostname: string) => {
    const lowered = hostname.toLowerCase();
    const embeddedMatch = lowered.match(
      /^((?:\d{1,3}\.){3}\d{1,3})\.(?:nip|sslip)\.io$/
    );
    return embeddedMatch?.[1] ?? null;
  };

  const isPrivateIpv4Host = (hostname: string) => {
    if (/^10\./.test(hostname)) {
      return true;
    }

    if (/^192\.168\./.test(hostname)) {
      return true;
    }

    const match = hostname.match(/^172\.(\d{1,3})\./);
    if (!match) {
      return false;
    }

    const secondOctet = Number(match[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  };

  const isLocalNetworkOrigin = (value: string) => {
    try {
      const url = new URL(value);
      const normalizedHost = extractEmbeddedIpv4Host(url.hostname) ?? url.hostname;
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (localhostHosts.has(normalizedHost) || isPrivateIpv4Host(normalizedHost))
      );
    } catch {
      return false;
    }
  };

  const allowedOrigins = new Set(
    [
      env.CLIENT_URL,
      env.SOCKET_ORIGIN,
      ...env.CORS_ALLOWED_ORIGINS.split(",").map((value) => value.trim()),
    ]
      .map((value) => value.trim())
      .filter(Boolean)
  );

  const allowImplicitLocalNetworkOrigins =
    !env.CORS_ALLOWED_ORIGINS.trim() &&
    Array.from(allowedOrigins).some((origin) => isLocalNetworkOrigin(origin));

  app.use(
    cors({
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.size === 0 ||
          allowedOrigins.has(origin) ||
          (allowImplicitLocalNetworkOrigins && isLocalNetworkOrigin(origin))
        ) {
          callback(null, true);
          return;
        }

        logger.warn("CORS blocked request origin", {
          origin,
          allowedOrigins: Array.from(allowedOrigins),
        });
        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
  );
  app.use(
    "/webhooks/stripe",
    express.raw({
      type: "application/json",
      limit: "2mb",
    }),
    stripeWebhookRoutes
  );
  app.use(
    express.json({
      limit: "15mb",
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: string }).rawBody = buffer.toString(
          "utf8"
        );
      },
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/webhooks/facebook", facebookWebhookRoutes);
  app.use("/webhooks/instagram", instagramWebhookRoutes);
  app.use("/webhooks/line", lineWebhookRoutes);
  app.use("/webhooks/telegram", telegramWebhookRoutes);
  app.use("/webhooks/viber", viberWebhookRoutes);
  app.use("/webhooks/tiktok", tiktokWebhookRoutes);
  app.use("/webhooks/website", websiteWebhookRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/public/workspaces", workspacePublicRoutes);
  app.use("/api/sticker-previews", stickerPreviewRoutes);
  app.use("/api/media-assets/content", mediaAssetContentRoutes);
  app.use("/api/line-media", lineMediaRoutes);
  app.use("/api/stickers", stickersRoutes);
  app.use("/api/tiktok-media", tiktokMediaRoutes);
  app.use("/oauth/tiktok-shop", tiktokShopOAuthRoutes);
  app.use("/oauth/facebook", facebookOAuthRoutes);
  app.use("/oauth/google", googleOAuthRoutes);
  app.use("/meta/data-deletion", metaDataDeletionRoutes);
  app.use("/meta/deauthorize", metaDeauthorizeRoutes);
  app.use("/api", authenticate);
  app.use("/api/account", accountRoutes);
  app.use("/api/portal", portalRoutes);
  app.use("/api/conversations", conversationsRoutes);
  app.use("/api/audit-logs", auditLogsRoutes);
  app.use("/api/contacts", contactsRoutes);
  app.use("/api/channels", channelsRoutes);
  app.use("/api/knowledge", knowledgeRoutes);
  app.use("/api/canned-replies", cannedRepliesRoutes);
  app.use("/api/ai-settings", aiSettingsRoutes);
  app.use("/api/workspace-profile", workspaceProfileRoutes);
  app.use("/api/billing-requests", billingRequestsRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/media-assets", mediaAssetsRoutes);
  app.use("/api/automations", automationsRoutes);
  app.use("/api/workspaces", workspaceMembersRoutes);

  app.use(errorHandler);
  return app;
};
