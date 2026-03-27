import { Request, Router } from "express";
import { appendFileSync } from "fs";
import { join } from "path";
import { asyncHandler } from "../../lib/async-handler";
import { env } from "../../config/env";
import { channelConnectionService } from "../../services/channel-connection.service";
import { inboundWebhookService } from "../../services/inbound-webhook.service";
import { logger } from "../../lib/logger";

const router = Router();
const LOG_PATH = join(process.cwd(), "instagram-payloads.txt");

const handleVerification = asyncHandler(async (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expectedVerifyToken = String(env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();

  if (
    mode !== "subscribe" ||
    typeof verifyToken !== "string" ||
    typeof challenge !== "string" ||
    !expectedVerifyToken ||
    verifyToken !== expectedVerifyToken
  ) {
    res.status(403).send("Forbidden");
    return;
  }

  try {
    await channelConnectionService.markInstagramWebhookVerified();
  } catch (error) {
    logger.warn("Instagram webhook verified with Meta but local verification state update failed", {
      error: error instanceof Error ? error.message : error,
    });
  }

  res.status(200).type("text/plain").send(challenge);
});

router.get("/", handleVerification);
router.get("/verify", handleVerification);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const timestamp = new Date().toISOString();
    const entry = `\n===== ${timestamp} =====\n${JSON.stringify(req.body, null, 2)}\n`;
    try {
      appendFileSync(LOG_PATH, entry, "utf8");
    } catch {
      // non-blocking - best effort
    }

    const result = await inboundWebhookService.receive({
      channel: "instagram",
      body: req.body,
      rawBody: (req as Request & { rawBody?: string }).rawBody,
      headers: req.headers,
      query: {},
    });

    res.status(200).json({
      processed: result.processed.length,
      duplicate: result.duplicate,
      queued: result.queued,
    });
  })
);

export default router;
