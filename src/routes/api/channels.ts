import { Router } from "express";
import { z } from "zod";
import { CHANNELS } from "../../channels/types";
import { asyncHandler } from "../../lib/async-handler";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { createChannelConnectionSchema, objectIdParamSchema } from "../../lib/validators";
import { ChannelConnectionModel } from "../../models";
import { channelConnectionService } from "../../services/channel-connection.service";
import { channelSupportService } from "../../services/channel-support.service";
import { facebookOAuthService } from "../../services/facebook-oauth.service";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";
import { logger } from "../../lib/logger";
import { billingService } from "../../services/billing.service";

const router = Router();
const workspaceQuerySchema = z.object({
  workspaceId: z.string().min(1),
});
const rehookSchema = z.object({
  workspaceId: z.string().min(1).optional(),
});
const facebookOAuthExchangeSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});
const facebookOAuthStartSchema = z.object({
  uiOrigin: z.string().trim().optional(),
});

const formatChannelLabel = (channel: (typeof CHANNELS)[number]) => {
  if (channel === "line") {
    return "LINE";
  }

  if (channel === "tiktok") {
    return "TikTok";
  }

  if (channel === "website") {
    return "Website Chat";
  }

  return channel.charAt(0).toUpperCase() + channel.slice(1);
};

const assertChannelActionAllowed = async (params: {
  workspaceId: string;
  channel: (typeof CHANNELS)[number];
  ignoreConnectionId?: string | null;
}) => {
  const [planAllowedChannels, supportedChannels] = await Promise.all([
    channelSupportService.getPlanAllowedChannels(params.workspaceId),
    channelSupportService.getSupportedChannels(params.workspaceId),
  ]);

  if (!planAllowedChannels[params.channel]) {
    await billingService.assertCanConnectChannel({
      workspaceId: params.workspaceId,
      channel: params.channel,
      ignoreConnectionId: params.ignoreConnectionId ?? null,
    });
  }

  if (!supportedChannels[params.channel]) {
    throw new ValidationError(
      `${formatChannelLabel(
        params.channel
      )} is turned off in workspace channel availability.`
    );
  }
};

router.use(requireWorkspace);
router.use(requireRole(["admin"]));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { workspaceId } = workspaceQuerySchema.parse({
      ...req.query,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const [items, billing] = await Promise.all([
      channelConnectionService.listConnectionsByWorkspace(workspaceId),
      billingService.getWorkspaceBillingState(workspaceId),
    ]);
    res.json({
      items: await channelConnectionService.serializeMany(items),
      publicWebhookBaseUrl: channelConnectionService.getPublicWebhookBaseUrl(),
      billing: billing.serialized,
    });
  })
);

const handleFacebookOAuthStart = asyncHandler(async (req, res) => {
  const workspaceId = String(req.workspace?._id ?? "");
  const payload = facebookOAuthStartSchema.safeParse(req.body);
  const uiOrigin = payload.success ? payload.data.uiOrigin : undefined;

  const result = facebookOAuthService.createAuthorizationUrl({
    workspaceId,
    uiOrigin,
  });

  logger.info("Facebook OAuth start endpoint called", {
    workspaceId,
    method: req.method,
    attemptId: result.attemptId,
    state: result.state,
    callbackOrigin: result.callbackOrigin,
    uiOrigin: uiOrigin || null,
  });

  res.json(result);
});

router.get("/facebook/oauth/start", handleFacebookOAuthStart);
router.post("/facebook/oauth/start", handleFacebookOAuthStart);

router.post(
  "/facebook/oauth/exchange",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const payload = facebookOAuthExchangeSchema.parse(req.body);

    logger.info("Facebook OAuth exchange endpoint called", {
      workspaceId,
      state: payload.state,
      hasCode: !!payload.code,
    });

    const pages = await facebookOAuthService.exchangeCodeForPages({
      workspaceId,
      state: payload.state,
      code: payload.code,
    });

    logger.info("Facebook OAuth exchange endpoint succeeded", {
      workspaceId,
      state: payload.state,
      pages: pages.length,
    });

    res.json({ pages });
  })
);

