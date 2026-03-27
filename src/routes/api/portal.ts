import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { asyncHandler } from "../../lib/async-handler";
import { ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import {
  MANAGEABLE_PLATFORM_ROLES,
  PUBLIC_PLATFORM_ROLES,
  STORED_PORTAL_ACCESS_ROLES,
  isPlatformAdmin,
  serializePlatformRole,
} from "../../lib/platform-role";
import { serializeWorkspaceRole } from "../../lib/workspace-role";
import { requirePlatformRole } from "../../middleware/require-platform-role";
import {
  AuditLogModel,
  ChannelConnectionModel,
  UserDocument,
  UserModel,
  WorkspaceDocument,
  WorkspaceMembershipModel,
  WorkspaceModel,
} from "../../models";
import {
  BILLING_ACCOUNT_STATUSES,
  BILLING_INTERVALS,
  BILLING_PLAN_GROUPS,
  BILLING_PRICING_MODES,
  billingService,
  PLATFORM_FAMILIES,
  SUBSCRIPTION_PROVIDERS,
  type ResolvedBillingEntitlements,
} from "../../services/billing.service";
import { platformSettingsService } from "../../services/platform-settings.service";
import {
  getPortalDashboardCache,
  invalidatePortalDashboardCache,
  setPortalDashboardCache,
} from "../../lib/portal-dashboard-cache";

const router = Router();

const workspaceIdParamSchema = z.object({
  workspaceId: z.string().min(1),
});

const planCatalogIdParamSchema = z.object({
  planCatalogId: z.string().min(1),
});

const planCodeSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

const optionalDateField = z
  .union([z.coerce.date(), z.null(), z.literal("")])
  .optional()
  .transform((value) => {
    if (value === "" || value === undefined) {
      return undefined;
    }

    return value;
  });

const entitlementsSchema = z.object({
  maxWorkspaces: z.coerce.number().int().min(0),
  maxSeats: z.coerce.number().int().min(0),
  allowedPlatformFamilies: z.array(z.enum(PLATFORM_FAMILIES)).min(1),
  maxExternalPlatformFamilies: z.coerce.number().int().min(0),
  maxConnectedAccountsPerPlatform: z.object({
    website: z.coerce.number().int().min(0),
    meta: z.coerce.number().int().min(0),
    telegram: z.coerce.number().int().min(0),
    viber: z.coerce.number().int().min(0),
    tiktok: z.coerce.number().int().min(0),
    line: z.coerce.number().int().min(0),
  }),
  allowWebsiteChat: z.boolean(),
  allowBYOAI: z.boolean(),
  allowAutomation: z.boolean(),
  allowAuditExports: z.boolean(),
  allowCustomDomain: z.boolean(),
  allowExtraSeats: z.boolean(),
  allowExtraWorkspaces: z.boolean(),
  allowExtraConnections: z.boolean(),
});

const planCatalogCreateSchema = z.object({
  code: planCodeSchema,
  displayName: z.string().trim().min(1).max(80),
  sortOrder: z.coerce.number().int().min(0).default(100),
  showPublicly: z.boolean().default(true),
  selfServe: z.boolean().default(true),
  pricingMode: z.enum(BILLING_PRICING_MODES),
  planGroup: z.enum(BILLING_PLAN_GROUPS),
  active: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

const planCatalogUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  showPublicly: z.boolean().optional(),
  selfServe: z.boolean().optional(),
  pricingMode: z.enum(BILLING_PRICING_MODES).optional(),
  planGroup: z.enum(BILLING_PLAN_GROUPS).optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

const planVersionCreateSchema = z.object({
  active: z.boolean().optional(),
  billingInterval: z.enum(BILLING_INTERVALS),
  priceAmount: z.coerce.number().min(0),
  currency: z.string().trim().min(3).max(8),
  entitlements: entitlementsSchema,
  note: z.string().trim().max(500).optional(),
});

const subscriptionUpdateSchema = z.object({
  billingAccountName: z.string().trim().min(1).max(120).optional(),
  provider: z.enum(SUBSCRIPTION_PROVIDERS).optional(),
  status: z.enum(BILLING_ACCOUNT_STATUSES),
  planVersionId: z.string().trim().min(1),
  currentPeriodStart: optionalDateField,
  currentPeriodEnd: optionalDateField,
  cancelAtPeriodEnd: z.boolean().optional(),
  trialEndsAt: optionalDateField,
  note: z.string().trim().max(500).optional(),
});

const entitlementOverridePayloadSchema = z
  .object({
    maxWorkspaces: z.coerce.number().int().min(0).optional(),
    maxSeats: z.coerce.number().int().min(0).optional(),
    allowedPlatformFamilies: z.array(z.enum(PLATFORM_FAMILIES)).optional(),
    maxExternalPlatformFamilies: z.coerce.number().int().min(0).optional(),
    maxConnectedAccountsPerPlatform: z
      .object({
        website: z.coerce.number().int().min(0).optional(),
        meta: z.coerce.number().int().min(0).optional(),
        telegram: z.coerce.number().int().min(0).optional(),
        viber: z.coerce.number().int().min(0).optional(),
        tiktok: z.coerce.number().int().min(0).optional(),
        line: z.coerce.number().int().min(0).optional(),
      })
      .optional(),
    allowWebsiteChat: z.boolean().optional(),
    allowBYOAI: z.boolean().optional(),
    allowAutomation: z.boolean().optional(),
    allowAuditExports: z.boolean().optional(),
    allowCustomDomain: z.boolean().optional(),
    allowExtraSeats: z.boolean().optional(),
    allowExtraWorkspaces: z.boolean().optional(),
    allowExtraConnections: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one entitlement override is required",
  });

const billingOverrideCreateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("entitlement_override"),
    payload: entitlementOverridePayloadSchema,
    effectiveFrom: optionalDateField,
    effectiveTo: optionalDateField,
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("manual_status"),
    payload: z.object({
      status: z.enum(BILLING_ACCOUNT_STATUSES),
    }),
    effectiveFrom: optionalDateField,
    effectiveTo: optionalDateField,
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("trial_extension"),
    payload: z.object({
      trialEndsAt: z.coerce.date(),
    }),
    effectiveFrom: optionalDateField,
    effectiveTo: optionalDateField,
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("manual_discount"),
    payload: z.object({
      label: z.string().trim().max(120).optional(),
      amountOff: z.coerce.number().min(0).optional(),
      percentOff: z.coerce.number().min(0).max(100).optional(),
      note: z.string().trim().max(250).optional(),
    }),
    effectiveFrom: optionalDateField,
    effectiveTo: optionalDateField,
    reason: z.string().trim().min(1).max(500),
  }),
]);

