import {
  AISettingsModel,
  AutomationRuleModel,
  BusinessHoursModel,
} from "../models";
import { CanonicalMessage } from "../channels/types";
import { aiReplyService } from "./ai-reply.service";
import { auditLogService } from "./audit-log.service";
import { conversationService } from "./conversation.service";
import { messageService } from "./message.service";
import { outboundContentExecutorService } from "./outbound-content-executor.service";

const weekdayMap: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const getLocalDayAndTime = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";

  return {
    dayOfWeek: weekdayMap[weekday] ?? 0,
    minutes: Number(hour) * 60 + Number(minute),
  };
};

const toMinutes = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

class AutomationService {
  private async recordSkip(params: {
    workspaceId: string;
    conversationId: string;
    reason: string;
    data?: Record<string, unknown>;
  }) {
    await auditLogService.record({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      actorType: "automation",
      eventType: "automation.decision.skipped",
      reason: params.reason,
      data: params.data,
    });
  }

  async handleInbound(params: {
    workspaceId: string;
    conversationId: string;
    message: CanonicalMessage;
  }) {
    if (
      params.message.direction !== "inbound" ||
      params.message.senderType !== "customer"
    ) {
      await this.recordSkip({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        reason: "Inbound message is not customer-originated",
        data: {
          direction: params.message.direction,
          senderType: params.message.senderType,
        },
      });
      return;
    }

    const [aiSettings, businessHours, afterHoursRule, conversation] =
      await Promise.all([
        AISettingsModel.findOne({ workspaceId: params.workspaceId }),
        BusinessHoursModel.findOne({ workspaceId: params.workspaceId }),
        AutomationRuleModel.findOne({
          workspaceId: params.workspaceId,
          type: "after_hours_auto_reply",
          isActive: true,
        }),
        conversationService.getById(params.conversationId),
      ]);

    if (!conversation || !conversation.aiEnabled) {
      await this.recordSkip({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        reason: !conversation
          ? "Conversation not found for automation"
          : "Conversation AI disabled",
      });
      return;
    }

    if (
      conversation.aiState === "human_requested" ||
      conversation.aiState === "human_active"
    ) {
      await this.recordSkip({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        reason: "Conversation is in human-handoff state",
        data: {
          aiState: conversation.aiState,
        },
      });
      return;
    }

    const effectiveEnabled = aiSettings?.enabled ?? true;
    const effectiveAutoReplyEnabled = aiSettings?.autoReplyEnabled ?? true;
    const effectiveConfidenceThreshold = aiSettings?.confidenceThreshold ?? 0.7;

    if (!effectiveEnabled || !effectiveAutoReplyEnabled) {
      await this.recordSkip({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        reason: "Workspace AI auto-reply is disabled",
        data: {
          enabled: effectiveEnabled,
          autoReplyEnabled: effectiveAutoReplyEnabled,
        },
      });
      return;
    }

    const inboundOccurredAt = params.message.occurredAt ?? new Date();
    let isOutsideBusinessHours = false;

    if (businessHours) {
      const local = getLocalDayAndTime(inboundOccurredAt, businessHours.timeZone);
      const dayConfig = businessHours.weeklySchedule.find(
        (day) => day.dayOfWeek === local.dayOfWeek
      );

      const withinBusinessHours =
        !!dayConfig?.enabled &&
        dayConfig.windows.some((window) => {
          const start = toMinutes(window.start);
          const end = toMinutes(window.end);
          return local.minutes >= start && local.minutes <= end;
        });

      isOutsideBusinessHours = !withinBusinessHours;
    }

    if (isOutsideBusinessHours && !afterHoursRule) {
      await this.recordSkip({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        reason: "Outside business hours but no active after-hours rule",
        data: {
          outsideBusinessHours: true,
        },
      });
      return;
    }

    const recentMessages = await messageService.listRecentCanonicalByConversation(
      params.conversationId,
      12
    );

    const suggestion = await aiReplyService.generateReply({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      message: params.message,
      channel: conversation.channel,
      recentMessages,
      workspaceAiOverride: aiSettings
        ? {
            encryptedApiKey: aiSettings.geminiApiKey || undefined,
            modelOverride: aiSettings.geminiModel || undefined,
          }
        : undefined,
    });


    await auditLogService.record({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      actorType: "automation",
      eventType: "automation.decision.evaluated",
      reason: suggestion.reason,
      confidence: suggestion.confidence,
      sourceHints: suggestion.sourceHints,
      data: {
        decisionKind: suggestion.kind,
        messageKind: params.message.kind,
        outsideBusinessHours: isOutsideBusinessHours,
      },
    });

    if (
      suggestion.kind === "unsupported" ||
      suggestion.kind === "requires_human" ||
      suggestion.confidence < effectiveConfidenceThreshold
    ) {
      // Outside business hours with an active fallback text → send it instead of human handoff.
      if (isOutsideBusinessHours && afterHoursRule) {
        const fallbackText =
          typeof (afterHoursRule.action as { fallbackText?: string })?.fallbackText === "string"
            ? (afterHoursRule.action as { fallbackText: string }).fallbackText
            : null;

        if (fallbackText) {
          const replyOccurredAt = new Date(inboundOccurredAt.getTime() + 1000);
          const result = await outboundContentExecutorService.sendBlocks({
            conversationId: params.conversationId,
            senderType: "automation",
            blocks: [
              {
                kind: "text",
                text: { body: fallbackText, plain: fallbackText },
              },
            ],
            meta: { automationRuleId: String(afterHoursRule._id), sourceHints: [] },
            source: "automation",
            occurredAt: replyOccurredAt,
          });
          const finalMessage = result.messages[result.messages.length - 1];

          await auditLogService.record({
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
            messageId: finalMessage ? String(finalMessage._id) : undefined,
            actorType: "automation",
            eventType: "automation.reply.sent",
            reason: "Sent after-hours fallback text (AI confidence too low)",
            confidence: suggestion.confidence,
            sourceHints: suggestion.sourceHints,
            data: {
              messageIds: result.messages.map((message) => String(message._id)),
              ruleId: String(afterHoursRule._id),
              replyType: "after_hours_fallback",
              outsideBusinessHours: true,
            },
          });
          return;
        }
      }

      await conversationService.requestHumanHandoff(params.conversationId);

      await auditLogService.record({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        actorType: "automation",
        eventType: "automation.handoff.requested",
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        sourceHints: suggestion.sourceHints,
        data: {
          messageKind: params.message.kind,
          ruleId: afterHoursRule ? String(afterHoursRule._id) : undefined,
          outsideBusinessHours: isOutsideBusinessHours,
          escalationReason: suggestion.kind === "requires_human" ? "Media or high-risk content requires human handling" : undefined,
        },
      });
      return;
    }

    if (!(suggestion.kind === "canned" || suggestion.kind === "knowledge")) {
      return;
    }

    const replyOccurredAt = new Date(inboundOccurredAt.getTime() + 1000);

    const result = await outboundContentExecutorService.sendBlocks({
      conversationId: params.conversationId,
      senderType: "automation",
      blocks: suggestion.blocks,
      meta: {
        automationRuleId: afterHoursRule ? String(afterHoursRule._id) : undefined,
        sourceHints: suggestion.sourceHints,
      },
      source: "automation",
      occurredAt: replyOccurredAt,
    });
    const finalMessage = result.messages[result.messages.length - 1];

    await conversationService.setAIState(
      params.conversationId,
      "auto_replied"
    );

    await auditLogService.record({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: finalMessage ? String(finalMessage._id) : undefined,
      actorType: "automation",
      eventType: "automation.reply.sent",
      reason: suggestion.reason,
      confidence: suggestion.confidence,
      sourceHints: suggestion.sourceHints,
      data: {
        messageIds: result.messages.map((message) => String(message._id)),
        blockKinds: suggestion.blocks.map((block) => block.kind),
        ruleId: afterHoursRule ? String(afterHoursRule._id) : undefined,
        replyType: suggestion.kind,
        outsideBusinessHours: isOutsideBusinessHours,
      },
    });
  }
}

export const automationService = new AutomationService();
