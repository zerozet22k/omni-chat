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

router.use(requireWorkspace);
router.use(requireRole(["owner", "admin"]));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { workspaceId } = workspaceQuerySchema.parse({
      ...req.query,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const items = await channelConnectionService.listConnectionsByWorkspace(
      workspaceId
    );
    res.json({
      items: channelConnectionService.serializeMany(items),
      publicWebhookBaseUrl: channelConnectionService.getPublicWebhookBaseUrl(),
    });
  })
);

router.post(
  "/facebook/oauth/start",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const result = facebookOAuthService.createAuthorizationUrl(workspaceId);
    res.json(result);
  })
);

router.post(
  "/facebook/oauth/exchange",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const payload = facebookOAuthExchangeSchema.parse(req.body);
    const pages = await facebookOAuthService.exchangeCodeForPages({
      workspaceId,
      state: payload.state,
      code: payload.code,
    });

    res.json({ pages });
  })
);

router.post(
  "/:channel/connect",
  asyncHandler(async (req, res) => {
    const channel = z.enum(CHANNELS).parse(req.params.channel);
    const workspaceId = String(req.workspace?._id ?? "");
    const channelEnabled = await channelSupportService.isChannelEnabled(
      workspaceId,
      channel
    );
    if (!channelEnabled) {
      throw new ValidationError(
        `Channel ${channel} is disabled in workspace admin settings.`
      );
    }

    const payload = createChannelConnectionSchema.parse({
      ...req.body,
      workspaceId,
    });
    const connection = await channelConnectionService.createConnection(channel, payload);
    res.status(201).json({
      connection: channelConnectionService.serialize(connection),
    });
  })
);

router.post(
  "/:channel/test",
  asyncHandler(async (req, res) => {
    const channel = z.enum(CHANNELS).parse(req.params.channel);
    const workspaceId = String(req.workspace?._id ?? "");
    const channelEnabled = await channelSupportService.isChannelEnabled(
      workspaceId,
      channel
    );
    if (!channelEnabled) {
      throw new ValidationError(
        `Channel ${channel} is disabled in workspace admin settings.`
      );
    }

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

    const channelEnabled = await channelSupportService.isChannelEnabled(
      workspaceId,
      existingConnection.channel
    );
    if (!channelEnabled) {
      throw new ValidationError(
        `Channel ${existingConnection.channel} is disabled in workspace admin settings.`
      );
    }

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
      connection: channelConnectionService.serialize(connection),
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

    const channelEnabled = await channelSupportService.isChannelEnabled(
      workspaceId,
      existingConnection.channel
    );
    if (!channelEnabled) {
      throw new ValidationError(
        `Channel ${existingConnection.channel} is disabled in workspace admin settings.`
      );
    }

    const connection = await channelConnectionService.revalidateExistingConnection(
      id,
      workspaceId
    );
    res.json({
      connection: channelConnectionService.serialize(connection),
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