const portalStaffRoleUpdateSchema = z.object({
  email: z.string().trim().email(),
  platformRole: z.enum(MANAGEABLE_PLATFORM_ROLES).nullable(),
  note: z.string().trim().max(500).optional(),
});

const paymentSettingsUpdateSchema = z.object({
  stripe: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  manualEmail: z
    .object({
      enabled: z.boolean().optional(),
      contactEmail: z.union([z.string().trim().email(), z.literal("")]).optional(),
    })
    .optional(),
  kbzpay: z
    .object({
      enabled: z.boolean().optional(),
      contactEmail: z.union([z.string().trim().email(), z.literal("")]).optional(),
    })
    .optional(),
  note: z.string().trim().max(500).optional(),
});

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const requirePlatformAdminAction = (role?: string | null) => {
  if (!isPlatformAdmin(role)) {
    throw new ForbiddenError("Only platform admins can manage internal staff roles.");
  }
};

const configuredPlatformFounderEmailSet = new Set(
  env.PLATFORM_FOUNDER_EMAILS.split(",")
    .map((value) => trimString(value).toLowerCase())
    .filter(Boolean)
);

const configuredPlatformAdminEmailSet = new Set(
  env.PLATFORM_ADMIN_EMAILS.split(",")
    .map((value) => trimString(value).toLowerCase())
    .filter(Boolean)
);

const configuredPlatformStaffEmailSet = new Set(
  env.PLATFORM_STAFF_EMAILS.split(",")
    .map((value) => trimString(value).toLowerCase())
    .filter(Boolean)
);

