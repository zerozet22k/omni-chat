import { Router } from "express";
import { ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import { objectIdParamSchema, updateContactSchema } from "../../lib/validators";
import { emitRealtimeEvent } from "../../lib/realtime";
import { contactService } from "../../services/contact.service";
import { requireWorkspace } from "../../middleware/require-workspace";

const router = Router();
router.use(requireWorkspace);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const contact = await contactService.getById(id);
    if (!contact) {
      throw new NotFoundError("Contact not found");
    }

    if (String(contact.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Contact does not belong to active workspace");
    }

    res.json({ contact });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const contact = await contactService.getById(id);
    if (!contact) {
      throw new NotFoundError("Contact not found");
    }

    if (String(contact.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Contact does not belong to active workspace");
    }

    const patch = updateContactSchema.parse(req.body);
    const updatedContact = await contactService.updateById({
      workspaceId: String(req.workspace?._id),
      contactId: id,
      patch,
    });

    if (!updatedContact) {
      throw new NotFoundError("Contact not found");
    }

    emitRealtimeEvent("contact.updated", {
      workspaceId: String(req.workspace?._id),
      contactId: String(updatedContact._id),
      contact: updatedContact.toObject(),
    });

    res.json({ contact: updatedContact });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = objectIdParamSchema.parse(req.params);
    const contact = await contactService.getById(id);
    if (!contact) {
      throw new NotFoundError("Contact not found");
    }

    if (String(contact.workspaceId) !== String(req.workspace?._id)) {
      throw new ForbiddenError("Contact does not belong to active workspace");
    }

    const confirm = String(req.query.confirm ?? "").trim().toLowerCase();
    const isConfirmed = ["1", "true", "yes", "confirm"].includes(confirm);
    if (!isConfirmed) {
      throw new ValidationError("confirm=true query parameter is required for delete");
    }

    const result = await contactService.deleteWithHistory({
      workspaceId: String(req.workspace?._id),
      contactId: id,
    });

    if (!result) {
      throw new NotFoundError("Contact not found");
    }

    res.json({ deleted: true, result });
  })
);

export default router;
