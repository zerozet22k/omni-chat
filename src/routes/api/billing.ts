import { Request, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { NotFoundError, UnauthorizedError } from "../../lib/errors";
import { invalidatePortalDashboardCache } from "../../lib/portal-dashboard-cache";
import { BillingAccountDocument, BillingAccountModel, WorkspaceModel } from "../../models";
import { auditLogService } from "../../services/audit-log.service";
import { requireRole } from "../../middleware/require-role";
import { requireWorkspace } from "../../middleware/require-workspace";
import { billingService } from "../../services/billing.service";
import { platformSettingsService } from "../../services/platform-settings.service";
import { stripeBillingService } from "../../services/stripe-billing.service";

const router = Router();

const billingAccountUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  companyLegalName: z.string().trim().max(160).optional(),
  billingEmail: z.union([z.string().trim().email(), z.literal("")]).optional(),
  billingPhone: z.string().trim().max(60).optional(),
  billingAddress: z
    .object({
      line1: z.string().trim().max(160).optional(),
      line2: z.string().trim().max(160).optional(),
      city: z.string().trim().max(120).optional(),
      state: z.string().trim().max(120).optional(),
      postalCode: z.string().trim().max(40).optional(),
      country: z.string().trim().max(120).optional(),
    })
    .optional(),
});

const billingAccountCreateSchema = z.object({
  name: z.string().trim().max(120).optional(),
});

const billingAccountSelectionSchema = z.object({
  billingAccountId: z.string().trim().min(1),
});

const workspaceBillingAccountSelectionSchema = z.object({
  billingAccountId: z.string().trim().min(1),
  makeDefaultForAccount: z.boolean().optional(),
});

const billingPlanSessionSchema = z.object({
  planVersionId: z.string().trim().min(1),
});

const workspacePlanChangeSchema = z.object({
  planVersionId: z.string().trim().min(1),
});

const billingPortalSessionSchema = z.object({
  flow: z.enum(["manage", "payment_method_update"]).optional(),
});

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const requireAuthUserId = (req: Request) => {
  const userId = trimString(req.auth?.userId);
  if (!userId) {
    throw new UnauthorizedError("Authentication required");
  }

  return userId;
};

const serializeBillingAccountProfile = (
  billingAccount: BillingAccountDocument
) => {
  const paymentMethodSummary =
    billingAccount.paymentMethodSummary &&
    typeof billingAccount.paymentMethodSummary === "object"
      ? (billingAccount.paymentMethodSummary as {
          provider?: unknown;
          brand?: unknown;
          last4?: unknown;
          expMonth?: unknown;
          expYear?: unknown;
        })
      : {};

  return {
    accountId: String(billingAccount._id),
    name: billingAccount.name,
    companyLegalName: trimString(billingAccount.companyLegalName),
    billingEmail: trimString(billingAccount.billingEmail),
    billingPhone: trimString(billingAccount.billingPhone),
    billingAddress: {
      line1: trimString(billingAccount.billingAddress?.line1),
      line2: trimString(billingAccount.billingAddress?.line2),
      city: trimString(billingAccount.billingAddress?.city),
      state: trimString(billingAccount.billingAddress?.state),
      postalCode: trimString(billingAccount.billingAddress?.postalCode),
      country: trimString(billingAccount.billingAddress?.country),
    },
    paymentMethod: {
      provider: trimString(paymentMethodSummary.provider) || null,
      customerId: trimString(billingAccount.paymentProviderCustomerId) || null,
      brand: trimString(paymentMethodSummary.brand) || null,
      last4: trimString(paymentMethodSummary.last4) || null,
      expMonth:
        typeof paymentMethodSummary.expMonth === "number"
          ? paymentMethodSummary.expMonth
          : null,
      expYear:
        typeof paymentMethodSummary.expYear === "number"
          ? paymentMethodSummary.expYear
          : null,
    },
  };
};

const serializeAttachedWorkspaces = async (billingAccountId: string) => {
  const workspaces = await WorkspaceModel.find({ billingAccountId })
    .sort({ updatedAt: -1, name: 1 })
    .select("_id name slug");

  return workspaces.map((workspace) => ({
    _id: String(workspace._id),
    name: workspace.name,
    slug: workspace.slug,
  }));
};

