import { logger } from "../lib/logger";
import { createInboundWebhookWorker } from "../lib/queues";
import { inboundWebhookService } from "../services/inbound-webhook.service";

export const startInboundWebhookWorker = () =>
  createInboundWebhookWorker(async (job) => {
    logger.info("Processing inbound webhook job", {
      jobId: job.id,
      channel: job.data.channel,
    });

    await inboundWebhookService.process(job.data);
  });

if (require.main === module) {
  const worker = startInboundWebhookWorker();
  if (!worker) {
    logger.warn("Inbound webhook worker not started because Redis/BullMQ is unavailable");
  } else {
    logger.info("Inbound webhook worker started");
  }
}
