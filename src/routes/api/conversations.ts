import { Router } from "express";
import { z } from "zod";
import { ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import {
  conversationQuerySchema,
  createOutboundContentEnvelopeSchema,
  createOutboundMessageSchema,
  objectIdParamSchema,
  updateConversationSchema,
} from "../../lib/validators";
import { attentionItemService } from "../../services/attention-item.service";
import { conversationService } from "../../services/conversation.service";
import { contactService } from "../../services/contact.service";
import { messageService } from "../../services/message.service";
import { outboundContentExecutorService } from "../../services/outbound-content-executor.service";
import { outboundMessageService } from "../../services/outbound-message.service";
import { stickerCatalogService } from "../../services/sticker-catalog.service";
import { requireWorkspace } from "../../middleware/require-workspace";
import { emitRealtimeEvent } from "../../lib/realtime";
import { serializeBotPause } from "../../lib/bot-pause";
import { assertWithinRateLimit, normalizeRateLimitKeyPart } from "../../lib/request-rate-limit";

const router = Router();
router.use(requireWorkspace);

const attentionItemActionParamSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i),
  attentionItemId: z.string().regex(/^[a-f\d]{24}$/i),
});

const conversationActionParamSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i),
});

async function requireConversationForAction(conversationId: string, workspaceId?: string | null) {
  const conversation = await conversationService.getById(conversationId);
  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }
  if (String(conversation.workspaceId) !== String(workspaceId ?? "")) {
    throw new ForbiddenError("Conversation does not belong to active workspace");
  }

  return conversation;
}

async function buildConversationWithAttentionState(conversationId: string) {
  const conversation = await conversationService.getById(conversationId);
  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }

  const currentAttentionItem = await attentionItemService.getCurrentByConversation(conversationId);
  return {
    ...conversation.toObject(),
    ...serializeBotPause(conversation),
    currentAttentionItemId: currentAttentionItem?._id ?? null,
    currentAttentionItem,
  };
}

async function buildAttentionItemActionResponse(
  conversationId: string,
  attentionItemId?: string | null
) {
  const [conversation, items] = await Promise.all([
    buildConversationWithAttentionState(conversationId),
    attentionItemService.listByConversation(conversationId),
  ]);

  return {
    conversation,
    currentAttentionItem: conversation.currentAttentionItem ?? null,
    attentionItem: attentionItemId
      ? items.find((item) => item._id === attentionItemId) ?? null
      : null,
    items,
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = conversationQuerySchema.parse({
      ...req.query,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const items = await conversationService.list(query);
    res.json({ items });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const conversation = await conversationService.getById(id);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }

    if (String(conversation.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Conversation does not belong to active workspace");
    }

    const contact = conversation.contactId
      ? await contactService.getById(String(conversation.contactId))
      : null;
    const currentAttentionItem = await attentionItemService.getCurrentByConversation(id);

    res.json({
      conversation: {
        ...conversation.toObject(),
        ...serializeBotPause(conversation),
      },
      contact,
      currentAttentionItem,
    });
  })
);

router.get(
  "/:id/attention-items",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const conversation = await conversationService.getById(id);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }
    if (String(conversation.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Conversation does not belong to active workspace");
    }

    const items = await attentionItemService.listByConversation(id);
    res.json({ items });
  })
);

router.post(
  "/:id/pause-bot",
  asyncHandler(async (req, res) => {
    const { id } = conversationActionParamSchema.parse(req.params);
    const conversation = await requireConversationForAction(id, String(req.workspace?._id ?? ""));

    const attentionItem = await attentionItemService.pauseBotForConversation({
      conversationId: id,
      userId: String(req.auth?.userId ?? ""),
    });
    if (!attentionItem) {
      throw new ValidationError("Conversation has no inbound message to pause yet");
    }

    const payload = await buildAttentionItemActionResponse(id, attentionItem._id);
    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: id,
      status: payload.conversation.status,
      unreadCount: payload.conversation.unreadCount,
    });

    res.json(payload);
  })
);

router.post(
  "/:id/request-human",
  asyncHandler(async (req, res) => {
    const { id } = conversationActionParamSchema.parse(req.params);
    const conversation = await requireConversationForAction(id, String(req.workspace?._id ?? ""));

    const attentionItem = await attentionItemService.requestHumanForConversation({
      conversationId: id,
    });
    if (!attentionItem) {
      throw new ValidationError("Conversation has no inbound message to request help for yet");
    }

    const payload = await buildAttentionItemActionResponse(id, attentionItem._id);
    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: id,
      status: payload.conversation.status,
      unreadCount: payload.conversation.unreadCount,
    });

    res.json(payload);
  })
);

