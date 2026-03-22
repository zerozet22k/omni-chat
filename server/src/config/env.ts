import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().default("http://localhost:3000"),
  MONGO_URL: z.string().default("mongodb://localhost:27017"),
  MONGO_DB: z.string().default("botDb"),
  PUBLIC_WEBHOOK_BASE_URL: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite-preview"),
  SOCKET_ORIGIN: z.string().default("http://localhost:3000"),
  JWT_SECRET: z.string().default("change-me"),
  SESSION_SECRET: z.string().default("change-me"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Deployment-level tenant configuration
  APP_TENANT_MODE: z.enum(["single", "multi"]).default("multi"),
  ALLOW_SELF_SIGNUP: z
    .string()
    .transform((v) => v.toLowerCase() !== "false")
    .default("true"),
  ALLOW_WORKSPACE_CREATION: z
    .string()
    .transform((v) => v.toLowerCase() !== "false")
    .default("true"),
  DEFAULT_WORKSPACE_SLUG: z.string().default(""),
  // Encryption key for workspace-owned sensitive fields
  // Falls back to SESSION_SECRET when not set.
  FIELD_ENCRYPTION_KEY: z.string().default(""),
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),
  TIKTOK_APP_ID: z.string().default(""),
  TIKTOK_APP_SECRET: z.string().default(""),
  TIKTOK_BUSINESS_API_BASE_URL: z
    .string()
    .default("https://business-api.tiktok.com"),
  TIKTOK_WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().min(0).default(300),
  TIKTOK_SHOP_APP_KEY: z.string().default(""),
  TIKTOK_SHOP_APP_SECRET: z.string().default(""),
  TIKTOK_SHOP_AUTH_BASE_URL: z
    .string()
    .default("https://auth.tiktok-shops.com"),
}).superRefine((value, ctx) => {
  const hasTikTokAppId = value.TIKTOK_APP_ID.trim().length > 0;
  const hasTikTokAppSecret = value.TIKTOK_APP_SECRET.trim().length > 0;
  const hasTikTokShopAppKey = value.TIKTOK_SHOP_APP_KEY.trim().length > 0;
  const hasTikTokShopAppSecret = value.TIKTOK_SHOP_APP_SECRET.trim().length > 0;
  const hasMetaAppId = value.META_APP_ID.trim().length > 0;
  const hasMetaAppSecret = value.META_APP_SECRET.trim().length > 0;
  const hasMetaWebhookVerifyToken =
    value.META_WEBHOOK_VERIFY_TOKEN.trim().length > 0;

  const configuredMetaValues = [
    hasMetaAppId,
    hasMetaAppSecret,
    hasMetaWebhookVerifyToken,
  ].filter(Boolean).length;

  if (configuredMetaValues > 0 && configuredMetaValues < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "META_APP_ID, META_APP_SECRET, and META_WEBHOOK_VERIFY_TOKEN must be configured together.",
      path: !hasMetaAppId
        ? ["META_APP_ID"]
        : !hasMetaAppSecret
          ? ["META_APP_SECRET"]
          : ["META_WEBHOOK_VERIFY_TOKEN"],
    });
  }

  if (hasTikTokAppId !== hasTikTokAppSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "TIKTOK_APP_ID and TIKTOK_APP_SECRET must be configured together.",
      path: hasTikTokAppId ? ["TIKTOK_APP_SECRET"] : ["TIKTOK_APP_ID"],
    });
  }

  if (hasTikTokShopAppKey !== hasTikTokShopAppSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET must be configured together.",
      path: hasTikTokShopAppKey
        ? ["TIKTOK_SHOP_APP_SECRET"]
        : ["TIKTOK_SHOP_APP_KEY"],
    });
  }
});

export const env = envSchema.parse(process.env);
