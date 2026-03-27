import { AuditLogModel } from "../models";

type AuditInput = {
  workspaceId?: string;
  conversationId?: string;
  messageId?: string;
  actorType: string;
  actorId?: string;
  eventType: string;
  reason?: string;
  confidence?: number;
  sourceHints?: string[];
  data?: Record<string, unknown>;
};

class AuditLogService {
  async record(input: AuditInput) {
    return AuditLogModel.create({
      ...input,
      sourceHints: input.sourceHints ?? [],
      data: input.data ?? {},
    });
  }

  async list(filters: {
    workspaceId: string;
    conversationId?: string;
    eventType?: string;
    limit?: number;
  }) {
    const query: Record<string, unknown> = {
      workspaceId: filters.workspaceId,
    };

    if (filters.conversationId) {
      query.conversationId = filters.conversationId;
    }

    if (filters.eventType) {
      query.eventType = filters.eventType;
    }

    return AuditLogModel.find(query)
      .sort({ createdAt: -1 })
      .limit(filters.limit ?? 25);
  }
}

export const auditLogService = new AuditLogService();
