import { z } from "zod";
import {
  CHANNELS,
  CONVERSATION_ROUTING_STATES,
  CONVERSATION_STATUSES,
  OUTBOUND_MESSAGE_KINDS,
  SENDER_TYPES,
} from "../channels/types";

export const objectIdParamSchema = z.object({
  id: z.string().min(1),
});

const contentBlockChannelSchema = z.enum([...CHANNELS, "any"] as const);
const canonicalTextSchema = z.object({
  body: z.string().min(1),
  plain: z.string().optional(),
});
const canonicalMediaItemSchema = z.object({
  url: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().optional(),
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  providerFileId: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  isTemporary: z.boolean().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  expirySource: z.enum(["provider_ttl", "signed_url", "unknown"]).nullable().optional(),
  lastValidatedAt: z.coerce.date().nullable().optional(),
  storedAssetId: z.string().nullable().optional(),
  storedAssetUrl: z.string().nullable().optional(),
});
export const outboundContentBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    channel: contentBlockChannelSchema.optional(),
    text: canonicalTextSchema,
    meta: z.record(z.any()).optional(),
  }),
  z.object({
    kind: z.literal("sticker"),
    channel: contentBlockChannelSchema.optional(),
    sticker: z.object({
      platformStickerId: z.string().min(1),
      packageId: z.string().min(1).optional(),
      stickerResourceType: z.string().optional(),
      label: z.string().optional(),
      description: z.string().optional(),
      emoji: z.string().optional(),
      preview: z
        .object({
          kind: z.enum(["image", "video", "tgs", "fallback"]),
          url: z.string().optional(),
          mimeType: z.string().optional(),
        })
        .optional(),
    }),
    meta: z.record(z.any()).optional(),
  }),
  z.object({
    kind: z.literal("attachment"),
    channel: contentBlockChannelSchema.optional(),
    attachment: z.object({
      kind: z.enum(["image", "video", "audio", "file"]),
      text: canonicalTextSchema.optional(),
      media: z.array(canonicalMediaItemSchema).min(1),
    }),
    meta: z.record(z.any()).optional(),
  }),
]);

export const createChannelConnectionSchema = z.object({
  workspaceId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  externalAccountId: z.string().min(1).optional(),
  credentials: z.record(z.any()).default({}),
  webhookConfig: z.record(z.any()).default({}),
});

export const conversationQuerySchema = z.object({
  workspaceId: z.string().min(1),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  channel: z.enum(CHANNELS).optional(),
  assigneeUserId: z.string().optional(),
  needsHuman: z
    .union([z.boolean(), z.string()])
    .transform((value) =>
      typeof value === "boolean" ? value : value.toLowerCase() === "true"
    )
    .optional(),
  search: z.string().optional(),
});

