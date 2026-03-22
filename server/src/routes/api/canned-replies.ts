import { Router } from "express";
import { NotFoundError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import {
  createCannedReplySchema,
  objectIdParamSchema,
  updateCannedReplySchema,
} from "../../lib/validators";
import { cannedReplyService } from "../../services/canned-reply.service";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";

const router = Router();
router.use(requireWorkspace);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const items = await cannedReplyService.list(workspaceId);
    res.json({ items });
  })
);

router.post(
  "/",
  requireRole(["owner", "admin"]),
  asyncHandler(async (req, res) => {
    const payload = createCannedReplySchema.parse({
      ...req.body,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const item = await cannedReplyService.create(payload);
    res.status(201).json({ item });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const item = await cannedReplyService.getById(id);
    if (!item) {
      throw new NotFoundError("Canned reply not found");
    }

    res.json({ item });
  })
);

router.patch(
  "/:id",
  requireRole(["owner", "admin"]),
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const patch = updateCannedReplySchema.parse(req.body);
    const item = await cannedReplyService.update(id, patch);
    if (!item) {
      throw new NotFoundError("Canned reply not found");
    }

    res.json({ item });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const item = await cannedReplyService.remove(id);
    if (!item) {
      throw new NotFoundError("Canned reply not found");
    }

    res.json({ deleted: true });
  })
);

export default router;
