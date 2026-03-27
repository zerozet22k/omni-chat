import { Router } from "express";
import Stripe from "stripe";
import { asyncHandler } from "../../lib/async-handler";
import { ValidationError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { addBillingEventJob } from "../../lib/queues";
import { claimEventOnce } from "../../lib/redis-idempotency";
import { getStripeClient, getStripeWebhookSecret } from "../../lib/stripe";
import { stripeBillingService } from "../../services/stripe-billing.service";

const router = Router();

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string" || !signature.trim()) {
      throw new ValidationError("Missing Stripe-Signature header");
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(
          typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}),
          "utf8"
        );

    let event: Stripe.Event;
    try {
      event = getStripeClient().webhooks.constructEvent(
        rawBody,
        signature,
        getStripeWebhookSecret()
      );
    } catch (error) {
      throw new ValidationError(
        error instanceof Error
          ? `Stripe webhook verification failed: ${error.message}`
          : "Stripe webhook verification failed"
      );
    }

    const claimed = await claimEventOnce(`idem:billing:stripe:${event.id}`, 60 * 60 * 24 * 7);
    if (!claimed) {
      res.status(200).json({
        received: true,
        duplicate: true,
        queued: false,
      });
      return;
    }

    const payload = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;

    try {
      const job = await addBillingEventJob(
        {
          provider: "stripe",
          eventId: event.id,
          payload,
        },
        {
          jobId: `billing-stripe-${event.id}`,
        }
      );

      if (job) {
        res.status(200).json({
          received: true,
          duplicate: false,
          queued: true,
        });
        return;
      }
    } catch (error) {
      logger.warn("Stripe billing event queueing failed; falling back to inline processing", {
        eventId: event.id,
        error: error instanceof Error ? error.message : error,
      });
    }

    await stripeBillingService.processBillingEvent({
      provider: "stripe",
      eventId: event.id,
      payload,
    });

    res.status(200).json({
      received: true,
      duplicate: false,
      queued: false,
    });
  })
);

export default router;
