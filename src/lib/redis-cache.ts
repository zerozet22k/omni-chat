import { getRedisClient } from "./redis";

export const getCachedJson = async <T>(key: string): Promise<T | null> => {
  const redis = await getRedisClient("Redis cache");
  if (!redis) {
    return null;
  }

  const value = await redis.get(key);
  if (!value) {
    return null;
  }

  return JSON.parse(value) as T;
};

export const setCachedJson = async (
  key: string,
  value: unknown,
  ttlSeconds: number
) => {
  const redis = await getRedisClient("Redis cache");
  if (!redis) {
    return false;
  }

  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  return true;
};

export const deleteCachedKeys = async (...keys: string[]) => {
  const redis = await getRedisClient("Redis cache");
  if (!redis || keys.length === 0) {
    return 0;
  }

  return redis.del(keys);
};
