import { Request, Router } from "express";
import { appendFileSync } from "fs";
import { join } from "path";
import { asyncHandler } from "../../lib/async-handler";
import { inboundWebhookService } from "../../services/inbound-webhook.service";

const LOG_PATH = join(process.cwd(), "telegram-payloads.txt");

const router = Router();

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const timestamp = new Date().toISOString();
    const entry = `\n===== ${timestamp} =====\n${JSON.stringify(req.body, null, 2)}\n`;
    try {
      appendFileSync(LOG_PATH, entry, "utf8");
    } catch {
      // non-blocking – best effort
    }

    const result = await inboundWebhookService.receive({
      channel: "telegram",
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
