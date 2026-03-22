import { Router } from "express";
import { ForbiddenError, NotFoundError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import {
  conversationQuerySchema,
  createOutboundContentEnvelopeSchema,
  createOutboundMessageSchema,
  objectIdParamSchema,
  updateConversationSchema,
} from "../../lib/validators";
import { conversationService } from "../../services/conversation.service";
import { contactService } from "../../services/contact.service";
import { messageService } from "../../services/message.service";
import { outboundContentExecutorService } from "../../services/outbound-content-executor.service";
import { outboundMessageService } from "../../services/outbound-message.service";
import { stickerCatalogService } from "../../services/sticker-catalog.service";
import { requireWorkspace } from "../../middleware/require-workspace";
import { emitRealtimeEvent } from "../../lib/realtime";

const router = Router();
router.use(requireWorkspace);

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

    res.json({
      conversation,
      contact,
    });
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
    const isStructuredRequest =
      typeof req.body === "object" &&
      req.body !== null &&
      Array.isArray((req.body as { blocks?: unknown }).blocks);

    if (isStructuredRequest) {
      const payload = createOutboundContentEnvelopeSchema.parse(req.body);
      const result = await outboundContentExecutorService.sendBlocks({
        conversationId: id,
        senderType: payload.senderType,
        blocks: payload.blocks,
        meta: payload.meta,
        source: "inbox",
      });

      res.status(201).json({
        messages: result.messages,
        deliveries: result.deliveries,
        message: result.messages[result.messages.length - 1] ?? null,
        delivery: result.deliveries[result.deliveries.length - 1] ?? null,
      });
      return;
    }

    const command = createOutboundMessageSchema.parse(req.body);
    const result = await outboundMessageService.send({
      conversationId: id,
      command,
      source: "inbox",
    });
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
