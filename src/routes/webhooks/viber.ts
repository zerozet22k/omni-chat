import { Request, Router } from "express";
import { appendFileSync } from "fs";
import { join } from "path";
import { asyncHandler } from "../../lib/async-handler";
import { inboundWebhookService } from "../../services/inbound-webhook.service";

const LOG_PATH = join(process.cwd(), "viber-payloads.txt");

const router = Router();

router.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    channel: "viber",
    connectionKey:
      typeof req.query.connectionKey === "string" ? req.query.connectionKey : null,
  });
});

router.head("/", (_req, res) => {
  res.status(200).end();
});

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

    const body = req.body as { event?: string } | undefined;

    // Viber can POST a webhook registration handshake before the connection is
    // persisted locally. Acknowledge it without full connection resolution.
    if (body?.event === "webhook") {
      res.status(200).json({ ok: true, event: "webhook" });
      return;
    }

    const result = await inboundWebhookService.receive({
      channel: "viber",
      body: req.body,
      rawBody: (req as Request & { rawBody?: string }).rawBody,
      headers: req.headers,
      query: {
        connectionKey: req.query.connectionKey as string | undefined,
      },
    });

    res.status(200).json({
      processed: result.processed.length,
      duplicate: result.duplicate,
      queued: result.queued,
    });
  })
);

export default router;
