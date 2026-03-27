import { createServer } from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { connectMongo } from "./lib/mongo";
import { logger } from "./lib/logger";
import { billingAccountMigrationService } from "./services/billing-account-migration.service";
import { initializeRealtime } from "./lib/realtime";
import { inboundBufferService } from "./services/inbound-buffer.service";
import { roleModelMigrationService } from "./services/role-model-migration.service";
import { ensureRedisReady } from "./lib/redis";
import { startQueueWorkers } from "./workers/bootstrap";

const bootstrap = async () => {
  await connectMongo();
  await roleModelMigrationService.normalizeRoleModel();
  await billingAccountMigrationService.normalizeBillingAccounts();
  await ensureRedisReady("server bootstrap");
  const app = createApp();
  const server = createServer(app);
  initializeRealtime(server);
  await startQueueWorkers();
  server.listen(env.PORT, () => {
    logger.info("Server started", { port: env.PORT });
  });

  setInterval(async () => {
    try {
      await inboundBufferService.flushPendingBuffers();
    } catch (error) {
      logger.error("Failed to flush inbound buffers", error);
    }
  }, 3000);
};

bootstrap().catch((error) => {
  logger.error("Failed to start server", error);
  process.exit(1);
});
