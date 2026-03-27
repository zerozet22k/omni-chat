import { CanonicalChannel } from "../channels/types";
import {
  BILLING_ACCOUNT_STATUSES,
  BILLING_CYCLES,
  BILLING_INTERVALS,
  BILLING_OVERRIDE_TYPES,
  BILLING_PLAN_GROUPS,
  BILLING_PRICING_MODES,
  BillingAccountStatus,
  BillingCycle,
  BillingInterval,
  BillingOverrideType,
  BillingPlanGroup,
  BillingPricingMode,
  EXTERNAL_PLATFORM_FAMILIES,
  PLATFORM_FAMILIES,
  PlatformFamily,
  SUBSCRIPTION_PROVIDERS,
  SubscriptionProvider,
} from "../billing/constants";
import {
  BillingAccountDocument,
  BillingAccountModel,
  BillingOverrideDocument,
  BillingOverrideModel,
  BillingSubscriptionDocument,
  BillingSubscriptionModel,
  ChannelConnectionModel,
  EntitlementsDocument,
  EntitlementsModel,
  PlanCatalogDocument,
  PlanCatalogModel,
  PlanVersionDocument,
  PlanVersionModel,
  UsageSummaryModel,
  UserModel,
  WorkspaceDocument,
  WorkspaceMembershipModel,
  WorkspaceModel,
} from "../models";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import { withRedisLock } from "../lib/redis-lock";
import { invalidatePortalDashboardCache } from "../lib/portal-dashboard-cache";

type SerializedConnectedAccountsPerPlatform = Record<PlatformFamily, number>;

export type ResolvedBillingEntitlements = {
  maxWorkspaces: number;
  maxSeats: number;
  allowedPlatformFamilies: PlatformFamily[];
  maxExternalPlatformFamilies: number;
  maxConnectedAccountsPerPlatform: SerializedConnectedAccountsPerPlatform;
  allowWebsiteChat: boolean;
  allowCustomDomain: boolean;
  allowBYOAI: boolean;
  allowAutomation: boolean;
  allowAuditExports: boolean;
  allowExtraSeats: boolean;
  allowExtraWorkspaces: boolean;
  allowExtraConnections: boolean;
};

type BillingUsageCounts = {
  billingAccountId: string;
  periodStart: Date;
  periodEnd: Date;
  seatsUsed: number;
  workspacesUsed: number;
  connectedAccountsUsedByPlatform: SerializedConnectedAccountsPerPlatform;
  platformFamiliesUsed: PlatformFamily[];
  externalPlatformFamiliesUsed: Array<Exclude<PlatformFamily, "website">>;
};

type ScheduledChangeKind = "downgrade" | "cancel";

type BillingActivitySummary = {
  outstandingAmount: number | null;
  currency: string | null;
  latestChargeStatus: string | null;
  nextBillingAt: Date | null;
  latestInvoiceLabel: string | null;
};

export type SerializedBillingOverrideSummary = {
  _id: string;
  type: BillingOverrideType;
  payload: Record<string, unknown>;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
  active: boolean;
};

export type SerializedPlanVersionSummary = {
  _id: string;
  planCatalogId: string;
  version: number;
  active: boolean;
  billingInterval: BillingInterval;
  priceAmount: number;
  currency: string;
  stripeProductId: string | null;
  stripePriceId: string | null;
  entitlements: ResolvedBillingEntitlements;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
};

export type SerializedPlanCatalogSummary = {
  _id: string;
  code: string;
  displayName: string;
  sortOrder: number;
  showPublicly: boolean;
  selfServe: boolean;
  pricingMode: BillingPricingMode;
  planGroup: BillingPlanGroup;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  currentSubscriptions: number;
  versions: SerializedPlanVersionSummary[];
};

export type SerializedBillingState = {
  account: {
    _id: string;
    ownerUserId: string | null;
    name: string;
    status: BillingAccountStatus;
    createdAt: Date;
  };
  subscription: {
    _id: string;
    provider: SubscriptionProvider;
    providerSubscriptionId: string | null;
    status: BillingAccountStatus;
    planCatalogId: string | null;
    planVersionId: string | null;
    planCode: string;
    planDisplayName: string;
    version: number | null;
    billingInterval: BillingInterval;
    priceAmount: number;
    currency: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: Date | null;
    trialPlanCode: string | null;
    scheduledPlanCatalogId: string | null;
    scheduledPlanVersionId: string | null;
    scheduledPlanCode: string | null;
    scheduledPlanDisplayName: string | null;
    scheduledChangeKind: ScheduledChangeKind | null;
    scheduledChangeEffectiveAt: Date | null;
    renewsAt: Date | null;
    gracePeriodEndsAt: Date | null;
  };
  entitlements: ResolvedBillingEntitlements;
  usageSummary: BillingUsageCounts & {
    seatsRemaining: number;
    workspacesRemaining: number;
    externalPlatformFamiliesRemaining: number;
  };
  overrides: {
    activeCount: number;
  };
  actionRequiredBeforeEffectiveDate: string[];
  billingActivity: BillingActivitySummary;
};

type BillingLimitGate =
  | "workspaces"
  | "seats"
  | "website_chat"
  | "byo_ai"
  | "automation"
  | "platform_family"
  | "external_platform_families"
  | "channel_connections";

type BillingLimitDetails = {
  upgradeRequired: true;
  gate: BillingLimitGate;
  billing: SerializedBillingState;
  limitValue?: number;
  usedValue?: number;
  platformFamily?: PlatformFamily;
  channel?: CanonicalChannel;
};

type BillingStateSnapshotInput = {
  billingAccount: BillingAccountDocument;
  subscription: BillingSubscriptionDocument;
  planCatalog: PlanCatalogDocument;
  planVersion: PlanVersionDocument;
  resolvedEntitlements: ResolvedBillingEntitlements;
  resolvedStatus: BillingAccountStatus;
  resolvedTrialEndsAt: Date | null;
  resolvedScheduledPlanCatalog: PlanCatalogDocument | null;
  resolvedScheduledPlanVersion: PlanVersionDocument | null;
  resolvedScheduledChangeKind: ScheduledChangeKind | null;
  resolvedScheduledChangeEffectiveAt: Date | null;
  resolvedRenewsAt: Date | null;
  resolvedGracePeriodEndsAt: Date | null;
  usageCounts: BillingUsageCounts;
  activeOverrideCount: number;
};

type BillingContext = {
  workspace: WorkspaceDocument;
  billingAccount: BillingAccountDocument;
  subscription: BillingSubscriptionDocument;
  planCatalog: PlanCatalogDocument;
  planVersion: PlanVersionDocument;
  resolvedEntitlements: ResolvedBillingEntitlements;
  resolvedStatus: BillingAccountStatus;
  resolvedTrialEndsAt: Date | null;
  resolvedScheduledPlanCatalog: PlanCatalogDocument | null;
  resolvedScheduledPlanVersion: PlanVersionDocument | null;
  resolvedScheduledChangeKind: ScheduledChangeKind | null;
  resolvedScheduledChangeEffectiveAt: Date | null;
  resolvedRenewsAt: Date | null;
  resolvedGracePeriodEndsAt: Date | null;
  allOverrides: BillingOverrideDocument[];
  activeOverrides: BillingOverrideDocument[];
  usageCounts: BillingUsageCounts;
};

export type AccountTrialState = {
  available: boolean;
  hasUsedTrial: boolean;
  trialStartedAt: Date | null;
  trialConsumedAt: Date | null;
  trialUsedByBillingAccountId: string | null;
  trialUsedOnPlanCode: string | null;
};

export type PlanCatalogCreateInput = {
  code: string;
  displayName: string;
  sortOrder?: number;
  showPublicly?: boolean;
  selfServe?: boolean;
  pricingMode?: BillingPricingMode;
  planGroup?: BillingPlanGroup;
  active?: boolean;
};

export type PlanCatalogUpdateInput = {
  displayName?: string;
  sortOrder?: number;
  showPublicly?: boolean;
  selfServe?: boolean;
  pricingMode?: BillingPricingMode;
  planGroup?: BillingPlanGroup;
  active?: boolean;
};

export type PlanVersionCreateInput = {
  active?: boolean;
  billingInterval: BillingInterval;
  priceAmount: number;
  currency: string;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  entitlements: ResolvedBillingEntitlements;
  createdBy?: string | null;
};

export type ManualBillingSubscriptionUpdateInput = {
  billingAccountName?: string;
  provider?: SubscriptionProvider;
  status: BillingAccountStatus;
  planVersionId: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  trialEndsAt?: Date | null;
};

export type ManualBillingOverrideInput = {
  type: BillingOverrideType;
  payload: Record<string, unknown>;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  reason?: string | null;
  createdBy?: string | null;
};

export type WorkspacePlanChangeResult = {
  mode:
    | "plan_updated"
    | "trial_started"
    | "change_scheduled"
    | "manual_billing_required";
  billing: SerializedBillingState;
  trial: AccountTrialState;
};

const DEFAULT_PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: "Free",
  basic: "Basic",
  "basic-plus": "Basic Plus",
  pro: "Pro",
  custom: "Custom",
};

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const titleCaseLabel = (value: string) =>
  value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");

const normalizeCurrency = (value: unknown) => {
  const normalized = trimString(value).toUpperCase();
  return normalized || "USD";
};

const normalizeSortOrder = (value: unknown, fallback = 100) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  return fallback;
};

const normalizePlanCode = (value: unknown, fallback = "free") => {
  const normalized = trimString(value).toLowerCase();
  return normalized || fallback;
};

const normalizePricingMode = (
  value: unknown,
  fallback: BillingPricingMode = "fixed"
): BillingPricingMode => {
  const normalized = trimString(value).toLowerCase();
  if (BILLING_PRICING_MODES.includes(normalized as BillingPricingMode)) {
    return normalized as BillingPricingMode;
  }

  return fallback;
};

const normalizePlanGroup = (
  value: unknown,
  fallback: BillingPlanGroup = "standard"
): BillingPlanGroup => {
  const normalized = trimString(value).toLowerCase();
  if (BILLING_PLAN_GROUPS.includes(normalized as BillingPlanGroup)) {
    return normalized as BillingPlanGroup;
  }

  return fallback;
};

const emptyConnectedAccountsMap = (): SerializedConnectedAccountsPerPlatform => ({
  website: 0,
  meta: 0,
  telegram: 0,
  viber: 0,
  tiktok: 0,
  line: 0,
});

const normalizePlatformFamilies = (
  value: unknown,
  fallback?: PlatformFamily[]
): PlatformFamily[] => {
  const validFamilies = new Set<PlatformFamily>(PLATFORM_FAMILIES);
  const values = Array.isArray(value) ? value : fallback ?? [];
  const normalized = values
    .map((item) => trimString(item))
    .filter((item): item is PlatformFamily => validFamilies.has(item as PlatformFamily));

  return Array.from(new Set(normalized));
};

const normalizeConnectedAccountsPerPlatform = (
  value: unknown,
  fallback?: Partial<Record<PlatformFamily, number>>
): SerializedConnectedAccountsPerPlatform => {
  const initial = {
    ...emptyConnectedAccountsMap(),
    ...(fallback ?? {}),
  };
  const entries =
    value instanceof Map
      ? Object.fromEntries(value.entries())
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};

  for (const family of PLATFORM_FAMILIES) {
    const raw = entries[family];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      initial[family] = Math.max(0, Math.floor(raw));
    }
  }

  return initial;
};

const normalizeBillingInterval = (
  value: unknown,
  fallback: BillingInterval = "manual"
): BillingInterval => {
  const normalized = trimString(value);
  if (BILLING_INTERVALS.includes(normalized as BillingInterval)) {
    return normalized as BillingInterval;
  }

  return fallback;
};

const normalizeBillingStatus = (
  value: unknown,
  fallback: BillingAccountStatus = "active"
): BillingAccountStatus => {
  const normalized = trimString(value);

  if (normalized === "trial") {
    return "trialing";
  }

  if (normalized === "suspended") {
    return "paused";
  }

  if (BILLING_ACCOUNT_STATUSES.includes(normalized as BillingAccountStatus)) {
    return normalized as BillingAccountStatus;
  }

  return fallback;
};

const channelToPlatformFamily = (channel: CanonicalChannel): PlatformFamily => {
  if (channel === "facebook" || channel === "instagram") {
    return "meta";
  }

  if (channel === "website") {
    return "website";
  }

  return channel;
};

const buildPeriodWindow = (
  interval: BillingInterval,
  anchor = new Date()
): { currentPeriodStart: Date; currentPeriodEnd: Date } => {
  const currentPeriodStart = new Date(anchor);
  const currentPeriodEnd = new Date(anchor);

  if (interval === "yearly") {
    currentPeriodEnd.setFullYear(currentPeriodEnd.getFullYear() + 1);
  } else {
    currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
  }

  return { currentPeriodStart, currentPeriodEnd };
};

const buildTrialEndsAt = (anchor = new Date()) => {
  const next = new Date(anchor);
  next.setDate(next.getDate() + 30);
  return next;
};

const buildGracePeriodEndsAt = (anchor = new Date()) => {
  const next = new Date(anchor);
  next.setDate(next.getDate() + 7);
  return next;
};

const isDateValue = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const uniqueStringList = (items: Array<string | null | undefined>) =>
  Array.from(new Set(items.filter((item): item is string => !!trimString(item))));

const getEffectiveRenewalDate = (subscription: BillingSubscriptionDocument) =>
  subscription.trialEndsAt ?? subscription.currentPeriodEnd ?? null;

