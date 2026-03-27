import { getRedisClient } from "./redis";

const memoryWindows = new Map<
  string,
  {
    count: number;
    expiresAt: number;
  }
>();

const pruneExpiredMemoryWindows = () => {
  const now = Date.now();
  for (const [key, item] of memoryWindows.entries()) {
    if (item.expiresAt <= now) {
      memoryWindows.delete(key);
    }
  }
};

export const hitRateLimit = async (key: string, limit: number, windowSec: number) => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return false;
  }

  const redis = await getRedisClient("Redis rate limit");
  if (redis) {
    const total = await redis.incr(normalizedKey);
    if (total === 1) {
      await redis.expire(normalizedKey, windowSec);
    }

    return total > limit;
  }

  pruneExpiredMemoryWindows();
  const now = Date.now();
  const current = memoryWindows.get(normalizedKey);
  if (!current || current.expiresAt <= now) {
    memoryWindows.set(normalizedKey, {
      count: 1,
      expiresAt: now + windowSec * 1000,
    });
    return false;
  }

  current.count += 1;
  memoryWindows.set(normalizedKey, current);
  return current.count > limit;
};
