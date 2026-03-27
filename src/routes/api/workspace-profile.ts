import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { asyncHandler } from "../../lib/async-handler";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";
import { AISettingsModel, ChannelConnectionModel, WorkspaceModel } from "../../models";
import { billingService } from "../../services/billing.service";
import { channelConnectionService } from "../../services/channel-connection.service";
import { channelSupportService } from "../../services/channel-support.service";

const router = Router();

const optionalUrlSchema = z.union([z.string().trim().url(), z.literal("")]).optional();
const optionalEmailSchema = z.union([z.string().trim().email(), z.literal("")]).optional();

const updateWorkspaceProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  bio: z.string().trim().max(2500).optional(),
  publicDescription: z.string().trim().max(2500).optional(),
  publicWebsiteUrl: optionalUrlSchema,
  publicSupportEmail: optionalEmailSchema,
  publicSupportPhone: z.string().trim().max(60).optional(),
  publicLogoUrl: optionalUrlSchema,
  publicWelcomeMessage: z.string().trim().max(400).optional(),
  publicChatEnabled: z.boolean().optional(),
});

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const buildClientPageUrl = (slug: string) =>
  `${env.CLIENT_URL.trim().replace(/\/+$/, "")}/w/${encodeURIComponent(slug)}`;

const buildClientChatPageUrl = (slug: string) =>
  `${buildClientPageUrl(slug)}/chat`;

const serializeWorkspaceProfile = async (workspaceId: string) => {
  const [workspace, websiteConnection, supportedChannels] = await Promise.all([
    WorkspaceModel.findById(workspaceId),
    ChannelConnectionModel.findOne({
      workspaceId,
      channel: "website",
      status: "active",
    }).sort({ updatedAt: -1 }),
    channelSupportService.getSupportedChannels(workspaceId),
  ]);

  if (!workspace) {
    return null;
  }

  const billing = (await billingService.getWorkspaceBillingState(workspace)).serialized;
  const websiteChatEntitled = billing.entitlements.allowWebsiteChat;
  const websiteChannelEnabled = supportedChannels.website;
  const publicChatEnabled =
    workspace.publicChatEnabled !== false &&
    websiteChatEntitled &&
    websiteChannelEnabled;
  const ensuredWebsiteConnection = publicChatEnabled
    ? !websiteConnection || !trimString(websiteConnection.webhookConfig?.connectionKey)
      ? await channelConnectionService.ensureWebsiteChatConnection(String(workspace._id))
      : websiteConnection
    : websiteConnection;

  return {
    _id: String(workspace._id),
    name: workspace.name,
    slug: workspace.slug,
    timeZone: workspace.timeZone,
    bio: trimString(workspace.bio),
    publicDescription: trimString(workspace.publicDescription),
    publicWebsiteUrl: trimString(workspace.publicWebsiteUrl),
    publicSupportEmail: trimString(workspace.publicSupportEmail),
    publicSupportPhone: trimString(workspace.publicSupportPhone),
    publicLogoUrl: trimString(workspace.publicLogoUrl),
    publicWelcomeMessage: trimString(workspace.publicWelcomeMessage),
    publicChatEnabled,
    websiteChatAvailable: publicChatEnabled && !!ensuredWebsiteConnection,
    websiteChatEntitled,
    publicChatPagePath: `/w/${workspace.slug}/chat`,
    publicChatPageUrl: buildClientChatPageUrl(workspace.slug),
    publicPagePath: `/w/${workspace.slug}`,
    publicPageUrl: buildClientPageUrl(workspace.slug),
    billing,
  };
};

router.use(requireWorkspace);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspace = await serializeWorkspaceProfile(String(req.workspace?._id ?? ""));
    res.json({ workspace });
  })
);

router.patch(
  "/",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const payload = updateWorkspaceProfileSchema.parse(req.body);
    const workspace = await WorkspaceModel.findById(req.workspace?._id);
    if (!workspace) {
      res.status(404).json({ error: { message: "Workspace not found" } });
      return;
    }

    if (typeof payload.name === "string") {
      workspace.name = payload.name;
    }
    if (typeof payload.bio === "string") {
      workspace.bio = payload.bio;
    }
    if (typeof payload.publicDescription === "string") {
      workspace.publicDescription = payload.publicDescription;
    }
    if (typeof payload.publicWebsiteUrl === "string") {
      workspace.publicWebsiteUrl = payload.publicWebsiteUrl;
    }
    if (typeof payload.publicSupportEmail === "string") {
      workspace.publicSupportEmail = payload.publicSupportEmail;
    }
    if (typeof payload.publicSupportPhone === "string") {
      workspace.publicSupportPhone = payload.publicSupportPhone;
    }
    if (typeof payload.publicLogoUrl === "string") {
      workspace.publicLogoUrl = payload.publicLogoUrl;
    }
    if (typeof payload.publicWelcomeMessage === "string") {
      workspace.publicWelcomeMessage = payload.publicWelcomeMessage;
    }
    if (typeof payload.publicChatEnabled === "boolean") {
      if (payload.publicChatEnabled) {
        await billingService.assertCanUseWebsiteChat(String(workspace._id));
      }
      workspace.publicChatEnabled = payload.publicChatEnabled;
      await AISettingsModel.findOneAndUpdate(
        { workspaceId: workspace._id },
        {
          $set: {
            workspaceId: workspace._id,
            "supportedChannels.website": payload.publicChatEnabled,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );
      if (payload.publicChatEnabled) {
        await channelConnectionService.ensureWebsiteChatConnection(String(workspace._id));
      }
    }

    await workspace.save();

    const serialized = await serializeWorkspaceProfile(String(workspace._id));
    res.json({ workspace: serialized });
  })
);

export default router;
