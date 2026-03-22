import { createServer } from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { connectMongo } from "./lib/mongo";
import { logger } from "./lib/logger";
import { initializeRealtime } from "./lib/realtime";
import { inboundBufferService } from "./services/inbound-buffer.service";

const bootstrap = async () => {
  await connectMongo();
  const app = createApp();
  const server = createServer(app);
  initializeRealtime(server);
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
