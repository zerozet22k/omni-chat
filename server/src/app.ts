import cors from "cors";
import express from "express";
import path from "path";
import { env } from "./config/env";
import { errorHandler } from "./middleware/error-handler";
import { authenticate } from "./middleware/authenticate";
import authRoutes from "./routes/api/auth";
import aiSettingsRoutes from "./routes/api/ai-settings";
import auditLogsRoutes from "./routes/api/audit-logs";
import automationsRoutes from "./routes/api/automations";
import cannedRepliesRoutes from "./routes/api/canned-replies";
import channelsRoutes from "./routes/api/channels";
import contactsRoutes from "./routes/api/contacts";
import conversationsRoutes from "./routes/api/conversations";
import knowledgeRoutes from "./routes/api/knowledge";
import workspaceMembersRoutes from "./routes/api/workspace-members";
import mediaAssetsRoutes from "./routes/api/media-assets";
import stickerPreviewRoutes from "./routes/public/sticker-previews";
import tiktokMediaRoutes from "./routes/public/tiktok-media";
import tiktokShopOAuthRoutes from "./routes/public/tiktok-shop-oauth";
import facebookOAuthRoutes from "./routes/public/facebook-oauth";
import metaDataDeletionRoutes from "./routes/public/meta-data-deletion";
import metaDeauthorizeRoutes from "./routes/public/meta-deauthorize";
import facebookWebhookRoutes from "./routes/webhooks/facebook";
import telegramWebhookRoutes from "./routes/webhooks/telegram";
import tiktokWebhookRoutes from "./routes/webhooks/tiktok";
import viberWebhookRoutes from "./routes/webhooks/viber";

export const createApp = () => {
  const app = express();

  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
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

  app.use("/assets", express.static(path.resolve(process.cwd(), "uploads")));

  app.use("/webhooks/facebook", facebookWebhookRoutes);
  app.use("/webhooks/telegram", telegramWebhookRoutes);
  app.use("/webhooks/viber", viberWebhookRoutes);
  app.use("/webhooks/tiktok", tiktokWebhookRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/sticker-previews", stickerPreviewRoutes);
  app.use("/api/tiktok-media", tiktokMediaRoutes);
  app.use("/oauth/tiktok-shop", tiktokShopOAuthRoutes);
  app.use("/oauth/facebook", facebookOAuthRoutes);
  app.use("/meta/data-deletion", metaDataDeletionRoutes);
  app.use("/meta/deauthorize", metaDeauthorizeRoutes);
  app.use("/api", authenticate);
  app.use("/api/conversations", conversationsRoutes);
  app.use("/api/audit-logs", auditLogsRoutes);
  app.use("/api/contacts", contactsRoutes);
  app.use("/api/channels", channelsRoutes);
  app.use("/api/knowledge", knowledgeRoutes);
  app.use("/api/canned-replies", cannedRepliesRoutes);
  app.use("/api/ai-settings", aiSettingsRoutes);
  app.use("/api/media-assets", mediaAssetsRoutes);
  app.use("/api/automations", automationsRoutes);
  app.use("/api/workspaces", workspaceMembersRoutes);

  app.use(errorHandler);
  return app;
};
