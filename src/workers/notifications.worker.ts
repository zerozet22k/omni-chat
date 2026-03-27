import { logger } from "../lib/logger";
import { createNotificationWorker } from "../lib/queues";

export const startNotificationWorker = () =>
  createNotificationWorker(async (job) => {
    logger.info("Processing notification job", {
      jobId: job.id,
      kind: job.data.kind,
    });
  });

if (require.main === module) {
  const worker = startNotificationWorker();
  if (!worker) {
    logger.warn("Notification worker not started because Redis/BullMQ is unavailable");
  } else {
    logger.info("Notification worker started");
  }
}