const isConfiguredPlatformFounderEmail = (email: string) =>
  configuredPlatformFounderEmailSet.has(email);

const isConfiguredPlatformAdminEmail = (email: string) =>
  configuredPlatformAdminEmailSet.has(email);

const buildClientPagePath = (slug: string) => `/w/${encodeURIComponent(slug)}`;
const buildClientChatPagePath = (slug: string) =>
  `${buildClientPagePath(slug)}/chat`;

const buildClientPageUrl = (slug: string) =>
  `${env.CLIENT_URL.trim().replace(/\/+$/, "")}${buildClientPagePath(slug)}`;

const buildClientChatPageUrl = (slug: string) =>
  `${env.CLIENT_URL.trim().replace(/\/+$/, "")}${buildClientChatPagePath(slug)}`;

const serializeOwner = (owner: UserDocument | null) =>
  owner
    ? {
        _id: String(owner._id),
        name: owner.name,
        email: owner.email,
      }
    : null;

const serializePortalStaffUser = (user: UserDocument) => ({
  _id: String(user._id),
  name: user.name,
  email: user.email,
  avatarUrl: user.avatarUrl,
  platformRole: serializePlatformRole(user.platformRole),
  authProvider:
    user.authProvider === "google" || user.authProvider === "hybrid"
      ? user.authProvider
      : "password",
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const buildMemberCountMap = async (workspaceIds: string[]) => {
  if (!workspaceIds.length) {
    return new Map<string, { total: number; active: number; invited: number; disabled: number }>();
  }

  const memberships = await WorkspaceMembershipModel.find({
    workspaceId: { $in: workspaceIds },
  });

  const counts = new Map<
    string,
    { total: number; active: number; invited: number; disabled: number }
  >();

  for (const membership of memberships) {
    const workspaceId = String(membership.workspaceId);
    const current =
      counts.get(workspaceId) ?? { total: 0, active: 0, invited: 0, disabled: 0 };

    current.total += 1;
    if (membership.status === "active") current.active += 1;
    if (membership.status === "invited") current.invited += 1;
    if (membership.status === "disabled") current.disabled += 1;
    counts.set(workspaceId, current);
  }

  return counts;
};

const buildConnectionMap = async (workspaceIds: string[]) => {
  if (!workspaceIds.length) {
    return new Map<
      string,
      Array<{
        _id: string;
        channel: string;
        status: string;
        displayName: string;
        verificationState: string;
        lastInboundAt: Date | null;
        lastOutboundAt: Date | null;
      }>
    >();
  }

  const connections = await ChannelConnectionModel.find({
    workspaceId: { $in: workspaceIds },
  }).sort({ updatedAt: -1 });

  const map = new Map<
    string,
    Array<{
      _id: string;
      channel: string;
      status: string;
      displayName: string;
      verificationState: string;
      lastInboundAt: Date | null;
      lastOutboundAt: Date | null;
    }>
  >();

  for (const connection of connections) {
    const workspaceId = String(connection.workspaceId);
    const items = map.get(workspaceId) ?? [];
    items.push({
      _id: String(connection._id),
      channel: connection.channel,
      status: connection.status,
      displayName: connection.displayName,
      verificationState: connection.verificationState,
      lastInboundAt: connection.lastInboundAt ?? null,
      lastOutboundAt: connection.lastOutboundAt ?? null,
    });
    map.set(workspaceId, items);
  }

  return map;
};

const normalizeEntitlementsForPortal = (value: ResolvedBillingEntitlements) => {
  const maxExternalFamilyLimit = value.allowedPlatformFamilies.filter(
    (family) => family !== "website"
  ).length;

  if (value.maxExternalPlatformFamilies > maxExternalFamilyLimit) {
    throw new ValidationError(
      "maxExternalPlatformFamilies cannot exceed the number of allowed external platform families"
    );
  }

  return value;
};

const serializeWorkspaceSummary = async (params: {
  workspace: WorkspaceDocument;
  owner: UserDocument | null;
  memberCounts: { total: number; active: number; invited: number; disabled: number };
  connections: Array<{
    _id: string;
    channel: string;
    status: string;
    displayName: string;
    verificationState: string;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
  }>;
}) => {
  const { workspace, owner, memberCounts, connections } = params;
  const activeConnections = connections.filter((item) => item.status === "active");
  const billing = (await billingService.getWorkspaceBillingState(workspace)).serialized;
  const publicChatEnabled =
    workspace.publicChatEnabled !== false && billing.entitlements.allowWebsiteChat;
  const websiteConnection = activeConnections.find((item) => item.channel === "website");

  return {
    _id: String(workspace._id),
    name: workspace.name,
    slug: workspace.slug,
    timeZone: workspace.timeZone,
    owner: serializeOwner(owner),
    memberCounts,
    billing,
    connectionCounts: {
      total: connections.length,
      active: activeConnections.length,
    },
    channels: activeConnections.map((item) => item.channel),
    publicChatEnabled,
    websiteChatAvailable: publicChatEnabled && !!websiteConnection,
    publicPagePath: buildClientPagePath(workspace.slug),
    publicChatPagePath: buildClientChatPagePath(workspace.slug),
    publicPageUrl: buildClientPageUrl(workspace.slug),
    publicChatPageUrl: buildClientChatPageUrl(workspace.slug),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
};

router.use(requirePlatformRole([...PUBLIC_PLATFORM_ROLES]));

router.get(
  "/staff-users",
  asyncHandler(async (req, res) => {
    const users = await UserModel.find({
      platformRole: { $in: STORED_PORTAL_ACCESS_ROLES },
    }).sort({ platformRole: 1, createdAt: 1 });

    res.json({
      currentUserRole: serializePlatformRole(req.auth?.user?.platformRole),
      canManageRoles: isPlatformAdmin(req.auth?.user?.platformRole),
      items: users.map(serializePortalStaffUser),
    });
  })
);

router.post(
  "/staff-users/assign",
  asyncHandler(async (req, res) => {
    requirePlatformAdminAction(req.auth?.user?.platformRole);

    const payload = portalStaffRoleUpdateSchema.parse(req.body);
    const email = payload.email.toLowerCase();
    const targetUser = await UserModel.findOne({ email });
    if (!targetUser) {
      throw new ValidationError(
        "This person needs to sign in first before a portal role can be assigned."
      );
    }

    if (String(targetUser._id) === req.auth?.userId && payload.platformRole === null) {
      throw new ValidationError("You cannot remove your own portal access from here.");
    }

    if (isConfiguredPlatformFounderEmail(email) || isConfiguredPlatformAdminEmail(email)) {
      throw new ValidationError(
        "Configured founder and platform admin accounts cannot be changed from the portal."
      );
    }

    targetUser.platformRole = payload.platformRole;
    await targetUser.save();

    await AuditLogModel.create({
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.staff_role_updated",
      reason: payload.note?.trim() || null,
      sourceHints: ["portal", "staff", "roles"],
      data: {
        actorEmail: req.auth?.email ?? null,
        targetUserId: String(targetUser._id),
        targetEmail: targetUser.email,
        assignedRole: payload.platformRole,
      },
    });

    const users = await UserModel.find({
      platformRole: { $in: STORED_PORTAL_ACCESS_ROLES },
    }).sort({ platformRole: 1, createdAt: 1 });

    res.json({
      currentUserRole: serializePlatformRole(req.auth?.user?.platformRole),
      canManageRoles: true,
      items: users.map(serializePortalStaffUser),
    });
  })
);

router.get(
  "/payment-settings",
  asyncHandler(async (req, res) => {
    res.json({
      canEdit: isPlatformAdmin(req.auth?.user?.platformRole),
      paymentProviders: await platformSettingsService.getPaymentProviderSummary(),
    });
  })
);

router.patch(
  "/payment-settings",
  asyncHandler(async (req, res) => {
    requirePlatformAdminAction(req.auth?.user?.platformRole);
    const payload = paymentSettingsUpdateSchema.parse(req.body);
    const paymentProviders = await platformSettingsService.updatePaymentSettings({
      stripe: payload.stripe,
      manualEmail: payload.manualEmail,
      kbzpay: payload.kbzpay,
    });

    await AuditLogModel.create({
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.payment_settings_updated",
      reason: payload.note?.trim() || null,
      sourceHints: ["portal", "billing", "payment-settings"],
      data: {
        actorEmail: req.auth?.email ?? null,
        paymentProviders,
      },
    });

    res.json({
      canEdit: true,
      paymentProviders,
    });
  })
);

router.get(
  "/workspaces",
  asyncHandler(async (_req, res) => {
    const cached = await getPortalDashboardCache<{
      summary: Record<string, unknown>;
      items: unknown[];
    }>();
    if (cached) {
      res.json(cached);
      return;
    }

    const workspaces = await WorkspaceModel.find().sort({ createdAt: -1 });
    const workspaceIds = workspaces.map((workspace) => String(workspace._id));
    const ownerIds = workspaces
      .map((workspace) => workspace.createdByUserId)
      .filter((value): value is NonNullable<typeof value> => !!value);

    const [memberCountMap, connectionMap, owners] = await Promise.all([
      buildMemberCountMap(workspaceIds),
      buildConnectionMap(workspaceIds),
      ownerIds.length ? UserModel.find({ _id: { $in: ownerIds } }) : Promise.resolve([]),
    ]);

    const ownerMap = new Map(owners.map((owner) => [String(owner._id), owner]));
    const items = await Promise.all(
      workspaces.map((workspace) =>
        serializeWorkspaceSummary({
          workspace,
          owner: workspace.createdByUserId
            ? ownerMap.get(String(workspace.createdByUserId)) ?? null
            : null,
          memberCounts:
            memberCountMap.get(String(workspace._id)) ?? {
              total: 0,
              active: 0,
              invited: 0,
              disabled: 0,
            },
          connections: connectionMap.get(String(workspace._id)) ?? [],
        })
      )
    );

    const uniqueBillingStates = new Map(
      items.map((item) => [item.billing.account._id, item.billing])
    );
    const plansByCode: Record<string, number> = {};
    const statuses: Record<string, number> = {
      trialing: 0,
      active: 0,
      past_due: 0,
      grace_period: 0,
      restricted: 0,
      free_fallback: 0,
      canceled: 0,
      paused: 0,
    };

    for (const billing of uniqueBillingStates.values()) {
      plansByCode[billing.subscription.planCode] =
        (plansByCode[billing.subscription.planCode] ?? 0) + 1;
      statuses[billing.subscription.status] += 1;
    }

    const response = {
      summary: {
        totalWorkspaces: items.length,
        totalBillingAccounts: uniqueBillingStates.size,
        totalSeatsUsed: Array.from(uniqueBillingStates.values()).reduce(
          (sum, item) => sum + item.usageSummary.seatsUsed,
          0
        ),
        plansByCode,
        statuses,
      },
      items,
    };

    await setPortalDashboardCache(response);
    res.json(response);
  })
);

router.get(
  "/workspaces/:workspaceId",
  asyncHandler(async (req, res) => {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const [owner, memberships, connections, auditItems, planCatalogs, overrides] =
      await Promise.all([
        workspace.createdByUserId
          ? UserModel.findById(workspace.createdByUserId)
          : Promise.resolve(null),
        WorkspaceMembershipModel.find({ workspaceId: workspace._id }).sort({ createdAt: 1 }),
        ChannelConnectionModel.find({ workspaceId: workspace._id }).sort({ updatedAt: -1 }),
        AuditLogModel.find({
          workspaceId: workspace._id,
          eventType: { $regex: "^portal\\." },
        })
          .sort({ createdAt: -1 })
          .limit(20),
        billingService.listPlanCatalogs(),
        billingService.listBillingAccountOverrides(workspace),
      ]);

    const userIds = memberships.map((membership) => membership.userId);
    const users = userIds.length ? await UserModel.find({ _id: { $in: userIds } }) : [];
    const userMap = new Map(users.map((user) => [String(user._id), user]));

    const memberCounts = memberships.reduce(
      (accumulator, membership) => {
        accumulator.total += 1;
        if (membership.status === "active") accumulator.active += 1;
        if (membership.status === "invited") accumulator.invited += 1;
        if (membership.status === "disabled") accumulator.disabled += 1;
        return accumulator;
      },
      { total: 0, active: 0, invited: 0, disabled: 0 }
    );

    const overview = await serializeWorkspaceSummary({
      workspace,
      owner,
      memberCounts,
      connections: connections.map((connection) => ({
        _id: String(connection._id),
        channel: connection.channel,
        status: connection.status,
        displayName: connection.displayName,
        verificationState: connection.verificationState,
        lastInboundAt: connection.lastInboundAt ?? null,
        lastOutboundAt: connection.lastOutboundAt ?? null,
      })),
    });

    res.json({
      workspace: {
        ...overview,
        bio: trimString(workspace.bio),
        description: trimString(workspace.publicDescription),
        websiteUrl: trimString(workspace.publicWebsiteUrl),
        supportEmail: trimString(workspace.publicSupportEmail),
        supportPhone: trimString(workspace.publicSupportPhone),
        welcomeMessage: trimString(workspace.publicWelcomeMessage),
        members: memberships.map((membership) => {
          const user = userMap.get(String(membership.userId)) ?? null;
          const isWorkspaceOwner =
            workspace.createdByUserId &&
            String(workspace.createdByUserId) === String(membership.userId);
          return {
            _id: String(membership._id),
            workspaceRole: isWorkspaceOwner
              ? "owner"
              : serializeWorkspaceRole(membership.role),
            status: membership.status,
            inviteExpiresAt: membership.inviteExpiresAt ?? null,
            inviteAcceptedAt: membership.inviteAcceptedAt ?? null,
            user: user
              ? {
                  _id: String(user._id),
                  name: user.name,
                  email: user.email,
                }
              : null,
          };
        }),
        connections: connections.map((connection) => ({
          _id: String(connection._id),
          channel: connection.channel,
          status: connection.status,
          displayName: connection.displayName,
          verificationState: connection.verificationState,
          lastInboundAt: connection.lastInboundAt ?? null,
          lastOutboundAt: connection.lastOutboundAt ?? null,
          lastError: trimString(connection.lastError) || null,
        })),
        auditTrail: auditItems.map((item) => ({
          _id: String(item._id),
          actorType: item.actorType,
          actorId: item.actorId,
          eventType: item.eventType,
          reason: item.reason,
          data: item.data ?? {},
          createdAt: item.createdAt,
        })),
      },
      planCatalogs,
      overrides,
    });
  })
);

router.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    res.json({
      items: await billingService.listPlanCatalogs(),
    });
  })
);

