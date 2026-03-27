import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { NotFoundError, ValidationError } from "../../lib/errors";
import {
  ChannelConnectionModel,
  ConversationModel,
  MessageModel,
  WorkspaceModel,
} from "../../models";
import { billingService } from "../../services/billing.service";
import { channelConnectionService } from "../../services/channel-connection.service";
import { inboundWebhookService } from "../../services/inbound-webhook.service";
import { assertWithinRateLimit, normalizeRateLimitKeyPart } from "../../lib/request-rate-limit";

const router = Router();

const optionalEmailSchema = z.union([z.string().trim().email(), z.literal("")]).optional();

const chatMessageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  senderName: z.string().trim().max(120).optional(),
  senderEmail: optionalEmailSchema,
  sessionId: z.string().trim().min(1).max(120).optional(),
});

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const getWorkspaceAndWebsiteConnection = async (slug: string) => {
  const workspace = await WorkspaceModel.findOne({ slug: trimString(slug).toLowerCase() });
  if (!workspace) {
    throw new NotFoundError("Workspace not found");
  }

  const currentWebsiteConnection = await ChannelConnectionModel.findOne({
    workspaceId: workspace._id,
    channel: "website",
    status: "active",
  }).sort({ updatedAt: -1 });

  const billing = (await billingService.getWorkspaceBillingState(workspace)).serialized;
  const publicChatEnabled =
    workspace.publicChatEnabled !== false && billing.entitlements.allowWebsiteChat;
  const websiteConnection = publicChatEnabled
    ? !currentWebsiteConnection ||
      !trimString(currentWebsiteConnection.webhookConfig?.connectionKey)
      ? await channelConnectionService.ensureWebsiteChatConnection(String(workspace._id))
      : currentWebsiteConnection
    : currentWebsiteConnection;

  return { workspace, websiteConnection, billing };
};

router.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const { workspace, websiteConnection, billing } = await getWorkspaceAndWebsiteConnection(
      String(req.params.slug ?? "")
    );
    const publicChatEnabled =
      workspace.publicChatEnabled !== false && billing.entitlements.allowWebsiteChat;

    res.json({
      workspace: {
        _id: String(workspace._id),
        name: workspace.name,
        slug: workspace.slug,
        bio: trimString(workspace.bio),
        publicDescription: trimString(workspace.publicDescription),
        publicWebsiteUrl: trimString(workspace.publicWebsiteUrl),
        publicSupportEmail: trimString(workspace.publicSupportEmail),
        publicSupportPhone: trimString(workspace.publicSupportPhone),
        publicLogoUrl: trimString(workspace.publicLogoUrl),
        publicWelcomeMessage: trimString(workspace.publicWelcomeMessage),
        publicChatEnabled,
        websiteChatAvailable: publicChatEnabled && !!websiteConnection,
      },
    });
  })
);

router.get(
  "/:slug/chat/:sessionId/messages",
  asyncHandler(async (req, res) => {
    const sessionId = trimString(req.params.sessionId);
    if (!sessionId) {
      throw new ValidationError("sessionId is required");
    }

    const { workspace, websiteConnection, billing } = await getWorkspaceAndWebsiteConnection(
      String(req.params.slug ?? "")
    );

    if (
      workspace.publicChatEnabled === false ||
      !billing.entitlements.allowWebsiteChat ||
      !websiteConnection
    ) {
      throw new NotFoundError("Website chat is not available for this workspace");
    }

    const conversation = await ConversationModel.findOne({
      workspaceId: workspace._id,
      channel: "website",
      channelAccountId: websiteConnection.externalAccountId,
      externalChatId: sessionId,
    }).sort({ updatedAt: -1 });

    if (!conversation) {
      res.json({ sessionId, items: [] });
      return;
    }

    const messages = await MessageModel.find({
      conversationId: conversation._id,
      channel: "website",
    })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();

    res.json({
      sessionId,
      items: messages.map((message) => ({
        _id: String(message._id),
        direction: message.direction,
        senderType: message.senderType,
        kind: message.kind,
        body:
          typeof message.text?.body === "string"
            ? message.text.body
            : typeof message.text?.plain === "string"
              ? message.text.plain
              : "",
        createdAt: message.createdAt,
      })),
    });
  })
);

router.post(
  "/:slug/chat",
  asyncHandler(async (req, res) => {
    const payload = chatMessageSchema.parse(req.body);
    const { workspace, websiteConnection, billing } = await getWorkspaceAndWebsiteConnection(
      String(req.params.slug ?? "")
    );

    if (
      workspace.publicChatEnabled === false ||
      !billing.entitlements.allowWebsiteChat ||
      !websiteConnection
    ) {
      throw new NotFoundError("Website chat is not available for this workspace");
    }

    await assertWithinRateLimit({
      key: `rate:widget:${String(workspace._id)}:${normalizeRateLimitKeyPart(req.ip)}`,
      limit: 30,
      windowSec: 300,
      message: "Too many public chat messages from this IP. Please wait and try again.",
      details: {
        scope: "widget",
        workspaceId: String(workspace._id),
      },
    });

    const connectionKey = trimString(websiteConnection.webhookConfig?.connectionKey);
    if (!connectionKey) {
      throw new ValidationError("Website chat connection is missing a connection key");
    }

    const sessionId = trimString(payload.sessionId) || randomUUID();
    const body = {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      sessionId,
      visitorId: sessionId,
      senderName: trimString(payload.senderName) || undefined,
      senderEmail: trimString(payload.senderEmail) || undefined,
      text: payload.text,
      channelAccountId: websiteConnection.externalAccountId,
      metadata: {
        source: "public-workspace-page",
        workspaceSlug: workspace.slug,
      },
    };

    await inboundWebhookService.receive({
      channel: "website",
      body,
      rawBody: JSON.stringify(body),
      headers: {},
      query: {
        connectionKey,
      },
    });

    res.status(201).json({
      queued: true,
      sessionId,
    });
  })
);

export default router;