const serializeOwnedBillingAccountChoices = async (ownerUserId: string) => {
  const { defaultBillingAccountId, billingAccounts } =
    await billingService.listBillingAccountsForOwner(ownerUserId);

  const items = await Promise.all(
    billingAccounts.map(async (billingAccount) => {
      const [state, workspaceCount] = await Promise.all([
        billingService.getBillingAccountState(billingAccount),
        WorkspaceModel.countDocuments({ billingAccountId: billingAccount._id }),
      ]);

      return {
        _id: String(billingAccount._id),
        name: billingAccount.name,
        planDisplayName: state.serialized.subscription.planDisplayName,
        version: state.serialized.subscription.version,
        status: state.serialized.subscription.status,
        workspaceCount,
        isDefault: String(billingAccount._id) === String(defaultBillingAccountId),
      };
    })
  );

  return {
    defaultBillingAccountId,
    items,
  };
};

const serializeOwnedBillingAccounts = async (ownerUserId: string) => {
  const { defaultBillingAccountId, billingAccounts } =
    await billingService.listBillingAccountsForOwner(ownerUserId);
  const paymentProviders = await platformSettingsService.getPaymentProviderSummary();

  const items = await Promise.all(
    billingAccounts.map(async (billingAccount) => {
      const [state, stripe, attachedWorkspaces] = await Promise.all([
        billingService.getBillingAccountState(billingAccount),
        stripeBillingService.getBillingAccountStripeSummaryById(String(billingAccount._id)),
        serializeAttachedWorkspaces(String(billingAccount._id)),
      ]);

      return {
        billing: state.serialized,
        accountProfile: serializeBillingAccountProfile(state.billingAccount),
        stripe,
        workspaceCount: attachedWorkspaces.length,
        attachedWorkspaces,
        isDefault: String(billingAccount._id) === String(defaultBillingAccountId),
      };
    })
  );

  return {
    defaultBillingAccountId,
    items,
    paymentProviders,
  };
};

const serializeWorkspaceBillingDetails = async (workspaceId: string, ownerUserId?: string) => {
  const context = await billingService.getWorkspaceBillingState(workspaceId);
  const stripe = await stripeBillingService.getBillingAccountStripeSummary(workspaceId);
  const paymentProviders = await platformSettingsService.getPaymentProviderSummary();
  const ownedBillingAccounts = ownerUserId
    ? await serializeOwnedBillingAccountChoices(ownerUserId)
    : null;

  return {
    billing: context.serialized,
    accountProfile: serializeBillingAccountProfile(context.billingAccount),
    stripe,
    paymentProviders,
    workspaceBillingAccountId: String(context.billingAccount._id),
    ownedBillingAccounts,
  };
};

router.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    const ownerUserId = requireAuthUserId(req);
    res.json(await serializeOwnedBillingAccounts(ownerUserId));
  })
);

router.post(
  "/accounts",
  asyncHandler(async (req, res) => {
    const ownerUserId = requireAuthUserId(req);
    const payload = billingAccountCreateSchema.parse(req.body);
    const authUser = req.auth?.user;
    const billingAccount = await billingService.createBillingAccountForOwner({
      ownerUserId,
      fallbackName: trimString(payload.name) || trimString(authUser?.name) || "Billing account",
      seedPlanCode: "free",
      seedStatus: "active",
    });

    await auditLogService.record({
      actorType: "workspace_user",
      actorId: ownerUserId,
      eventType: "billing.account_created",
      sourceHints: ["billing", "account"],
      data: {
        billingAccountId: String(billingAccount.billingAccount._id),
      },
    });

    await invalidatePortalDashboardCache();
    res.json(await serializeOwnedBillingAccounts(ownerUserId));
  })
);

router.patch(
  "/accounts/default",
  asyncHandler(async (req, res) => {
    const ownerUserId = requireAuthUserId(req);
    const payload = billingAccountSelectionSchema.parse(req.body);
    const billingAccount = await billingService.setDefaultBillingAccountForOwner(
      ownerUserId,
      payload.billingAccountId
    );

    await auditLogService.record({
      actorType: "workspace_user",
      actorId: ownerUserId,
      eventType: "billing.default_account_updated",
      sourceHints: ["billing", "account"],
      data: {
        billingAccountId: String(billingAccount._id),
      },
    });

    await invalidatePortalDashboardCache();
    res.json(await serializeOwnedBillingAccounts(ownerUserId));
  })
);

