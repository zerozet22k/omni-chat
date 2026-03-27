import { logger } from "../lib/logger";
import { createOutboundSendWorker } from "../lib/queues";
import { outboundMessageService } from "../services/outbound-message.service";

export const startOutboundSendWorker = () =>
  createOutboundSendWorker(async (job) => {
    logger.info("Processing outbound send job", {
      jobId: job.id,
      messageId: job.data.messageId,
      conversationId: job.data.conversationId,
    });

    return outboundMessageService.processQueuedMessage(job.data);
  });

if (require.main === module) {
  const worker = startOutboundSendWorker();
  if (!worker) {
    logger.warn("Outbound send worker not started because Redis/BullMQ is unavailable");
  } else {
    logger.info("Outbound send worker started");
  }
}
