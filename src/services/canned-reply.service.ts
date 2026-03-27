import { CannedReplyModel } from "../models";
import { OutboundContentBlock } from "./outbound-content.types";
import {
  deriveLegacyBodyFromBlocks,
  normalizeStoredOutboundBlocks,
} from "./outbound-content.utils";

export type NormalizedCannedReply = {
  _id: string;
  workspaceId: string;
  title: string;
  body: string;
  blocks: OutboundContentBlock[];
  triggers: string[];
  category: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

class CannedReplyService {
  private normalizeTriggers(triggers: string[]) {
    return [...new Set(
      triggers
        .map((trigger) => trigger.trim())
        .filter((trigger) => trigger.length > 0)
    )];
  }

  private toTextOnlyBlocks(body: string): OutboundContentBlock[] {
    const normalizedBody = body.trim();
    if (!normalizedBody) {
      return [];
    }

    return [
      {
        kind: "text",
        channel: "any",
        text: {
          body: normalizedBody,
          plain: normalizedBody,
        },
      },
    ];
  }

  private toResponse(item: {
    _id: unknown;
    workspaceId: unknown;
    title: string;
    body?: string;
    blocks?: unknown;
    triggers?: string[];
    category?: string;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }): NormalizedCannedReply {
    const normalizedBlocks = normalizeStoredOutboundBlocks({
      blocks: item.blocks,
      body: item.body,
    });
    const body = deriveLegacyBodyFromBlocks(normalizedBlocks);
    const blocks = this.toTextOnlyBlocks(body);

    return {
      _id: String(item._id),
      workspaceId: String(item.workspaceId),
      title: item.title,
      body,
      blocks,
      triggers: this.normalizeTriggers(item.triggers ?? []),
      category: item.category ?? "general",
      isActive: item.isActive ?? true,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async list(workspaceId: string) {
    const items = await CannedReplyModel.find({ workspaceId }).sort({ updatedAt: -1 }).lean();
    return items.map((item) => this.toResponse(item));
  }

  async listActive(workspaceId: string) {
    const items = await CannedReplyModel.find({
      workspaceId,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    return items.map((item) => this.toResponse(item));
  }

  async create(payload: {
    workspaceId: string;
    title: string;
    body?: string;
    blocks?: OutboundContentBlock[];
    triggers: string[];
    category: string;
  }) {
    const normalizedBlocks = normalizeStoredOutboundBlocks({
      blocks: payload.blocks,
      body: payload.body,
    });
    const body = deriveLegacyBodyFromBlocks(normalizedBlocks);
    const blocks = this.toTextOnlyBlocks(body);

    const item = await CannedReplyModel.create({
      ...payload,
      body,
      blocks,
      triggers: this.normalizeTriggers(payload.triggers),
    });

    return this.toResponse(item.toObject());
  }

  async getById(id: string) {
    const item = await CannedReplyModel.findById(id).lean();
    return item ? this.toResponse(item) : null;
  }

  async getByIdInWorkspace(id: string, workspaceId: string) {
    const item = await CannedReplyModel.findOne({ _id: id, workspaceId }).lean();
    return item ? this.toResponse(item) : null;
  }

  async update(
    id: string,
    patch: {
      title?: string;
      body?: string;
      blocks?: OutboundContentBlock[];
      triggers?: string[];
      category?: string;
      isActive?: boolean;
    }
  ) {
    const existing = await CannedReplyModel.findById(id);
    if (!existing) {
      return null;
    }

    const normalizedBlocks = normalizeStoredOutboundBlocks({
      blocks: patch.blocks ?? existing.blocks,
      body: patch.body ?? existing.body,
    });
    const body = deriveLegacyBodyFromBlocks(normalizedBlocks);
    const blocks = this.toTextOnlyBlocks(body);

    existing.set({
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.category ? { category: patch.category } : {}),
      ...(typeof patch.isActive === "boolean" ? { isActive: patch.isActive } : {}),
      ...(patch.triggers
        ? { triggers: this.normalizeTriggers(patch.triggers) }
        : {}),
      body,
      blocks,
    });

    await existing.save();
    return this.toResponse(existing.toObject());
  }

  async updateInWorkspace(
    id: string,
    workspaceId: string,
    patch: {
      title?: string;
      body?: string;
      blocks?: OutboundContentBlock[];
      triggers?: string[];
      category?: string;
      isActive?: boolean;
    }
  ) {
    const existing = await CannedReplyModel.findOne({ _id: id, workspaceId });
    if (!existing) {
      return null;
    }

    const normalizedBlocks = normalizeStoredOutboundBlocks({
      blocks: patch.blocks ?? existing.blocks,
      body: patch.body ?? existing.body,
    });
    const body = deriveLegacyBodyFromBlocks(normalizedBlocks);
    const blocks = this.toTextOnlyBlocks(body);

    existing.set({
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.category ? { category: patch.category } : {}),
      ...(typeof patch.isActive === "boolean" ? { isActive: patch.isActive } : {}),
      ...(patch.triggers
        ? { triggers: this.normalizeTriggers(patch.triggers) }
        : {}),
      body,
      blocks,
    });

    await existing.save();
    return this.toResponse(existing.toObject());
  }

  async remove(id: string) {
    return CannedReplyModel.findByIdAndDelete(id);
  }

  async removeInWorkspace(id: string, workspaceId: string) {
    return CannedReplyModel.findOneAndDelete({ _id: id, workspaceId });
  }
}

export const cannedReplyService = new CannedReplyService();