router.patch(
  "/accounts/:billingAccountId",
  asyncHandler(async (req, res) => {
    const ownerUserId = requireAuthUserId(req);
    const payload = billingAccountUpdateSchema.parse(req.body);
    const billingAccount = await billingService.getOwnedBillingAccount(
      ownerUserId,
      String(req.params.billingAccountId)
    );

    if (typeof payload.name === "string") {
      billingAccount.name = payload.name;
    }
    if (typeof payload.companyLegalName === "string") {
      billingAccount.companyLegalName = payload.companyLegalName;
    }
    if (typeof payload.billingEmail === "string") {
      billingAccount.billingEmail = payload.billingEmail;
    }
    if (typeof payload.billingPhone === "string") {
      billingAccount.billingPhone = payload.billingPhone;
    }
    if (payload.billingAddress) {
      billingAccount.billingAddress = {
        line1: payload.billingAddress.line1 ?? billingAccount.billingAddress?.line1 ?? "",
        line2: payload.billingAddress.line2 ?? billingAccount.billingAddress?.line2 ?? "",
        city: payload.billingAddress.city ?? billingAccount.billingAddress?.city ?? "",
        state: payload.billingAddress.state ?? billingAccount.billingAddress?.state ?? "",
        postalCode:
          payload.billingAddress.postalCode ??
          billingAccount.billingAddress?.postalCode ??
          "",
        country:
          payload.billingAddress.country ?? billingAccount.billingAddress?.country ?? "",
      };
    }

    await billingAccount.save();
    await stripeBillingService.syncCustomerProfileIfPossible(String(billingAccount._id));
    await invalidatePortalDashboardCache();

    res.json(await serializeOwnedBillingAccounts(ownerUserId));
  })
);

router.delete(
  "/accounts/:billingAccountId",
  asyncHandler(async (req, res) => {
    const ownerUserId = requireAuthUserId(req);
    const result = await billingService.deleteBillingAccountForOwner(
      ownerUserId,
      String(req.params.billingAccountId)
    );

    await auditLogService.record({
      actorType: "workspace_user",
      actorId: ownerUserId,
      eventType: "billing.account_deleted",
      sourceHints: ["billing", "account"],
      data: result,
    });

    await invalidatePortalDashboardCache();
    res.json(await serializeOwnedBillingAccounts(ownerUserId));
  })
);

router.use(requireWorkspace);

router.get(
  "/account",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const ownerUserId =
      req.workspaceMembership?.role === "owner" ? requireAuthUserId(req) : undefined;
    res.json(await serializeWorkspaceBillingDetails(workspaceId, ownerUserId));
  })
);

router.get(
  "/catalog",
  asyncHandler(async (_req, res) => {
    const paymentProviders = await platformSettingsService.getPaymentProviderSummary();
    const items = await billingService.listPlanCatalogs();
    const ownerUserId = trimString(_req.auth?.userId);
    res.json({
      items: items
        .filter((item) => item.active && item.showPublicly && item.selfServe)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => ({
          ...item,
          versions: item.versions.filter((version) => version.active),
        })),
      trial: ownerUserId
        ? await billingService.getAccountTrialState(ownerUserId)
        : {
            available: false,
            hasUsedTrial: false,
            trialStartedAt: null,
            trialConsumedAt: null,
            trialUsedByBillingAccountId: null,
            trialUsedOnPlanCode: null,
          },
      stripeConfigured: paymentProviders.stripe.available,
      paymentProviders,
    });
  })
);

router.patch(
  "/workspace-account",
  requireRole(["owner"]),
  asyncHandler(async (req, res) => {
    const ownerUserId = requireAuthUserId(req);
    const payload = workspaceBillingAccountSelectionSchema.parse(req.body);
    const workspaceId = String(req.workspace?._id ?? "");
    const billingAccount = await billingService.assignWorkspaceToBillingAccount(
      workspaceId,
      payload.billingAccountId,
      ownerUserId
    );

    if (payload.makeDefaultForAccount) {
      await billingService.setDefaultBillingAccountForOwner(
        ownerUserId,
        String(billingAccount._id)
      );
    }

    await auditLogService.record({
      workspaceId,
      actorType: "workspace_user",
      actorId: ownerUserId,
      eventType: "billing.workspace_account_updated",
      sourceHints: ["billing", "workspace"],
      data: {
        billingAccountId: String(billingAccount._id),
        makeDefaultForAccount: !!payload.makeDefaultForAccount,
      },
    });

    await invalidatePortalDashboardCache();
    res.json(await serializeWorkspaceBillingDetails(workspaceId, ownerUserId));
  })
);

router.post(
  "/plan-session",
  requireRole(["owner"]),
  asyncHandler(async (req, res) => {
    const payload = billingPlanSessionSchema.parse(req.body);
    await platformSettingsService.assertStripeCheckoutEnabled();
    const workspaceId = String(req.workspace?._id ?? "");
    const workspaceSlug = req.workspace?.slug ?? "";
    const result = await stripeBillingService.createPlanSession({
      workspaceId,
      workspaceSlug,
      planVersionId: payload.planVersionId,
      uiOrigin: typeof req.headers.origin === "string" ? req.headers.origin : null,
    });

    await auditLogService.record({
      workspaceId,
      actorType: "workspace_user",
      actorId: req.auth?.userId ?? undefined,
      eventType: "billing.plan_session_started",
      sourceHints: ["billing", "stripe", "checkout"],
      data: {
        mode: result.mode,
        planVersionId: payload.planVersionId,
      },
    });

    res.json(result);
  })
);

