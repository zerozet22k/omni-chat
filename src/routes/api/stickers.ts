import axios from "axios";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { asyncHandler } from "../../lib/async-handler";
import { authenticate } from "../../middleware/authenticate";
import { requireWorkspace } from "../../middleware/require-workspace";
import { requireRole } from "../../middleware/require-role";
import { workspaceStickerService } from "../../services/workspace-sticker.service";

const router = Router();

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

// In-process cache: stickerId -> last verified CDN URL (null = all probes failed)
const previewCache = new Map<string, { url: string | null; at: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Build unofficial but widely-observed CDN candidates using the correct host
 * `stickershop.line-scdn.net`. The older `obs.line-scdn.net` and
 * `sticker.line-scdn.net` hosts are unreliable; this one is current as of 2026.
 */
const buildCdnCandidates = (stickerId: string): string[] => [
  `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/iPhone/sticker_key@2x.png`,
  `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`,
  `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/iPhone/sticker@2x.png`,
];

const fetchImageCandidate = async (url: string) => {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 6000,
    validateStatus: () => true,
    headers: { "User-Agent": "OmniChat/1.0 StickerProxy" },
  });
  const ctHeader = response.headers["content-type"];
  const contentType = Array.isArray(ctHeader)
    ? String(ctHeader[0] ?? "")
    : String(ctHeader ?? "");
  return { status: response.status, contentType, data: response.data };
};

const stickerChannelSchema = z.enum(["telegram", "viber", "line"]);
const createWorkspaceStickerSchema = z.object({
  channel: stickerChannelSchema,
  platformStickerId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().trim().optional(),
  emoji: z.string().trim().optional(),
  providerMeta: z
    .object({
      telegram: z
        .object({
          fileId: z.string().trim().min(1).optional(),
          thumbnailFileId: z.string().trim().optional(),
          isAnimated: z.boolean().optional(),
          isVideo: z.boolean().optional(),
        })
        .optional(),
      viber: z
        .object({
          previewUrl: z.string().trim().url().optional(),
        })
        .optional(),
      line: z
        .object({
          packageId: z.string().trim().min(1),
          stickerResourceType: z.string().trim().optional(),
          storeUrl: z.string().trim().url().optional(),
          packTitle: z.string().trim().optional(),
        })
        .optional(),
    })
    .optional(),
})
.superRefine((value, ctx) => {
  if (value.channel === "telegram" && !value.providerMeta?.telegram?.fileId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerMeta", "telegram", "fileId"],
      message: "Telegram stickers require providerMeta.telegram.fileId",
    });
  }

  if (value.channel === "line" && !value.providerMeta?.line?.packageId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerMeta", "line", "packageId"],
      message: "LINE stickers require providerMeta.line.packageId",
    });
  }
});

const listWorkspaceStickerQuerySchema = z.object({
  channel: stickerChannelSchema.optional(),
});

router.get(
  "/proxy/:stickerId/:packageId",
  asyncHandler(async (req, res) => {
    const stickerId: string = Array.isArray(req.params.stickerId)
      ? req.params.stickerId[0]
      : req.params.stickerId;
    const packageId: string = Array.isArray(req.params.packageId)
      ? req.params.packageId[0]
      : req.params.packageId;
    const stickerResourceType = trimString(req.query.stickerResourceType);

    if (!stickerId || !packageId || !/^\d+$/.test(stickerId) || !/^\d+$/.test(packageId)) {
      res.status(400).json({ error: "Invalid sticker or package ID" });
      return;
    }

    const now = Date.now();

    // Serve from cache when possible
    const cached = previewCache.get(stickerId);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      if (!cached.url) {
        res.status(404).json({ previewUrl: null, reason: "cdn_not_available_cached" });
        return;
      }
      try {
        const { status, contentType, data } = await fetchImageCandidate(cached.url);
        if (status >= 200 && status < 300 && contentType.toLowerCase().startsWith("image/")) {
          res
            .set("Content-Type", contentType)
            .set("Cache-Control", "public, max-age=86400")
            .send(Buffer.from(data));
          return;
        }
      } catch {
        // Cache hit but fetch failed — fall through to re-probe
      }
      previewCache.delete(stickerId);
    }

    // Probe CDN candidates in order; first valid image/* response wins
    const candidates = buildCdnCandidates(stickerId);
    for (const url of candidates) {
      try {
        const { status, contentType, data } = await fetchImageCandidate(url);
        if (status >= 200 && status < 300 && contentType.toLowerCase().startsWith("image/")) {
          logger.info("LINE sticker CDN preview found", {
            stickerId,
            packageId,
            stickerResourceType: stickerResourceType || undefined,
            url,
            contentType,
          });
          previewCache.set(stickerId, { url, at: now });
          res
            .set("Content-Type", contentType)
            .set("Cache-Control", "public, max-age=86400")
            .send(Buffer.from(data));
          return;
        }
        logger.debug("LINE sticker CDN candidate rejected", {
          stickerId,
          url,
          status,
          contentType,
        });
      } catch (err) {
        logger.debug("LINE sticker CDN candidate error", {
          stickerId,
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // All candidates failed
    logger.warn("LINE sticker CDN preview not available", {
      stickerId,
      packageId,
      stickerResourceType: stickerResourceType || undefined,
    });
    previewCache.set(stickerId, { url: null, at: now });
    res.status(404).json({ previewUrl: null, reason: "cdn_not_available" });
  })
);

router.use(authenticate);
router.use(requireWorkspace);
router.use(requireRole(["admin"]));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listWorkspaceStickerQuerySchema.parse(req.query);
    const items = await workspaceStickerService.listByWorkspace({
      workspaceId: String(req.workspace?._id ?? ""),
      channel: query.channel,
    });

    res.json({ items });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const payload = createWorkspaceStickerSchema.parse(req.body);
    const providerMeta =
      payload.channel === "telegram"
        ? {
            telegram: {
              fileId:
                payload.providerMeta?.telegram?.fileId ??
                payload.platformStickerId,
              thumbnailFileId: payload.providerMeta?.telegram?.thumbnailFileId,
              isAnimated: payload.providerMeta?.telegram?.isAnimated,
              isVideo: payload.providerMeta?.telegram?.isVideo,
            },
          }
        : payload.channel === "viber"
          ? {
              viber: {
                previewUrl: payload.providerMeta?.viber?.previewUrl,
              },
            }
          : {
              line: {
                packageId: payload.providerMeta?.line?.packageId ?? "",
                stickerResourceType:
                  payload.providerMeta?.line?.stickerResourceType,
                storeUrl: payload.providerMeta?.line?.storeUrl,
                packTitle: payload.providerMeta?.line?.packTitle,
              },
            };

    const item = await workspaceStickerService.create({
      workspaceId: String(req.workspace?._id ?? ""),
      createdByUserId: String(req.auth?.userId ?? ""),
      channel: payload.channel,
      platformStickerId: payload.platformStickerId,
      label: payload.label,
      description: payload.description,
      emoji: payload.emoji,
      providerMeta,
    });

    res.status(201).json({ item });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "Sticker id is required" });
      return;
    }

    const result = await workspaceStickerService.removeInWorkspace(
      id,
      String(req.workspace?._id ?? "")
    );

    res.json({
      deleted: true,
      id: result._id,
    });
  })
);

export default router;
