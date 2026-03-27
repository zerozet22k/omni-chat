import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  AISettingsModel,
  BusinessHoursModel,
  UserDocument,
  UserModel,
  WorkspaceModel,
  WorkspaceMembershipModel,
} from "../../models";
import { asyncHandler } from "../../lib/async-handler";
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../lib/errors";
import { env } from "../../config/env";
import { authenticate } from "../../middleware/authenticate";
import { channelSupportService } from "../../services/channel-support.service";
import { googleAuthService } from "../../services/google-auth.service";
import { billingService } from "../../services/billing.service";
import { workspaceInviteService } from "../../services/workspace-invite.service";
import { hasPortalAccess, serializePlatformRole } from "../../lib/platform-role";
import { serializeWorkspaceRole } from "../../lib/workspace-role";
import { assertWithinRateLimit, normalizeRateLimitKeyPart } from "../../lib/request-rate-limit";
import { invalidatePortalDashboardCache } from "../../lib/portal-dashboard-cache";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  workspaceName: z.string().min(1),
  workspaceSlug: z.string().min(1),
  timeZone: z.string().min(1).default("Asia/Bangkok"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  audience: z.enum(["client", "staff"]).optional(),
});

const createWorkspaceSchema = z.object({
  workspaceName: z.string().min(1),
  workspaceSlug: z.string().min(1),
  timeZone: z.string().min(1).default("Asia/Bangkok"),
  billingSelection: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("existing"),
        billingAccountId: z.string().trim().min(1),
      }),
      z.object({
        type: z.literal("new"),
        billingAccountName: z.string().trim().max(120).optional(),
      }),
    ])
    .optional(),
});

const googleAuthStartSchema = z.object({
  uiOrigin: z.string().trim().optional(),
});

const googleAuthExchangeSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  audience: z.enum(["client", "staff"]).optional(),
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
});

const joinInviteSchema = z.object({
  token: z.string().min(1),
});

const inviteTokenParamSchema = z.object({
  token: z.string().min(1),
});

const buildDefaultBusinessHours = () => [
  {
    dayOfWeek: 1,
    enabled: true,
    windows: [{ start: "09:00", end: "18:00" }],
  },
  {
    dayOfWeek: 2,
    enabled: true,
    windows: [{ start: "09:00", end: "18:00" }],
  },
  {
    dayOfWeek: 3,
    enabled: true,
    windows: [{ start: "09:00", end: "18:00" }],
  },
  {
    dayOfWeek: 4,
    enabled: true,
    windows: [{ start: "09:00", end: "18:00" }],
  },
  {
    dayOfWeek: 5,
    enabled: true,
    windows: [{ start: "09:00", end: "18:00" }],
  },
];

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const normalizeWorkspaceSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

const buildDefaultWorkspaceName = (name: string) => {
  const firstSegment = trimString(name).split(/\s+/)[0] || "My";
  return `${firstSegment}'s Workspace`;
};

const configuredPlatformStaffEmailSet = new Set(
  env.PLATFORM_STAFF_EMAILS.split(",")
    .map((value) => trimString(value).toLowerCase())
    .filter(Boolean)
);

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

const isConfiguredPlatformFounderEmail = (email: string) =>
  configuredPlatformFounderEmailSet.has(trimString(email).toLowerCase());

const isConfiguredPlatformAdminEmail = (email: string) =>
  configuredPlatformAdminEmailSet.has(trimString(email).toLowerCase());

const isConfiguredPlatformStaffEmail = (email: string) =>
  configuredPlatformStaffEmailSet.has(trimString(email).toLowerCase());

const syncPlatformRoleFromEmail = async (user: UserDocument) => {
  if (isConfiguredPlatformFounderEmail(user.email)) {
    if (user.platformRole !== "founder") {
      user.platformRole = "founder";
      await user.save();
    }

    return user;
  }

  if (isConfiguredPlatformAdminEmail(user.email)) {
    if (user.platformRole !== "platform_admin") {
      user.platformRole = "platform_admin";
      await user.save();
    }

    return user;
  }

  if (!isConfiguredPlatformStaffEmail(user.email)) {
    return user;
  }

  if (
    user.platformRole !== "staff" &&
    user.platformRole !== "platform_admin" &&
    user.platformRole !== "founder"
  ) {
    user.platformRole = "staff";
    await user.save();
  }

  return user;
};

