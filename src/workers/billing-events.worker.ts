import { logger } from "../lib/logger";
import { createBillingEventWorker } from "../lib/queues";
import { stripeBillingService } from "../services/stripe-billing.service";

export const startBillingEventWorker = () =>
  createBillingEventWorker(async (job) => {
    logger.info("Processing billing event job", {
      jobId: job.id,
      provider: job.data.provider,
      eventId: job.data.eventId,
    });

    await stripeBillingService.processBillingEvent(job.data);
  });

if (require.main === module) {
  const worker = startBillingEventWorker();
  if (!worker) {
    logger.warn("Billing event worker not started because Redis/BullMQ is unavailable");
  } else {
    logger.info("Billing event worker started");
  }
}
