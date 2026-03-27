import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { auditLogQuerySchema } from "../../lib/validators";
import { auditLogService } from "../../services/audit-log.service";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";

const router = Router();
router.use(requireWorkspace);

router.get(
  "/",
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const query = auditLogQuerySchema.parse({
      ...req.query,
      workspaceId: String(req.workspace?._id ?? ""),
    });
    const items = await auditLogService.list(query);
    res.json({ items });
  })
);

export default router;
