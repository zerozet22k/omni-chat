import axios from "axios";
import { CanonicalMessage } from "../channels/types";
import { env } from "../config/env";
import { decryptField } from "../lib/crypto";
import { cannedReplyService } from "./canned-reply.service";
import { knowledgeService, KnowledgeBundle } from "./knowledge.service";
import { OutboundContentBlock } from "./outbound-content.types";
import { filterOutboundBlocksForChannel } from "./outbound-content.utils";

type AIAction = "send" | "review" | "handoff";

type AIContactUpdates = {
  phones?: string[];
  deliveryAddress?: string;
  aiNotes?: string;
};

type AIReplyResult =
  | {
    kind: "canned" | "knowledge";
    blocks: OutboundContentBlock[];
    text?: string;
    confidence: number;
    sourceHints: string[];
    reason: string;
    internalNote?: string;
    contactUpdates?: AIContactUpdates;
  }
  | {
    kind: "review";
    blocks: OutboundContentBlock[];
    text?: string;
    confidence: number;
    sourceHints: string[];
    reason: string;
    internalNote: string;
    contactUpdates?: AIContactUpdates;
  }
  | {
    kind: "unsupported" | "low_confidence" | "requires_human";
    confidence: number;
    sourceHints: string[];
    reason: string;
    internalNote?: string;
    draftBlocks?: OutboundContentBlock[];
    contactUpdates?: AIContactUpdates;
  };

class AIReplyService {
  async generateReply(params: {
    workspaceId: string;
    conversationId?: string;
    message: CanonicalMessage;
    channel: CanonicalMessage["channel"];
    recentMessages?: Array<{
      senderType: string;
      kind: string;
      text?: { body?: string };
      media?: Array<{ url?: string; filename?: string }>;
      meta?: Record<string, unknown>;
      createdAt: Date;
    }>;
    workspaceAiOverride?: {
      encryptedApiKey?: string;
      modelOverride?: string;
      assistantInstructions?: string;
    };
    contactProfile?: {
      primaryName?: string;
      phones?: string[];
      deliveryAddress?: string;
      notes?: string;
      aiNotes?: string;
    };
  }): Promise<AIReplyResult> {
    if (params.message.kind === "unsupported") {
      return {
        kind: "unsupported",
        confidence: 0,
        sourceHints: [],
        reason: "Unsupported inbound content requires human review",
      };
    }

    const incomingText = this.normalizeText(params.message.text?.body);
    const mediaContextText = this.buildMediaContextText(params.message);
    const retrievalText = incomingText || mediaContextText;

    if (!retrievalText) {
      return {
        kind: "requires_human",
        confidence: 0.2,
        sourceHints: [],
        reason: "Message has no text content to analyze. Human review recommended.",
      };
    }

    const [cannedReplies, knowledgeItems] = await Promise.all([
      cannedReplyService.listActive(params.workspaceId),
      knowledgeService.selectRelevantBundles(params.workspaceId, retrievalText, {
        maxItems: 8,
        maxBundles: 8,
        useEntireLibraryWhenTotalItemsAtMost: 24,
      }),
    ]);

    const cannedResult = this.tryCannedReply({
      incomingText: retrievalText,
      channel: params.channel,
      cannedReplies,
    });

    if (cannedResult) {
      return cannedResult;
    }

    const codexResult = await this.tryKnowledgeReply({
      incomingText,
      mediaContextText,
      conversationId: params.conversationId,
      recentMessages: params.recentMessages,
      knowledgeBundles: knowledgeItems,
      workspaceAiOverride: params.workspaceAiOverride,
      contactProfile: params.contactProfile,
    });

    if (
      (codexResult.kind === "knowledge" || codexResult.kind === "review") &&
      codexResult.blocks.length > 0
    ) {
      return codexResult;
    }

    return codexResult;
  }

  private tryCannedReply(params: {
    incomingText: string;
    channel: CanonicalMessage["channel"];
    cannedReplies: Array<{
      title: string;
      blocks: OutboundContentBlock[];
      triggers: string[];
    }>;
  }): AIReplyResult | null {
    for (const reply of params.cannedReplies) {
      const cleanedTriggers = this.normalizeTriggers(reply.triggers);

      const matchedTrigger = cleanedTriggers.find((trigger) =>
        this.matchesTrigger(params.incomingText, trigger)
      );

      if (matchedTrigger) {
        const compatibleBlocks = filterOutboundBlocksForChannel(
          reply.blocks,
          params.channel
        );

        if (!compatibleBlocks.length) {
          continue;
        }

        return {
          kind: "canned",
          blocks: compatibleBlocks,
          text:
            compatibleBlocks.find((block) => block.kind === "text")?.text?.body ?? undefined,
          confidence: 0.95,
          sourceHints: [reply.title],
          reason: `Matched canned reply trigger "${matchedTrigger}"`,
        };
      }
    }

    return null;
  }