router.post(
  "/plans",
  asyncHandler(async (req, res) => {
    const payload = planCatalogCreateSchema.parse(req.body);
    const plan = await billingService.createPlanCatalog({
      code: payload.code,
      displayName: payload.displayName,
      sortOrder: payload.sortOrder,
      showPublicly: payload.showPublicly,
      selfServe: payload.selfServe,
      pricingMode: payload.pricingMode,
      planGroup: payload.planGroup,
      active: payload.active,
    });

    await AuditLogModel.create({
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.plan_catalog_created",
      reason: payload.note?.trim() || null,
      sourceHints: ["portal", "billing", "plan-catalog"],
      data: {
        actorEmail: req.auth?.email ?? null,
        planCatalogId: plan._id,
        code: plan.code,
        displayName: plan.displayName,
      },
    });

    await invalidatePortalDashboardCache();
    res.status(201).json({ plan });
  })
);

router.get(
  "/plans/:planCatalogId",
  asyncHandler(async (req, res) => {
    const { planCatalogId } = planCatalogIdParamSchema.parse(req.params);
    res.json({
      plan: await billingService.getPlanCatalog(planCatalogId),
    });
  })
);

router.patch(
  "/plans/:planCatalogId",
  asyncHandler(async (req, res) => {
    const { planCatalogId } = planCatalogIdParamSchema.parse(req.params);
    const payload = planCatalogUpdateSchema.parse(req.body);
    const plan = await billingService.updatePlanCatalog(planCatalogId, {
      displayName: payload.displayName,
      sortOrder: payload.sortOrder,
      showPublicly: payload.showPublicly,
      selfServe: payload.selfServe,
      pricingMode: payload.pricingMode,
      planGroup: payload.planGroup,
      active: payload.active,
    });

    await AuditLogModel.create({
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.plan_catalog_updated",
      reason: payload.note?.trim() || null,
      sourceHints: ["portal", "billing", "plan-catalog"],
      data: {
        actorEmail: req.auth?.email ?? null,
        planCatalogId: plan._id,
        displayName: plan.displayName,
        active: plan.active,
      },
    });

    await invalidatePortalDashboardCache();
    res.json({ plan });
  })
);

