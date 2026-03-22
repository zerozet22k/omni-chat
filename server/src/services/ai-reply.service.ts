import axios from "axios";
import { CanonicalMessage } from "../channels/types";
import { env } from "../config/env";
import { decryptField } from "../lib/crypto";
import { cannedReplyService } from "./canned-reply.service";
import { knowledgeService, KnowledgeBundle } from "./knowledge.service";
import { OutboundContentBlock } from "./outbound-content.types";
import { filterOutboundBlocksForChannel } from "./outbound-content.utils";

type AIReplyResult =
  | {
      kind: "canned" | "knowledge";
      blocks: OutboundContentBlock[];
      confidence: number;
      sourceHints: string[];
      reason: string;
    }
  | {
      kind: "unsupported" | "low_confidence" | "requires_human";
      confidence: number;
      sourceHints: string[];
      reason: string;
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
      createdAt: Date;
    }>;
    /**
     * Optional workspace-owned Gemini credentials.
     * `encryptedApiKey` is the value from AISettings.geminiApiKey (stored encrypted).
     * `modelOverride` is the plain workspace model name override.
     * When provided, these take priority over deployment-level env vars.
     */
    workspaceAiOverride?: {
      encryptedApiKey?: string;
      modelOverride?: string;
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
    const inferredMediaText = this.buildMediaIntentText(params.message);
    const effectiveIncomingText = incomingText || inferredMediaText;
    
    // If message has media but no text, escalate to human (no vision processing to save costs)
    if (!effectiveIncomingText && ["image", "video", "file"].includes(params.message.kind)) {
      return {
        kind: "requires_human",
        confidence: 0.4,
        sourceHints: [],
        reason: `Message contains ${params.message.kind} without text context. Human review needed.`,
      };
    }

    // If no text and not media, cannot process
    if (!effectiveIncomingText) {
      return {
        kind: "requires_human",
        confidence: 0.2,
        sourceHints: [],
        reason: "Message has no text content to analyze. Human review recommended.",
      };
    }

    const [cannedReplies, knowledgeItems] = await Promise.all([
      cannedReplyService.listActive(params.workspaceId),
      knowledgeService.selectRelevantBundles(params.workspaceId, effectiveIncomingText, {
        maxItems: 4,
        maxBundles: 3,
      }),
    ]);

    const cannedResult = this.tryCannedReply({
      incomingText: effectiveIncomingText,
      channel: params.channel,
      cannedReplies,
    });

    if (cannedResult) {
      return cannedResult;
    }

    const geminiResult = await this.tryKnowledgeReply({
      incomingText: effectiveIncomingText,
      conversationId: params.conversationId,
      recentMessages: params.recentMessages,
      knowledgeBundles: knowledgeItems,
      workspaceAiOverride: params.workspaceAiOverride,
    });

    if (
      geminiResult.kind === "knowledge" &&
      geminiResult.blocks.length > 0
    ) {
      return geminiResult;
    }

    return {
      kind: "requires_human",
      confidence: 0.3,
      sourceHints: [],
      reason: geminiResult.reason || "AI confidence is too low. Escalating to human agent for review.",
    };
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
    conversationId?: string;
    recentMessages?: Array<{
      senderType: string;
      kind: string;
      text?: { body?: string };
      media?: Array<{ url?: string; filename?: string }>;
      createdAt: Date;
    }>;
    knowledgeBundles: KnowledgeBundle[];
    workspaceAiOverride?: {
      encryptedApiKey?: string;
      modelOverride?: string;
    };
  }): Promise<AIReplyResult> {
    // Resolve API key from workspace-owned settings only.
    const encryptionSecret = env.FIELD_ENCRYPTION_KEY || env.SESSION_SECRET;
    const workspaceDecryptedKey = params.workspaceAiOverride?.encryptedApiKey
      ? decryptField(params.workspaceAiOverride.encryptedApiKey, encryptionSecret)
      : "";

    const geminiApiKey = workspaceDecryptedKey.trim();

    // Resolve model: workspace override → deployment env → built-in default.
    const geminiModel =
      (params.workspaceAiOverride?.modelOverride?.trim() ||
        env.GEMINI_MODEL?.trim() ||
        "gemini-2.0-flash-lite");

    if (!geminiApiKey) {
      return {
        kind: "low_confidence",
        confidence: 0.2,
        sourceHints: [],
        reason: "Workspace Gemini API key is not configured",
      };
    }

    try {
      console.log("[AI] calling Gemini with model:", geminiModel);

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
        {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: this.buildGeminiPrompt({
                    incomingText: params.incomingText,
                    recentMessages: params.recentMessages,
                    knowledgeBundles: params.knowledgeBundles,
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

      const result = this.parseGeminiResult(response.data);

      if (!result.messages.length) {
        return {
          kind: "low_confidence",
          confidence: 0.2,
          sourceHints: [],
          reason: result.reason || "Gemini did not return a usable reply",
        };
      }

      return {
        kind: "knowledge",
        blocks: result.messages.map((message) => ({
          kind: "text" as const,
          text: {
            body: message,
            plain: message,
          },
        })),
        confidence: result.confidence,
        sourceHints: result.sourceHints,
        reason: result.reason || "Gemini generated a reply from provided context",
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("[AI] Gemini error response:", error.response?.data);
      } else {
        console.error("[AI] Gemini error:", error);
      }

      return {
        kind: "low_confidence",
        confidence: 0.2,
        sourceHints: [],
        reason:
          error instanceof Error
            ? `Gemini request failed: ${error.message}`
            : "Gemini request failed",
      };
    }
  }

  private buildGeminiPrompt(params: {
    incomingText: string;
    recentMessages?: Array<{
      senderType: string;
      kind: string;
      text?: { body?: string };
      media?: Array<{ url?: string; filename?: string }>;
      createdAt: Date;
    }>;
    knowledgeBundles: KnowledgeBundle[];
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

    return [
      "You are assisting an ecommerce seller inbox.",
      "Use only the provided context items and recent conversation history.",
      "Do not invent products, prices, shipping timelines, or policies.",
      "If business-specific context is missing, you may still send a short safe reply, acknowledge the message, or ask one clarifying question.",
      "Do not claim facts that are not present in the conversation or knowledge items.",
      "Keep the reply concise, customer-friendly, and directly useful.",
      "You may return 1 to 3 short customer-facing messages when that is clearer than one long paragraph.",
      'Return strict JSON with keys: messages, confidence, sourceHints, reason.',
      'messages must be an array of 1 to 3 non-empty strings, each suitable to send as a separate chat message.',
      "",
      "Recent conversation history:",
      ...(historyLines.length ? historyLines : ["- [No recent history]"]),
      "",
      `Customer message: ${params.incomingText}`,
      "",
      "Ranked knowledge bundles:",
      ...(params.knowledgeBundles.length
        ? params.knowledgeBundles.flatMap((bundle, index) => [
            `${index + 1}. Bundle: ${bundle.title}`,
            ...bundle.items.map(
              (item, itemIndex) =>
                `   ${itemIndex + 1}) ${item.title}\n   Tags: ${item.tags.join(", ")}\n   Score: ${item.score.toFixed(2)}\n   ${item.content}`
            ),
          ])
        : ["[No strongly relevant active knowledge items were found for this message]"]),
      "",
      "Respond only with valid JSON and make the response suitable for customer messaging.",
    ].join("\n");
  }

  private parseGeminiResult(data: unknown) {
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
        messages: [] as string[],
        confidence: 0.2,
        sourceHints: [] as string[],
        reason: "Gemini returned an empty response",
      };
    }

    const normalized = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      const parsed = JSON.parse(normalized) as {
        messages?: string[];
        confidence?: number;
        sourceHints?: string[];
        reason?: string;
      };

      return {
        messages: Array.isArray(parsed.messages)
          ? parsed.messages
              .map((item) => String(item).trim())
              .filter((item) => item.length > 0)
              .slice(0, 3)
          : [],
        confidence:
          typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.75,
        sourceHints: Array.isArray(parsed.sourceHints)
          ? parsed.sourceHints.map((item) => String(item))
          : [],
        reason: parsed.reason ?? "Gemini generated a reply from provided context",
      };
    } catch {
      return {
        messages: [] as string[],
        confidence: 0.2,
        sourceHints: [] as string[],
        reason: "Gemini response was not valid JSON",
      };
    }
  }

  private normalizeText(value?: string | null) {
    return (value ?? "").trim().toLowerCase();
  }

  private buildMediaIntentText(message: CanonicalMessage) {
    if (!["image", "video", "file"].includes(message.kind)) {
      return "";
    }

    const firstMedia = message.media?.[0];
    const filename = firstMedia?.filename?.trim() ?? "";
    const mimeType = firstMedia?.mimeType?.toLowerCase() ?? "";
    const raw = (message.raw as Record<string, unknown> | undefined) ?? {};

    const isTelegramAnimation =
      message.channel === "telegram" &&
      typeof raw.animation === "object" &&
      raw.animation !== null;

    const looksGifByName = /\.gif$/i.test(filename);
    const looksAnimationByName = /\.(gif|mp4|webm)$/i.test(filename);
    const looksGifByMime = mimeType.includes("gif");

    if (isTelegramAnimation || looksGifByName || looksGifByMime) {
      if (filename) {
        return this.normalizeText(`customer sent an animation file named ${filename}`);
      }
      return this.normalizeText("customer sent an animation gif");
    }

    if (looksAnimationByName && message.kind === "video") {
      return this.normalizeText(`customer sent a short animation video named ${filename}`);
    }

    return "";
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
