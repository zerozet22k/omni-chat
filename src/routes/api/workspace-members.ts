import { Router } from "express";
import { z } from "zod";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import {
  ASSIGNABLE_WORKSPACE_ROLES,
  formatWorkspaceRoleLabel,
  serializeWorkspaceRole,
} from "../../lib/workspace-role";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";
import {
  UserModel,
  WorkspaceMembershipDocument,
  WorkspaceMembershipModel,
  WorkspaceModel,
} from "../../models";
import { workspaceInviteService } from "../../services/workspace-invite.service";
import { emailService } from "../../services/email.service";
import { billingService } from "../../services/billing.service";
import { invalidatePortalDashboardCache } from "../../lib/portal-dashboard-cache";

const router = Router();

const createMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
  workspaceRole: z.enum(ASSIGNABLE_WORKSPACE_ROLES).default("agent"),
});

const updateMemberSchema = z.object({
  workspaceRole: z.enum(ASSIGNABLE_WORKSPACE_ROLES).optional(),
  status: z.enum(["active", "invited", "disabled"]).optional(),
});

const workspaceParamSchema = z.object({
  workspaceId: z.string().min(1),
});

const memberParamSchema = z.object({
  memberId: z.string().min(1),
});

const serializeMembershipWithUser = async (
  membership: WorkspaceMembershipDocument,
  founderUserId?: string | null
) => {
  const user = await UserModel.findById(membership.userId);
  const isWorkspaceOwnerAccount =
    !!founderUserId && founderUserId === String(membership.userId);

  return {
    _id: String(membership._id),
    workspaceId: String(membership.workspaceId),
    workspaceRole: isWorkspaceOwnerAccount
      ? "owner"
      : serializeWorkspaceRole(membership.role),
    status: membership.status,
    invitedByUserId: membership.invitedByUserId
      ? String(membership.invitedByUserId)
      : null,
    lastActiveAt: membership.lastActiveAt,
    inviteExpiresAt: membership.inviteExpiresAt ?? null,
    inviteEmailSentAt: membership.inviteEmailSentAt ?? null,
    inviteAcceptedAt: membership.inviteAcceptedAt ?? null,
    isWorkspaceOwnerAccount,
    user: user
      ? {
          _id: String(user._id),
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        }
      : null,
  };
};

const issueWorkspaceInvite = async (params: {
  membership: WorkspaceMembershipDocument;
  workspaceName: string;
  inviterName?: string | null;
}) => {
  const user = await UserModel.findById(params.membership.userId);
  if (!user) {
    throw new NotFoundError("Invited user not found");
  }

  const inviteToken = workspaceInviteService.createInviteToken();
  const inviteExpiresAt = workspaceInviteService.buildInviteExpiry();
  params.membership.inviteTokenHash = workspaceInviteService.hashInviteToken(inviteToken);
  params.membership.inviteExpiresAt = inviteExpiresAt;
  params.membership.inviteAcceptedAt = null;

  const inviteUrl = workspaceInviteService.buildInviteUrl(inviteToken);
  const emailResult = await emailService.sendWorkspaceInvitation({
    toEmail: user.email,
    toName: user.name,
    workspaceName: params.workspaceName,
    inviterName: params.inviterName,
    inviteUrl,
    workspaceRoleLabel: formatWorkspaceRoleLabel(params.membership.role),
  });

  params.membership.inviteEmailSentAt = emailResult.sent ? new Date() : null;
  await params.membership.save();

  return {
    inviteUrl,
    emailSent: emailResult.sent,
    emailSkipped: emailResult.skipped,
    emailReason: emailResult.reason ?? null,
  };
};

router.use("/:workspaceId/members", requireWorkspace);

router.get(
  "/:workspaceId/members",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    workspaceParamSchema.parse(req.params);
    const founderUserId = req.workspace?.createdByUserId
      ? String(req.workspace.createdByUserId)
      : null;
    const [memberships, billing] = await Promise.all([
      WorkspaceMembershipModel.find({
        workspaceId: req.workspace?._id,
      }).sort({ createdAt: 1 }),
      billingService.getWorkspaceBillingState(String(req.workspace?._id ?? "")),
    ]);

    const userIds = memberships.map((membership) => membership.userId);
    const users = userIds.length ? await UserModel.find({ _id: { $in: userIds } }) : [];
    const userMap = new Map(users.map((user) => [String(user._id), user]));

    const items = memberships.map((membership) => ({
      _id: String(membership._id),
      workspaceId: String(membership.workspaceId),
      workspaceRole:
        founderUserId && founderUserId === String(membership.userId)
          ? "owner"
          : serializeWorkspaceRole(membership.role),
      status: membership.status,
      invitedByUserId: membership.invitedByUserId
        ? String(membership.invitedByUserId)
        : null,
      lastActiveAt: membership.lastActiveAt,
      inviteExpiresAt: membership.inviteExpiresAt ?? null,
      inviteEmailSentAt: membership.inviteEmailSentAt ?? null,
      inviteAcceptedAt: membership.inviteAcceptedAt ?? null,
      isWorkspaceOwnerAccount:
        !!founderUserId && founderUserId === String(membership.userId),
      user: (() => {
        const user = userMap.get(String(membership.userId));
        return user
          ? {
              _id: String(user._id),
              email: user.email,
              name: user.name,
              avatarUrl: user.avatarUrl,
            }
          : null;
      })(),
    }));

    res.json({
      items,
      billing: billing.serialized,
    });
  })
);