export const createOutboundMessageSchema = z
  .object({
    senderType: z.enum(["agent"]).default("agent"),
    kind: z.enum(OUTBOUND_MESSAGE_KINDS),
    text: canonicalTextSchema.optional(),
    media: z.array(canonicalMediaItemSchema).optional(),
    location: z
      .object({
        lat: z.number(),
        lng: z.number(),
        label: z.string().optional(),
      })
      .optional(),
    contact: z
      .object({
        name: z.string().min(1),
        phone: z.string().min(1),
      })
      .optional(),
    interactive: z
      .object({
        subtype: z.string().min(1),
        label: z.string().optional(),
        value: z.string().optional(),
        payload: z.any().optional(),
      })
      .optional(),
    meta: z.record(z.any()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "text" && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Text body is required for text outbound messages.",
      });
      return;
    }

    if (
      ["image", "video", "audio", "file"].includes(value.kind) &&
      (!value.media || value.media.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.kind} outbound messages require at least one media item.`,
      });
      return;
    }

    if (["image", "video", "file"].includes(value.kind)) {
      const mediaUrl = value.media?.[0]?.storedAssetUrl ?? value.media?.[0]?.url;
      if (!mediaUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.kind} outbound messages require media[0].url or media[0].storedAssetUrl.`,
        });
        return;
      }
    }

    if (["video", "file"].includes(value.kind) && !value.media?.[0]?.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.kind} outbound messages require media[0].size for provider payload compatibility.`,
      });
      return;
    }

    if (value.kind === "location" && !value.location) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Location outbound messages require location payload.",
      });
      return;
    }

    if (value.kind === "contact" && !value.contact) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Contact outbound messages require contact payload.",
      });
      return;
    }

    if (value.kind === "interactive" && !value.interactive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Interactive outbound messages require interactive payload.",
      });
      return;
    }

    if (value.kind === "sticker") {
      const stickerId = String(value.meta?.platformStickerId ?? "").trim();
      if (!stickerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Sticker outbound messages require meta.platformStickerId.",
        });
        return;
      }
    }
  });

export const createOutboundContentEnvelopeSchema = z.object({
  senderType: z.enum(["agent"]).default("agent"),
  blocks: z.array(outboundContentBlockSchema).min(1),
  meta: z.record(z.any()).optional(),
});

export const updateConversationSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  assigneeUserId: z.string().nullable().optional(),
  aiEnabled: z.boolean().optional(),
  routingState: z.enum(CONVERSATION_ROUTING_STATES).optional(),
  tags: z.array(z.string()).optional(),
  unreadCount: z.number().int().min(0).optional(),
});

export const updateContactSchema = z.object({
  phones: z.array(z.string().min(1)).optional(),
  deliveryAddress: z.string().optional(),
  notes: z.string().optional(),
  aiNotes: z.string().optional(),
});

export const createKnowledgeItemSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
});

export const updateKnowledgeItemSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export const createCannedReplySchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1).optional(),
  blocks: z.array(outboundContentBlockSchema).min(1).optional(),
  triggers: z.array(z.string()).default([]),
  category: z.string().default("general"),
}).superRefine((value, ctx) => {
  if ((!value.body || !value.body.trim()) && (!value.blocks || value.blocks.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Canned replies require either body or at least one structured block.",
    });
  }
});

export const updateCannedReplySchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  blocks: z.array(outboundContentBlockSchema).min(1).optional(),
  triggers: z.array(z.string()).optional(),
  category: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const updateAISettingsSchema = z.object({
  workspaceId: z.string().min(1),
  enabled: z.boolean().optional(),
  autoReplyEnabled: z.boolean().optional(),
  autoReplyMode: z
    .enum(["none", "all", "after_hours_only", "business_hours_only"])
    .optional(),
  afterHoursEnabled: z.boolean().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  fallbackMessage: z.string().optional(),
  assistantInstructions: z.string().optional(),
  geminiApiKey: z.string().optional(),
  geminiModel: z.string().optional(),
  supportedChannels: z
    .object({
      facebook: z.boolean().optional(),
      instagram: z.boolean().optional(),
      telegram: z.boolean().optional(),
      viber: z.boolean().optional(),
      tiktok: z.boolean().optional(),
      line: z.boolean().optional(),
    })
    .optional(),
});

export const updateAutomationsSchema = z.object({
  workspaceId: z.string().min(1),
  businessHours: z
    .object({
      timeZone: z.string().min(1),
      weeklySchedule: z.array(
        z.object({
          dayOfWeek: z.number().min(0).max(6),
          enabled: z.boolean(),
          windows: z.array(
            z.object({
              start: z.string().regex(/^\d{2}:\d{2}$/),
              end: z.string().regex(/^\d{2}:\d{2}$/),
            })
          ),
        })
      ),
    })
    .optional(),
  afterHoursRule: z
    .object({
      isActive: z.boolean(),
      mode: z.enum(["off", "after_hours", "all"]).optional(),
      name: z.string().min(1),
      fallbackText: z.string().optional(),
    })
    .optional(),
});

export const auditLogQuerySchema = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().optional(),
  eventType: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
});