  private async tryKnowledgeReply(params: {
    incomingText: string;
    mediaContextText: string;
    conversationId?: string;
    recentMessages?: Array<{
      senderType: string;
      kind: string;
      text?: { body?: string };
      media?: Array<{ url?: string; filename?: string }>;
      meta?: Record<string, unknown>;
      createdAt: Date;
    }>;
    knowledgeBundles: KnowledgeBundle[];
    workspaceAiOverride?: {
      encryptedApiKey?: string;
      modelOverride?: string;
      assistantInstructions?: string;
    };
    contactProfile?: {
      primaryName?: string;
      phones?: string[];
      deliveryAddress?: string;
      notes?: string;
      aiNotes?: string;
    };
  }): Promise<AIReplyResult> {
    const encryptionSecret = env.FIELD_ENCRYPTION_KEY || env.SESSION_SECRET;
    const workspaceDecryptedKey = params.workspaceAiOverride?.encryptedApiKey
      ? decryptField(params.workspaceAiOverride.encryptedApiKey, encryptionSecret)
      : "";

    const geminiApiKey = workspaceDecryptedKey.trim() || env.GEMINI_API_KEY.trim();
    const geminiModel =
      params.workspaceAiOverride?.modelOverride?.trim() ||
      env.GEMINI_MODEL.trim() ||
      "gemini-3.1-flash-lite-preview";

    if (!geminiApiKey) {
      return {
        kind: "low_confidence",
        confidence: 0.2,
        sourceHints: [],
        reason: "Workspace Gemini API key is not configured",
      };
    }

    try {
      console.log("[AI:gemini] calling model:", geminiModel);

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
        {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: this.buildAssistantPrompt({
                    incomingText: params.incomingText,
                    mediaContextText: params.mediaContextText,
                    recentMessages: params.recentMessages,
                    knowledgeBundles: params.knowledgeBundles,
                    assistantInstructions: params.workspaceAiOverride?.assistantInstructions,
                    contactProfile: params.contactProfile,
                  }),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        },
        {
          headers: {
            "x-goog-api-key": geminiApiKey,
            "Content-Type": "application/json",
          },
        }
      );

      const result = this.parseAssistantResult(response.data);
      const messageBlocks = this.buildTextBlocks(result.messages);
      const combinedText = this.combineMessages(result.messages);

      if (result.action === "review" && messageBlocks.length) {
        return {
          kind: "review",
          blocks: messageBlocks,
          text: combinedText || undefined,
          confidence: result.confidence,
          sourceHints: result.sourceHints,
          reason: result.reason || "Gemini prepared a draft reply that should be verified by a human",
          internalNote:
            result.internalNote ||
            "Please review this draft before sending it to the customer.",
          contactUpdates: result.contactUpdates,
        };
      }

      if (result.action === "handoff") {
        return {
          kind: "requires_human",
          confidence: result.confidence,
          sourceHints: result.sourceHints,
          reason: result.reason || "Gemini recommended human handling",
          internalNote: result.internalNote || undefined,
          draftBlocks: messageBlocks.length ? messageBlocks : undefined,
          contactUpdates: result.contactUpdates,
        };
      }

      if (!messageBlocks.length) {
        return {
          kind: "low_confidence",
          confidence: 0.2,
          sourceHints: [],
          reason: result.reason || "Gemini did not return a usable reply",
          internalNote: result.internalNote || undefined,
          contactUpdates: result.contactUpdates,
        };
      }

      return {
        kind: "knowledge",
        blocks: messageBlocks,
        text: combinedText || undefined,
        confidence: result.confidence,
        sourceHints: result.sourceHints,
        reason: result.reason || "Gemini generated a reply from provided context",
        internalNote: result.internalNote || undefined,
        contactUpdates: result.contactUpdates,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("[AI:gemini] error response:", error.response?.data);
      } else {
        console.error("[AI:gemini] error:", error);
      }

      return {
        kind: "low_confidence",
        confidence: 0.2,
        sourceHints: [],
        reason:
          error instanceof Error ? `Gemini request failed: ${error.message}` : "Gemini request failed",
      };
    }
  }

  private buildWorkspaceInstructionSection(assistantInstructions?: string) {
    const lines = assistantInstructions
      ?.split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    return [
      "Workspace operating instructions:",
      ...(lines?.length
        ? lines
        : [
          "[None provided. Stay neutral, avoid assumptions, and use review or handoff when workspace-specific policy is required.]",
        ]),
    ];
  }
  private buildAssistantPrompt(params: {
    incomingText: string;
    mediaContextText: string;
    recentMessages?: Array<{
      senderType: string;
      kind: string;
      text?: { body?: string };
      media?: Array<{ url?: string; filename?: string }>;
      meta?: Record<string, unknown>;
      createdAt: Date;
    }>;
    knowledgeBundles: KnowledgeBundle[];
    assistantInstructions?: string;
    contactProfile?: {
      primaryName?: string;
      phones?: string[];
      deliveryAddress?: string;
      notes?: string;
      aiNotes?: string;
    };
  }) {
    const historyLines = (params.recentMessages ?? []).map((message) => {
      let content = "";
      if (message.kind === "text") {
        content = message.text?.body ?? "";
      } else if (message.kind === "interactive") {
        content = message.text?.body ?? "[Interactive]";
      } else if (message.kind === "image") {
        content = "[Image]";
      } else if (message.kind === "video") {
        content = "[Video]";
      } else if (message.kind === "audio") {
        content = "[Audio]";
      } else if (message.kind === "file") {
        content = "[File]";
      } else if (message.kind === "location") {
        content = "[Location]";
      } else if (message.kind === "contact") {
        content = "[Contact]";
      } else if (message.kind === "sticker") {
        const meta = message.meta ?? {};
        const keywords = Array.isArray(meta.lineStickerKeywords)
          ? (meta.lineStickerKeywords as string[]).filter(Boolean).slice(0, 6).join(", ")
          : "";
        const packTitle =
          typeof meta.lineStickerPackTitle === "string" ? meta.lineStickerPackTitle : "";
        const emoji = message.text?.body?.trim() ?? "";
        if (keywords) {
          content = packTitle
            ? `[Sticker expressing: "${keywords}" (${packTitle})]`
            : `[Sticker expressing: "${keywords}"]`;
        } else if (emoji) {
          content = `[Sticker: ${emoji}]`;
        } else {
          content = "[Sticker]";
        }
      } else {
        content = "[Unsupported]";
      }

      const speaker =
        message.senderType === "customer"
          ? "customer"
          : message.senderType === "agent"
            ? "agent"
            : message.senderType === "automation"
              ? "automation"
              : message.senderType === "ai"
                ? "ai"
                : "system";

      return `- ${speaker}: ${content}`;
    });

    const contactProfileLines = this.buildContactProfileLines(params.contactProfile);

    return [
      "You are Gemini, the inbox assistant.",
      ...this.buildWorkspaceInstructionSection(params.assistantInstructions),
      "",
      "Core protocol:",
      "Use only the context blocks in this prompt.",
      "Ground factual claims in the provided context. Do not invent or assume facts that are not present.",
      "Prefer the exact wording and facts from the most relevant knowledge library matches when available.",
      "If knowledge matches conflict, prefer the most specific and most directly relevant match.",
      "Do not claim to have inspected attachment contents unless the attachment context explicitly describes them.",
      "Do not invent prices, grades, subjects, policies, promotions, warranty terms, payment confirmation, verification results, delivery progress, or fulfillment status.",
      "If the customer explicitly provides reusable profile details such as phone number, delivery address, or stable preferences, capture them in contactUpdates.",
      "Use aiNotes only for a short reusable internal memory grounded in customer-provided details.",
      "Keep customer-facing messages concise, helpful, warm, and ready to send.",
      "Prefer a single customer-facing message. Split into multiple messages only when it clearly improves clarity.",
      "Do not mention AI, bot, automation, prompt, memory, internal logic, developer mode, testing mode, or system behavior in customer-facing messages.",
      "Do not explain an earlier message as being caused by automation, AI behavior, system logic, or memory.",
      "If the customer asks a meta question about an earlier confusing message, apologize briefly and provide only the current customer-facing status or next step.",
      "If the current customer message indicates payment, receipt submission, transfer proof, or a payment confirmation request, and the provided context does not explicitly confirm verification, do not assume payment is verified.",
      "In that case, prefer a short send-ready reply stating that staff will check and confirm.",
      "Do not claim fulfillment, delivery, sending, preparation, scheduling, or completion unless the provided context explicitly states that.",
      "When payment or verification is staff-dependent but a safe waiting message can be written from the provided context, prefer action 'send' over 'review'.",
      "Use action 'send' for a safe send-ready reply.",
      "Use action 'review' when a staff-ready draft can be created but a human should verify or approve it before sending.",
      "Use action 'handoff' when no responsible draft can be created from the provided context.",
      "When action is 'review' or 'handoff', internalNote must tell staff exactly what to verify, decide, or do next.",
      "Return strict JSON with keys: action, messages, confidence, sourceHints, reason, internalNote, contactUpdates.",
      'action must be one of: "send", "review", "handoff".',
      'messages must be an array of 0 to 3 non-empty strings, each suitable to send as a separate chat message.',
      'Use 0 messages only when action is "handoff" and no safe draft should be suggested.',
      'internalNote must be a short staff-facing note when action is "review" or "handoff". Return an empty string when action is "send".',
      'sourceHints should list the most relevant knowledge titles used when available.',
      'contactUpdates must be an object. Use only these optional keys when they are explicitly supported by the context: phones, deliveryAddress, aiNotes.',
      'Use an empty object for contactUpdates when no profile update is warranted.',
      "",
      "Context type: recent conversation history",
      ...(historyLines.length ? historyLines : ["- [No recent history]"]),
      "",
      "Context type: customer profile",
      ...contactProfileLines,
      "",
      "Context type: current customer message",
      `- Text: ${params.incomingText || "[No text provided]"}`,
      `- Attachment context: ${params.mediaContextText || "[No attachment context]"}`,
      "",
      "Context type: knowledge library matches",
      ...(params.knowledgeBundles.length
        ? params.knowledgeBundles.flatMap((bundle, index) => [
          `${index + 1}. Knowledge library bundle: ${bundle.title}`,
          ...bundle.items.map(
            (item, itemIndex) =>
              `   ${itemIndex + 1}) ${item.title}\n   Tags: ${item.tags.join(", ")}\n   Score: ${item.score.toFixed(2)}\n   ${item.content}`
          ),
        ])
        : ["[No strongly relevant active knowledge library matches were found for this message]"]),
      "",
      "Respond only with valid JSON and make the response suitable for customer messaging.",
    ].join("\n");
  }

  private parseAssistantResult(data: unknown) {
    const rawText =
      (data as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      }).candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";

    if (!rawText) {
      return {
        action: "handoff" as const,
        messages: [] as string[],
        confidence: 0.2,
        sourceHints: [] as string[],
        reason: "Gemini returned an empty response",
        internalNote: "",
        contactUpdates: undefined,
      };
    }

    const normalized = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      const parsed = JSON.parse(normalized) as {
        action?: AIAction;
        messages?: string[];
        replyText?: string;
        confidence?: number;
        sourceHints?: string[];
        reason?: string;
        internalNote?: string;
        contactUpdates?: {
          phones?: unknown;
          deliveryAddress?: unknown;
          aiNotes?: unknown;
        };
      };

      const messages = Array.isArray(parsed.messages)
        ? parsed.messages
        : typeof parsed.replyText === "string"
          ? [parsed.replyText]
          : [];

      const action: AIAction =
        parsed.action === "send" ||
          parsed.action === "review" ||
          parsed.action === "handoff"
          ? parsed.action
          : messages.length > 0
            ? "send"
            : "handoff";

      const contactUpdates = this.normalizeContactUpdates(parsed.contactUpdates);

      return {
        action,
        messages: messages
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0)
          .slice(0, 3),
        confidence:
          typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.75,
        sourceHints: Array.isArray(parsed.sourceHints)
          ? parsed.sourceHints.map((item) => String(item))
          : [],
        reason: parsed.reason ?? "Gemini generated a reply from provided context",
        internalNote:
          typeof parsed.internalNote === "string" ? parsed.internalNote.trim() : "",
        contactUpdates,
      };
    } catch {
      return {
        action: "handoff" as const,
        messages: [] as string[],
        confidence: 0.2,
        sourceHints: [] as string[],
        reason: "Gemini response was not valid JSON",
        internalNote: "",
        contactUpdates: undefined,
      };
    }
  }

  private buildTextBlocks(messages: string[]) {
    const combined = this.combineMessages(messages);
    if (!combined) {
      return [];
    }

    return [
      {
        kind: "text" as const,
        text: {
          body: combined,
          plain: combined,
        },
      },
    ];
  }

  private combineMessages(messages: string[]) {
    return messages.map((message) => message.trim()).filter(Boolean).join("\n\n").trim();
  }

  private buildContactProfileLines(profile?: {
    primaryName?: string;
    phones?: string[];
    deliveryAddress?: string;
    notes?: string;
    aiNotes?: string;
  }) {
    const lines = [
      profile?.primaryName?.trim() ? `- Name: ${profile.primaryName.trim()}` : null,
      profile?.phones?.length ? `- Phones: ${profile.phones.join(", ")}` : null,
      profile?.deliveryAddress?.trim()
        ? `- Delivery address: ${profile.deliveryAddress.trim()}`
        : null,
      profile?.notes?.trim() ? `- Team notes: ${profile.notes.trim()}` : null,
      profile?.aiNotes?.trim() ? `- AI memory: ${profile.aiNotes.trim()}` : null,
    ].filter((line): line is string => !!line);

    return lines.length ? lines : ["- [No stored customer profile details]"];
  }

  private normalizeContactUpdates(value: {
    phones?: unknown;
    deliveryAddress?: unknown;
    aiNotes?: unknown;
  } | undefined): AIContactUpdates | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const updates: AIContactUpdates = {};

    if (Array.isArray(value.phones)) {
      const phones = [
        ...new Set(
          value.phones
            .map((item) => String(item).replace(/\s+/g, " ").trim())
            .filter((item) => item.length > 0)
        ),
      ];
      if (phones.length) {
        updates.phones = phones;
      }
    }

    if (typeof value.deliveryAddress === "string" && value.deliveryAddress.trim()) {
      updates.deliveryAddress = value.deliveryAddress.trim();
    }

    if (typeof value.aiNotes === "string" && value.aiNotes.trim()) {
      updates.aiNotes = value.aiNotes.trim();
    }

    return Object.keys(updates).length ? updates : undefined;
  }

  private normalizeText(value?: string | null) {
    return (value ?? "").trim().toLowerCase();
  }

  private buildMediaContextText(message: CanonicalMessage) {
    if (!["image", "video", "file"].includes(message.kind)) {
      return "";
    }

    const firstMedia = message.media?.[0];
    const filename = firstMedia?.filename?.trim() ?? "";
    const mimeType = firstMedia?.mimeType?.toLowerCase() ?? "";
    const raw = (message.raw as Record<string, unknown> | undefined) ?? {};
    const hasText = this.normalizeText(message.text?.body).length > 0;
    const contextSuffix = hasText ? " alongside their text message" : " without any text";

    const isTelegramAnimation =
      message.channel === "telegram" &&
      typeof raw.animation === "object" &&
      raw.animation !== null;

    const looksGifByName = /\.gif$/i.test(filename);
    const looksAnimationByName = /\.(gif|mp4|webm)$/i.test(filename);
    const looksGifByMime = mimeType.includes("gif");

    if (isTelegramAnimation || looksGifByName || looksGifByMime) {
      if (filename) {
        return this.normalizeText(
          `customer sent an animation file named ${filename}${contextSuffix}`
        );
      }
      return this.normalizeText(`customer sent an animation gif${contextSuffix}`);
    }

    if (looksAnimationByName && message.kind === "video") {
      return this.normalizeText(
        `customer sent a short animation video named ${filename}${contextSuffix}`
      );
    }

    if (message.kind === "image") {
      if (filename) {
        return this.normalizeText(
          `customer sent an image attachment named ${filename}${contextSuffix}`
        );
      }
      return this.normalizeText(`customer sent an image attachment${contextSuffix}`);
    }

    if (message.kind === "video") {
      if (filename) {
        return this.normalizeText(
          `customer sent a video attachment named ${filename}${contextSuffix}`
        );
      }
      return this.normalizeText(`customer sent a video attachment${contextSuffix}`);
    }

    if (filename) {
      return this.normalizeText(
        `customer sent a file attachment named ${filename}${contextSuffix}`
      );
    }

    return this.normalizeText(`customer sent a file attachment${contextSuffix}`);
  }

  private normalizeTriggers(triggers: string[]) {
    return [
      ...new Set(
        triggers
          .map((trigger) => this.normalizeText(trigger))
          .filter((trigger) => trigger.length > 0)
      ),
    ];
  }

  private matchesTrigger(incomingText: string, trigger: string) {
    if (!trigger) {
      return false;
    }

    if (incomingText === trigger) {
      return true;
    }

    const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escapedTrigger}\\b`, "i");
    return regex.test(incomingText);
  }
}

export const aiReplyService = new AIReplyService();
