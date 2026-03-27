import { Request, Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { inboundWebhookService } from "../../services/inbound-webhook.service";

const router = Router();

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const result = await inboundWebhookService.receive({
      channel: "tiktok",
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
