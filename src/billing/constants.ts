export const BILLING_PLAN_CODES = ["free", "basic", "pro", "custom"] as const;
export const BILLING_ACCOUNT_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "grace_period",
  "restricted",
  "free_fallback",
  "canceled",
  "paused",
] as const;
export const BILLING_OVERRIDE_TYPES = [
  "entitlement_override",
  "trial_extension",
  "manual_discount",
  "manual_status",
] as const;
export const SUBSCRIPTION_PROVIDERS = ["manual", "stripe"] as const;
export const BILLING_INTERVALS = ["monthly", "yearly", "manual"] as const;
export const BILLING_CYCLES = BILLING_INTERVALS;
export const BILLING_PRICING_MODES = ["free", "fixed", "manual"] as const;
export const BILLING_PLAN_GROUPS = ["standard", "custom"] as const;
export const PLATFORM_FAMILIES = [
  "website",
  "meta",
  "telegram",
  "viber",
  "tiktok",
  "line",
] as const;
export const EXTERNAL_PLATFORM_FAMILIES = PLATFORM_FAMILIES.filter(
  (family) => family !== "website"
) as Array<Exclude<(typeof PLATFORM_FAMILIES)[number], "website">>;

export type BillingPlanCode = string;
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number]; 
export type BillingOverrideType = (typeof BILLING_OVERRIDE_TYPES)[number];
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export type BillingCycle = BillingInterval;
export type BillingPricingMode = (typeof BILLING_PRICING_MODES)[number];
export type BillingPlanGroup = (typeof BILLING_PLAN_GROUPS)[number];
export type PlatformFamily = (typeof PLATFORM_FAMILIES)[number];