const buildSeedEntitlements = (planCode: string): ResolvedBillingEntitlements => {
  if (planCode === "basic-plus") {
    return {
      maxWorkspaces: 2,
      maxSeats: 5,
      allowedPlatformFamilies: [...PLATFORM_FAMILIES],
      maxExternalPlatformFamilies: 2,
      maxConnectedAccountsPerPlatform: normalizeConnectedAccountsPerPlatform(null, {
        website: 1,
        meta: 1,
        telegram: 1,
        viber: 1,
        tiktok: 1,
        line: 1,
      }),
      allowWebsiteChat: true,
      allowCustomDomain: false,
      allowBYOAI: true,
      allowAutomation: true,
      allowAuditExports: false,
      allowExtraSeats: false,
      allowExtraWorkspaces: false,
      allowExtraConnections: false,
    };
  }

  if (planCode === "basic") {
    return {
      maxWorkspaces: 1,
      maxSeats: 3,
      allowedPlatformFamilies: [...PLATFORM_FAMILIES],
      maxExternalPlatformFamilies: 1,
      maxConnectedAccountsPerPlatform: normalizeConnectedAccountsPerPlatform(null, {
        website: 1,
        meta: 1,
        telegram: 1,
        viber: 1,
        tiktok: 1,
        line: 1,
      }),
      allowWebsiteChat: true,
      allowCustomDomain: false,
      allowBYOAI: true,
      allowAutomation: false,
      allowAuditExports: false,
      allowExtraSeats: false,
      allowExtraWorkspaces: false,
      allowExtraConnections: false,
    };
  }

  if (planCode === "pro") {
    return {
      maxWorkspaces: 3,
      maxSeats: 10,
      allowedPlatformFamilies: [...PLATFORM_FAMILIES],
      maxExternalPlatformFamilies: 3,
      maxConnectedAccountsPerPlatform: normalizeConnectedAccountsPerPlatform(null, {
        website: 1,
        meta: 2,
        telegram: 2,
        viber: 2,
        tiktok: 2,
        line: 2,
      }),
      allowWebsiteChat: true,
      allowCustomDomain: true,
      allowBYOAI: true,
      allowAutomation: true,
      allowAuditExports: true,
      allowExtraSeats: true,
      allowExtraWorkspaces: true,
      allowExtraConnections: true,
    };
  }

  if (planCode === "custom") {
    return {
      maxWorkspaces: 3,
      maxSeats: 10,
      allowedPlatformFamilies: [...PLATFORM_FAMILIES],
      maxExternalPlatformFamilies: 3,
      maxConnectedAccountsPerPlatform: normalizeConnectedAccountsPerPlatform(null, {
        website: 1,
        meta: 2,
        telegram: 2,
        viber: 2,
        tiktok: 2,
        line: 2,
      }),
      allowWebsiteChat: true,
      allowCustomDomain: true,
      allowBYOAI: true,
      allowAutomation: true,
      allowAuditExports: true,
      allowExtraSeats: true,
      allowExtraWorkspaces: true,
      allowExtraConnections: true,
    };
  }

  return {
    maxWorkspaces: 1,
    maxSeats: 1,
    allowedPlatformFamilies: ["website"],
    maxExternalPlatformFamilies: 0,
    maxConnectedAccountsPerPlatform: normalizeConnectedAccountsPerPlatform(null, {
      website: 1,
      meta: 0,
      telegram: 0,
      viber: 0,
      tiktok: 0,
      line: 0,
    }),
    allowWebsiteChat: true,
    allowCustomDomain: false,
    allowBYOAI: false,
    allowAutomation: false,
    allowAuditExports: false,
    allowExtraSeats: false,
    allowExtraWorkspaces: false,
    allowExtraConnections: false,
  };
};

const getSeedPlanCatalogMetadata = (planCode: string) => {
  const normalizedCode = normalizePlanCode(planCode);

  if (normalizedCode === "free") {
    return {
      sortOrder: 0,
      showPublicly: true,
      selfServe: true,
      pricingMode: "free" as const,
      planGroup: "standard" as const,
      billingInterval: "monthly" as const,
      priceAmount: 0,
      currency: "USD",
    };
  }

  if (normalizedCode === "basic") {
    return {
      sortOrder: 10,
      showPublicly: true,
      selfServe: true,
      pricingMode: "fixed" as const,
      planGroup: "standard" as const,
      billingInterval: "monthly" as const,
      priceAmount: 30,
      currency: "USD",
    };
  }

  if (normalizedCode === "basic-plus") {
    return {
      sortOrder: 20,
      showPublicly: true,
      selfServe: true,
      pricingMode: "fixed" as const,
      planGroup: "standard" as const,
      billingInterval: "monthly" as const,
      priceAmount: 40,
      currency: "USD",
    };
  }

  if (normalizedCode === "pro") {
    return {
      sortOrder: 30,
      showPublicly: true,
      selfServe: true,
      pricingMode: "fixed" as const,
      planGroup: "standard" as const,
      billingInterval: "monthly" as const,
      priceAmount: 50,
      currency: "USD",
    };
  }

  if (normalizedCode === "custom") {
    return {
      sortOrder: 999,
      showPublicly: false,
      selfServe: false,
      pricingMode: "manual" as const,
      planGroup: "custom" as const,
      billingInterval: "manual" as const,
      priceAmount: 0,
      currency: "USD",
    };
  }

  return {
    sortOrder: 100,
    showPublicly: true,
    selfServe: true,
    pricingMode: "fixed" as const,
    planGroup: "standard" as const,
    billingInterval: "monthly" as const,
    priceAmount: 0,
    currency: "USD",
  };
};

const normalizeEntitlements = (
  value: Partial<ResolvedBillingEntitlements> | null | undefined,
  fallback: ResolvedBillingEntitlements
): ResolvedBillingEntitlements => {
  const candidate = value ?? {};
  const allowWebsiteChat =
    typeof candidate.allowWebsiteChat === "boolean"
      ? candidate.allowWebsiteChat
      : fallback.allowWebsiteChat;
  const allowedPlatformFamilies = normalizePlatformFamilies(
    candidate.allowedPlatformFamilies,
    fallback.allowedPlatformFamilies
  );
  if (allowWebsiteChat && !allowedPlatformFamilies.includes("website")) {
    allowedPlatformFamilies.unshift("website");
  }

  const maxConnectedAccountsPerPlatform = normalizeConnectedAccountsPerPlatform(
    candidate.maxConnectedAccountsPerPlatform,
    fallback.maxConnectedAccountsPerPlatform
  );

  for (const family of PLATFORM_FAMILIES) {
    if (!allowedPlatformFamilies.includes(family)) {
      maxConnectedAccountsPerPlatform[family] = 0;
    }
  }

  const maxExternalPlatformFamilies = Math.min(
    Math.max(
      0,
      Math.floor(
        typeof candidate.maxExternalPlatformFamilies === "number"
          ? candidate.maxExternalPlatformFamilies
          : fallback.maxExternalPlatformFamilies
      )
    ),
    allowedPlatformFamilies.filter((family) => family !== "website").length
  );

  return {
    maxWorkspaces: Math.max(
      0,
      Math.floor(
        typeof candidate.maxWorkspaces === "number"
          ? candidate.maxWorkspaces
          : fallback.maxWorkspaces
      )
    ),
    maxSeats: Math.max(
      0,
      Math.floor(typeof candidate.maxSeats === "number" ? candidate.maxSeats : fallback.maxSeats)
    ),
    allowedPlatformFamilies,
    maxExternalPlatformFamilies,
    maxConnectedAccountsPerPlatform,
    allowWebsiteChat,
    allowCustomDomain:
      typeof candidate.allowCustomDomain === "boolean"
        ? candidate.allowCustomDomain
        : fallback.allowCustomDomain,
    allowBYOAI:
      typeof candidate.allowBYOAI === "boolean"
        ? candidate.allowBYOAI
        : fallback.allowBYOAI,
    allowAutomation:
      typeof candidate.allowAutomation === "boolean"
        ? candidate.allowAutomation
        : fallback.allowAutomation,
    allowAuditExports:
      typeof candidate.allowAuditExports === "boolean"
        ? candidate.allowAuditExports
        : fallback.allowAuditExports,
    allowExtraSeats:
      typeof candidate.allowExtraSeats === "boolean"
        ? candidate.allowExtraSeats
        : typeof (candidate as { allowExtraSeatPurchase?: unknown }).allowExtraSeatPurchase ===
            "boolean"
          ? !!(candidate as { allowExtraSeatPurchase?: unknown }).allowExtraSeatPurchase
          : fallback.allowExtraSeats,
    allowExtraWorkspaces:
      typeof candidate.allowExtraWorkspaces === "boolean"
        ? candidate.allowExtraWorkspaces
        : typeof (candidate as { allowExtraWorkspacePurchase?: unknown })
              .allowExtraWorkspacePurchase === "boolean"
          ? !!(candidate as { allowExtraWorkspacePurchase?: unknown })
              .allowExtraWorkspacePurchase
          : fallback.allowExtraWorkspaces,
    allowExtraConnections:
      typeof candidate.allowExtraConnections === "boolean"
        ? candidate.allowExtraConnections
        : typeof (candidate as { allowExtraConnectionPurchase?: unknown })
              .allowExtraConnectionPurchase === "boolean"
          ? !!(candidate as { allowExtraConnectionPurchase?: unknown })
              .allowExtraConnectionPurchase
          : fallback.allowExtraConnections,
  };
};

const legacyEntitlementsToResolved = (
  legacy: EntitlementsDocument,
  fallback: ResolvedBillingEntitlements
) =>
  normalizeEntitlements(
    ({
      maxWorkspaces: legacy.maxWorkspaces,
      maxSeats: legacy.maxSeats,
      allowedPlatformFamilies: legacy.allowedPlatformFamilies as PlatformFamily[],
      maxExternalPlatformFamilies:
        normalizePlatformFamilies(
          legacy.allowedPlatformFamilies,
          fallback.allowedPlatformFamilies
        ).filter((family) => family !== "website").length,
      maxConnectedAccountsPerPlatform:
        legacy.maxConnectedAccountsPerPlatform as unknown as SerializedConnectedAccountsPerPlatform,
      allowWebsiteChat: legacy.allowWebsiteChat,
      allowCustomDomain: legacy.allowCustomDomain,
      allowBYOAI: legacy.allowBYOAI,
      allowAutomation: legacy.allowAutomation,
      allowAuditExports: legacy.allowAuditExports,
      allowExtraSeatPurchase: legacy.allowExtraSeatPurchase,
      allowExtraWorkspacePurchase: legacy.allowExtraWorkspacePurchase,
      allowExtraConnectionPurchase: legacy.allowExtraConnectionPurchase,
    } as Partial<ResolvedBillingEntitlements> & {
      allowExtraSeatPurchase?: boolean;
      allowExtraWorkspacePurchase?: boolean;
      allowExtraConnectionPurchase?: boolean;
    }),
    fallback
  );

const diffEntitlements = (
  base: ResolvedBillingEntitlements,
  next: ResolvedBillingEntitlements
): Partial<ResolvedBillingEntitlements> => {
  const diff: Partial<ResolvedBillingEntitlements> = {};
  const familiesChanged =
    base.allowedPlatformFamilies.join("|") !== next.allowedPlatformFamilies.join("|");
  if (familiesChanged) {
    diff.allowedPlatformFamilies = next.allowedPlatformFamilies;
  }

  const connectedChanged = PLATFORM_FAMILIES.some(
    (family) =>
      base.maxConnectedAccountsPerPlatform[family] !==
      next.maxConnectedAccountsPerPlatform[family]
  );
  if (connectedChanged) {
    diff.maxConnectedAccountsPerPlatform = next.maxConnectedAccountsPerPlatform;
  }

  const scalarKeys: Array<
    Exclude<
      keyof ResolvedBillingEntitlements,
      "allowedPlatformFamilies" | "maxConnectedAccountsPerPlatform"
    >
  > = [
    "maxWorkspaces",
    "maxSeats",
    "maxExternalPlatformFamilies",
    "allowWebsiteChat",
    "allowCustomDomain",
    "allowBYOAI",
    "allowAutomation",
    "allowAuditExports",
    "allowExtraSeats",
    "allowExtraWorkspaces",
    "allowExtraConnections",
  ];

  for (const key of scalarKeys) {
    if (base[key] !== next[key]) {
      (diff as Record<string, unknown>)[key] = next[key];
    }
  }

  return diff;
};

const isOverrideActive = (override: BillingOverrideDocument, at = new Date()) => {
  const effectiveFrom = override.effectiveFrom ?? null;
  const effectiveTo = override.effectiveTo ?? null;

  if (effectiveFrom && effectiveFrom > at) {
    return false;
  }

  if (effectiveTo && effectiveTo < at) {
    return false;
  }

  return true;
};

const serializeOverride = (
  override: BillingOverrideDocument,
  at = new Date()
): SerializedBillingOverrideSummary => ({
  _id: String(override._id),
  type: override.type,
  payload:
    override.payload && typeof override.payload === "object"
      ? (override.payload as Record<string, unknown>)
      : {},
  effectiveFrom: override.effectiveFrom ?? null,
  effectiveTo: override.effectiveTo ?? null,
  reason: trimString(override.reason) || null,
  createdBy: override.createdBy ? String(override.createdBy) : null,
  createdAt: override.createdAt,
  active: isOverrideActive(override, at),
});

const serializePlanVersion = (
  planVersion: PlanVersionDocument
): SerializedPlanVersionSummary => {
  const fallback = buildSeedEntitlements("free");

  return {
    _id: String(planVersion._id),
    planCatalogId: String(planVersion.planCatalogId),
    version: planVersion.version,
    active: planVersion.active,
    billingInterval: planVersion.billingInterval,
    priceAmount: planVersion.priceAmount,
    currency: normalizeCurrency(planVersion.currency),
    stripeProductId: trimString(planVersion.stripeProductId) || null,
    stripePriceId: trimString(planVersion.stripePriceId) || null,
    entitlements: normalizeEntitlements(
      planVersion.entitlements as ResolvedBillingEntitlements,
      fallback
    ),
    createdAt: planVersion.createdAt,
    updatedAt: planVersion.updatedAt,
    createdBy: planVersion.createdBy ? String(planVersion.createdBy) : null,
  };
};

class BillingService {
  private seedPromise: Promise<void> | null = null;

  private async ensureDefaultPlanCatalogs() {
    if (!this.seedPromise) {
      this.seedPromise = this.seedDefaultPlanCatalogs();
    }

    await this.seedPromise;
  }