router.post(
  "/:workspaceId/members",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    workspaceParamSchema.parse(req.params);
    const payload = createMemberSchema.parse(req.body);

    const email = payload.email.trim().toLowerCase();
    const workspace = await WorkspaceModel.findById(req.workspace?._id);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }
    let user = await UserModel.findOne({ email });
    if (!user) {
      user = await UserModel.create({
        email,
        name: payload.name?.trim() || email.split("@")[0],
        passwordHash: "!invited-account",
        workspaceIds: [],
      });
    }

    await billingService.assertCanAddSeat(
      String(req.workspace?._id ?? ""),
      String(user._id)
    );

    const existingMembership = await WorkspaceMembershipModel.findOne({
      workspaceId: req.workspace?._id,
      userId: user._id,
    });
    if (existingMembership) {
      throw new ConflictError("User is already attached to this workspace");
    }

    const status = user.passwordHash === "!invited-account" ? "invited" : "active";

    const membership = await WorkspaceMembershipModel.create({
      workspaceId: req.workspace?._id,
      userId: user._id,
      role: payload.workspaceRole,
      status,
      invitedByUserId: req.auth?.userId ?? null,
      inviteTokenHash: null,
      inviteExpiresAt: null,
      inviteEmailSentAt: null,
      inviteAcceptedAt: null,
      lastActiveAt: null,
    });

    if (!user.workspaceIds.some((id) => String(id) === String(req.workspace?._id))) {
      user.workspaceIds.push(req.workspace!._id);
      await user.save();
    }

    const inviter = req.auth?.userId ? await UserModel.findById(req.auth.userId) : null;
    const inviteDelivery =
      status === "invited"
        ? await issueWorkspaceInvite({
            membership,
            workspaceName: workspace.name,
            inviterName: inviter?.name ?? null,
          })
        : null;

    await invalidatePortalDashboardCache();
    res.status(201).json({
      membership: await serializeMembershipWithUser(membership),
      user: {
        _id: String(user._id),
        email: user.email,
        name: user.name,
      },
      inviteDelivery,
    });
  })
);

router.post(
  "/:workspaceId/members/:memberId/resend-invite",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    workspaceParamSchema.parse(req.params);
    const { memberId } = memberParamSchema.parse(req.params);

    const membership = await WorkspaceMembershipModel.findById(memberId);
    if (!membership || String(membership.workspaceId) !== String(req.workspace?._id)) {
      throw new NotFoundError("Workspace membership not found");
    }

    if (membership.status !== "invited") {
      throw new ValidationError("Only invited members can receive a new invite link");
    }

    const workspace = await WorkspaceModel.findById(req.workspace?._id);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }

    const inviter = req.auth?.userId ? await UserModel.findById(req.auth.userId) : null;
    const inviteDelivery = await issueWorkspaceInvite({
      membership,
      workspaceName: workspace.name,
      inviterName: inviter?.name ?? null,
    });

    res.json({
      membership: await serializeMembershipWithUser(membership),
      inviteDelivery,
    });
  })
);

router.patch(
  "/:workspaceId/members/:memberId",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    workspaceParamSchema.parse(req.params);
    const { memberId } = memberParamSchema.parse(req.params);
    const patch = updateMemberSchema.parse(req.body);

    const membership = await WorkspaceMembershipModel.findById(memberId);
    if (!membership || String(membership.workspaceId) !== String(req.workspace?._id)) {
      throw new NotFoundError("Workspace membership not found");
    }

    const founderUserId = req.workspace?.createdByUserId
      ? String(req.workspace.createdByUserId)
      : "";
    if (founderUserId && founderUserId === String(membership.userId)) {
      throw new ValidationError(
        "The workspace owner-of-record account is locked and cannot be changed."
      );
    }

    if (patch.workspaceRole) {
      membership.role = patch.workspaceRole;
    }
    if (patch.status) {
      membership.status = patch.status;
      if (patch.status !== "invited") {
        membership.inviteTokenHash = null;
        membership.inviteExpiresAt = null;
      }
    }

    await membership.save();
    await invalidatePortalDashboardCache();
    res.json({
      membership: await serializeMembershipWithUser(membership, founderUserId || null),
    });
  })
);

router.delete(
  "/:workspaceId/members/:memberId",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    workspaceParamSchema.parse(req.params);
    const { memberId } = memberParamSchema.parse(req.params);

    const membership = await WorkspaceMembershipModel.findById(memberId);
    if (!membership || String(membership.workspaceId) !== String(req.workspace?._id)) {
      throw new NotFoundError("Workspace membership not found");
    }

    const founderUserId = req.workspace?.createdByUserId
      ? String(req.workspace.createdByUserId)
      : "";
    if (founderUserId && founderUserId === String(membership.userId)) {
      throw new ValidationError(
        "The workspace owner-of-record account is locked and cannot be removed."
      );
    }

    await WorkspaceMembershipModel.findByIdAndDelete(memberId);
    await invalidatePortalDashboardCache();
    res.json({ deleted: true });
  })
);

export default router;
