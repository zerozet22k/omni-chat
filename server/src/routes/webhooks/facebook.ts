import { Request, Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { env } from "../../config/env";
import { channelConnectionService } from "../../services/channel-connection.service";
import { inboundWebhookService } from "../../services/inbound-webhook.service";

const router = Router();

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

  await channelConnectionService.markFacebookWebhookVerified();
  res.status(200).send(challenge);
});

router.get("/", handleVerification);
router.get("/verify", handleVerification);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const result = await inboundWebhookService.handle({
      channel: "facebook",
      body: req.body,
      rawBody: (req as Request & { rawBody?: string }).rawBody,
      headers: req.headers,
      query: {},
    });

    res.status(200).json({
      processed: result.processed.length,
    });
  })
);

export default router;