router.post(
  "/plan-change",
  requireRole(["owner"]),
  asyncHandler(async (req, res) => {
    const payload = workspacePlanChangeSchema.parse(req.body);
    const workspaceId = String(req.workspace?._id ?? "");
    const ownerUserId = requireAuthUserId(req);

    const result = await billingService.changeWorkspacePlan({
      workspaceId,
      ownerUserId,
      planVersionId: payload.planVersionId,
    });

    await auditLogService.record({
      workspaceId,
      actorType: "workspace_user",
      actorId: ownerUserId,
      eventType: "billing.plan_changed",
      sourceHints: ["billing", "plan-change"],
      data: {
        mode: result.mode,
        planVersionId: payload.planVersionId,
      },
    });

    res.json(result);
  })
);

router.post(
  "/plan-change/undo",
  requireRole(["owner"]),
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const ownerUserId = requireAuthUserId(req);
    const updated = await billingService.undoScheduledWorkspacePlanChange({
      workspaceId,
      ownerUserId,
    });

    await auditLogService.record({
      workspaceId,
      actorType: "workspace_user",
      actorId: ownerUserId,
      eventType: "billing.plan_change_undone",
      sourceHints: ["billing", "plan-change"],
      data: {
        billingAccountId: String(updated.billingAccount._id),
      },
    });

    res.json(await serializeWorkspaceBillingDetails(workspaceId, ownerUserId));
  })
);

router.post(
  "/portal-session",
  requireRole(["owner"]),
  asyncHandler(async (req, res) => {
    const payload = billingPortalSessionSchema.parse(req.body);
    await platformSettingsService.assertStripeCheckoutEnabled();
    const workspaceId = String(req.workspace?._id ?? "");
    const workspaceSlug = req.workspace?.slug ?? "";
    const result = await stripeBillingService.createPortalSession({
      workspaceId,
      workspaceSlug,
      flow: payload.flow,
      uiOrigin: typeof req.headers.origin === "string" ? req.headers.origin : null,
    });

    await auditLogService.record({
      workspaceId,
      actorType: "workspace_user",
      actorId: req.auth?.userId ?? undefined,
      eventType: "billing.portal_session_started",
      sourceHints: ["billing", "stripe", "portal"],
      data: {
        mode: result.mode,
      },
    });

    res.json(result);
  })
);

router.patch(
  "/account",
  requireRole(["owner"]),
  asyncHandler(async (req, res) => {
    const payload = billingAccountUpdateSchema.parse(req.body);
    const workspaceId = String(req.workspace?._id ?? "");
    const context = await billingService.getWorkspaceBillingState(workspaceId);
    const billingAccount = await BillingAccountModel.findById(context.billingAccount._id);

    if (!billingAccount) {
      throw new NotFoundError("Billing account not found");
    }

    if (typeof payload.name === "string") {
      billingAccount.name = payload.name;
    }
    if (typeof payload.companyLegalName === "string") {
      billingAccount.companyLegalName = payload.companyLegalName;
    }
    if (typeof payload.billingEmail === "string") {
      billingAccount.billingEmail = payload.billingEmail;
    }
    if (typeof payload.billingPhone === "string") {
      billingAccount.billingPhone = payload.billingPhone;
    }
    if (payload.billingAddress) {
      billingAccount.billingAddress = {
        line1: payload.billingAddress.line1 ?? billingAccount.billingAddress?.line1 ?? "",
        line2: payload.billingAddress.line2 ?? billingAccount.billingAddress?.line2 ?? "",
        city: payload.billingAddress.city ?? billingAccount.billingAddress?.city ?? "",
        state: payload.billingAddress.state ?? billingAccount.billingAddress?.state ?? "",
        postalCode:
          payload.billingAddress.postalCode ??
          billingAccount.billingAddress?.postalCode ??
          "",
        country:
          payload.billingAddress.country ?? billingAccount.billingAddress?.country ?? "",
      };
    }

    await billingAccount.save();
    await stripeBillingService.syncCustomerProfileIfPossible(String(billingAccount._id));
    await invalidatePortalDashboardCache();

    res.json(await serializeWorkspaceBillingDetails(workspaceId, requireAuthUserId(req)));
  })
);

export default router;