  private async seedDefaultPlanCatalogs() {
    const defaults: Array<{
      code: string;
      displayName: string;
      sortOrder: number;
      showPublicly: boolean;
      selfServe: boolean;
      pricingMode: BillingPricingMode;
      planGroup: BillingPlanGroup;
      active: boolean;
      billingInterval: BillingInterval;
      priceAmount: number;
      currency: string;
    }> = [
      {
        code: "free",
        displayName: "Free",
        sortOrder: 0,
        showPublicly: true,
        selfServe: true,
        pricingMode: "free",
        planGroup: "standard",
        active: true,
        billingInterval: "monthly",
        priceAmount: 0,
        currency: "USD",
      },
      {
        code: "basic",
        displayName: "Basic",
        sortOrder: 10,
        showPublicly: true,
        selfServe: true,
        pricingMode: "fixed",
        planGroup: "standard",
        active: true,
        billingInterval: "monthly",
        priceAmount: 30,
        currency: "USD",
      },
      {
        code: "pro",
        displayName: "Pro",
        sortOrder: 30,
        showPublicly: true,
        selfServe: true,
        pricingMode: "fixed",
        planGroup: "standard",
        active: true,
        billingInterval: "monthly",
        priceAmount: 50,
        currency: "USD",
      },
      {
        code: "custom",
        displayName: "Custom",
        sortOrder: 999,
        showPublicly: false,
        selfServe: false,
        pricingMode: "manual",
        planGroup: "custom",
        active: true,
        billingInterval: "manual",
        priceAmount: 0,
        currency: "USD",
      },
    ];

    for (const item of defaults) {
      const catalog = await PlanCatalogModel.findOneAndUpdate(
        { code: item.code },
        {
          $setOnInsert: {
            code: item.code,
            displayName: item.displayName,
            sortOrder: item.sortOrder,
            showPublicly: item.showPublicly,
            selfServe: item.selfServe,
            pricingMode: item.pricingMode,
            planGroup: item.planGroup,
            active: item.active,
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        }
      );

      const existingVersion = await PlanVersionModel.findOne({
        planCatalogId: catalog._id,
        billingInterval: item.billingInterval,
      });

      let catalogChanged = false;
      if (catalog.displayName !== item.displayName) {
        catalog.displayName = item.displayName;
        catalogChanged = true;
      }
      if (typeof catalog.sortOrder !== "number") {
        catalog.sortOrder = item.sortOrder;
        catalogChanged = true;
      }
      if (typeof catalog.showPublicly !== "boolean") {
        catalog.showPublicly = item.showPublicly;
        catalogChanged = true;
      }
      if (typeof catalog.selfServe !== "boolean") {
        catalog.selfServe = item.selfServe;
        catalogChanged = true;
      }
      if (!trimString(catalog.pricingMode)) {
        catalog.pricingMode = item.pricingMode;
        catalogChanged = true;
      }
      if (!trimString(catalog.planGroup)) {
        catalog.planGroup = item.planGroup;
        catalogChanged = true;
      }
      if (catalogChanged) {
        await catalog.save();
      }

      if (existingVersion) {
        continue;
      }

      const latestVersion = await PlanVersionModel.findOne({
        planCatalogId: catalog._id,
      }).sort({ version: -1 });

      await PlanVersionModel.create({
        planCatalogId: catalog._id,
        version: latestVersion ? latestVersion.version + 1 : 1,
        active: true,
        billingInterval: item.billingInterval,
        priceAmount: item.priceAmount,
        currency: item.currency,
        entitlements: buildSeedEntitlements(item.code),
        createdBy: null,
      });
    }
  }

  private getDefaultPlanDisplayName(code: string) {
    return DEFAULT_PLAN_DISPLAY_NAMES[code] ?? code.replace(/[-_]+/g, " ");
  }

  private async findOwnedBillingAccount(
    ownerUserId: string,
    billingAccountId: string
  ) {
    const normalizedOwnerUserId = trimString(ownerUserId);
    const normalizedBillingAccountId = trimString(billingAccountId);
    if (!normalizedOwnerUserId || !normalizedBillingAccountId) {
      return null;
    }

    return BillingAccountModel.findOne({
      _id: normalizedBillingAccountId,
      ownerUserId: normalizedOwnerUserId,
    });
  }

  private async ensureBillingAccountForOwner(params: {
    ownerUserId: string;
    fallbackName?: string;
    seedPlanCode?: string;
    seedStatus?: BillingAccountStatus;
  }) {
    await this.ensureDefaultPlanCatalogs();

    const ownerUserId = trimString(params.ownerUserId);
    if (!ownerUserId) {
      throw new ValidationError("Billing account owner is required");
    }

    const seedPlanCode = normalizePlanCode(params.seedPlanCode, "free");
    const seedStatus = normalizeBillingStatus(params.seedStatus, "active");
    const owner = await UserModel.findById(ownerUserId).select(
      "name defaultBillingAccountId"
    );
    const fallbackName =
      trimString(params.fallbackName) || trimString(owner?.name) || "Billing account";

    const defaultBillingAccountId = owner?.defaultBillingAccountId
      ? String(owner.defaultBillingAccountId)
      : "";

    let billingAccount =
      (defaultBillingAccountId
        ? await this.findOwnedBillingAccount(ownerUserId, defaultBillingAccountId)
        : null) ??
      (await BillingAccountModel.findOne({ ownerUserId }).sort({ createdAt: 1 }));

    if (!billingAccount) {
      billingAccount = await BillingAccountModel.create({
        ownerUserId,
        name: fallbackName,
        status: seedStatus,
        planCode: seedPlanCode,
      });
    } else {
      let changed = false;
      if (!trimString(billingAccount.name)) {
        billingAccount.name = fallbackName;
        changed = true;
      }
      if (!trimString(billingAccount.planCode)) {
        billingAccount.planCode = seedPlanCode;
        changed = true;
      }
      if (!trimString(billingAccount.status)) {
        billingAccount.status = seedStatus;
        changed = true;
      }
      if (changed) {
        await billingAccount.save();
      }
    }

    if (
      owner &&
      String(owner.defaultBillingAccountId ?? "") !== String(billingAccount._id)
    ) {
      owner.defaultBillingAccountId = billingAccount._id;
      await owner.save();
    }

    const subscription = await this.ensureBillingSubscriptionForAccount({
      billingAccount,
      seedPlanCode,
      seedStatus,
      provisioning: true,
    });

    return { billingAccount, subscription };
  }

  async getAccountTrialState(ownerUserId: string): Promise<AccountTrialState> {
    const normalizedOwnerUserId = trimString(ownerUserId);
    if (!normalizedOwnerUserId) {
      throw new ValidationError("Billing account owner is required");
    }

    const owner = await UserModel.findById(normalizedOwnerUserId).select(
      "hasUsedTrial trialStartedAt trialConsumedAt trialUsedByBillingAccountId trialUsedOnPlanCode"
    );
    if (!owner) {
      throw new NotFoundError("User not found");
    }

    return {
      available: !owner.hasUsedTrial,
      hasUsedTrial: !!owner.hasUsedTrial,
      trialStartedAt: owner.trialStartedAt ?? null,
      trialConsumedAt: owner.trialConsumedAt ?? null,
      trialUsedByBillingAccountId: owner.trialUsedByBillingAccountId
        ? String(owner.trialUsedByBillingAccountId)
        : null,
      trialUsedOnPlanCode: trimString(owner.trialUsedOnPlanCode) || null,
    };
  }

  private async consumePaidPlanTrial(params: {
    ownerUserId: string;
    billingAccountId: string;
    planCode: string;
    startedAt?: Date;
  }) {
    const normalizedOwnerUserId = trimString(params.ownerUserId);
    const owner = await UserModel.findById(normalizedOwnerUserId).select(
      "hasUsedTrial trialStartedAt trialConsumedAt trialUsedByBillingAccountId trialUsedOnPlanCode"
    );
    if (!owner) {
      throw new NotFoundError("User not found");
    }

    if (owner.hasUsedTrial) {
      throw new ForbiddenError("This account has already used its one-time paid plan trial.");
    }

    const startedAt = params.startedAt ?? new Date();
    owner.hasUsedTrial = true;
    owner.trialStartedAt = startedAt;
    owner.trialConsumedAt = startedAt;
    owner.trialUsedByBillingAccountId =
      params.billingAccountId as unknown as typeof owner.trialUsedByBillingAccountId;
    owner.trialUsedOnPlanCode = normalizePlanCode(params.planCode, "basic");
    await owner.save();

    return this.getAccountTrialState(String(owner._id));
  }

  async listBillingAccountsForOwner(ownerUserId: string) {
    const normalizedOwnerUserId = trimString(ownerUserId);
    if (!normalizedOwnerUserId) {
      throw new ValidationError("Billing account owner is required");
    }

    const ensured = await this.ensureBillingAccountForOwner({
      ownerUserId: normalizedOwnerUserId,
    });
    const [owner, billingAccounts] = await Promise.all([
      UserModel.findById(normalizedOwnerUserId).select("defaultBillingAccountId"),
      BillingAccountModel.find({ ownerUserId: normalizedOwnerUserId }).sort({
        createdAt: 1,
      }),
    ]);

    return {
      defaultBillingAccountId:
        owner?.defaultBillingAccountId
          ? String(owner.defaultBillingAccountId)
          : String(ensured.billingAccount._id),
      billingAccounts,
    };
  }

  async getOwnedBillingAccount(ownerUserId: string, billingAccountId: string) {
    const billingAccount = await this.findOwnedBillingAccount(ownerUserId, billingAccountId);
    if (!billingAccount) {
      throw new NotFoundError("Billing account not found");
    }

    return billingAccount;
  }

  async createBillingAccountForOwner(params: {
    ownerUserId: string;
    fallbackName?: string;
    seedPlanCode?: string;
    seedStatus?: BillingAccountStatus;
  }) {
    await this.ensureDefaultPlanCatalogs();

    const ownerUserId = trimString(params.ownerUserId);
    if (!ownerUserId) {
      throw new ValidationError("Billing account owner is required");
    }

    const seedPlanCode = normalizePlanCode(params.seedPlanCode, "free");
    const seedStatus = normalizeBillingStatus(params.seedStatus, "active");
    const owner = await UserModel.findById(ownerUserId).select(
      "name defaultBillingAccountId"
    );
    const fallbackName =
      trimString(params.fallbackName) || trimString(owner?.name) || "Billing account";

    const billingAccount = await BillingAccountModel.create({
      ownerUserId,
      name: fallbackName,
      status: seedStatus,
      planCode: seedPlanCode,
    });

    const subscription = await this.ensureBillingSubscriptionForAccount({
      billingAccount,
      seedPlanCode,
      seedStatus,
      provisioning: true,
    });

    if (owner && !owner.defaultBillingAccountId) {
      owner.defaultBillingAccountId = billingAccount._id;
      await owner.save();
    }

    return { billingAccount, subscription };
  }

  async setDefaultBillingAccountForOwner(ownerUserId: string, billingAccountId: string) {
    const normalizedOwnerUserId = trimString(ownerUserId);
    const owner = await UserModel.findById(normalizedOwnerUserId).select(
      "defaultBillingAccountId"
    );
    if (!owner) {
      throw new NotFoundError("User not found");
    }

    const billingAccount = await this.getOwnedBillingAccount(
      normalizedOwnerUserId,
      billingAccountId
    );

    owner.defaultBillingAccountId = billingAccount._id;
    await owner.save();

    return billingAccount;
  }

  async deleteBillingAccountForOwner(ownerUserId: string, billingAccountId: string) {
    const normalizedOwnerUserId = trimString(ownerUserId);
    const billingAccount = await this.getOwnedBillingAccount(
      normalizedOwnerUserId,
      billingAccountId
    );

    const [owner, ownedBillingAccounts, attachedWorkspaceCount] = await Promise.all([
      UserModel.findById(normalizedOwnerUserId).select("defaultBillingAccountId"),
      BillingAccountModel.find({ ownerUserId: normalizedOwnerUserId })
        .sort({ createdAt: 1 })
        .select("_id"),
      WorkspaceModel.countDocuments({ billingAccountId: billingAccount._id }),
    ]);

    if (attachedWorkspaceCount > 0) {
      throw new ValidationError(
        "Remove this billing account from attached workspaces before deleting it."
      );
    }

    if (ownedBillingAccounts.length <= 1) {
      throw new ValidationError("At least one billing account must remain.");
    }

    const replacementBillingAccount =
      ownedBillingAccounts.find(
        (item) => String(item._id) !== String(billingAccount._id)
      ) ?? null;

    await Promise.all([
      BillingSubscriptionModel.deleteMany({ billingAccountId: billingAccount._id }),
      BillingOverrideModel.deleteMany({ billingAccountId: billingAccount._id }),
      EntitlementsModel.deleteMany({ billingAccountId: billingAccount._id }),
      UsageSummaryModel.deleteMany({ billingAccountId: billingAccount._id }),
      BillingAccountModel.findByIdAndDelete(billingAccount._id),
    ]);

    if (
      owner &&
      String(owner.defaultBillingAccountId ?? "") === String(billingAccount._id) &&
      replacementBillingAccount
    ) {
      owner.defaultBillingAccountId = replacementBillingAccount._id;
      await owner.save();
    }

    return {
      deletedBillingAccountId: String(billingAccount._id),
      replacementBillingAccountId: replacementBillingAccount
        ? String(replacementBillingAccount._id)
        : null,
    };
  }

  private async ensureProvisioningPlanVersion(
    planCode: string,
    billingInterval: BillingInterval
  ) {
    await this.ensureDefaultPlanCatalogs();

    const normalizedCode = normalizePlanCode(planCode);
    const catalogDefaults = getSeedPlanCatalogMetadata(normalizedCode);
    const catalog =
      (await PlanCatalogModel.findOne({ code: normalizedCode })) ??
      (await PlanCatalogModel.create({
        code: normalizedCode,
        displayName: this.getDefaultPlanDisplayName(normalizedCode),
        sortOrder: catalogDefaults.sortOrder,
        showPublicly: catalogDefaults.showPublicly,
        selfServe: catalogDefaults.selfServe,
        pricingMode: catalogDefaults.pricingMode,
        planGroup: catalogDefaults.planGroup,
        active: true,
      }));

    const existing =
      (await PlanVersionModel.findOne({
        planCatalogId: catalog._id,
        billingInterval,
        active: true,
      }).sort({ version: -1 })) ??
      (await PlanVersionModel.findOne({
        planCatalogId: catalog._id,
        active: true,
      }).sort({ version: -1 }));

    if (existing) {
      return { catalog, version: existing };
    }

    const latest = await PlanVersionModel.findOne({ planCatalogId: catalog._id }).sort({
      version: -1,
    });
    const nextVersion = latest ? latest.version + 1 : 1;
    const version = await PlanVersionModel.create({
      planCatalogId: catalog._id,
      version: nextVersion,
      active: true,
      billingInterval,
      priceAmount: catalogDefaults.priceAmount,
      currency: catalogDefaults.currency,
      entitlements: buildSeedEntitlements(normalizedCode),
      createdBy: null,
    });

    return { catalog, version };
  }

  private async ensureBackfillPlanVersion(
    planCode: string,
    billingInterval: BillingInterval
  ) {
    await this.ensureDefaultPlanCatalogs();

    const normalizedCode = normalizePlanCode(planCode);
    const catalogDefaults = getSeedPlanCatalogMetadata(normalizedCode);
    const catalog =
      (await PlanCatalogModel.findOne({ code: normalizedCode })) ??
      (await PlanCatalogModel.create({
        code: normalizedCode,
        displayName: this.getDefaultPlanDisplayName(normalizedCode),
        sortOrder: catalogDefaults.sortOrder,
        showPublicly: catalogDefaults.showPublicly,
        selfServe: catalogDefaults.selfServe,
        pricingMode: catalogDefaults.pricingMode,
        planGroup: catalogDefaults.planGroup,
        active: true,
      }));

    const existing =
      (await PlanVersionModel.findOne({
        planCatalogId: catalog._id,
        billingInterval,
      }).sort({ version: 1 })) ??
      (await PlanVersionModel.findOne({ planCatalogId: catalog._id }).sort({ version: 1 }));

    if (existing) {
      return { catalog, version: existing };
    }

    const latest = await PlanVersionModel.findOne({ planCatalogId: catalog._id }).sort({
      version: -1,
    });
    const nextVersion = latest ? latest.version + 1 : 1;
    const version = await PlanVersionModel.create({
      planCatalogId: catalog._id,
      version: nextVersion,
      active: true,
      billingInterval,
      priceAmount: catalogDefaults.priceAmount,
      currency: catalogDefaults.currency,
      entitlements: buildSeedEntitlements(normalizedCode),
      createdBy: null,
    });

    return { catalog, version };
  }

  private async ensureBillingSubscriptionForAccount(params: {
    billingAccount: BillingAccountDocument;
    seedPlanCode?: string;
    seedStatus?: BillingAccountStatus;
    provisioning?: boolean;
  }) {
    const seedPlanCode = normalizePlanCode(
      params.seedPlanCode ?? params.billingAccount.planCode,
      "free"
    );
    const seedStatus = normalizeBillingStatus(
      params.seedStatus ?? params.billingAccount.status,
      "active"
    );
    let subscription = await BillingSubscriptionModel.findOne({
      billingAccountId: params.billingAccount._id,
    });

    if (
      subscription?.planCatalogId &&
      subscription.planVersionId &&
      subscription.billingInterval
    ) {
      let changed = false;
      if (!subscription.planCode) {
        subscription.planCode = seedPlanCode;
        changed = true;
      }
      if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
        const window = buildPeriodWindow(subscription.billingInterval);
        subscription.currentPeriodStart =
          subscription.currentPeriodStart ?? window.currentPeriodStart;
        subscription.currentPeriodEnd =
          subscription.currentPeriodEnd ?? window.currentPeriodEnd;
        changed = true;
      }
      if (!subscription.renewsAt) {
        subscription.renewsAt = getEffectiveRenewalDate(subscription);
        changed = true;
      }
      if (subscription.status === "trialing" && !subscription.trialEndsAt) {
        subscription.trialEndsAt = buildTrialEndsAt();
        changed = true;
      }
      if (
        subscription.status === "past_due" &&
        !subscription.gracePeriodEndsAt
      ) {
        subscription.gracePeriodEndsAt = buildGracePeriodEndsAt();
        changed = true;
      }
      if (changed) {
        await subscription.save();
      }
      return subscription;
    }

    const legacyInterval = normalizeBillingInterval(
      subscription?.billingInterval ?? subscription?.billingCycle,
      seedPlanCode === "custom" ? "manual" : "monthly"
    );
    const planResolver = params.provisioning
      ? this.ensureProvisioningPlanVersion(seedPlanCode, legacyInterval)
      : this.ensureBackfillPlanVersion(seedPlanCode, legacyInterval);
    const { catalog, version } = await planResolver;
    const periodWindow = buildPeriodWindow(version.billingInterval);

    if (!subscription) {
      subscription = await BillingSubscriptionModel.create({
        billingAccountId: params.billingAccount._id,
        provider: "manual",
        status: seedStatus,
        planCatalogId: catalog._id,
        planVersionId: version._id,
        planCode: catalog.code,
        billingInterval: version.billingInterval,
        billingCycle: version.billingInterval,
        currentPeriodStart: periodWindow.currentPeriodStart,
        currentPeriodEnd: periodWindow.currentPeriodEnd,
        cancelAtPeriodEnd: false,
        trialEndsAt: seedStatus === "trialing" ? buildTrialEndsAt() : null,
        trialPlanCode: seedStatus === "trialing" ? catalog.code : null,
        scheduledPlanCatalogId: null,
        scheduledPlanVersionId: null,
        scheduledPlanCode: null,
        scheduledChangeKind: null,
        scheduledChangeEffectiveAt: null,
        renewsAt: periodWindow.currentPeriodEnd,
        gracePeriodEndsAt: seedStatus === "past_due" ? buildGracePeriodEndsAt() : null,
      });
      return subscription;
    }

    subscription.provider = subscription.provider || "manual";
    subscription.status = normalizeBillingStatus(subscription.status, seedStatus);
    subscription.planCatalogId = catalog._id;
    subscription.planVersionId = version._id;
    subscription.planCode = catalog.code;
    subscription.billingInterval = version.billingInterval;
    subscription.billingCycle = version.billingInterval;
    subscription.currentPeriodStart =
      subscription.currentPeriodStart ?? periodWindow.currentPeriodStart;
    subscription.currentPeriodEnd =
      subscription.currentPeriodEnd ?? periodWindow.currentPeriodEnd;
    subscription.cancelAtPeriodEnd = subscription.cancelAtPeriodEnd ?? false;
    subscription.trialEndsAt =
      subscription.status === "trialing"
        ? subscription.trialEndsAt ?? buildTrialEndsAt()
        : subscription.trialEndsAt ?? null;
    subscription.trialPlanCode =
      subscription.status === "trialing"
        ? trimString(subscription.trialPlanCode) || catalog.code
        : null;
    subscription.renewsAt = subscription.renewsAt ?? getEffectiveRenewalDate(subscription);
    subscription.gracePeriodEndsAt =
      subscription.status === "past_due"
        ? subscription.gracePeriodEndsAt ?? buildGracePeriodEndsAt()
        : subscription.gracePeriodEndsAt ?? null;
    await subscription.save();
    return subscription;
  }