router.post(
  "/plans/:planCatalogId/versions",
  asyncHandler(async (req, res) => {
    const { planCatalogId } = planCatalogIdParamSchema.parse(req.params);
    const payload = planVersionCreateSchema.parse(req.body);
    const entitlements = normalizeEntitlementsForPortal(
      payload.entitlements as ResolvedBillingEntitlements
    );
    const plan = await billingService.createPlanVersion(planCatalogId, {
      active: payload.active,
      billingInterval: payload.billingInterval,
      priceAmount: payload.priceAmount,
      currency: payload.currency,
      entitlements,
      createdBy: req.auth?.userId ?? null,
    });

    await AuditLogModel.create({
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.plan_version_created",
      reason: payload.note?.trim() || null,
      sourceHints: ["portal", "billing", "plan-version"],
      data: {
        actorEmail: req.auth?.email ?? null,
        planCatalogId: plan._id,
        version: plan.versions[0]?.version ?? null,
      },
    });

    await invalidatePortalDashboardCache();
    res.status(201).json({ plan });
  })
);

router.post(
  "/workspaces/:workspaceId/subscription",
  asyncHandler(async (req, res) => {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const payload = subscriptionUpdateSchema.parse(req.body);
    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const before = (await billingService.getWorkspaceBillingState(workspace)).serialized;
    const updated = await billingService.updateWorkspaceSubscription(workspaceId, {
      billingAccountName: payload.billingAccountName,
      provider: payload.provider,
      status: payload.status,
      planVersionId: payload.planVersionId,
      currentPeriodStart: payload.currentPeriodStart,
      currentPeriodEnd: payload.currentPeriodEnd,
      cancelAtPeriodEnd: payload.cancelAtPeriodEnd,
      trialEndsAt: payload.trialEndsAt,
    });

    await AuditLogModel.create({
      workspaceId: workspace._id,
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.subscription_migrated",
      reason: payload.note?.trim() || null,
      sourceHints: ["portal", "billing", "subscription"],
      data: {
        actorEmail: req.auth?.email ?? null,
        before: {
          account: before.account,
          subscription: before.subscription,
        },
        after: {
          account: updated.serialized.account,
          subscription: updated.serialized.subscription,
        },
      },
    });

    await invalidatePortalDashboardCache();
    res.json({
      billing: updated.serialized,
      overrides: await billingService.listBillingAccountOverrides(workspace),
    });
  })
);

router.post(
  "/workspaces/:workspaceId/overrides",
  asyncHandler(async (req, res) => {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const payload = billingOverrideCreateSchema.parse(req.body);
    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const updated = await billingService.createBillingOverride(workspaceId, {
      type: payload.type,
      payload: payload.payload,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: payload.effectiveTo,
      reason: payload.reason,
      createdBy: req.auth?.userId ?? null,
    });

    await AuditLogModel.create({
      workspaceId: workspace._id,
      actorType: "platform_user",
      actorId: req.auth?.userId ?? null,
      eventType: "portal.billing_override_created",
      reason: payload.reason,
      sourceHints: ["portal", "billing", "override"],
      data: {
        actorEmail: req.auth?.email ?? null,
        type: payload.type,
        payload: payload.payload,
        effectiveFrom: payload.effectiveFrom ?? null,
        effectiveTo: payload.effectiveTo ?? null,
      },
    });

    await invalidatePortalDashboardCache();
    res.status(201).json({
      billing: updated.serialized,
      overrides: await billingService.listBillingAccountOverrides(workspace),
    });
  })
);

export default router;
