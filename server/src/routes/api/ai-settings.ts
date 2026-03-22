import { Router } from "express";
import { AISettingsModel } from "../../models";
import { asyncHandler } from "../../lib/async-handler";
import { updateAISettingsSchema } from "../../lib/validators";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";
import { encryptField } from "../../lib/crypto";
import { env } from "../../config/env";
import {
  channelSupportService,
  DEFAULT_SUPPORTED_CHANNELS,
} from "../../services/channel-support.service";

const router = Router();
router.use(requireWorkspace);

/** Return the effective encryption secret (FIELD_ENCRYPTION_KEY falls back to SESSION_SECRET). */
const encryptionSecret = () => env.FIELD_ENCRYPTION_KEY || env.SESSION_SECRET;

/** Serialize AI settings for the client — never expose the raw geminiApiKey. */
const serializeSettings = (settings: InstanceType<typeof AISettingsModel> | null) => {
  if (!settings) return null;
  return {
    workspaceId: String(settings.workspaceId),
    enabled: settings.enabled,
    autoReplyEnabled: settings.autoReplyEnabled,
    afterHoursEnabled: settings.afterHoursEnabled,
    confidenceThreshold: settings.confidenceThreshold,
    fallbackMessage: settings.fallbackMessage,
    geminiModel: settings.geminiModel || "",
    supportedChannels: {
      ...DEFAULT_SUPPORTED_CHANNELS,
      ...(settings.supportedChannels ?? {}),
    },
    // Expose only whether a workspace key is set, never the key itself.
    hasGeminiApiKey: !!(settings.geminiApiKey),
  };
};

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const settings = await AISettingsModel.findOne({ workspaceId });
    res.json({ settings: serializeSettings(settings) });
  })
);

router.patch(
  "/",
  requireRole(["owner", "admin"]),
  asyncHandler(async (req, res) => {
    const payload = updateAISettingsSchema.parse({
      ...req.body,
      workspaceId: String(req.workspace?._id ?? ""),
    });

    // Build $set payload — encrypt geminiApiKey before storing.
    const updateFields: Record<string, unknown> = {
      workspaceId: payload.workspaceId,
    };

    if (payload.enabled !== undefined) updateFields.enabled = payload.enabled;
    if (payload.autoReplyEnabled !== undefined) updateFields.autoReplyEnabled = payload.autoReplyEnabled;
    if (payload.afterHoursEnabled !== undefined) updateFields.afterHoursEnabled = payload.afterHoursEnabled;
    if (payload.confidenceThreshold !== undefined) updateFields.confidenceThreshold = payload.confidenceThreshold;
    if (payload.fallbackMessage !== undefined) updateFields.fallbackMessage = payload.fallbackMessage;
    if (payload.geminiModel !== undefined) updateFields.geminiModel = payload.geminiModel;
    if (payload.geminiApiKey !== undefined) {
      // Empty string clears the override; a non-empty value is encrypted at rest.
      updateFields.geminiApiKey = payload.geminiApiKey
        ? encryptField(payload.geminiApiKey, encryptionSecret())
        : "";
    }
    if (payload.supportedChannels !== undefined) {
      const currentSupportedChannels =
        await channelSupportService.getSupportedChannels(payload.workspaceId);
      updateFields.supportedChannels = {
        ...currentSupportedChannels,
        ...payload.supportedChannels,
      };
    }

    const settings = await AISettingsModel.findOneAndUpdate(
      { workspaceId: payload.workspaceId },
      { $set: updateFields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ settings: serializeSettings(settings) });
  })
);

export default router;
