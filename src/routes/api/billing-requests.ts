import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireWorkspace } from "../../middleware/require-workspace";
import { AuditLogModel } from "../../models";
import { billingService } from "../../services/billing.service";

const router = Router();

const billingRequestSchema = z.object({
  requestType: z
    .enum(["upgrade_review", "plan_change", "billing_question", "sales_contact"])
    .default("upgrade_review"),
  note: z.string().trim().min(1).max(2000),
  gate: z
    .enum([
      "workspaces",
      "seats",
      "website_chat",
      "byo_ai",
      "automation",
      "platform_family",
      "external_platform_families",
      "channel_connections",
      "general",
    ])
    .default("general"),
});

router.use(requireWorkspace);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = billingRequestSchema.parse(req.body);
    const workspaceId = String(req.workspace?._id ?? "");
    const billing = (await billingService.getWorkspaceBillingState(workspaceId)).serialized;

    const auditLog = await AuditLogModel.create({
      workspaceId: req.workspace?._id,
      actorType: "workspace_user",
      actorId: req.auth?.userId ?? null,
      eventType: "billing.request.submitted",
      reason: payload.note,
      sourceHints: ["workspace_billing_modal"],
      data: {
        requestType: payload.requestType,
        gate: payload.gate,
        billingAccountId: billing.account._id,
        planCode: billing.subscription.planCode,
        planVersionId: billing.subscription.planVersionId,
        planDisplayName: billing.subscription.planDisplayName,
        subscriptionStatus: billing.subscription.status,
      },
    });

    res.status(201).json({
      submitted: true,
      request: {
        _id: String(auditLog._id),
        createdAt: auditLog.createdAt,
      },
    });
  })
);

export default router;
