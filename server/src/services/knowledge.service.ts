import { KnowledgeItemModel } from "../models";

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);

export type RankedKnowledgeItem = {
  title: string;
  content: string;
  tags: string[];
  score: number;
  topicKey: string;
};

export type KnowledgeBundle = {
  key: string;
  title: string;
  items: RankedKnowledgeItem[];
  sourceHints: string[];
};

class KnowledgeService {
  async list(workspaceId: string) {
    return KnowledgeItemModel.find({ workspaceId }).sort({ updatedAt: -1 });
  }

  async create(payload: {
    workspaceId: string;
    title: string;
    content: string;
    tags: string[];
  }) {
    return KnowledgeItemModel.create(payload);
  }

  async getById(id: string) {
    return KnowledgeItemModel.findById(id);
  }

  async update(
    id: string,
    patch: {
      title?: string;
      content?: string;
      tags?: string[];
      isActive?: boolean;
    }
  ) {
    return KnowledgeItemModel.findByIdAndUpdate(id, { $set: patch }, { new: true });
  }

  async remove(id: string) {
    return KnowledgeItemModel.findByIdAndDelete(id);
  }

  async findBestMatch(workspaceId: string, queryText: string) {
    const items = await KnowledgeItemModel.find({
      workspaceId,
      isActive: true,
    });

    const queryTokens = tokenize(queryText);
    if (!queryTokens.length) {
      return null;
    }

    let best:
      | {
          item: (typeof items)[number];
          confidence: number;
        }
      | null = null;

    for (const item of items) {
      const haystack = tokenize(`${item.title} ${item.content} ${item.tags.join(" ")}`);
      const titleAndTags = tokenize(`${item.title} ${item.tags.join(" ")}`);
      const overlap = queryTokens.filter((token) => haystack.includes(token)).length;
      const priorityOverlap = queryTokens.filter((token) =>
        titleAndTags.includes(token)
      ).length;
      const exactTitleMatch =
        item.title.toLowerCase().includes(queryText.toLowerCase()) ||
        queryText.toLowerCase().includes(item.title.toLowerCase());
      const confidence = exactTitleMatch
        ? 0.9
        : Math.max(
            overlap / queryTokens.length + 0.15,
            priorityOverlap / queryTokens.length + 0.2
          );
      if (!best || confidence > best.confidence) {
        best = { item, confidence };
      }
    }

    if (!best || best.confidence < 0.45) {
      return null;
    }

    return {
      kind: "knowledge" as const,
      confidence: Math.min(0.85, best.confidence + 0.15),
      sourceHints: [best.item.title],
      text: best.item.content,
    };
  }

  async selectRelevantBundles(
    workspaceId: string,
    queryText: string,
    options?: {
      maxItems?: number;
      maxBundles?: number;
    }
  ) {
    const items = await KnowledgeItemModel.find({
      workspaceId,
      isActive: true,
    }).lean();

    const queryTokens = tokenize(queryText);
    if (!queryTokens.length || !items.length) {
      return [] as KnowledgeBundle[];
    }

    const ranked = items
      .map((item) => this.rankKnowledgeItem(item, queryTokens))
      .filter((item) => item.score >= 0.28)
      .sort((a, b) => b.score - a.score);

    const selected = ranked.slice(0, options?.maxItems ?? 4);
    if (!selected.length) {
      return [];
    }

    const grouped = new Map<string, KnowledgeBundle>();

    for (const item of selected) {
      const existing = grouped.get(item.topicKey);
      if (existing) {
        existing.items.push(item);
        existing.sourceHints.push(item.title);
        continue;
      }

      grouped.set(item.topicKey, {
        key: item.topicKey,
        title: item.topicKey,
        items: [item],
        sourceHints: [item.title],
      });
    }

    return Array.from(grouped.values())
      .map((bundle) => ({
        ...bundle,
        items: bundle.items.sort((a, b) => b.score - a.score),
        sourceHints: Array.from(new Set(bundle.sourceHints)),
      }))
      .sort(
        (a, b) =>
          (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0) ||
          a.title.localeCompare(b.title)
      )
      .slice(0, options?.maxBundles ?? 3);
  }

  private rankKnowledgeItem(
    item: {
      title: string;
      content: string;
      tags: string[];
    },
    queryTokens: string[]
  ): RankedKnowledgeItem {
    const haystackTokens = tokenize(`${item.title} ${item.content} ${item.tags.join(" ")}`);
    const titleTokens = tokenize(item.title);
    const tagTokens = tokenize(item.tags.join(" "));

    const contentOverlap = queryTokens.filter((token) => haystackTokens.includes(token)).length;
    const titleOverlap = queryTokens.filter((token) => titleTokens.includes(token)).length;
    const tagOverlap = queryTokens.filter((token) => tagTokens.includes(token)).length;
    const exactTitleMatch =
      item.title.toLowerCase().includes(queryTokens.join(" ")) ||
      queryTokens.join(" ").includes(item.title.toLowerCase());

    const score = exactTitleMatch
      ? 1
      : Math.min(
          0.95,
          titleOverlap * 0.28 +
            tagOverlap * 0.24 +
            contentOverlap * 0.14 +
            (contentOverlap > 0 ? 0.12 : 0)
        );

    const overlappingTag =
      item.tags.find((tag) => queryTokens.some((token) => tag.toLowerCase().includes(token))) ??
      item.tags[0] ??
      item.title;

    return {
      title: item.title,
      content: item.content,
      tags: item.tags,
      score,
      topicKey: overlappingTag.trim() || "General",
    };
  }
}

export const knowledgeService = new KnowledgeService();