  private async ensureLegacyEntitlementBackfill(params: {
    billingAccountId: string;
    planCode: string;
    planVersion: PlanVersionDocument;
  }) {
    const legacyEntitlements = await EntitlementsModel.findOne({
      billingAccountId: params.billingAccountId,
    });

    if (!legacyEntitlements) {
      return;
    }

    const baseEntitlements = normalizeEntitlements(
      params.planVersion.entitlements as ResolvedBillingEntitlements,
      buildSeedEntitlements(params.planCode)
    );
    const legacyResolved = legacyEntitlementsToResolved(legacyEntitlements, baseEntitlements);
    const diff = diffEntitlements(baseEntitlements, legacyResolved);

    if (Object.keys(diff).length === 0) {
      return;
    }

    const existingOverride = await BillingOverrideModel.findOne({
      billingAccountId: params.billingAccountId,
      type: "entitlement_override",
      createdBy: null,
      reason: "Legacy entitlement backfill",
    });

    if (existingOverride) {
      return;
    }

    await BillingOverrideModel.create({
      billingAccountId: params.billingAccountId,
      type: "entitlement_override",
      payload: diff,
      effectiveFrom: legacyEntitlements.createdAt ?? new Date(),
      effectiveTo: null,
      reason: "Legacy entitlement backfill",
      createdBy: null,
    });
  }

  async ensureWorkspaceBillingAccount(workspace: WorkspaceDocument) {
    const currentBillingAccountId = workspace.billingAccountId
      ? String(workspace.billingAccountId)
      : "";

    let billingAccount =
      currentBillingAccountId
        ? await BillingAccountModel.findById(currentBillingAccountId)
        : null;
    const seedPlanCode = normalizePlanCode(billingAccount?.planCode, "free");
    const seedStatus = normalizeBillingStatus(billingAccount?.status, "active");

    if (!billingAccount) {
      if (!workspace.createdByUserId) {
        const fallbackMembership = await WorkspaceMembershipModel.findOne({
          workspaceId: workspace._id,
          status: { $in: ["active", "invited"] },
        }).sort({ createdAt: 1 });

        if (!fallbackMembership) {
          throw new ValidationError("Workspace is missing billing owner information");
        }

        workspace.createdByUserId = fallbackMembership.userId;
        await workspace.save();
      }

      const ensured = await this.ensureBillingAccountForOwner({
        ownerUserId: String(workspace.createdByUserId),
        fallbackName: workspace.name,
        seedPlanCode,
        seedStatus,
      });
      billingAccount = ensured.billingAccount;
      if (String(workspace.billingAccountId) !== String(billingAccount._id)) {
        workspace.billingAccountId = billingAccount._id;
        await workspace.save();
      }
    }

    const subscription = await this.ensureBillingSubscriptionForAccount({
      billingAccount,
      seedPlanCode: normalizePlanCode(billingAccount.planCode, seedPlanCode),
      seedStatus: normalizeBillingStatus(billingAccount.status, seedStatus),
      provisioning: false,
    });

    const planCatalog = await PlanCatalogModel.findById(subscription.planCatalogId);
    const planVersion = await PlanVersionModel.findById(subscription.planVersionId);
    if (!planCatalog || !planVersion) {
      throw new ValidationError("Billing subscription is missing its plan definition");
    }

    await this.ensureLegacyEntitlementBackfill({
      billingAccountId: String(billingAccount._id),
      planCode: planCatalog.code,
      planVersion,
    });

    return {
      workspace,
      billingAccount,
      subscription,
      planCatalog,
      planVersion,
    };
  }

  async getBillingAccountState(billingAccountOrId: string | BillingAccountDocument) {
    const billingAccount =
      typeof billingAccountOrId === "string"
        ? await BillingAccountModel.findById(billingAccountOrId)
        : billingAccountOrId;

    if (!billingAccount) {
      throw new NotFoundError("Billing account not found");
    }

    const seedPlanCode = normalizePlanCode(billingAccount.planCode, "free");
    const seedStatus = normalizeBillingStatus(billingAccount.status, "active");
    const subscription = await this.ensureBillingSubscriptionForAccount({
      billingAccount,
      seedPlanCode,
      seedStatus,
      provisioning: false,
    });

    const planCatalog = await PlanCatalogModel.findById(subscription.planCatalogId);
    const planVersion = await PlanVersionModel.findById(subscription.planVersionId);
    if (!planCatalog || !planVersion) {
      throw new ValidationError("Billing subscription is missing its plan definition");
    }

    await this.ensureLegacyEntitlementBackfill({
      billingAccountId: String(billingAccount._id),
      planCode: planCatalog.code,
      planVersion,
    });

    await this.applyAutomaticLifecycleTransitions({
      billingAccount,
      subscription,
    });

    const refreshedPlanCatalog =
      (await PlanCatalogModel.findById(subscription.planCatalogId)) ?? planCatalog;
    const refreshedPlanVersion =
      (await PlanVersionModel.findById(subscription.planVersionId)) ?? planVersion;

    const allOverrides = await this.loadOverrides(String(billingAccount._id));
    const resolved = this.resolveOverrides({
      subscription,
      planVersion: refreshedPlanVersion,
      planCode: refreshedPlanCatalog.code,
      overrides: allOverrides,
    });

    await this.enforceSeatAssignmentsForBillingAccount({
      billingAccountId: String(billingAccount._id),
      maxSeats: resolved.resolvedEntitlements.maxSeats,
    });

    const usageCounts = await this.buildUsageCounts(
      String(billingAccount._id),
      subscription
    );
    const scheduled = await this.resolveScheduledPlan(subscription);

    return {
      billingAccount,
      subscription,
      planCatalog: refreshedPlanCatalog,
      planVersion: refreshedPlanVersion,
      resolvedEntitlements: resolved.resolvedEntitlements,
      resolvedStatus: resolved.resolvedStatus,
      resolvedTrialEndsAt: resolved.resolvedTrialEndsAt,
      resolvedScheduledPlanCatalog: scheduled.scheduledPlanCatalog,
      resolvedScheduledPlanVersion: scheduled.scheduledPlanVersion,
      resolvedScheduledChangeKind:
        (subscription.scheduledChangeKind as ScheduledChangeKind | null) ?? null,
      resolvedScheduledChangeEffectiveAt:
        subscription.scheduledChangeEffectiveAt ?? null,
      resolvedRenewsAt: subscription.renewsAt ?? getEffectiveRenewalDate(subscription),
      resolvedGracePeriodEndsAt: subscription.gracePeriodEndsAt ?? null,
      allOverrides,
      activeOverrides: resolved.activeOverrides,
      usageCounts,
      serialized: this.serializeBillingSnapshot({
        billingAccount,
        subscription,
        planCatalog: refreshedPlanCatalog,
        planVersion: refreshedPlanVersion,
        resolvedEntitlements: resolved.resolvedEntitlements,
        resolvedStatus: resolved.resolvedStatus,
        resolvedTrialEndsAt: resolved.resolvedTrialEndsAt,
        resolvedScheduledPlanCatalog: scheduled.scheduledPlanCatalog,
        resolvedScheduledPlanVersion: scheduled.scheduledPlanVersion,
        resolvedScheduledChangeKind:
          (subscription.scheduledChangeKind as ScheduledChangeKind | null) ?? null,
        resolvedScheduledChangeEffectiveAt:
          subscription.scheduledChangeEffectiveAt ?? null,
        resolvedRenewsAt: subscription.renewsAt ?? getEffectiveRenewalDate(subscription),
        resolvedGracePeriodEndsAt: subscription.gracePeriodEndsAt ?? null,
        usageCounts,
        activeOverrideCount: resolved.activeOverrides.length,
      }),
    };
  }

  async assignWorkspaceToOwnerBillingAccount(
    workspace: WorkspaceDocument,
    ownerUserId: string
  ) {
    const ensured = await this.ensureBillingAccountForOwner({
      ownerUserId,
      fallbackName: workspace.name,
      seedPlanCode: "free",
      seedStatus: "active",
    });

    workspace.billingAccountId = ensured.billingAccount._id;
    await workspace.save();

    return ensured.billingAccount;
  }

  async assignWorkspaceToBillingAccount(
    workspaceOrId: string | WorkspaceDocument,
    billingAccountId: string,
    ownerUserId: string
  ) {
    const workspace =
      typeof workspaceOrId === "string"
        ? await WorkspaceModel.findById(workspaceOrId)
        : workspaceOrId;

    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const billingAccount = await this.getOwnedBillingAccount(ownerUserId, billingAccountId);

    if (String(workspace.billingAccountId ?? "") !== String(billingAccount._id)) {
      workspace.billingAccountId = billingAccount._id;
      await workspace.save();
    }

    return billingAccount;
  }