router.post(
  "/:channel/connect",
  asyncHandler(async (req, res) => {
    const channel = z.enum(CHANNELS).parse(req.params.channel);
    const workspaceId = String(req.workspace?._id ?? "");
    await assertChannelActionAllowed({ workspaceId, channel });
    await channelConnectionService.assertConnectionPreflight({
      workspaceId,
      channel,
      actionLabel: `connecting ${formatChannelLabel(channel)}`,
    });

    const payload = createChannelConnectionSchema.parse({
      ...req.body,
      workspaceId,
    });
    const connection = await channelConnectionService.createConnection(channel, payload);

    if (channel === "facebook") {
      logger.info("Facebook connection saved from channel connect", {
        workspaceId,
        connectionId: String(connection._id),
        externalAccountId: connection.externalAccountId,
        status: connection.status,
        verificationState: connection.verificationState,
      });
    }

    res.status(201).json({
      connection: await channelConnectionService.serialize(connection),
    });
  })
);

router.post(
  "/:channel/test",
  asyncHandler(async (req, res) => {
    const channel = z.enum(CHANNELS).parse(req.params.channel);
    const workspaceId = String(req.workspace?._id ?? "");
    await assertChannelActionAllowed({ workspaceId, channel });
    await channelConnectionService.assertConnectionPreflight({
      workspaceId,
      channel,
      actionLabel: `testing ${formatChannelLabel(channel)} credentials`,
    });

    const payload = createChannelConnectionSchema.parse({
      ...req.body,
      workspaceId,
    });
    const diagnostics = await channelConnectionService.validateConnection(
      channel,
      payload
    );
    res.json({ diagnostics });
  })
);

router.post(
  "/rehook",
  asyncHandler(async (req, res) => {
    const payload = rehookSchema.parse({
      ...req.body,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const supportedChannels = await channelSupportService.getSupportedChannels(
      payload.workspaceId ?? String(req.workspace?._id ?? "")
    );
    const items = await channelConnectionService.rehookConnections({
      workspaceId: payload.workspaceId,
    });
    const filteredItems = items.filter((item) => supportedChannels[item.channel]);
    res.json({
      updated: filteredItems.length,
      items: filteredItems,
    });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const workspaceId = String(req.workspace?._id ?? "");
    const existingConnection = await ChannelConnectionModel.findById(id);
    if (!existingConnection || String(existingConnection.workspaceId) !== workspaceId) {
      throw new NotFoundError("Channel connection not found");
    }

    await assertChannelActionAllowed({
      workspaceId,
      channel: existingConnection.channel,
      ignoreConnectionId: id,
    });
    await channelConnectionService.assertConnectionPreflight({
      workspaceId,
      channel: existingConnection.channel,
      actionLabel: `updating ${formatChannelLabel(existingConnection.channel)}`,
    });

    const payload = createChannelConnectionSchema.partial().parse({
      ...req.body,
      workspaceId,
    });
    const connection = await channelConnectionService.revalidateExistingConnection(
      id,
      workspaceId,
      payload
    );
    res.json({
      connection: await channelConnectionService.serialize(connection),
    });
  })
);

router.post(
  "/:id/reconnect",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const workspaceId = String(req.workspace?._id ?? "");
    const existingConnection = await ChannelConnectionModel.findById(id);
    if (!existingConnection || String(existingConnection.workspaceId) !== workspaceId) {
      throw new NotFoundError("Channel connection not found");
    }

    await assertChannelActionAllowed({
      workspaceId,
      channel: existingConnection.channel,
      ignoreConnectionId: id,
    });
    await channelConnectionService.assertConnectionPreflight({
      workspaceId,
      channel: existingConnection.channel,
      actionLabel: `reconnecting ${formatChannelLabel(existingConnection.channel)}`,
    });

    const connection = await channelConnectionService.revalidateExistingConnection(
      id,
      workspaceId
    );
    res.json({
      connection: await channelConnectionService.serialize(connection),
    });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const connection = await channelConnectionService.deleteConnectionInWorkspace(
      id,
      String(req.workspace?._id ?? "")
    );
    res.json({
      deleted: true,
      connectionId: String(connection._id),
    });
  })
);

export default router;
