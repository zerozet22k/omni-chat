import { randomUUID } from "crypto";
import IORedis, { type RedisOptions } from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

type BullMQConnectionOptions = RedisOptions & {
  maxRetriesPerRequest: null;
};

type RedisConfig = {
  url: string | null;
  host: string | null;
  port: number;
  password: string | null;
  db: number;
  tls: boolean;
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const parsedRedisConfig = (): RedisConfig => {
  const url = trimString(env.REDIS_URL) || null;
  const host = trimString(env.REDIS_HOST) || null;

  return {
    url,
    host,
    port: env.REDIS_PORT,
    password: trimString(env.REDIS_PASSWORD) || null,
    db: env.REDIS_DB,
    tls: env.REDIS_TLS,
  };
};

const redisConfig = parsedRedisConfig();
let sharedRedisClient: IORedis | null = null;
let sharedRedisReadyPromise: Promise<IORedis | null> | null = null;
let hasBoundSharedRedisEvents = false;
let missingConfigWarned = false;
let bullMqCompatibility: boolean | null = null;
let bullMqCompatibilityPromise: Promise<boolean> | null = null;

const parseRedisInfoSection = (rawInfo: string) => {
  return rawInfo.split(/\r?\n/).reduce<Record<string, string>>((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return acc;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      return acc;
    }

    acc[trimmed.slice(0, separatorIndex)] = trimmed.slice(separatorIndex + 1);
    return acc;
  }, {});
};

const buildBaseRedisOptions = (): RedisOptions => {
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  };

  if (redisConfig.password) {
    options.password = redisConfig.password;
  }

  if (redisConfig.db > 0) {
    options.db = redisConfig.db;
  }

  if (redisConfig.tls) {
    options.tls = {};
  }

  return options;
};

const buildRedisClient = () => {
  const options = buildBaseRedisOptions();
  if (redisConfig.url) {
    return new IORedis(redisConfig.url, options);
  }

  if (!redisConfig.host) {
    return null;
  }

  return new IORedis({
    ...options,
    host: redisConfig.host,
    port: redisConfig.port,
  });
};

const bindSharedRedisEvents = (client: IORedis) => {
  if (hasBoundSharedRedisEvents) {
    return;
  }

  hasBoundSharedRedisEvents = true;
  client.on("connect", () => {
    logger.info("Redis connected", {
      mode: redisConfig.url ? "url" : "host",
      db: redisConfig.db,
    });
  });

  client.on("error", (error) => {
    logger.error("Redis error", {
      error: error instanceof Error ? error.message : error,
    });
  });

  client.on("close", () => {
    logger.warn("Redis connection closed");
  });
};

export const isRedisConfigured = () => {
  return !!redisConfig.url || !!redisConfig.host;
};

export const assertRedisConfiguration = (context: string) => {
  if (isRedisConfigured()) {
    return;
  }

  if (!env.REDIS_REQUIRED) {
    if (!missingConfigWarned) {
      missingConfigWarned = true;
      logger.warn("Redis is not configured; coordination features will fall back to direct mode", {
        context,
      });
    }
    return;
  }

  throw new Error(
    `${context} requires Redis, but no REDIS_URL or REDIS_HOST/REDIS_PORT configuration was found.`
  );
};

export const getRedisClient = async (context = "Redis client") => {
  assertRedisConfiguration(context);

  if (!isRedisConfigured()) {
    return null;
  }

  if (sharedRedisClient) {
    return sharedRedisClient;
  }

  if (!sharedRedisReadyPromise) {
    sharedRedisReadyPromise = (async () => {
      const client = buildRedisClient();
      if (!client) {
        return null;
      }

      bindSharedRedisEvents(client);
      await client.connect();
      sharedRedisClient = client;
      return sharedRedisClient;
    })().catch((error) => {
      sharedRedisReadyPromise = null;
      sharedRedisClient = null;

      if (env.REDIS_REQUIRED) {
        throw error;
      }

      logger.warn("Redis connection unavailable; falling back to direct mode", {
        context,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    });
  }

  return sharedRedisReadyPromise;
};

export const ensureRedisReady = async (context = "Redis runtime") => {
  const client = await getRedisClient(context);
  if (!client) {
    return false;
  }

  await client.ping();
  return true;
};

export const closeRedis = async () => {
  if (!sharedRedisClient) {
    return;
  }

  const client = sharedRedisClient;
  sharedRedisClient = null;
  sharedRedisReadyPromise = null;
  hasBoundSharedRedisEvents = false;
  await client.quit();
};

export const isBullMqCompatibleRedisRuntime = () => bullMqCompatibility !== false;

export const ensureBullMqCompatibleRedisRuntime = async () => {
  if (!isRedisConfigured()) {
    bullMqCompatibility = false;
    return false;
  }

  if (bullMqCompatibility !== null) {
    return bullMqCompatibility;
  }

  if (!bullMqCompatibilityPromise) {
    bullMqCompatibilityPromise = (async () => {
      const client = await getRedisClient("BullMQ runtime probe");
      if (!client) {
        bullMqCompatibility = false;
        return false;
      }

      let redisVersion: string | null = null;
      let redisOs: string | null = null;

      try {
        const serverInfo = parseRedisInfoSection(await client.info("server"));
        redisVersion = serverInfo.redis_version ?? null;
        redisOs = serverInfo.os ?? null;
      } catch {
        // Best-effort diagnostics only.
      }

      const probeKey = `bullmq:compat:${randomUUID()}`;

      try {
        await client.del(probeKey);
        await client.lpush(probeKey, "sentinel-a", "sentinel-b");
        await client.lrem(probeKey, -1, "sentinel-a");
        bullMqCompatibility = true;
        return true;
      } catch (error) {
        bullMqCompatibility = false;
        logger.warn("BullMQ disabled because the Redis runtime failed compatibility checks", {
          error: error instanceof Error ? error.message : error,
          redisVersion,
          redisOs,
        });
        return false;
      } finally {
        await client.del(probeKey).catch(() => undefined);
      }
    })().finally(() => {
      bullMqCompatibilityPromise = null;
    });
  }

  return bullMqCompatibilityPromise;
};

export const buildBullMQConnectionOptions = (): BullMQConnectionOptions | null => {
  assertRedisConfiguration("BullMQ");

  if (!isRedisConfigured()) {
    return null;
  }

  const base: BullMQConnectionOptions = {
    ...buildBaseRedisOptions(),
    maxRetriesPerRequest: null,
  };

  if (redisConfig.url) {
    const parsed = new URL(redisConfig.url);
    base.host = parsed.hostname;
    base.port = parsed.port ? Number(parsed.port) : 6379;
    base.username = parsed.username || undefined;
    base.password = parsed.password || base.password;
    base.db =
      parsed.pathname && parsed.pathname !== "/"
        ? Number(parsed.pathname.replace(/^\//, "")) || base.db
        : base.db;
    if (parsed.protocol === "rediss:") {
      base.tls = {};
    }
    return base;
  }

  if (!redisConfig.host) {
    return null;
  }

  return {
    ...base,
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password ?? undefined,
    db: redisConfig.db,
  };
};
