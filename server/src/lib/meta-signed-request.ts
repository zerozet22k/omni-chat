import { createHmac, timingSafeEqual } from "crypto";

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const normalizeBase64 = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (!padding) {
    return normalized;
  }
  return normalized.padEnd(normalized.length + (4 - padding), "=");
};

const decodeBase64Url = (value: string) =>
  Buffer.from(normalizeBase64(value), "base64");

export function parseFacebookSignedRequest(
  signedRequest: string,
  appSecret: string
) {
  const secret = trimString(appSecret);
  if (!secret) {
    throw new Error("META_APP_SECRET is not configured.");
  }

  const [encodedSignature, encodedPayload] = signedRequest.split(".", 2);
  if (!encodedSignature || !encodedPayload) {
    throw new Error("Invalid signed request.");
  }

  const signature = decodeBase64Url(encodedSignature);
  const expectedSignature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest();

  if (
    signature.length !== expectedSignature.length ||
    !timingSafeEqual(signature, expectedSignature)
  ) {
    throw new Error("Signed request signature mismatch.");
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as {
    algorithm?: string;
    user_id?: string;
    issued_at?: number;
  };

  if (trimString(payload.algorithm).toUpperCase() !== "HMAC-SHA256") {
    throw new Error("Unsupported signed request algorithm.");
  }

  const userId = trimString(payload.user_id);
  if (!userId) {
    throw new Error("Signed request did not include a user identifier.");
  }

  return {
    userId,
    payload,
  };
}
