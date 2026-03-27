import { logger } from "../lib/logger";
import {
  ensureBullMqCompatibleRedisRuntime,
  ensureRedisReady,
  isRedisConfigured,
} from "../lib/redis";
import { startBillingEventWorker } from "./billing-events.worker";
import { startInboundWebhookWorker } from "./inbound-webhooks.worker";
import { startNotificationWorker } from "./notifications.worker";
import { startOutboundSendWorker } from "./outbound-sends.worker";

let workersStarted = false;

export const startQueueWorkers = async () => {
  if (workersStarted) {
    return;
  }

  if (!isRedisConfigured()) {
    logger.info("Queue workers are disabled because Redis is not configured");
    return;
  }

  const ready = await ensureRedisReady("queue workers");
  if (!ready) {
    logger.warn("Queue workers were skipped because Redis is unavailable");
    return;
  }

  const bullMqCompatible = await ensureBullMqCompatibleRedisRuntime();
  if (!bullMqCompatible) {
    logger.warn(
      "Queue workers were skipped because this Redis runtime is incompatible with BullMQ; inline processing will be used instead"
    );
    return;
  }

  startInboundWebhookWorker();
  startOutboundSendWorker();
  startBillingEventWorker();
  startNotificationWorker();
  workersStarted = true;
  logger.info("Queue workers started in-process");
};
