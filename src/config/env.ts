import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z } from "zod";

const initialProcessEnvKeys = new Set(Object.keys(process.env));
const dotenvCandidatePaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), "server/.env"),
  path.resolve(process.cwd(), "server/.env.local"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../.env.local"),
];

const seenDotenvPaths = new Set<string>();
for (const candidatePath of dotenvCandidatePaths) {
  if (seenDotenvPaths.has(candidatePath) || !fs.existsSync(candidatePath)) {
    continue;
  }

  seenDotenvPaths.add(candidatePath);
  const parsed = dotenv.parse(fs.readFileSync(candidatePath));

  for (const [key, value] of Object.entries(parsed)) {
    if (initialProcessEnvKeys.has(key)) {
      continue;
    }

    process.env[key] = value;
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_URL: z.string().default("http://localhost:3000"),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  REDIS_URL: z.string().default(""),
  REDIS_HOST: z.string().default(""),
  REDIS_PORT: z
    .preprocess(
      (value) => (value === "" || value === undefined ? undefined : value),
      z.coerce.number().int().positive().default(6379)
    ),
  REDIS_PASSWORD: z.string().default(""),
  REDIS_DB: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().min(0).default(0)
  ),
  REDIS_TLS: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),
  REDIS_REQUIRED: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("false"),
  BULLMQ_PREFIX: z.string().default("omni-chat"),
  MONGO_URL: z.string().default("mongodb://localhost:27017"),
  MONGO_DB: z.string().default("elqen_zero"),
  PUBLIC_WEBHOOK_BASE_URL: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite-preview"),
  OPENAI_MODEL: z.string().default("gpt-5.3-codex"),
  OPENAI_API_BASE_URL: z.string().default("https://api.openai.com/v1"),
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
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z
    .string()
    .transform((v) => v.toLowerCase() !== "false")
    .default("true"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM_EMAIL: z.string().default(""),
  SMTP_FROM_NAME: z.string().default(""),
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),
  META_LOGIN_CONFIG_ID: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_PUBLISHABLE_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: z.string().default(""),
  PLATFORM_FOUNDER_EMAILS: z.string().default(""),
  PLATFORM_ADMIN_EMAILS: z.string().default(""),
  PLATFORM_STAFF_EMAILS: z.string().default(""),
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
  // Comma-separated list of channels that support outbound (e.g., "facebook,instagram,telegram,viber,tiktok,line,website")
  OUTBOUND_CHANNELS_ENABLED: z.string().default("facebook,instagram,telegram,viber,tiktok,line,website"),
}).superRefine((value, ctx) => {
  const hasTikTokAppId = value.TIKTOK_APP_ID.trim().length > 0;
  const hasTikTokAppSecret = value.TIKTOK_APP_SECRET.trim().length > 0;
  const hasTikTokShopAppKey = value.TIKTOK_SHOP_APP_KEY.trim().length > 0;
  const hasTikTokShopAppSecret = value.TIKTOK_SHOP_APP_SECRET.trim().length > 0;
  const hasStripeSecretKey = value.STRIPE_SECRET_KEY.trim().length > 0;
  const hasStripeWebhookSecret = value.STRIPE_WEBHOOK_SECRET.trim().length > 0;
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

  if (hasStripeSecretKey !== hasStripeWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be configured together.",
      path: hasStripeSecretKey
        ? ["STRIPE_WEBHOOK_SECRET"]
        : ["STRIPE_SECRET_KEY"],
    });
  }

  const hasRedisUrl = value.REDIS_URL.trim().length > 0;
  const hasRedisHost = value.REDIS_HOST.trim().length > 0;

  if (!hasRedisUrl && hasRedisHost && !Number.isFinite(value.REDIS_PORT)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "REDIS_PORT must be a valid positive number when REDIS_HOST is set.",
      path: ["REDIS_PORT"],
    });
  }

  if (value.REDIS_REQUIRED && !hasRedisUrl && !hasRedisHost) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "REDIS_REQUIRED is true, but neither REDIS_URL nor REDIS_HOST is configured.",
      path: ["REDIS_URL"],
    });
  }
});

export const env = envSchema.parse(process.env);
