import { randomUUID } from "crypto";
import { getRedisClient } from "./redis";

const memoryLocks = new Map<string, { token: string; expiresAt: number }>();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pruneExpiredMemoryLocks = () => {
  const now = Date.now();
  for (const [key, value] of memoryLocks.entries()) {
    if (value.expiresAt <= now) {
      memoryLocks.delete(key);
    }
  }
};

const releaseLockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export const withRedisLock = async <T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return fn();
  }

  const ttlMs = Math.max(1000, ttlSeconds * 1000);
  const deadline = Date.now() + Math.max(5000, ttlMs * 2);
  const token = randomUUID();
  const redis = await getRedisClient("Redis lock");

  if (redis) {
    while (Date.now() < deadline) {
      const acquired = await redis.set(normalizedKey, token, "PX", ttlMs, "NX");
      if (acquired === "OK") {
        try {
          return await fn();
        } finally {
          await redis.eval(releaseLockScript, 1, normalizedKey, token);
        }
      }

      await delay(100);
    }

    throw new Error(`Timed out acquiring Redis lock for ${normalizedKey}`);
  }

  while (Date.now() < deadline) {
    pruneExpiredMemoryLocks();
    const current = memoryLocks.get(normalizedKey);
    if (!current) {
      memoryLocks.set(normalizedKey, {
        token,
        expiresAt: Date.now() + ttlMs,
      });
      try {
        return await fn();
      } finally {
        const latest = memoryLocks.get(normalizedKey);
        if (latest?.token === token) {
          memoryLocks.delete(normalizedKey);
        }
      }
    }

    await delay(100);
  }

  throw new Error(`Timed out acquiring in-memory lock for ${normalizedKey}`);
};