router.post(
  "/:id/resume-bot",
  asyncHandler(async (req, res) => {
    const { id } = conversationActionParamSchema.parse(req.params);
    const conversation = await requireConversationForAction(id, String(req.workspace?._id ?? ""));

    const attentionItem = await attentionItemService.resumeBotForConversation({
      conversationId: id,
    });

    const payload = await buildAttentionItemActionResponse(id, attentionItem?._id ?? null);
    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: id,
      status: payload.conversation.status,
      unreadCount: payload.conversation.unreadCount,
    });

    res.json(payload);
  })
);

router.post(
  "/:id/attention-items/:attentionItemId/claim",
  asyncHandler(async (req, res) => {
    const { id, attentionItemId } = attentionItemActionParamSchema.parse(req.params);
    const conversation = await requireConversationForAction(id, String(req.workspace?._id ?? ""));

    const attentionItem = await attentionItemService.getById(attentionItemId);
    if (!attentionItem) {
      throw new NotFoundError("Attention item not found");
    }
    if (attentionItem.conversationId !== id) {
      throw new ForbiddenError("Attention item does not belong to this conversation");
    }
    if (attentionItem.resolvedAt) {
      throw new ValidationError("Attention item is already resolved");
    }

    await attentionItemService.claimByUser({
      attentionItemId,
      userId: String(req.auth?.userId ?? ""),
    });

    const payload = await buildAttentionItemActionResponse(id, attentionItemId);
    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: id,
      status: payload.conversation.status,
      unreadCount: payload.conversation.unreadCount,
    });

    res.json(payload);
  })
);

router.post(
  "/:id/attention-items/:attentionItemId/request-human",
  asyncHandler(async (req, res) => {
    const { id, attentionItemId } = attentionItemActionParamSchema.parse(req.params);
    const conversation = await requireConversationForAction(id, String(req.workspace?._id ?? ""));

    const attentionItem = await attentionItemService.getById(attentionItemId);
    if (!attentionItem) {
      throw new NotFoundError("Attention item not found");
    }
    if (attentionItem.conversationId !== id) {
      throw new ForbiddenError("Attention item does not belong to this conversation");
    }
    if (attentionItem.resolvedAt) {
      throw new ValidationError("Attention item is already resolved");
    }

    await attentionItemService.markAwaitingHuman({
      attentionItemId,
      needsHumanReason: "manual_request",
      routingState:
        attentionItem.botPausedAt || attentionItem.claimedAt
          ? "human_active"
          : "human_pending",
      assignedUserId: attentionItem.assignedUserId ?? null,
      botPausedAt: attentionItem.botPausedAt ? new Date(attentionItem.botPausedAt) : null,
      botPausedUntil: attentionItem.botPausedUntil ? new Date(attentionItem.botPausedUntil) : null,
      botPausedByUserId: attentionItem.botPausedByUserId ?? null,
    });

    const payload = await buildAttentionItemActionResponse(id, attentionItemId);
    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: id,
      status: payload.conversation.status,
      unreadCount: payload.conversation.unreadCount,
    });

    res.json(payload);
  })
);

router.post(
  "/:id/attention-items/:attentionItemId/resume-bot",
  asyncHandler(async (req, res) => {
    const { id, attentionItemId } = attentionItemActionParamSchema.parse(req.params);
    const conversation = await requireConversationForAction(id, String(req.workspace?._id ?? ""));

    const attentionItem = await attentionItemService.getById(attentionItemId);
    if (!attentionItem) {
      throw new NotFoundError("Attention item not found");
    }
    if (attentionItem.conversationId !== id) {
      throw new ForbiddenError("Attention item does not belong to this conversation");
    }
    if (attentionItem.resolvedAt) {
      throw new ValidationError("Attention item is already resolved");
    }

    await attentionItemService.resumeBot({
      attentionItemId,
    });

    const payload = await buildAttentionItemActionResponse(id, attentionItemId);
    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: id,
      status: payload.conversation.status,
      unreadCount: payload.conversation.unreadCount,
    });

    res.json(payload);
  })
);

router.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const conversation = await conversationService.getById(id);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }
    if (String(conversation.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Conversation does not belong to active workspace");
    }
    const items = await messageService.listByConversation(id);
    
    // Log stickers and their media URLs
    const stickers = items.filter((m) => m.kind === "sticker" && m.channel === "line");
    if (stickers.length > 0) {
      console.log(`\n[API] ${new Date().toISOString()} - Returning ${stickers.length} LINE sticker messages:`);
      stickers.forEach((s, idx) => {
        console.log(`  [${idx}] Message ID: ${s._id}`);
        console.log(`      Kind: ${s.kind}`);
        console.log(`      Meta: ${JSON.stringify({
          platformStickerId: (s.meta as Record<string, unknown>)?.platformStickerId,
          stickerPackageId: (s.meta as Record<string, unknown>)?.stickerPackageId,
        })}`);
        const mediaItems = Array.isArray(s.media)
          ? (s.media as Array<{
              url?: string;
              mimeType?: string;
              providerFileId?: string;
            }>)
          : [];
        console.log(`      Media count: ${mediaItems.length}`);
        mediaItems.forEach((m, midx) => {
          console.log(`      Media[${midx}]:`, {
            url: m.url ? `${m.url.substring(0, 80)}...` : 'MISSING',
            mimeType: m.mimeType,
            providerFileId: m.providerFileId,
          });
        });
      });
    }
    
    res.json({ items });
  })
);

