import { Router } from "express";
import { AISettingsModel } from "../../models";
import { asyncHandler } from "../../lib/async-handler";
import { updateAISettingsSchema } from "../../lib/validators";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";
import { encryptField } from "../../lib/crypto";
import { env } from "../../config/env";
import { channelSupportService } from "../../services/channel-support.service";
import { billingService } from "../../services/billing.service";

const router = Router();
router.use(requireWorkspace);

const encryptionSecret = () => env.FIELD_ENCRYPTION_KEY || env.SESSION_SECRET;

const serializeSettings = (
  settings: InstanceType<typeof AISettingsModel> | null,
  supportedChannels: Awaited<ReturnType<typeof channelSupportService.getSupportedChannels>>
) => {
  const storedGeminiModel = settings?.geminiModel || settings?.assistantModel || "";
  const storedGeminiApiKey = settings?.geminiApiKey || settings?.assistantApiKey || "";
  const autoReplyMode =
    settings?.autoReplyMode || (settings?.autoReplyEnabled ? "all" : "none");
  return {
    workspaceId: String(settings?.workspaceId ?? ""),
    enabled: settings?.enabled ?? true,
    autoReplyEnabled: settings?.autoReplyEnabled ?? true,
    autoReplyMode,
    afterHoursEnabled: settings?.afterHoursEnabled ?? true,
    confidenceThreshold: settings?.confidenceThreshold ?? 0.7,
    fallbackMessage:
      settings?.fallbackMessage ??
      "Thanks for your message. A teammate will follow up soon.",
    assistantInstructions: settings?.assistantInstructions || "",
    geminiModel: storedGeminiModel,
    supportedChannels,
    hasGeminiApiKey: !!storedGeminiApiKey,
  };
};

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const [settings, billing, supportedChannels] = await Promise.all([
      AISettingsModel.findOne({ workspaceId }),
      billingService.getWorkspaceBillingState(workspaceId),
      channelSupportService.getSupportedChannels(workspaceId),
    ]);
    res.json({
      settings: serializeSettings(settings, supportedChannels),
      billingAccess: {
        allowBYOAI: billing.serialized.entitlements.allowBYOAI,
        allowAutomation: billing.serialized.entitlements.allowAutomation,
      },
      billing: billing.serialized,
    });
  })
);

router.patch(
  "/",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const payload = updateAISettingsSchema.parse({
      ...req.body,
      workspaceId: String(req.workspace?._id ?? ""),
    });

    const requestsBYOAIEnable =
      payload.enabled === true ||
      payload.autoReplyEnabled === true ||
      (payload.autoReplyMode !== undefined && payload.autoReplyMode !== "none") ||
      (typeof payload.geminiApiKey === "string" && payload.geminiApiKey.trim().length > 0);

    if (requestsBYOAIEnable) {
      await billingService.assertCanUseBYOAI(payload.workspaceId);
    }

    const updateFields: Record<string, unknown> = {
      workspaceId: payload.workspaceId,
    };

    if (payload.enabled !== undefined) updateFields.enabled = payload.enabled;
    if (payload.autoReplyMode !== undefined) {
      updateFields.autoReplyMode = payload.autoReplyMode;
      updateFields.autoReplyEnabled = payload.autoReplyMode !== "none";
    } else if (payload.autoReplyEnabled !== undefined) {
      updateFields.autoReplyEnabled = payload.autoReplyEnabled;
      updateFields.autoReplyMode = payload.autoReplyEnabled ? "all" : "none";
    }
    if (payload.afterHoursEnabled !== undefined) updateFields.afterHoursEnabled = payload.afterHoursEnabled;
    if (payload.confidenceThreshold !== undefined) updateFields.confidenceThreshold = payload.confidenceThreshold;
    if (payload.fallbackMessage !== undefined) updateFields.fallbackMessage = payload.fallbackMessage;
    if (payload.assistantInstructions !== undefined) updateFields.assistantInstructions = payload.assistantInstructions;
    if (payload.geminiModel !== undefined) {
      updateFields.geminiModel = payload.geminiModel;
      updateFields.assistantModel = "";
    }
    if (payload.geminiApiKey !== undefined) {
      updateFields.geminiApiKey = payload.geminiApiKey
        ? encryptField(payload.geminiApiKey, encryptionSecret())
        : "";
      updateFields.assistantApiKey = "";
    }
    if (payload.supportedChannels !== undefined) {
      const [currentSupportedChannels, planAllowedChannels] = await Promise.all([
        channelSupportService.getSupportedChannels(payload.workspaceId),
        channelSupportService.getPlanAllowedChannels(payload.workspaceId),
      ]);
      const mergedChannels = {
        ...currentSupportedChannels,
        ...payload.supportedChannels,
      };
      updateFields.supportedChannels = {
        facebook: planAllowedChannels.facebook ? mergedChannels.facebook : false,
        instagram: planAllowedChannels.instagram ? mergedChannels.instagram : false,
        telegram: planAllowedChannels.telegram ? mergedChannels.telegram : false,
        viber: planAllowedChannels.viber ? mergedChannels.viber : false,
        tiktok: planAllowedChannels.tiktok ? mergedChannels.tiktok : false,
        line: planAllowedChannels.line ? mergedChannels.line : false,
        website: planAllowedChannels.website ? currentSupportedChannels.website : false,
      };
    }

    const settings = await AISettingsModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId },
      { $set: updateFields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const [billing, supportedChannels] = await Promise.all([
      billingService.getWorkspaceBillingState(payload.workspaceId),
      channelSupportService.getSupportedChannels(payload.workspaceId),
    ]);
    res.json({
      settings: serializeSettings(settings, supportedChannels),
      billingAccess: {
        allowBYOAI: billing.serialized.entitlements.allowBYOAI,
        allowAutomation: billing.serialized.entitlements.allowAutomation,
      },
      billing: billing.serialized,
    });
  })
);

export default router;
