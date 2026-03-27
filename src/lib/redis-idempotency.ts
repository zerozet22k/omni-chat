import { createHash } from "crypto";
import { getRedisClient } from "./redis";

const memoryClaims = new Map<string, number>();

const pruneExpiredMemoryClaims = () => {
  const now = Date.now();
  for (const [key, expiresAt] of memoryClaims.entries()) {
    if (expiresAt <= now) {
      memoryClaims.delete(key);
    }
  }
};

export const claimEventOnce = async (key: string, ttlSeconds = 60 * 60 * 24) => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return true;
  }

  const redis = await getRedisClient("Redis idempotency");
  if (redis) {
    const result = await redis.set(normalizedKey, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  pruneExpiredMemoryClaims();
  if (memoryClaims.has(normalizedKey)) {
    return false;
  }

  memoryClaims.set(normalizedKey, Date.now() + ttlSeconds * 1000);
  return true;
};

export const hashIdempotencyPayload = (value: unknown) => {
  const payload =
    typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 0);
  return createHash("sha1").update(payload).digest("hex");
};
