import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { NotFoundError } from "../../lib/errors";
import {
  createKnowledgeItemSchema,
  objectIdParamSchema,
  updateKnowledgeItemSchema,
} from "../../lib/validators";
import { knowledgeService } from "../../services/knowledge.service";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";

const router = Router();
router.use(requireWorkspace);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.workspace?._id ?? "");
    const items = await knowledgeService.list(workspaceId);
    res.json({ items });
  })
);

router.post(
  "/",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const payload = createKnowledgeItemSchema.parse({
      ...req.body,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const item = await knowledgeService.create(payload);
    res.status(201).json({ item });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const item = await knowledgeService.getByIdInWorkspace(
      id,
      String(req.workspace?._id ?? "")
    );
    if (!item) {
      throw new NotFoundError("Knowledge item not found");
    }

    res.json({ item });
  })
);

router.patch(
  "/:id",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const patch = updateKnowledgeItemSchema.parse(req.body);
    const item = await knowledgeService.updateInWorkspace(
      id,
      String(req.workspace?._id ?? ""),
      patch
    );
    if (!item) {
      throw new NotFoundError("Knowledge item not found");
    }

    res.json({ item });
  })
);

router.delete(
  "/:id",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const item = await knowledgeService.removeInWorkspace(
      id,
      String(req.workspace?._id ?? "")
    );
    if (!item) {
      throw new NotFoundError("Knowledge item not found");
    }

    res.json({ deleted: true });
  })
);

export default router;
