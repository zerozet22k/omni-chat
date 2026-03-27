import { Request, Router } from "express";
import { appendFileSync } from "fs";
import { join } from "path";
import { asyncHandler } from "../../lib/async-handler";
import { inboundWebhookService } from "../../services/inbound-webhook.service";
import { logger } from "../../lib/logger";

const LOG_PATH = join(process.cwd(), "line-payloads.txt");

const router = Router();

router.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    channel: "line",
  });
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const timestamp = new Date().toISOString();
    const signature = req.headers["x-line-signature"];
    const destination =
      typeof req.body === "object" && req.body !== null
        ? (req.body as { destination?: unknown }).destination
        : null;
    const eventCount =
      typeof req.body === "object" && req.body !== null
        ? Array.isArray((req.body as { events?: unknown[] }).events)
          ? (req.body as { events?: unknown[] }).events?.length
          : 0
        : 0;

    logger.info("LINE webhook POST received", {
      destination,
      eventCount,
      signaturePresent: !!signature,
    });

    const entry = `\n===== ${timestamp} =====\n${JSON.stringify(req.body, null, 2)}\n`;
    try {
      appendFileSync(LOG_PATH, entry, "utf8");
    } catch {
      // non-blocking - best effort
    }

    const result = await inboundWebhookService.receive({
      channel: "line",
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