  private async buildUsageCounts(
    billingAccountId: string,
    subscription: BillingSubscriptionDocument,
    options?: { ignoreConnectionIds?: string[] }
  ): Promise<BillingUsageCounts> {
    const workspaces = await WorkspaceModel.find({ billingAccountId }).select("_id");
    const workspaceIds = workspaces.map((workspace) => workspace._id);
    const [memberships, connections] = await Promise.all([
      workspaceIds.length
        ? WorkspaceMembershipModel.find({
            workspaceId: { $in: workspaceIds },
            status: { $in: ["active", "invited"] },
          }).select("userId")
        : Promise.resolve([]),
      workspaceIds.length
        ? ChannelConnectionModel.find({
            workspaceId: { $in: workspaceIds },
            status: { $ne: "inactive" },
          }).select("channel")
        : Promise.resolve([]),
    ]);

    const ignoredConnectionIds = new Set(
      (options?.ignoreConnectionIds ?? []).map((value) => String(value))
    );
    const connectedAccountsUsedByPlatform = emptyConnectedAccountsMap();

    for (const connection of connections) {
      if (ignoredConnectionIds.has(String(connection._id))) {
        continue;
      }

      const family = channelToPlatformFamily(connection.channel);
      connectedAccountsUsedByPlatform[family] += 1;
    }

    const periodWindow =
      subscription.currentPeriodStart && subscription.currentPeriodEnd
        ? {
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : buildPeriodWindow(subscription.billingInterval ?? "manual");

    const platformFamiliesUsed = PLATFORM_FAMILIES.filter(
      (family) => connectedAccountsUsedByPlatform[family] > 0
    );
    const externalPlatformFamiliesUsed = EXTERNAL_PLATFORM_FAMILIES.filter(
      (family) => connectedAccountsUsedByPlatform[family] > 0
    );
    const uniqueSeatIds = new Set(memberships.map((membership) => String(membership.userId)));

    await UsageSummaryModel.findOneAndUpdate(
      {
        billingAccountId,
        periodStart: periodWindow.currentPeriodStart,
        periodEnd: periodWindow.currentPeriodEnd,
      },
      {
        $set: {
          workspacesUsed: workspaces.length,
          seatsUsed: uniqueSeatIds.size,
          connectedAccountsUsedByPlatform,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    return {
      billingAccountId,
      periodStart: periodWindow.currentPeriodStart,
      periodEnd: periodWindow.currentPeriodEnd,
      seatsUsed: uniqueSeatIds.size,
      workspacesUsed: workspaces.length,
      connectedAccountsUsedByPlatform,
      platformFamiliesUsed,
      externalPlatformFamiliesUsed,
    };
  }

  private async loadOverrides(billingAccountId: string) {
    return BillingOverrideModel.find({ billingAccountId }).sort({
      effectiveFrom: -1,
      createdAt: -1,
    });
  }

  private async resolveScheduledPlan(subscription: BillingSubscriptionDocument) {
    const scheduledPlanCatalog =
      subscription.scheduledPlanCatalogId
        ? await PlanCatalogModel.findById(subscription.scheduledPlanCatalogId)
        : null;
    const scheduledPlanVersion =
      subscription.scheduledPlanVersionId
        ? await PlanVersionModel.findById(subscription.scheduledPlanVersionId)
        : null;

    if (!scheduledPlanCatalog || !scheduledPlanVersion) {
      return {
        scheduledPlanCatalog: null,
        scheduledPlanVersion: null,
      };
    }

    return {
      scheduledPlanCatalog,
      scheduledPlanVersion,
    };
  }

  private buildActionRequiredBeforeEffectiveDate(params: {
    usageCounts: BillingUsageCounts;
    targetEntitlements: ResolvedBillingEntitlements;
  }) {
    const items: string[] = [];

    if (params.usageCounts.seatsUsed > params.targetEntitlements.maxSeats) {
      items.push(
        `Reduce active seats from ${params.usageCounts.seatsUsed} to ${params.targetEntitlements.maxSeats} before the scheduled change takes effect.`
      );
    }

    if (params.usageCounts.workspacesUsed > params.targetEntitlements.maxWorkspaces) {
      items.push(
        `Reduce attached workspaces from ${params.usageCounts.workspacesUsed} to ${params.targetEntitlements.maxWorkspaces} before the scheduled change takes effect.`
      );
    }

    if (
      params.usageCounts.externalPlatformFamiliesUsed.length >
      params.targetEntitlements.maxExternalPlatformFamilies
    ) {
      items.push(
        `Reduce external platform families from ${params.usageCounts.externalPlatformFamiliesUsed.length} to ${params.targetEntitlements.maxExternalPlatformFamilies} before the scheduled change takes effect.`
      );
    }

    const disallowedFamilies = params.usageCounts.platformFamiliesUsed.filter(
      (family) => !params.targetEntitlements.allowedPlatformFamilies.includes(family)
    );
    if (disallowedFamilies.length > 0) {
      items.push(
        `${disallowedFamilies
          .map((family) => titleCaseLabel(family === "meta" ? "meta" : family))
          .join(", ")} will be restricted on the scheduled plan unless those connections are removed first.`
      );
    }

    if (!params.targetEntitlements.allowWebsiteChat && params.usageCounts.platformFamiliesUsed.includes("website")) {
      items.push(
        "Website Chat is not included on the scheduled plan, so website chat must be turned off before the change takes effect."
      );
    }

    return uniqueStringList(items);
  }

  private usageFitsEntitlements(
    usageCounts: BillingUsageCounts,
    entitlements: ResolvedBillingEntitlements
  ) {
    if (usageCounts.seatsUsed > entitlements.maxSeats) {
      return false;
    }

    if (usageCounts.workspacesUsed > entitlements.maxWorkspaces) {
      return false;
    }

    if (
      usageCounts.externalPlatformFamiliesUsed.length >
      entitlements.maxExternalPlatformFamilies
    ) {
      return false;
    }

    return usageCounts.platformFamiliesUsed.every((family) =>
      entitlements.allowedPlatformFamilies.includes(family)
    );
  }

  private async applyResolvedPlanToSubscription(params: {
    billingAccount: BillingAccountDocument;
    subscription: BillingSubscriptionDocument;
    planCatalog: PlanCatalogDocument;
    planVersion: PlanVersionDocument;
    status: BillingAccountStatus;
    trialEndsAt?: Date | null;
  }) {
    const periodWindow = buildPeriodWindow(params.planVersion.billingInterval);
    params.billingAccount.status = params.status;
    params.billingAccount.planCode = params.planCatalog.code;
    await params.billingAccount.save();

    const previousProvider = params.subscription.provider;
    params.subscription.provider = previousProvider === "stripe" ? "manual" : previousProvider;
    params.subscription.providerSubscriptionId =
      previousProvider === "stripe" ? "" : params.subscription.providerSubscriptionId;
    params.subscription.status = params.status;
    params.subscription.planCatalogId = params.planCatalog._id;
    params.subscription.planVersionId = params.planVersion._id;
    params.subscription.planCode = params.planCatalog.code;
    params.subscription.billingInterval = params.planVersion.billingInterval;
    params.subscription.billingCycle = params.planVersion.billingInterval;
    params.subscription.currentPeriodStart = periodWindow.currentPeriodStart;
    params.subscription.currentPeriodEnd = periodWindow.currentPeriodEnd;
    params.subscription.cancelAtPeriodEnd = false;
    params.subscription.trialEndsAt = params.trialEndsAt ?? null;
    params.subscription.trialPlanCode =
      params.status === "trialing" ? params.planCatalog.code : null;
    params.subscription.scheduledPlanCatalogId = null;
    params.subscription.scheduledPlanVersionId = null;
    params.subscription.scheduledPlanCode = null;
    params.subscription.scheduledChangeKind = null;
    params.subscription.scheduledChangeEffectiveAt = null;
    params.subscription.renewsAt = getEffectiveRenewalDate(params.subscription);
    params.subscription.gracePeriodEndsAt = null;
    await params.subscription.save();
  }

  private async applyFreeFallbackOrRestriction(params: {
    billingAccount: BillingAccountDocument;
    subscription: BillingSubscriptionDocument;
    usageCounts: BillingUsageCounts;
  }) {
    const freePlan = await this.ensureBackfillPlanVersion("free", "monthly");
    const freeEntitlements = normalizeEntitlements(
      freePlan.version.entitlements as ResolvedBillingEntitlements,
      buildSeedEntitlements("free")
    );

    if (this.usageFitsEntitlements(params.usageCounts, freeEntitlements)) {
      await this.applyResolvedPlanToSubscription({
        billingAccount: params.billingAccount,
        subscription: params.subscription,
        planCatalog: freePlan.catalog,
        planVersion: freePlan.version,
        status: "free_fallback",
        trialEndsAt: null,
      });
      return "free_fallback" as const;
    }

    params.billingAccount.status = "restricted";
    await params.billingAccount.save();
    params.subscription.status = "restricted";
    params.subscription.gracePeriodEndsAt = params.subscription.gracePeriodEndsAt ?? new Date();
    params.subscription.renewsAt = null;
    await params.subscription.save();
    return "restricted" as const;
  }

  private async applyAutomaticLifecycleTransitions(params: {
    billingAccount: BillingAccountDocument;
    subscription: BillingSubscriptionDocument;
  }) {
    const now = new Date();
    let changed = false;

    if (
      params.subscription.status === "past_due" &&
      !isDateValue(params.subscription.gracePeriodEndsAt)
    ) {
      params.subscription.gracePeriodEndsAt = buildGracePeriodEndsAt(now);
      changed = true;
    }

    if (changed) {
      params.subscription.renewsAt = getEffectiveRenewalDate(params.subscription);
      await params.subscription.save();
    }

    const scheduledEffectiveAt = params.subscription.scheduledChangeEffectiveAt ?? null;
    const shouldApplyScheduledChange =
      isDateValue(scheduledEffectiveAt) && scheduledEffectiveAt.getTime() <= now.getTime();

    if (shouldApplyScheduledChange && params.subscription.scheduledPlanVersionId) {
      const scheduled = await this.resolveScheduledPlan(params.subscription);
      if (scheduled.scheduledPlanCatalog && scheduled.scheduledPlanVersion) {
        await this.applyResolvedPlanToSubscription({
          billingAccount: params.billingAccount,
          subscription: params.subscription,
          planCatalog: scheduled.scheduledPlanCatalog,
          planVersion: scheduled.scheduledPlanVersion,
          status:
            scheduled.scheduledPlanCatalog.code === "free" ? "active" : "active",
          trialEndsAt: null,
        });
        return;
      }
    }

    const usageCounts = await this.buildUsageCounts(
      String(params.billingAccount._id),
      params.subscription
    );

    if (
      (params.subscription.status === "past_due" ||
        params.subscription.status === "grace_period") &&
      isDateValue(params.subscription.gracePeriodEndsAt)
    ) {
      if (params.subscription.gracePeriodEndsAt.getTime() > now.getTime()) {
        if (params.subscription.status !== "grace_period") {
          params.billingAccount.status = "grace_period";
          params.subscription.status = "grace_period";
          await Promise.all([params.billingAccount.save(), params.subscription.save()]);
        }
      } else {
        await this.applyFreeFallbackOrRestriction({
          billingAccount: params.billingAccount,
          subscription: params.subscription,
          usageCounts,
        });
      }
    }

    if (
      params.subscription.status === "trialing" &&
      isDateValue(params.subscription.trialEndsAt) &&
      params.subscription.trialEndsAt.getTime() <= now.getTime()
    ) {
      const scheduled = await this.resolveScheduledPlan(params.subscription);
      if (scheduled.scheduledPlanCatalog && scheduled.scheduledPlanVersion) {
        await this.applyResolvedPlanToSubscription({
          billingAccount: params.billingAccount,
          subscription: params.subscription,
          planCatalog: scheduled.scheduledPlanCatalog,
          planVersion: scheduled.scheduledPlanVersion,
          status:
            scheduled.scheduledPlanCatalog.code === "free" ? "active" : "active",
          trialEndsAt: null,
        });
      } else {
        params.billingAccount.status = "active";
        params.subscription.status = "active";
        params.subscription.trialEndsAt = null;
        params.subscription.trialPlanCode = null;
        params.subscription.renewsAt = getEffectiveRenewalDate(params.subscription);
        await Promise.all([params.billingAccount.save(), params.subscription.save()]);
      }
    }

    if (
      params.subscription.cancelAtPeriodEnd &&
      isDateValue(params.subscription.currentPeriodEnd) &&
      params.subscription.currentPeriodEnd.getTime() <= now.getTime()
    ) {
      await this.applyFreeFallbackOrRestriction({
        billingAccount: params.billingAccount,
        subscription: params.subscription,
        usageCounts,
      });
    }
  }

  private async enforceSeatAssignmentsForBillingAccount(params: {
    billingAccountId: string;
    maxSeats: number;
  }) {
    const workspaces = await WorkspaceModel.find({
      billingAccountId: params.billingAccountId,
    }).select("_id createdByUserId");

    if (!workspaces.length) {
      return;
    }

    const workspaceOwnerMap = new Map(
      workspaces.map((workspace) => [
        String(workspace._id),
        workspace.createdByUserId ? String(workspace.createdByUserId) : null,
      ])
    );
    const memberships = await WorkspaceMembershipModel.find({
      workspaceId: { $in: workspaces.map((workspace) => workspace._id) },
      status: { $in: ["active", "invited", "inactive_due_to_plan_limit"] },
    }).sort({ createdAt: 1 });

    const membershipsByUserId = new Map<string, typeof memberships>();
    for (const membership of memberships) {
      const userId = String(membership.userId);
      const items = membershipsByUserId.get(userId) ?? [];
      items.push(membership);
      membershipsByUserId.set(userId, items);
    }

    const roleWeight = (role: string) => {
      switch (role) {
        case "owner":
          return 0;
        case "admin":
          return 1;
        case "manager":
          return 2;
        case "agent":
          return 3;
        default:
          return 4;
      }
    };

    const rankedUsers = [...membershipsByUserId.entries()]
      .map(([userId, userMemberships]) => {
        const ownerOfRecord = userMemberships.some(
          (membership) =>
            workspaceOwnerMap.get(String(membership.workspaceId)) === userId
        );
        const bestRoleScore = Math.min(
          ...userMemberships.map((membership) =>
            ownerOfRecord ? 0 : roleWeight(membership.role)
          )
        );
        const lastActiveAt = userMemberships.reduce<Date | null>((latest, membership) => {
          if (!isDateValue(membership.lastActiveAt)) {
            return latest;
          }
          if (!latest || membership.lastActiveAt.getTime() > latest.getTime()) {
            return membership.lastActiveAt;
          }
          return latest;
        }, null);
        const createdAt = userMemberships[0]?.createdAt ?? new Date(0);

        return {
          userId,
          ownerOfRecord,
          bestRoleScore,
          lastActiveAt,
          createdAt,
          memberships: userMemberships,
        };
      })
      .sort((left, right) => {
        if (left.ownerOfRecord !== right.ownerOfRecord) {
          return left.ownerOfRecord ? -1 : 1;
        }
        if (left.bestRoleScore !== right.bestRoleScore) {
          return left.bestRoleScore - right.bestRoleScore;
        }
        const leftTime = left.lastActiveAt?.getTime() ?? 0;
        const rightTime = right.lastActiveAt?.getTime() ?? 0;
        if (leftTime !== rightTime) {
          return rightTime - leftTime;
        }
        return left.createdAt.getTime() - right.createdAt.getTime();
      });

    const allowedUserIds = new Set(
      rankedUsers.slice(0, Math.max(0, params.maxSeats)).map((item) => item.userId)
    );
    const updates: Array<Promise<unknown>> = [];

    for (const rankedUser of rankedUsers) {
      const shouldStayActive = allowedUserIds.has(rankedUser.userId);
      for (const membership of rankedUser.memberships) {
        const targetStatus = shouldStayActive
          ? membership.inviteTokenHash && !membership.inviteAcceptedAt
            ? "invited"
            : "active"
          : "inactive_due_to_plan_limit";
        if (membership.status !== targetStatus) {
          membership.status = targetStatus;
          updates.push(membership.save());
        }
      }
    }

    if (updates.length > 0) {
      await Promise.all(updates);
    }
  }

  private resolveOverrides(params: {
    subscription: BillingSubscriptionDocument;
    planVersion: PlanVersionDocument;
    planCode: string;
    overrides: BillingOverrideDocument[];
  }) {
    const fallback = buildSeedEntitlements(params.planCode);
    let resolvedEntitlements = normalizeEntitlements(
      params.planVersion.entitlements as ResolvedBillingEntitlements,
      fallback
    );
    let resolvedStatus = normalizeBillingStatus(params.subscription.status, "active");
    let resolvedTrialEndsAt = params.subscription.trialEndsAt ?? null;

    const activeOverrides = params.overrides
      .filter((override) => isOverrideActive(override))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

    for (const override of activeOverrides) {
      if (override.type === "entitlement_override") {
        const payload =
          override.payload && typeof override.payload === "object"
            ? (override.payload as Partial<ResolvedBillingEntitlements>)
            : {};
        resolvedEntitlements = normalizeEntitlements(payload, resolvedEntitlements);
      }

      if (override.type === "manual_status") {
        const payload =
          override.payload && typeof override.payload === "object"
            ? (override.payload as { status?: unknown })
            : {};
        resolvedStatus = normalizeBillingStatus(payload.status, resolvedStatus);
      }

      if (override.type === "trial_extension") {
        const payload =
          override.payload && typeof override.payload === "object"
            ? (override.payload as { trialEndsAt?: unknown })
            : {};
        const nextTrialEndsAt =
          payload.trialEndsAt instanceof Date
            ? payload.trialEndsAt
            : trimString(payload.trialEndsAt)
              ? new Date(String(payload.trialEndsAt))
              : null;
        if (nextTrialEndsAt && !Number.isNaN(nextTrialEndsAt.getTime())) {
          resolvedTrialEndsAt = nextTrialEndsAt;
        }
      }
    }

    return {
      activeOverrides,
      resolvedEntitlements,
      resolvedStatus,
      resolvedTrialEndsAt,
    };
  }

  private serializeBillingState(context: BillingContext): SerializedBillingState {
    return this.serializeBillingSnapshot({
      billingAccount: context.billingAccount,
      subscription: context.subscription,
      planCatalog: context.planCatalog,
      planVersion: context.planVersion,
      resolvedEntitlements: context.resolvedEntitlements,
      resolvedStatus: context.resolvedStatus,
      resolvedTrialEndsAt: context.resolvedTrialEndsAt,
      resolvedScheduledPlanCatalog: context.resolvedScheduledPlanCatalog,
      resolvedScheduledPlanVersion: context.resolvedScheduledPlanVersion,
      resolvedScheduledChangeKind: context.resolvedScheduledChangeKind,
      resolvedScheduledChangeEffectiveAt: context.resolvedScheduledChangeEffectiveAt,
      resolvedRenewsAt: context.resolvedRenewsAt,
      resolvedGracePeriodEndsAt: context.resolvedGracePeriodEndsAt,
      usageCounts: context.usageCounts,
      activeOverrideCount: context.activeOverrides.length,
    });
  }

  private serializeBillingSnapshot(
    params: BillingStateSnapshotInput
  ): SerializedBillingState {
    const actionRequiredBeforeEffectiveDate =
      params.resolvedScheduledPlanVersion && params.resolvedScheduledChangeEffectiveAt
        ? this.buildActionRequiredBeforeEffectiveDate({
            usageCounts: params.usageCounts,
            targetEntitlements: normalizeEntitlements(
              params.resolvedScheduledPlanVersion
                .entitlements as ResolvedBillingEntitlements,
              buildSeedEntitlements(
                params.resolvedScheduledPlanCatalog?.code ?? "free"
              )
            ),
          })
        : [];

    const billingActivity: BillingActivitySummary = {
      outstandingAmount:
        params.resolvedStatus === "past_due" || params.resolvedStatus === "grace_period"
          ? params.planVersion.priceAmount
          : null,
      currency:
        params.resolvedStatus === "past_due" || params.resolvedStatus === "grace_period"
          ? normalizeCurrency(params.planVersion.currency)
          : null,
      latestChargeStatus:
        params.resolvedStatus === "past_due" || params.resolvedStatus === "grace_period"
          ? "Payment required"
          : params.resolvedStatus === "restricted"
            ? "Restricted until billing is resolved"
            : params.subscription.provider === "stripe"
              ? "Stripe-managed"
              : "Manual billing",
      nextBillingAt: params.resolvedRenewsAt,
      latestInvoiceLabel:
        params.subscription.provider === "stripe" ? "Stripe hosted" : "Manual billing",
    };

    return {
      account: {
        _id: String(params.billingAccount._id),
        ownerUserId: params.billingAccount.ownerUserId
          ? String(params.billingAccount.ownerUserId)
          : null,
        name: params.billingAccount.name,
        status: params.resolvedStatus,
        createdAt: params.billingAccount.createdAt,
      },
      subscription: {
        _id: String(params.subscription._id),
        provider: params.subscription.provider,
        providerSubscriptionId:
          trimString(params.subscription.providerSubscriptionId) || null,
        status: params.resolvedStatus,
        planCatalogId: String(params.planCatalog._id),
        planVersionId: String(params.planVersion._id),
        planCode: params.planCatalog.code,
        planDisplayName: params.planCatalog.displayName,
        version: params.planVersion.version,
        billingInterval: params.planVersion.billingInterval,
        priceAmount: params.planVersion.priceAmount,
        currency: normalizeCurrency(params.planVersion.currency),
        currentPeriodStart: params.subscription.currentPeriodStart ?? null,
        currentPeriodEnd: params.subscription.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: !!params.subscription.cancelAtPeriodEnd,
        trialEndsAt: params.resolvedTrialEndsAt,
        trialPlanCode: trimString(params.subscription.trialPlanCode) || null,
        scheduledPlanCatalogId: params.resolvedScheduledPlanCatalog
          ? String(params.resolvedScheduledPlanCatalog._id)
          : null,
        scheduledPlanVersionId: params.resolvedScheduledPlanVersion
          ? String(params.resolvedScheduledPlanVersion._id)
          : null,
        scheduledPlanCode:
          trimString(params.subscription.scheduledPlanCode) ||
          trimString(params.resolvedScheduledPlanCatalog?.code) ||
          null,
        scheduledPlanDisplayName: params.resolvedScheduledPlanCatalog?.displayName ?? null,
        scheduledChangeKind: params.resolvedScheduledChangeKind,
        scheduledChangeEffectiveAt: params.resolvedScheduledChangeEffectiveAt,
        renewsAt: params.resolvedRenewsAt,
        gracePeriodEndsAt: params.resolvedGracePeriodEndsAt,
      },
      entitlements: params.resolvedEntitlements,
      usageSummary: {
        ...params.usageCounts,
        seatsRemaining: Math.max(
          params.resolvedEntitlements.maxSeats - params.usageCounts.seatsUsed,
          0
        ),
        workspacesRemaining: Math.max(
          params.resolvedEntitlements.maxWorkspaces - params.usageCounts.workspacesUsed,
          0
        ),
        externalPlatformFamiliesRemaining: Math.max(
          params.resolvedEntitlements.maxExternalPlatformFamilies -
            params.usageCounts.externalPlatformFamiliesUsed.length,
          0
        ),
      },
      overrides: {
        activeCount: params.activeOverrideCount,
      },
      actionRequiredBeforeEffectiveDate,
      billingActivity,
    };
  }

  private buildBillingLimitDetails(params: {
    gate: BillingLimitGate;
    billing: SerializedBillingState;
    limitValue?: number;
    usedValue?: number;
    platformFamily?: PlatformFamily;
    channel?: CanonicalChannel;
  }): BillingLimitDetails {
    return {
      upgradeRequired: true,
      gate: params.gate,
      billing: params.billing,
      limitValue: params.limitValue,
      usedValue: params.usedValue,
      platformFamily: params.platformFamily,
      channel: params.channel,
    };
  }

  async getWorkspaceBillingState(
    workspaceOrId: string | WorkspaceDocument,
    options?: { ignoreConnectionIds?: string[] }
  ) {
    const workspace =
      typeof workspaceOrId === "string"
        ? await WorkspaceModel.findById(workspaceOrId)
        : workspaceOrId;

    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const ensured = await this.ensureWorkspaceBillingAccount(workspace);
    await this.applyAutomaticLifecycleTransitions({
      billingAccount: ensured.billingAccount,
      subscription: ensured.subscription,
    });

    const refreshedPlanCatalog =
      (await PlanCatalogModel.findById(ensured.subscription.planCatalogId)) ??
      ensured.planCatalog;
    const refreshedPlanVersion =
      (await PlanVersionModel.findById(ensured.subscription.planVersionId)) ??
      ensured.planVersion;
    const allOverrides = await this.loadOverrides(String(ensured.billingAccount._id));
    const resolved = this.resolveOverrides({
      subscription: ensured.subscription,
      planVersion: refreshedPlanVersion,
      planCode: refreshedPlanCatalog.code,
      overrides: allOverrides,
    });
    await this.enforceSeatAssignmentsForBillingAccount({
      billingAccountId: String(ensured.billingAccount._id),
      maxSeats: resolved.resolvedEntitlements.maxSeats,
    });
    const usageCounts = await this.buildUsageCounts(
      String(ensured.billingAccount._id),
      ensured.subscription,
      {
        ignoreConnectionIds: options?.ignoreConnectionIds,
      }
    );
    const scheduled = await this.resolveScheduledPlan(ensured.subscription);

    const context: BillingContext = {
      workspace,
      billingAccount: ensured.billingAccount,
      subscription: ensured.subscription,
      planCatalog: refreshedPlanCatalog,
      planVersion: refreshedPlanVersion,
      resolvedEntitlements: resolved.resolvedEntitlements,
      resolvedStatus: resolved.resolvedStatus,
      resolvedTrialEndsAt: resolved.resolvedTrialEndsAt,
      resolvedScheduledPlanCatalog: scheduled.scheduledPlanCatalog,
      resolvedScheduledPlanVersion: scheduled.scheduledPlanVersion,
      resolvedScheduledChangeKind:
        (ensured.subscription.scheduledChangeKind as ScheduledChangeKind | null) ?? null,
      resolvedScheduledChangeEffectiveAt:
        ensured.subscription.scheduledChangeEffectiveAt ?? null,
      resolvedRenewsAt:
        ensured.subscription.renewsAt ?? getEffectiveRenewalDate(ensured.subscription),
      resolvedGracePeriodEndsAt: ensured.subscription.gracePeriodEndsAt ?? null,
      allOverrides,
      activeOverrides: resolved.activeOverrides,
      usageCounts,
    };

    return {
      ...context,
      serialized: this.serializeBillingState(context),
    };
  }

  async listPlanCatalogs() {
    await this.ensureDefaultPlanCatalogs();
    const [catalogs, versions, subscriptions] = await Promise.all([
      PlanCatalogModel.find().sort({ sortOrder: 1, createdAt: 1 }),
      PlanVersionModel.find().sort({ planCatalogId: 1, version: -1 }),
      BillingSubscriptionModel.find().select("planCatalogId"),
    ]);

    const versionsByCatalogId = new Map<string, PlanVersionDocument[]>();
    for (const version of versions) {
      const key = String(version.planCatalogId);
      const items = versionsByCatalogId.get(key) ?? [];
      items.push(version);
      versionsByCatalogId.set(key, items);
    }

    const subscriptionCounts = new Map<string, number>();
    for (const subscription of subscriptions) {
      if (!subscription.planCatalogId) {
        continue;
      }
      const key = String(subscription.planCatalogId);
      subscriptionCounts.set(key, (subscriptionCounts.get(key) ?? 0) + 1);
    }

    return catalogs.map((catalog) => ({
      _id: String(catalog._id),
      code: catalog.code,
      displayName: catalog.displayName,
      sortOrder: normalizeSortOrder(catalog.sortOrder, 100),
      showPublicly:
        typeof catalog.showPublicly === "boolean" ? catalog.showPublicly : true,
      selfServe: typeof catalog.selfServe === "boolean" ? catalog.selfServe : true,
      pricingMode: normalizePricingMode(
        catalog.pricingMode,
        catalog.code === "free"
          ? "free"
          : catalog.code === "custom"
            ? "manual"
            : "fixed"
      ),
      planGroup: normalizePlanGroup(
        catalog.planGroup,
        catalog.code === "custom" ? "custom" : "standard"
      ),
      active: catalog.active,
      createdAt: catalog.createdAt,
      updatedAt: catalog.updatedAt,
      currentSubscriptions: subscriptionCounts.get(String(catalog._id)) ?? 0,
      versions: (versionsByCatalogId.get(String(catalog._id)) ?? []).map(serializePlanVersion),
    }));
  }

  async getPlanCatalog(planCatalogId: string) {
    await this.ensureDefaultPlanCatalogs();
    const catalog = await PlanCatalogModel.findById(planCatalogId);
    if (!catalog) {
      throw new NotFoundError("Plan catalog not found");
    }

    const [versions, subscriptionCount] = await Promise.all([
      PlanVersionModel.find({ planCatalogId: catalog._id }).sort({ version: -1 }),
      BillingSubscriptionModel.countDocuments({ planCatalogId: catalog._id }),
    ]);

    return {
      _id: String(catalog._id),
      code: catalog.code,
      displayName: catalog.displayName,
      sortOrder: normalizeSortOrder(catalog.sortOrder, 100),
      showPublicly:
        typeof catalog.showPublicly === "boolean" ? catalog.showPublicly : true,
      selfServe: typeof catalog.selfServe === "boolean" ? catalog.selfServe : true,
      pricingMode: normalizePricingMode(
        catalog.pricingMode,
        catalog.code === "free"
          ? "free"
          : catalog.code === "custom"
            ? "manual"
            : "fixed"
      ),
      planGroup: normalizePlanGroup(
        catalog.planGroup,
        catalog.code === "custom" ? "custom" : "standard"
      ),
      active: catalog.active,
      createdAt: catalog.createdAt,
      updatedAt: catalog.updatedAt,
      currentSubscriptions: subscriptionCount,
      versions: versions.map(serializePlanVersion),
    };
  }

  async createPlanCatalog(input: PlanCatalogCreateInput) {
    await this.ensureDefaultPlanCatalogs();

    const code = normalizePlanCode(input.code);
    const displayName = trimString(input.displayName);
    if (!code) {
      throw new ValidationError("Plan code is required");
    }
    if (!displayName) {
      throw new ValidationError("Plan display name is required");
    }

    const existing = await PlanCatalogModel.findOne({ code });
    if (existing) {
      throw new ValidationError("Plan code already exists");
    }

    const catalog = await PlanCatalogModel.create({
      code,
      displayName,
      sortOrder: normalizeSortOrder(input.sortOrder, 100),
      showPublicly:
        typeof input.showPublicly === "boolean" ? input.showPublicly : true,
      selfServe: typeof input.selfServe === "boolean" ? input.selfServe : true,
      pricingMode: normalizePricingMode(
        input.pricingMode,
        code === "free" ? "free" : code === "custom" ? "manual" : "fixed"
      ),
      planGroup: normalizePlanGroup(
        input.planGroup,
        code === "custom" ? "custom" : "standard"
      ),
      active: input.active !== false,
    });

    const createdPlan = await this.getPlanCatalog(String(catalog._id));
    await invalidatePortalDashboardCache();
    return createdPlan;
  }

  async updatePlanCatalog(planCatalogId: string, input: PlanCatalogUpdateInput) {
    const catalog = await PlanCatalogModel.findById(planCatalogId);
    if (!catalog) {
      throw new NotFoundError("Plan catalog not found");
    }

    let changed = false;
    if (typeof input.displayName === "string" && trimString(input.displayName)) {
      catalog.displayName = trimString(input.displayName);
      changed = true;
    }
    if (typeof input.sortOrder === "number" && Number.isFinite(input.sortOrder)) {
      catalog.sortOrder = normalizeSortOrder(input.sortOrder, catalog.sortOrder);
      changed = true;
    }
    if (typeof input.showPublicly === "boolean") {
      catalog.showPublicly = input.showPublicly;
      changed = true;
    }
    if (typeof input.selfServe === "boolean") {
      catalog.selfServe = input.selfServe;
      changed = true;
    }
    if (typeof input.pricingMode === "string") {
      catalog.pricingMode = normalizePricingMode(input.pricingMode, catalog.pricingMode);
      changed = true;
    }
    if (typeof input.planGroup === "string") {
      catalog.planGroup = normalizePlanGroup(input.planGroup, catalog.planGroup);
      changed = true;
    }
    if (typeof input.active === "boolean") {
      catalog.active = input.active;
      changed = true;
    }

    if (changed) {
      await catalog.save();
      await invalidatePortalDashboardCache();
    }

    return this.getPlanCatalog(planCatalogId);
  }

  async createPlanVersion(planCatalogId: string, input: PlanVersionCreateInput) {
    const catalog = await PlanCatalogModel.findById(planCatalogId);
    if (!catalog) {
      throw new NotFoundError("Plan catalog not found");
    }

    const latestVersion = await PlanVersionModel.findOne({
      planCatalogId: catalog._id,
    }).sort({ version: -1 });
    const versionNumber = latestVersion ? latestVersion.version + 1 : 1;

    await PlanVersionModel.create({
      planCatalogId: catalog._id,
      version: versionNumber,
      active: input.active !== false,
      billingInterval: normalizeBillingInterval(input.billingInterval),
      priceAmount: Math.max(0, input.priceAmount),
      currency: normalizeCurrency(input.currency),
      stripeProductId: trimString(input.stripeProductId),
      stripePriceId: trimString(input.stripePriceId),
      entitlements: normalizeEntitlements(
        input.entitlements,
        buildSeedEntitlements(catalog.code)
      ),
      createdBy: input.createdBy ?? null,
    });

    const updatedPlan = await this.getPlanCatalog(planCatalogId);
    await invalidatePortalDashboardCache();
    return updatedPlan;
  }

  async findPlanVersionByStripePriceId(stripePriceId: string) {
    const normalizedPriceId = trimString(stripePriceId);
    if (!normalizedPriceId) {
      return null;
    }

    const planVersion = await PlanVersionModel.findOne({
      stripePriceId: normalizedPriceId,
    });
    if (!planVersion) {
      return null;
    }

    const planCatalog = await PlanCatalogModel.findById(planVersion.planCatalogId);
    if (!planCatalog) {
      throw new NotFoundError("Plan catalog not found for Stripe price");
    }

    return { planCatalog, planVersion };
  }

  async syncStripeSubscriptionForBillingAccount(input: {
    billingAccountId: string;
    customerId: string;
    providerSubscriptionId: string;
    status: BillingAccountStatus;
    planVersionId?: string | null;
    stripePriceId?: string | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    trialEndsAt?: Date | null;
  }) {
    const billingAccountId = trimString(input.billingAccountId);
    if (!billingAccountId) {
      throw new ValidationError("billingAccountId is required for Stripe sync");
    }

    return withRedisLock(`lock:billing-account:${billingAccountId}`, 30, async () => {
      const billingAccount = await BillingAccountModel.findById(billingAccountId);
      if (!billingAccount) {
        throw new NotFoundError("Billing account not found");
      }

      const subscription = await this.ensureBillingSubscriptionForAccount({
        billingAccount,
        seedPlanCode: trimString(billingAccount.planCode) || undefined,
        seedStatus: input.status,
      });

      let resolvedPlanVersion =
        trimString(input.planVersionId).length > 0
          ? await PlanVersionModel.findById(trimString(input.planVersionId))
          : null;

      if (!resolvedPlanVersion && trimString(input.stripePriceId)) {
        resolvedPlanVersion =
          (await this.findPlanVersionByStripePriceId(trimString(input.stripePriceId)))?.planVersion ??
          null;
      }

      if (!resolvedPlanVersion && subscription.planVersionId) {
        resolvedPlanVersion = await PlanVersionModel.findById(subscription.planVersionId);
      }

      if (!resolvedPlanVersion) {
        throw new ValidationError(
          "Unable to resolve a billing plan version for the Stripe subscription"
        );
      }

      const resolvedPlanCatalog = await PlanCatalogModel.findById(
        resolvedPlanVersion.planCatalogId
      );
      if (!resolvedPlanCatalog) {
        throw new NotFoundError("Plan catalog not found");
      }

      billingAccount.paymentProviderCustomerId = trimString(input.customerId);
      billingAccount.status = normalizeBillingStatus(input.status, billingAccount.status);
      billingAccount.planCode = resolvedPlanCatalog.code;
      await billingAccount.save();

      const periodWindow = buildPeriodWindow(resolvedPlanVersion.billingInterval);
      subscription.provider = "stripe";
      subscription.providerSubscriptionId = trimString(input.providerSubscriptionId);
      subscription.status = normalizeBillingStatus(input.status, subscription.status);
      subscription.planCatalogId = resolvedPlanCatalog._id;
      subscription.planVersionId = resolvedPlanVersion._id;
      subscription.planCode = resolvedPlanCatalog.code;
      subscription.billingInterval = resolvedPlanVersion.billingInterval;
      subscription.billingCycle = resolvedPlanVersion.billingInterval;
      subscription.currentPeriodStart =
        input.currentPeriodStart === undefined
          ? subscription.currentPeriodStart ?? periodWindow.currentPeriodStart
          : input.currentPeriodStart;
      subscription.currentPeriodEnd =
        input.currentPeriodEnd === undefined
          ? subscription.currentPeriodEnd ?? periodWindow.currentPeriodEnd
          : input.currentPeriodEnd;
      subscription.cancelAtPeriodEnd =
        input.cancelAtPeriodEnd ?? subscription.cancelAtPeriodEnd ?? false;
      subscription.trialEndsAt =
        input.trialEndsAt === undefined
          ? subscription.status === "trialing"
            ? subscription.trialEndsAt ?? buildTrialEndsAt()
            : null
          : input.trialEndsAt;
      subscription.trialPlanCode =
        subscription.status === "trialing" ? resolvedPlanCatalog.code : null;
      subscription.scheduledPlanCatalogId = null;
      subscription.scheduledPlanVersionId = null;
      subscription.scheduledPlanCode = null;
      subscription.scheduledChangeKind = null;
      subscription.scheduledChangeEffectiveAt = null;
      subscription.renewsAt = getEffectiveRenewalDate(subscription);
      subscription.gracePeriodEndsAt =
        subscription.status === "past_due" || subscription.status === "grace_period"
          ? subscription.gracePeriodEndsAt ?? buildGracePeriodEndsAt()
          : null;
      await subscription.save();

      await invalidatePortalDashboardCache();

      return {
        billingAccount,
        subscription,
        planCatalog: resolvedPlanCatalog,
        planVersion: resolvedPlanVersion,
      };
    });
  }

  async listBillingAccountOverrides(workspaceOrId: string | WorkspaceDocument) {
    const context = await this.getWorkspaceBillingState(workspaceOrId);
    return context.allOverrides.map((override) => serializeOverride(override));
  }

  async updateWorkspaceSubscription(
    workspaceId: string,
    input: ManualBillingSubscriptionUpdateInput
  ) {
    const initialContext = await this.getWorkspaceBillingState(workspaceId);
    const billingAccountId = String(initialContext.billingAccount._id);

    return withRedisLock(`lock:billing-account:${billingAccountId}`, 30, async () => {
      const context = await this.getWorkspaceBillingState(workspaceId);
      const planVersion = await PlanVersionModel.findById(input.planVersionId);
      if (!planVersion) {
        throw new NotFoundError("Plan version not found");
      }

      const planCatalog = await PlanCatalogModel.findById(planVersion.planCatalogId);
      if (!planCatalog) {
        throw new NotFoundError("Plan catalog not found");
      }

      context.billingAccount.name =
        trimString(input.billingAccountName) || context.billingAccount.name;
      context.billingAccount.status = normalizeBillingStatus(input.status, "active");
      context.billingAccount.planCode = planCatalog.code;
      await context.billingAccount.save();

      const periodWindow = buildPeriodWindow(planVersion.billingInterval);
      context.subscription.provider = input.provider ?? context.subscription.provider ?? "manual";
      if (context.subscription.provider !== "stripe") {
        context.subscription.providerSubscriptionId = "";
      }
      context.subscription.status = normalizeBillingStatus(input.status, "active");
      context.subscription.planCatalogId = planCatalog._id;
      context.subscription.planVersionId = planVersion._id;
      context.subscription.planCode = planCatalog.code;
      context.subscription.billingInterval = planVersion.billingInterval;
      context.subscription.billingCycle = planVersion.billingInterval;
      context.subscription.currentPeriodStart =
        input.currentPeriodStart === undefined
          ? context.subscription.currentPeriodStart ?? periodWindow.currentPeriodStart
          : input.currentPeriodStart;
      context.subscription.currentPeriodEnd =
        input.currentPeriodEnd === undefined
          ? context.subscription.currentPeriodEnd ?? periodWindow.currentPeriodEnd
          : input.currentPeriodEnd;
      context.subscription.cancelAtPeriodEnd =
        input.cancelAtPeriodEnd ?? context.subscription.cancelAtPeriodEnd ?? false;
      context.subscription.trialEndsAt =
        input.trialEndsAt === undefined
          ? context.subscription.status === "trialing"
            ? context.subscription.trialEndsAt ?? buildTrialEndsAt()
            : null
          : input.trialEndsAt;
      context.subscription.trialPlanCode =
        context.subscription.status === "trialing" ? planCatalog.code : null;
      context.subscription.scheduledPlanCatalogId = null;
      context.subscription.scheduledPlanVersionId = null;
      context.subscription.scheduledPlanCode = null;
      context.subscription.scheduledChangeKind = null;
      context.subscription.scheduledChangeEffectiveAt = null;
      context.subscription.renewsAt = getEffectiveRenewalDate(context.subscription);
      context.subscription.gracePeriodEndsAt =
        context.subscription.status === "past_due" ||
        context.subscription.status === "grace_period"
          ? context.subscription.gracePeriodEndsAt ?? buildGracePeriodEndsAt()
          : null;
      await context.subscription.save();

      await invalidatePortalDashboardCache();
      return this.getWorkspaceBillingState(workspaceId);
    });
  }

  async changeWorkspacePlan(params: {
    workspaceId: string;
    ownerUserId: string;
    planVersionId: string;
  }): Promise<WorkspacePlanChangeResult> {
    const initialContext = await this.getWorkspaceBillingState(params.workspaceId);
    const billingAccountId = String(initialContext.billingAccount._id);

    return withRedisLock(`lock:billing-account:${billingAccountId}`, 30, async () => {
      const context = await this.getWorkspaceBillingState(params.workspaceId);

      if (String(context.billingAccount.ownerUserId ?? "") !== trimString(params.ownerUserId)) {
        throw new ForbiddenError("Only the billing-account owner can change this plan.");
      }

      const planVersion = await PlanVersionModel.findById(params.planVersionId);
      if (!planVersion) {
        throw new NotFoundError("Plan version not found");
      }

      const planCatalog = await PlanCatalogModel.findById(planVersion.planCatalogId);
      if (!planCatalog) {
        throw new NotFoundError("Plan catalog not found");
      }

      if (
        String(context.subscription.planCatalogId ?? "") === String(planCatalog._id) &&
        String(context.subscription.planVersionId ?? "") === String(planVersion._id)
      ) {
        return {
          mode: "plan_updated",
          billing: context.serialized,
          trial: await this.getAccountTrialState(params.ownerUserId),
        };
      }

      const pricingMode = normalizePricingMode(
        planCatalog.pricingMode,
        planCatalog.code === "free"
          ? "free"
          : planCatalog.code === "custom"
            ? "manual"
            : "fixed"
      );
      const currentTrial = await this.getAccountTrialState(params.ownerUserId);

      const currentSortOrder = normalizeSortOrder(context.planCatalog.sortOrder, 100);
      const targetSortOrder = normalizeSortOrder(planCatalog.sortOrder, 100);
      const currentEntitlements = context.resolvedEntitlements;
      const targetEntitlements = normalizeEntitlements(
        planVersion.entitlements as ResolvedBillingEntitlements,
        buildSeedEntitlements(planCatalog.code)
      );
      const targetIsLowerTier =
        targetSortOrder < currentSortOrder ||
        targetEntitlements.maxSeats < currentEntitlements.maxSeats ||
        targetEntitlements.maxWorkspaces < currentEntitlements.maxWorkspaces ||
        targetEntitlements.maxExternalPlatformFamilies <
          currentEntitlements.maxExternalPlatformFamilies ||
        currentEntitlements.allowedPlatformFamilies.some(
          (family) => !targetEntitlements.allowedPlatformFamilies.includes(family)
        ) ||
        (!targetEntitlements.allowAutomation && currentEntitlements.allowAutomation) ||
        (!targetEntitlements.allowBYOAI && currentEntitlements.allowBYOAI) ||
        (!targetEntitlements.allowCustomDomain && currentEntitlements.allowCustomDomain);

      if (pricingMode === "free" || targetIsLowerTier) {
        const effectiveAt =
          context.resolvedTrialEndsAt ??
          context.subscription.currentPeriodEnd ??
          new Date();

        context.subscription.scheduledPlanCatalogId = planCatalog._id;
        context.subscription.scheduledPlanVersionId = planVersion._id;
        context.subscription.scheduledPlanCode = planCatalog.code;
        context.subscription.scheduledChangeKind = "downgrade";
        context.subscription.scheduledChangeEffectiveAt = effectiveAt;
        context.subscription.cancelAtPeriodEnd = false;
        await context.subscription.save();

        await invalidatePortalDashboardCache();
        const updated = await this.getWorkspaceBillingState(params.workspaceId);
        return {
          mode: "change_scheduled",
          billing: updated.serialized,
          trial: currentTrial,
        };
      }

      if (pricingMode === "fixed" && currentTrial.available) {
        const startedAt = new Date();
        const trialEndsAt = buildTrialEndsAt(startedAt);
        await this.applyResolvedPlanToSubscription({
          billingAccount: context.billingAccount,
          subscription: context.subscription,
          planCatalog,
          planVersion,
          status: "trialing",
          trialEndsAt,
        });
        const consumedTrial = await this.consumePaidPlanTrial({
          ownerUserId: params.ownerUserId,
          billingAccountId,
          planCode: planCatalog.code,
          startedAt,
        });

        await invalidatePortalDashboardCache();
        const updated = await this.getWorkspaceBillingState(params.workspaceId);
        return {
          mode: "trial_started",
          billing: updated.serialized,
          trial: consumedTrial,
        };
      }

      return {
        mode: "manual_billing_required",
        billing: context.serialized,
        trial: currentTrial,
      };
    });
  }

  async undoScheduledWorkspacePlanChange(params: {
    workspaceId: string;
    ownerUserId: string;
  }) {
    const initialContext = await this.getWorkspaceBillingState(params.workspaceId);
    const billingAccountId = String(initialContext.billingAccount._id);

    return withRedisLock(`lock:billing-account:${billingAccountId}`, 30, async () => {
      const context = await this.getWorkspaceBillingState(params.workspaceId);

      if (String(context.billingAccount.ownerUserId ?? "") !== trimString(params.ownerUserId)) {
        throw new ForbiddenError("Only the billing-account owner can change this plan.");
      }

      context.subscription.scheduledPlanCatalogId = null;
      context.subscription.scheduledPlanVersionId = null;
      context.subscription.scheduledPlanCode = null;
      context.subscription.scheduledChangeKind = null;
      context.subscription.scheduledChangeEffectiveAt = null;
      context.subscription.cancelAtPeriodEnd = false;
      await context.subscription.save();

      await invalidatePortalDashboardCache();
      return this.getWorkspaceBillingState(params.workspaceId);
    });
  }

  async createBillingOverride(
    workspaceId: string,
    input: ManualBillingOverrideInput
  ) {
    const initialContext = await this.getWorkspaceBillingState(workspaceId);
    const billingAccountId = String(initialContext.billingAccount._id);

    return withRedisLock(`lock:billing-account:${billingAccountId}`, 30, async () => {
      const context = await this.getWorkspaceBillingState(workspaceId);
      const type = input.type;
      if (!BILLING_OVERRIDE_TYPES.includes(type)) {
        throw new ValidationError("Invalid billing override type");
      }

      let payload: Record<string, unknown> = {};
      if (type === "entitlement_override") {
        payload = diffEntitlements(
          context.resolvedEntitlements,
          normalizeEntitlements(
            input.payload as Partial<ResolvedBillingEntitlements>,
            context.resolvedEntitlements
          )
        ) as Record<string, unknown>;
        if (Object.keys(payload).length === 0) {
          throw new ValidationError("Entitlement override does not change any values");
        }
      } else if (type === "manual_status") {
        payload = {
          status: normalizeBillingStatus(
            (input.payload as { status?: unknown }).status,
            context.resolvedStatus
          ),
        };
      } else if (type === "trial_extension") {
        const nextTrialEndsAt =
          (input.payload as { trialEndsAt?: unknown }).trialEndsAt instanceof Date
            ? ((input.payload as { trialEndsAt?: Date }).trialEndsAt ?? null)
            : trimString((input.payload as { trialEndsAt?: unknown }).trialEndsAt)
              ? new Date(String((input.payload as { trialEndsAt?: unknown }).trialEndsAt))
              : null;
        if (!nextTrialEndsAt || Number.isNaN(nextTrialEndsAt.getTime())) {
          throw new ValidationError("trial_extension requires a valid trialEndsAt");
        }
        payload = { trialEndsAt: nextTrialEndsAt };
      } else {
        payload =
          input.payload && typeof input.payload === "object"
            ? (input.payload as Record<string, unknown>)
            : {};
      }

      await BillingOverrideModel.create({
        billingAccountId: context.billingAccount._id,
        type,
        payload,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        effectiveTo: input.effectiveTo ?? null,
        reason: trimString(input.reason),
        createdBy: input.createdBy ?? null,
      });

      await invalidatePortalDashboardCache();
      return this.getWorkspaceBillingState(workspaceId);
    });
  }

  private async assertWorkspaceCapacityForBillingAccount(
    billingAccount: BillingAccountDocument
  ) {
    const ensuredSubscription = await this.ensureBillingSubscriptionForAccount({
      billingAccount,
      seedPlanCode: normalizePlanCode(billingAccount.planCode, "free"),
      seedStatus: normalizeBillingStatus(billingAccount.status, "active"),
      provisioning: false,
    });

    const subscription = await BillingSubscriptionModel.findOne({
      billingAccountId: billingAccount._id,
    });
    if (!subscription) {
      throw new ValidationError("Billing subscription not found");
    }
    const planCatalog = await PlanCatalogModel.findById(subscription.planCatalogId);
    const planVersion = await PlanVersionModel.findById(subscription.planVersionId);
    if (!planCatalog || !planVersion) {
      throw new ValidationError("Billing plan definition not found");
    }

    await this.applyAutomaticLifecycleTransitions({
      billingAccount,
      subscription: ensuredSubscription,
    });

    const refreshedPlanCatalog =
      (await PlanCatalogModel.findById(ensuredSubscription.planCatalogId)) ?? planCatalog;
    const refreshedPlanVersion =
      (await PlanVersionModel.findById(ensuredSubscription.planVersionId)) ?? planVersion;

    const overrides = await this.loadOverrides(String(billingAccount._id));
    const resolved = this.resolveOverrides({
      subscription: ensuredSubscription,
      planVersion: refreshedPlanVersion,
      planCode: refreshedPlanCatalog.code,
      overrides,
    });
    await this.enforceSeatAssignmentsForBillingAccount({
      billingAccountId: String(billingAccount._id),
      maxSeats: resolved.resolvedEntitlements.maxSeats,
    });
    const usageCounts = await this.buildUsageCounts(
      String(billingAccount._id),
      ensuredSubscription
    );
    const scheduled = await this.resolveScheduledPlan(ensuredSubscription);
    const serializedBilling = this.serializeBillingSnapshot({
      billingAccount,
      subscription: ensuredSubscription,
      planCatalog: refreshedPlanCatalog,
      planVersion: refreshedPlanVersion,
      resolvedEntitlements: resolved.resolvedEntitlements,
      resolvedStatus: resolved.resolvedStatus,
      resolvedTrialEndsAt: resolved.resolvedTrialEndsAt,
      resolvedScheduledPlanCatalog: scheduled.scheduledPlanCatalog,
      resolvedScheduledPlanVersion: scheduled.scheduledPlanVersion,
      resolvedScheduledChangeKind:
        (ensuredSubscription.scheduledChangeKind as ScheduledChangeKind | null) ?? null,
      resolvedScheduledChangeEffectiveAt:
        ensuredSubscription.scheduledChangeEffectiveAt ?? null,
      resolvedRenewsAt:
        ensuredSubscription.renewsAt ?? getEffectiveRenewalDate(ensuredSubscription),
      resolvedGracePeriodEndsAt: ensuredSubscription.gracePeriodEndsAt ?? null,
      usageCounts,
      activeOverrideCount: resolved.activeOverrides.length,
    });

    if (usageCounts.workspacesUsed >= resolved.resolvedEntitlements.maxWorkspaces) {
      throw new ForbiddenError(
        `This billing account allows ${resolved.resolvedEntitlements.maxWorkspaces} workspace${
          resolved.resolvedEntitlements.maxWorkspaces === 1 ? "" : "s"
        }.`,
        this.buildBillingLimitDetails({
          gate: "workspaces",
          billing: serializedBilling,
          limitValue: resolved.resolvedEntitlements.maxWorkspaces,
          usedValue: usageCounts.workspacesUsed,
        })
      );
    }

    return {
      billingAccount,
      subscription: ensuredSubscription,
      entitlements: resolved.resolvedEntitlements,
      usageCounts,
    };
  }

  async assertCanAttachWorkspaceToBillingAccount(
    ownerUserId: string,
    billingAccountId: string
  ) {
    const billingAccount = await this.getOwnedBillingAccount(ownerUserId, billingAccountId);
    return this.assertWorkspaceCapacityForBillingAccount(billingAccount);
  }

  async assertCanCreateWorkspace(ownerUserId: string) {
    const ensured = await this.ensureBillingAccountForOwner({
      ownerUserId,
      seedPlanCode: "free",
      seedStatus: "active",
    });

    return this.assertWorkspaceCapacityForBillingAccount(ensured.billingAccount);
  }

  async assertCanAddSeat(workspaceId: string, candidateUserId?: string) {
    const context = await this.getWorkspaceBillingState(workspaceId);
    const billingAccountWorkspaceIds = await WorkspaceModel.find({
      billingAccountId: context.billingAccount._id,
    }).select("_id");

    if (candidateUserId) {
      const existingSeat = await WorkspaceMembershipModel.exists({
        workspaceId: { $in: billingAccountWorkspaceIds.map((item) => item._id) },
        userId: candidateUserId,
        status: { $in: ["active", "invited"] },
      });
      if (existingSeat) {
        return context;
      }
    }

    if (context.usageCounts.seatsUsed >= context.resolvedEntitlements.maxSeats) {
      throw new ForbiddenError(
        `This billing account allows ${context.resolvedEntitlements.maxSeats} seat${
          context.resolvedEntitlements.maxSeats === 1 ? "" : "s"
        }.`,
        this.buildBillingLimitDetails({
          gate: "seats",
          billing: context.serialized,
          limitValue: context.resolvedEntitlements.maxSeats,
          usedValue: context.usageCounts.seatsUsed,
        })
      );
    }

    return context;
  }

  async assertCanUseWebsiteChat(workspaceId: string) {
    const context = await this.getWorkspaceBillingState(workspaceId);
    if (!context.resolvedEntitlements.allowWebsiteChat) {
      throw new ForbiddenError(
        "Website chat is not enabled for this billing plan.",
        this.buildBillingLimitDetails({
          gate: "website_chat",
          billing: context.serialized,
          channel: "website",
        })
      );
    }

    return context;
  }

  async assertCanUseBYOAI(workspaceId: string) {
    const context = await this.getWorkspaceBillingState(workspaceId);
    if (!context.resolvedEntitlements.allowBYOAI) {
      throw new ForbiddenError(
        "BYO AI is not enabled for this billing plan.",
        this.buildBillingLimitDetails({
          gate: "byo_ai",
          billing: context.serialized,
        })
      );
    }

    return context;
  }

  async assertCanUseAutomation(workspaceId: string) {
    const context = await this.getWorkspaceBillingState(workspaceId);
    if (!context.resolvedEntitlements.allowAutomation) {
      throw new ForbiddenError(
        "Automation is not enabled for this billing plan.",
        this.buildBillingLimitDetails({
          gate: "automation",
          billing: context.serialized,
        })
      );
    }

    return context;
  }

  async assertCanConnectChannel(params: {
    workspaceId: string;
    channel: CanonicalChannel;
    ignoreConnectionId?: string | null;
  }) {
    const ignoredConnectionId = trimString(params.ignoreConnectionId);
    const context = await this.getWorkspaceBillingState(params.workspaceId, {
      ignoreConnectionIds: ignoredConnectionId ? [ignoredConnectionId] : [],
    });
    const family = channelToPlatformFamily(params.channel);

    if (family === "website" && !context.resolvedEntitlements.allowWebsiteChat) {
      throw new ForbiddenError(
        "Website chat is not enabled for this billing plan.",
        this.buildBillingLimitDetails({
          gate: "website_chat",
          billing: context.serialized,
          platformFamily: family,
          channel: params.channel,
        })
      );
    }

    if (!context.resolvedEntitlements.allowedPlatformFamilies.includes(family)) {
      throw new ForbiddenError(
        `${family} connections are not enabled for this billing account.`,
        this.buildBillingLimitDetails({
          gate: "platform_family",
          billing: context.serialized,
          platformFamily: family,
          channel: params.channel,
        })
      );
    }

    let familyAlreadyInUse = context.usageCounts.externalPlatformFamiliesUsed.includes(
      family as Exclude<PlatformFamily, "website">
    );

    if (ignoredConnectionId) {
      const ignoredConnection = await ChannelConnectionModel.findById(ignoredConnectionId);
      if (
        ignoredConnection &&
        channelToPlatformFamily(ignoredConnection.channel) === family
      ) {
        familyAlreadyInUse = true;
      }
    }

    if (
      family !== "website" &&
      !familyAlreadyInUse &&
      context.usageCounts.externalPlatformFamiliesUsed.length >=
        context.resolvedEntitlements.maxExternalPlatformFamilies
    ) {
      throw new ForbiddenError(
        `This billing account can use up to ${context.resolvedEntitlements.maxExternalPlatformFamilies} external platform famil${
          context.resolvedEntitlements.maxExternalPlatformFamilies === 1 ? "y" : "ies"
        } on the current plan.`,
        this.buildBillingLimitDetails({
          gate: "external_platform_families",
          billing: context.serialized,
          limitValue: context.resolvedEntitlements.maxExternalPlatformFamilies,
          usedValue: context.usageCounts.externalPlatformFamiliesUsed.length,
          platformFamily: family,
          channel: params.channel,
        })
      );
    }

    const currentCount = context.usageCounts.connectedAccountsUsedByPlatform[family] ?? 0;
    const familyLimit =
      context.resolvedEntitlements.maxConnectedAccountsPerPlatform[family] ?? 0;

    if (currentCount >= familyLimit) {
      throw new ForbiddenError(
        `This billing account can connect up to ${familyLimit} account${
          familyLimit === 1 ? "" : "s"
        } for ${family}.`,
        this.buildBillingLimitDetails({
          gate: "channel_connections",
          billing: context.serialized,
          limitValue: familyLimit,
          usedValue: currentCount,
          platformFamily: family,
          channel: params.channel,
        })
      );
    }

    return context;
  }
}

export const billingService = new BillingService();
export {
  BILLING_ACCOUNT_STATUSES,
  BILLING_CYCLES,
  BILLING_INTERVALS,
  BILLING_OVERRIDE_TYPES,
  BILLING_PLAN_GROUPS,
  BILLING_PRICING_MODES,
  EXTERNAL_PLATFORM_FAMILIES,
  PLATFORM_FAMILIES,
  SUBSCRIPTION_PROVIDERS,
  channelToPlatformFamily,
  type BillingAccountStatus,
  type BillingCycle,
  type BillingInterval,
  type BillingPlanGroup,
  type BillingPricingMode,
  type BillingOverrideType,
  type PlatformFamily,
  type SubscriptionProvider,
};