const resolveActorKind = (params: {
  hasPortalRole: boolean;
  workspaceCount: number;
}) => {
  if (params.hasPortalRole && params.workspaceCount > 0) {
    return "hybrid_user" as const;
  }

  if (params.hasPortalRole) {
    return "platform_user" as const;
  }

  return "workspace_user" as const;
};

const serializeUser = (user: UserDocument, workspaceCount: number) => ({
  _id: String(user._id),
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
  actorKind: resolveActorKind({
    hasPortalRole: hasPortalAccess(user.platformRole),
    workspaceCount,
  }),
  platformRole: serializePlatformRole(user.platformRole),
  authProvider:
    user.authProvider === "google" || user.authProvider === "hybrid"
      ? user.authProvider
      : "password",
});

const loadWorkspaceItemsByStatuses = async (
  userId: string,
  statuses: Array<"active" | "inactive_due_to_plan_limit">
) => {
  const memberships = await WorkspaceMembershipModel.find({
    userId,
    status: { $in: statuses },
  });
  const workspaceIds = memberships.map((membership) => membership.workspaceId);
  const workspaces = workspaceIds.length
    ? await WorkspaceModel.find({ _id: { $in: workspaceIds } })
    : [];
  const workspaceMap = new Map(
    workspaces.map((workspace) => [String(workspace._id), workspace])
  );

  return memberships
    .map((membership) => {
      const workspace = workspaceMap.get(String(membership.workspaceId));
      if (!workspace) {
        return null;
      }

      return {
        _id: String(workspace._id),
        name: workspace.name,
        slug: workspace.slug,
        timeZone: workspace.timeZone,
        workspaceRole: serializeWorkspaceRole(membership.role),
        status: membership.status,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
};

const loadActiveWorkspaceItems = async (userId: string) =>
  loadWorkspaceItemsByStatuses(userId, ["active"]);

const loadSeatLimitedWorkspaceItems = async (userId: string) =>
  loadWorkspaceItemsByStatuses(userId, ["inactive_due_to_plan_limit"]);

const buildSessionPayload = async (
  user: UserDocument,
  preferredWorkspaceId?: string
) => {
  const [workspaceItems, blockedWorkspaceItems] = await Promise.all([
    loadActiveWorkspaceItems(String(user._id)),
    loadSeatLimitedWorkspaceItems(String(user._id)),
  ]);
  if (
    !workspaceItems.length &&
    !blockedWorkspaceItems.length &&
    !hasPortalAccess(user.platformRole)
  ) {
    throw new ValidationError("No active workspace memberships found for this account");
  }

  const activeWorkspaceId = workspaceItems.some(
    (item) => item._id === preferredWorkspaceId
  )
    ? String(preferredWorkspaceId)
    : workspaceItems[0]?._id ?? "";

  const token = jwt.sign(
    {
      userId: String(user._id),
      email: user.email,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  return {
    token,
    user: serializeUser(user, workspaceItems.length || blockedWorkspaceItems.length),
    workspaces: workspaceItems,
    activeWorkspaceId,
    blockedAccess:
      !workspaceItems.length && blockedWorkspaceItems.length
        ? {
            reason: "inactive_due_to_plan_limit" as const,
            message:
              "This account is attached to a workspace that is currently over its seat limit. Ask a workspace admin to upgrade the plan or free a seat.",
            workspaces: blockedWorkspaceItems.map((workspace) => ({
              _id: workspace._id,
              name: workspace.name,
              slug: workspace.slug,
              status: workspace.status,
            })),
          }
        : null,
  };
};

const ensureWorkspaceDefaults = async (workspaceId: string, timeZone: string) => {
  const planAllowedChannels = await channelSupportService.getPlanAllowedChannels(workspaceId);

  await AISettingsModel.findOneAndUpdate(
    { workspaceId },
    {
      $setOnInsert: {
        workspaceId,
        enabled: false,
        autoReplyEnabled: false,
        afterHoursEnabled: false,
        confidenceThreshold: 0.7,
        supportedChannels: planAllowedChannels,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );

  await BusinessHoursModel.findOneAndUpdate(
    { workspaceId },
    {
      $setOnInsert: {
        workspaceId,
        timeZone,
        weeklySchedule: buildDefaultBusinessHours(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

const ensureUniqueWorkspaceSlug = async (value: string) => {
  const base = normalizeWorkspaceSlug(value) || "workspace";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const exists = await WorkspaceModel.exists({ slug: candidate });
    if (!exists) {
      return candidate;
    }
  }

  return `${base}-${Date.now().toString(36)}`;
};

const createWorkspaceForUser = async (params: {
  user: UserDocument;
  workspaceName: string;
  workspaceSlug?: string;
  timeZone: string;
  billingSelection?:
    | {
        type: "existing";
        billingAccountId: string;
      }
    | {
        type: "new";
        billingAccountName?: string;
      };
}) => {
  const workspaceName = trimString(params.workspaceName);
  const timeZone = trimString(params.timeZone) || "Asia/Bangkok";
  const requestedSlug = trimString(params.workspaceSlug);
  const workspaceSlug = requestedSlug
    ? normalizeWorkspaceSlug(requestedSlug)
    : await ensureUniqueWorkspaceSlug(workspaceName);

  if (!workspaceName) {
    throw new ValidationError("Workspace name is required");
  }

  if (!workspaceSlug) {
    throw new ValidationError("Workspace slug is invalid");
  }

  const existingWorkspace = await WorkspaceModel.findOne({ slug: workspaceSlug });
  if (existingWorkspace) {
    throw new ConflictError("Workspace slug already exists");
  }

  let targetBillingAccountId = "";

  if (!hasPortalAccess(params.user.platformRole)) {
    if (params.billingSelection?.type === "existing") {
      const selected = await billingService.assertCanAttachWorkspaceToBillingAccount(
        String(params.user._id),
        params.billingSelection.billingAccountId
      );
      targetBillingAccountId = String(selected.billingAccount._id);
    } else if (params.billingSelection?.type === "new") {
      const createdBillingAccount = await billingService.createBillingAccountForOwner({
        ownerUserId: String(params.user._id),
        fallbackName:
          trimString(params.billingSelection.billingAccountName) ||
          workspaceName ||
          trimString(params.user.name) ||
          "Billing account",
        seedPlanCode: "free",
        seedStatus: "active",
      });
      targetBillingAccountId = String(createdBillingAccount.billingAccount._id);
    } else {
      const selected = await billingService.assertCanCreateWorkspace(String(params.user._id));
      targetBillingAccountId = String(selected.billingAccount._id);
    }
  }

  const workspace = await WorkspaceModel.create({
    name: workspaceName,
    slug: workspaceSlug,
    timeZone,
    createdByUserId: params.user._id,
  });

  await WorkspaceMembershipModel.create({
    workspaceId: workspace._id,
    userId: params.user._id,
    role: "owner",
    status: "active",
    invitedByUserId: null,
    lastActiveAt: new Date(),
  });

  if (!params.user.workspaceIds.some((id) => String(id) === String(workspace._id))) {
    params.user.workspaceIds.push(workspace._id);
    await params.user.save();
  }

  if (targetBillingAccountId) {
    await billingService.assignWorkspaceToBillingAccount(
      workspace,
      targetBillingAccountId,
      String(params.user._id)
    );
  } else {
    await billingService.assignWorkspaceToOwnerBillingAccount(
      workspace,
      String(params.user._id)
    );
  }
  await ensureWorkspaceDefaults(String(workspace._id), timeZone);
  await invalidatePortalDashboardCache();

  return workspace;
};

router.get(
  "/deployment",
  asyncHandler(async (_req, res) => {
    res.json({
      deployment: {
        tenantMode: env.APP_TENANT_MODE,
        allowSignup: env.ALLOW_SELF_SIGNUP,
        allowWorkspaceCreation: env.ALLOW_WORKSPACE_CREATION,
        defaultWorkspaceSlug: env.DEFAULT_WORKSPACE_SLUG || null,
        googleAuthEnabled: googleAuthService.isConfigured(),
      },
    });
  })
);

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const payload = registerSchema.parse(req.body);
    const name = trimString(payload.name);
    const email = trimString(payload.email).toLowerCase();
    const workspaceSlug = trimString(payload.workspaceSlug).toLowerCase();
    const workspaceName = trimString(payload.workspaceName);
    const timeZone = trimString(payload.timeZone) || "Asia/Bangkok";

    const existingUser = await UserModel.findOne({ email });
    if (existingUser) {
      throw new ConflictError("An account with this email already exists");
    }

    // Tenant policy enforcement
    if (env.APP_TENANT_MODE === "single") {
      const workspaceCount = await WorkspaceModel.countDocuments();
      if (workspaceCount > 0) {
        throw new ForbiddenError(
          "Single-tenant mode: this deployment has already been bootstrapped. No further workspace registration is allowed."
        );
      }
    } else {
      // Multi-tenant: respect signup and workspace creation flags
      if (!env.ALLOW_SELF_SIGNUP) {
        throw new ForbiddenError("Self-registration is disabled on this deployment.");
      }
      if (!env.ALLOW_WORKSPACE_CREATION) {
        throw new ForbiddenError("Workspace creation is disabled on this deployment.");
      }
    }

    const passwordHash = await bcrypt.hash(payload.password, 10);

    const user = await UserModel.create({
      email,
      name,
      passwordHash,
      authProvider: "password",
      workspaceIds: [],
    });

    const workspace = await createWorkspaceForUser({
      user,
      workspaceName,
      workspaceSlug,
      timeZone,
    });

    res.json(await buildSessionPayload(user, String(workspace._id)));
  })
);

router.post(
  "/google/start",
  asyncHandler(async (req, res) => {
    const payload = googleAuthStartSchema.safeParse(req.body);
    res.json(
      googleAuthService.createAuthorizationUrl({
        uiOrigin: payload.success ? payload.data.uiOrigin : undefined,
      })
    );
  })
);

router.post(
  "/google/exchange",
  asyncHandler(async (req, res) => {
    await assertWithinRateLimit({
      key: `rate:login:ip:${normalizeRateLimitKeyPart(req.ip)}`,
      limit: 20,
      windowSec: 300,
      message: "Too many login attempts. Please wait a moment and try again.",
      details: {
        scope: "google_login",
      },
    });

    const payload = googleAuthExchangeSchema.parse(req.body);
    const audience = payload.audience ?? "client";
    const profile = await googleAuthService.exchangeCodeForProfile(payload);
    const isPortalFounderEmail = isConfiguredPlatformFounderEmail(profile.email);
    const isPortalAdminEmail = isConfiguredPlatformAdminEmail(profile.email);
    const isPortalStaffEmail =
      isPortalFounderEmail ||
      isPortalAdminEmail ||
      isConfiguredPlatformStaffEmail(profile.email);

    if (!profile.emailVerified) {
      throw new ForbiddenError(
        "Google account email is not verified. Verify the Google account and try again."
      );
    }

    let user =
      (await UserModel.findOne({ googleId: profile.sub })) ??
      (await UserModel.findOne({ email: profile.email }));

    let preferredWorkspaceId: string | undefined;

    if (!user) {
      if (isPortalStaffEmail) {
        user = await UserModel.create({
          email: profile.email,
          name: profile.name,
          passwordHash: "!google-auth",
          platformRole: isPortalFounderEmail
            ? "founder"
            : isPortalAdminEmail
              ? "platform_admin"
              : "staff",
          authProvider: "google",
          googleId: profile.sub,
          avatarUrl: profile.picture,
          workspaceIds: [],
        });

        res.json(await buildSessionPayload(user));
        return;
      }

      if (audience === "staff") {
        throw new UnauthorizedError(
          "Portal access is only available for approved staff accounts."
        );
      }

      if (env.APP_TENANT_MODE === "single") {
        const workspaceCount = await WorkspaceModel.countDocuments();
        if (workspaceCount > 0) {
          throw new ForbiddenError(
            "Single-tenant mode: this deployment has already been bootstrapped. No further workspace registration is allowed."
          );
        }
      } else {
        if (!env.ALLOW_SELF_SIGNUP) {
          throw new ForbiddenError("Self-registration is disabled on this deployment.");
        }
        if (!env.ALLOW_WORKSPACE_CREATION) {
          throw new ForbiddenError("Workspace creation is disabled on this deployment.");
        }
      }

      user = await UserModel.create({
        email: profile.email,
        name: profile.name,
        passwordHash: "!google-auth",
        authProvider: "google",
        googleId: profile.sub,
        avatarUrl: profile.picture,
        workspaceIds: [],
      });

      const workspace = await createWorkspaceForUser({
        user,
        workspaceName: buildDefaultWorkspaceName(profile.name),
        workspaceSlug: await ensureUniqueWorkspaceSlug(
          profile.email.split("@")[0] || profile.name
        ),
        timeZone: "Asia/Bangkok",
      });

      preferredWorkspaceId = String(workspace._id);
      res.json(await buildSessionPayload(user, preferredWorkspaceId));
      return;
    }

    await syncPlatformRoleFromEmail(user);

    if (audience === "staff" && !hasPortalAccess(user.platformRole)) {
      throw new ForbiddenError("This account does not have portal access.");
    }

    if (!trimString(user.googleId)) {
      user.googleId = profile.sub;
    }
    if (profile.picture && !trimString(user.avatarUrl)) {
      user.avatarUrl = profile.picture;
    }
    if (user.authProvider === "password") {
      user.authProvider = "hybrid";
    } else if (user.authProvider !== "hybrid") {
      user.authProvider = "google";
    }
    await user.save();

    res.json(await buildSessionPayload(user, preferredWorkspaceId));
  })
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    await assertWithinRateLimit({
      key: `rate:login:ip:${normalizeRateLimitKeyPart(req.ip)}`,
      limit: 10,
      windowSec: 300,
      message: "Too many login attempts. Please wait a few minutes and try again.",
      details: {
        scope: "password_login",
      },
    });

    const payload = loginSchema.parse(req.body);
    const email = trimString(payload.email).toLowerCase();

    const user = await UserModel.findOne({ email });
    if (!user) {
      throw new UnauthorizedError("Invalid email or password");
    }

    await syncPlatformRoleFromEmail(user);

    if (payload.audience === "staff" && !hasPortalAccess(user.platformRole)) {
      throw new ForbiddenError("This account does not have portal access.");
    }

    if (user.passwordHash === "!invited-account") {
      throw new UnauthorizedError(
        "This invited account has not been activated yet. Use the invitation link to set your password."
      );
    }

    if (user.passwordHash === "!google-auth") {
      throw new UnauthorizedError(
        "This account uses Google sign-in. Use Continue with Google."
      );
    }

    const passwordMatches = await bcrypt.compare(payload.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedError("Invalid email or password");
    }

    res.json(await buildSessionPayload(user));
  })
);

router.post(
  "/workspaces",
  authenticate,
  asyncHandler(async (req, res) => {
    const authUser = req.auth?.user;
    if (!authUser) {
      throw new UnauthorizedError("Authentication required");
    }

    if (env.APP_TENANT_MODE === "single") {
      throw new ForbiddenError(
        "Workspace creation is not available in single-tenant mode."
      );
    }

    if (!env.ALLOW_WORKSPACE_CREATION) {
      throw new ForbiddenError("Workspace creation is disabled on this deployment.");
    }

    const payload = createWorkspaceSchema.parse(req.body);
    const workspace = await createWorkspaceForUser({
      user: authUser,
      workspaceName: trimString(payload.workspaceName),
      workspaceSlug: trimString(payload.workspaceSlug),
      timeZone: trimString(payload.timeZone) || "Asia/Bangkok",
      billingSelection: payload.billingSelection,
    });

    res.json(await buildSessionPayload(authUser, String(workspace._id)));
  })
);

router.post(
  "/invitations/join",
  authenticate,
  asyncHandler(async (req, res) => {
    const authUser = req.auth?.user;
    if (!authUser) {
      throw new UnauthorizedError("Authentication required");
    }

    const payload = joinInviteSchema.parse(req.body);
    const inviteTokenHash = workspaceInviteService.hashInviteToken(payload.token);

    const membership = await WorkspaceMembershipModel.findOne({
      inviteTokenHash,
      status: "invited",
    });
    if (!membership || !membership.inviteExpiresAt || membership.inviteExpiresAt < new Date()) {
      throw new ValidationError("This invitation link is invalid or has expired");
    }

    const [workspace, invitedUser] = await Promise.all([
      WorkspaceModel.findById(membership.workspaceId),
      UserModel.findById(membership.userId),
    ]);
    if (!workspace || !invitedUser) {
      throw new ValidationError("This invitation is no longer available");
    }

    if (trimString(authUser.email).toLowerCase() !== trimString(invitedUser.email).toLowerCase()) {
      throw new ForbiddenError(
        "This invite code does not match the email on the current account."
      );
    }

    const existingMembership = await WorkspaceMembershipModel.findOne({
      workspaceId: membership.workspaceId,
      userId: authUser._id,
      status: "active",
    });
    if (existingMembership) {
      throw new ConflictError("This account already belongs to the workspace");
    }

    membership.userId = authUser._id;
    membership.status = "active";
    membership.inviteAcceptedAt = new Date();
    membership.inviteTokenHash = null;
    membership.inviteExpiresAt = null;
    membership.lastActiveAt = new Date();

    if (!authUser.workspaceIds.some((id) => String(id) === String(workspace._id))) {
      authUser.workspaceIds.push(workspace._id);
    }

    await Promise.all([authUser.save(), membership.save()]);
    await invalidatePortalDashboardCache();

    if (
      String(invitedUser._id) !== String(authUser._id) &&
      invitedUser.passwordHash === "!invited-account"
    ) {
      invitedUser.workspaceIds = invitedUser.workspaceIds.filter(
        (id) => String(id) !== String(workspace._id)
      );

      const invitedUserMembershipCount = await WorkspaceMembershipModel.countDocuments({
        userId: invitedUser._id,
      });

      if (invitedUserMembershipCount === 0) {
        await UserModel.findByIdAndDelete(invitedUser._id);
      } else {
        await invitedUser.save();
      }
    }

    res.json(await buildSessionPayload(authUser, String(workspace._id)));
  })
);

router.get(
  "/invitations/:token",
  asyncHandler(async (req, res) => {
    const { token } = inviteTokenParamSchema.parse(req.params);
    const inviteTokenHash = workspaceInviteService.hashInviteToken(token);

    const membership = await WorkspaceMembershipModel.findOne({
      inviteTokenHash,
      status: "invited",
    });
    if (!membership || !membership.inviteExpiresAt || membership.inviteExpiresAt < new Date()) {
      throw new ValidationError("This invitation link is invalid or has expired");
    }

    const [workspace, user] = await Promise.all([
      WorkspaceModel.findById(membership.workspaceId),
      UserModel.findById(membership.userId),
    ]);
    if (!workspace || !user) {
      throw new ValidationError("This invitation is no longer available");
    }

    res.json({
      invitation: {
        workspace: {
          _id: String(workspace._id),
          name: workspace.name,
          slug: workspace.slug,
        },
        workspaceRole: serializeWorkspaceRole(membership.role),
        email: user.email,
        name: user.name,
        expiresAt: membership.inviteExpiresAt,
      },
    });
  })
);

router.post(
  "/invitations/accept",
  asyncHandler(async (req, res) => {
    const payload = acceptInviteSchema.parse(req.body);
    const inviteTokenHash = workspaceInviteService.hashInviteToken(payload.token);

    const membership = await WorkspaceMembershipModel.findOne({
      inviteTokenHash,
      status: "invited",
    });
    if (!membership || !membership.inviteExpiresAt || membership.inviteExpiresAt < new Date()) {
      throw new ValidationError("This invitation link is invalid or has expired");
    }

    const [workspace, user] = await Promise.all([
      WorkspaceModel.findById(membership.workspaceId),
      UserModel.findById(membership.userId),
    ]);
    if (!workspace || !user) {
      throw new ValidationError("This invitation is no longer available");
    }

    user.passwordHash = await bcrypt.hash(payload.password, 10);
    user.authProvider =
      user.authProvider === "google" || user.authProvider === "hybrid"
        ? "hybrid"
        : "password";
    if (payload.name?.trim()) {
      user.name = payload.name.trim();
    }
    if (!user.workspaceIds.some((id) => String(id) === String(workspace._id))) {
      user.workspaceIds.push(workspace._id);
    }

    membership.status = "active";
    membership.inviteAcceptedAt = new Date();
    membership.inviteTokenHash = null;
    membership.inviteExpiresAt = null;
    membership.lastActiveAt = new Date();

    await Promise.all([user.save(), membership.save()]);
    await invalidatePortalDashboardCache();

    res.json(await buildSessionPayload(user, String(workspace._id)));
  })
);

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const authUser = req.auth?.user;
    if (!authUser) {
      throw new UnauthorizedError("Authentication required");
    }

    await syncPlatformRoleFromEmail(authUser);

    const [workspaceItems, blockedWorkspaceItems] = await Promise.all([
      loadActiveWorkspaceItems(String(authUser._id)),
      loadSeatLimitedWorkspaceItems(String(authUser._id)),
    ]);

    // In single-tenant mode with a pinned slug, surface only the default workspace
    // if the user is a member of it and reorder it to the front.
    let resolvedWorkspaces = workspaceItems;
    if (env.APP_TENANT_MODE === "single" && env.DEFAULT_WORKSPACE_SLUG) {
      const pinned = workspaceItems.find(
        (ws) => ws.slug === env.DEFAULT_WORKSPACE_SLUG
      );
      if (pinned) {
        resolvedWorkspaces = [pinned];
      }
    }

    res.json({
      user: serializeUser(
        authUser,
        resolvedWorkspaces.length || blockedWorkspaceItems.length
      ),
      workspaces: resolvedWorkspaces,
      blockedAccess:
        !resolvedWorkspaces.length && blockedWorkspaceItems.length
          ? {
              reason: "inactive_due_to_plan_limit" as const,
              message:
                "This account is attached to a workspace that is currently over its seat limit. Ask a workspace admin to upgrade the plan or free a seat.",
              workspaces: blockedWorkspaceItems.map((workspace) => ({
                _id: workspace._id,
                name: workspace.name,
                slug: workspace.slug,
                status: workspace.status,
              })),
            }
          : null,
      deployment: {
        tenantMode: env.APP_TENANT_MODE,
        allowSignup: env.ALLOW_SELF_SIGNUP,
        allowWorkspaceCreation: env.ALLOW_WORKSPACE_CREATION,
        defaultWorkspaceSlug: env.DEFAULT_WORKSPACE_SLUG || null,
        googleAuthEnabled: googleAuthService.isConfigured(),
      },
    });
  })
);

router.post(
  "/logout",
  authenticate,
  asyncHandler(async (_req, res) => {
    res.json({ loggedOut: true });
  })
);

export default router;