router.get(
  "/:id/sticker-catalog",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const conversation = await conversationService.getById(id);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }
    if (String(conversation.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Conversation does not belong to active workspace");
    }

    const catalog = await stickerCatalogService.getStickerCatalogForConversation(
      conversation
    );
    res.json({ catalog });
  })
);

router.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const conversation = await conversationService.getById(id);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }
    if (String(conversation.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Conversation does not belong to active workspace");
    }

    await assertWithinRateLimit({
      key: `rate:send:${String(conversation.workspaceId)}:${normalizeRateLimitKeyPart(String(req.auth?.userId ?? req.ip))}`,
      limit: 60,
      windowSec: 60,
      message: "Too many outbound send attempts right now. Please wait a moment and try again.",
      details: {
        scope: "workspace_send",
        workspaceId: String(conversation.workspaceId),
      },
    });

    const isStructuredRequest =
      typeof req.body === "object" &&
      req.body !== null &&
      Array.isArray((req.body as { blocks?: unknown }).blocks);

    if (isStructuredRequest) {
      const payload = createOutboundContentEnvelopeSchema.parse(req.body);
      const requestedAttentionItemId = String(payload.meta?.attentionItemId ?? "").trim();
      const currentAttentionItem =
        payload.senderType === "agent"
          ? requestedAttentionItemId
            ? { _id: requestedAttentionItemId }
            : await attentionItemService.getCurrentByConversation(id)
          : null;
      const result = await outboundContentExecutorService.sendBlocks({
        conversationId: id,
        senderType: payload.senderType,
        blocks: payload.blocks,
        meta: {
          ...(payload.meta ?? {}),
          actorUserId: payload.senderType === "agent" ? req.auth?.userId ?? null : null,
          attentionItemId: currentAttentionItem?._id ?? null,
        },
        source: "inbox",
      });
      const latestMessage = result.messages[result.messages.length - 1] ?? null;

      if (payload.senderType === "agent" && currentAttentionItem?._id && latestMessage) {
        await attentionItemService.markHumanReply({
          attentionItemId: currentAttentionItem._id,
          messageId: String(latestMessage._id),
          userId: String(req.auth?.userId ?? ""),
        });
      }

      res.status(201).json({
        messages: result.messages,
        deliveries: result.deliveries,
        message: latestMessage,
        delivery: result.deliveries[result.deliveries.length - 1] ?? null,
      });
      return;
    }

    const command = createOutboundMessageSchema.parse(req.body);
    const requestedAttentionItemId = String(command.meta?.attentionItemId ?? "").trim();
    const currentAttentionItem =
      command.senderType === "agent"
        ? requestedAttentionItemId
          ? { _id: requestedAttentionItemId }
          : await attentionItemService.getCurrentByConversation(id)
        : null;
    const result = await outboundMessageService.send({
      conversationId: id,
      command: {
        ...command,
        meta: {
          ...(command.meta ?? {}),
          actorUserId: command.senderType === "agent" ? req.auth?.userId ?? null : null,
          attentionItemId: currentAttentionItem?._id ?? null,
        },
      },
      source: "inbox",
    });

    if (command.senderType === "agent" && currentAttentionItem?._id && result.message) {
      await attentionItemService.markHumanReply({
        attentionItemId: currentAttentionItem._id,
        messageId: String(result.message._id),
        userId: String(req.auth?.userId ?? ""),
      });
    }

    res.status(201).json(result);
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const existingConversation = await conversationService.getById(id);
    if (!existingConversation) {
      throw new NotFoundError("Conversation not found");
    }
    if (String(existingConversation.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Conversation does not belong to active workspace");
    }

    const patch = updateConversationSchema.parse(req.body);
    const conversation = await conversationService.updateById(id, patch);
    if (!conversation) {
      throw new NotFoundError("Conversation not found");
    }

    emitRealtimeEvent("conversation.updated", {
      workspaceId: String(conversation.workspaceId),
      conversationId: String(conversation._id),
      status: conversation.status,
      unreadCount: conversation.unreadCount,
    });

    res.json({ conversation });
  })
);

export default router;
