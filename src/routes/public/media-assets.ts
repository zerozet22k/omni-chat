import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { mediaAssetService } from "../../services/media-asset.service";

const router = Router();

router.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const token = String(req.params.token ?? "").trim();
    if (!token) {
      res.status(404).end();
      return;
    }

    const streamed = await mediaAssetService.streamFromToken(token, res);
    if (!streamed && !res.headersSent) {
      res.status(404).end();
    }
  })
);

export default router;
