import { TooManyRequestsError } from "./errors";
import { hitRateLimit } from "./redis-rate-limit";

export const normalizeRateLimitKeyPart = (value: unknown) => {
  const normalized =
    typeof value === "string" ? value.trim().replace(/^::ffff:/, "") : "";
  return normalized || "unknown";
};

export const assertWithinRateLimit = async (params: {
  key: string;
  limit: number;
  windowSec: number;
  message: string;
  details?: unknown;
}) => {
  const limited = await hitRateLimit(params.key, params.limit, params.windowSec);
  if (limited) {
    throw new TooManyRequestsError(params.message, params.details);
  }
};
