import { KnowledgeItemModel } from "../models";

const BURMESE_VARIANT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\u1005\u103b\u1031\u1038/gu, "\u1008\u1031\u1038"],
];
const PRICE_INTENT_SIGNALS = [
  "price",
  "how much",
  "\u1008\u1031\u1038",
  "\u1018\u101a\u103a\u101c\u1031\u102c\u1000\u103a",
];

export const normalizeKnowledgeText = (value: string) => {
  const lowered = value.toLowerCase().normalize("NFKC");
  const canonicalized = BURMESE_VARIANT_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    lowered
  );

  return canonicalized
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const compactKnowledgeText = (value: string) =>
  normalizeKnowledgeText(value).replace(/\s+/g, "");

export const tokenizeKnowledgeText = (value: string) =>
  normalizeKnowledgeText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 || /\p{N}/u.test(token));

const buildCharacterNgrams = (value: string) => {
  const compact = compactKnowledgeText(value);
  const characters = Array.from(compact);

  if (!characters.length) {
    return new Set<string>();
  }

  const sizes = characters.length >= 3 ? [2, 3] : [characters.length];
  const ngrams = new Set<string>();

  for (const size of sizes) {
    if (characters.length < size) {
      continue;
    }

    for (let index = 0; index <= characters.length - size; index += 1) {
      ngrams.add(characters.slice(index, index + size).join(""));
    }
  }

  if (!ngrams.size) {
    ngrams.add(characters.join(""));
  }

  return ngrams;
};

const computeTokenOverlapRatio = (queryTokens: string[], candidateTokens: string[]) => {
  if (!queryTokens.length || !candidateTokens.length) {
    return 0;
  }

  const candidateSet = new Set(candidateTokens);
  const overlap = queryTokens.filter((token) => candidateSet.has(token)).length;

  return overlap / queryTokens.length;
};

export const computeKnowledgePhraseScore = (
  queryText: string,
  candidateText: string
) => {
  const queryCompact = compactKnowledgeText(queryText);
  const candidateCompact = compactKnowledgeText(candidateText);

  if (!queryCompact || !candidateCompact) {
    return 0;
  }

  if (queryCompact === candidateCompact) {
    return 1;
  }

  if (
    queryCompact.includes(candidateCompact) ||
    candidateCompact.includes(queryCompact)
  ) {
    const shorterLength = Math.min(queryCompact.length, candidateCompact.length);
    const longerLength = Math.max(queryCompact.length, candidateCompact.length);
    return Math.min(0.96, 0.78 + (shorterLength / longerLength) * 0.18);
  }

  const queryNgrams = buildCharacterNgrams(queryCompact);
  const candidateNgrams = buildCharacterNgrams(candidateCompact);

  if (!queryNgrams.size || !candidateNgrams.size) {
    return 0;
  }

  let overlap = 0;
  for (const ngram of candidateNgrams) {
    if (queryNgrams.has(ngram)) {
      overlap += 1;
    }
  }

  if (!overlap) {
    return 0;
  }

  const candidateCoverage = overlap / candidateNgrams.size;
  const queryCoverage = overlap / queryNgrams.size;

  return Math.min(0.88, Math.max(candidateCoverage, queryCoverage) * 0.88);
};

const getBestSignalScore = (value: string, signals: string[]) =>
  signals.reduce(
    (bestScore, signal) =>
      Math.max(bestScore, computeKnowledgePhraseScore(value, signal)),
    0
  );

export const rankKnowledgeItemMatch = (
  item: {
    title: string;
    content: string;
    tags: string[];
  },
  queryText: string
): RankedKnowledgeItem => {
  const queryTokens = tokenizeKnowledgeText(queryText);
  const titleTokens = tokenizeKnowledgeText(item.title);
  const contentTokens = tokenizeKnowledgeText(item.content);
  const tagTokens = tokenizeKnowledgeText(item.tags.join(" "));

  const titleOverlap = computeTokenOverlapRatio(queryTokens, titleTokens);
  const contentOverlap = computeTokenOverlapRatio(queryTokens, contentTokens);
  const tagOverlap = computeTokenOverlapRatio(queryTokens, tagTokens);

  const titlePhraseScore = computeKnowledgePhraseScore(queryText, item.title);
  const contentPhraseScore = computeKnowledgePhraseScore(queryText, item.content);
  const tagPhraseScores = item.tags.map((tag) => ({
    tag,
    score: Math.max(
      computeKnowledgePhraseScore(queryText, tag),
      computeTokenOverlapRatio(queryTokens, tokenizeKnowledgeText(tag))
    ),
  }));
  const bestTagMatch = tagPhraseScores.sort((a, b) => b.score - a.score)[0];
  const tagPhraseScore = bestTagMatch?.score ?? 0;
  const queryPriceIntentScore = getBestSignalScore(queryText, PRICE_INTENT_SIGNALS);
  const itemPriceSignalScore = Math.max(
    getBestSignalScore(item.title, PRICE_INTENT_SIGNALS),
    getBestSignalScore(item.content, PRICE_INTENT_SIGNALS),
    ...item.tags.map((tag) => getBestSignalScore(tag, PRICE_INTENT_SIGNALS))
  );
  const priceIntentBoost =
    queryPriceIntentScore >= 0.78 && itemPriceSignalScore >= 0.75
      ? queryPriceIntentScore * itemPriceSignalScore * 0.55
      : 0;

  const queryCompact = compactKnowledgeText(queryText);
  const titleCompact = compactKnowledgeText(item.title);
  const exactTitleMatch =
    !!queryCompact &&
    !!titleCompact &&
    (queryCompact === titleCompact ||
      queryCompact.includes(titleCompact) ||
      titleCompact.includes(queryCompact));

  const score = exactTitleMatch
    ? 1
    : Math.min(
        0.98,
        titlePhraseScore * 0.26 +
          tagPhraseScore * 0.38 +
          contentPhraseScore * 0.18 +
          titleOverlap * 0.16 +
          tagOverlap * 0.18 +
          contentOverlap * 0.08 +
          priceIntentBoost +
          (tagPhraseScore >= 0.78 ? 0.08 : 0) +
          (titlePhraseScore >= 0.84 ? 0.05 : 0) +
          (contentOverlap > 0 ? 0.04 : 0)
      );

  return {
    title: item.title,
    content: item.content,
    tags: item.tags,
    score,
    topicKey: bestTagMatch?.tag?.trim() || item.title.trim() || "General",
  };
};

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

  async getByIdInWorkspace(id: string, workspaceId: string) {
    return KnowledgeItemModel.findOne({ _id: id, workspaceId });
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

  async updateInWorkspace(
    id: string,
    workspaceId: string,
    patch: {
      title?: string;
      content?: string;
      tags?: string[];
      isActive?: boolean;
    }
  ) {
    return KnowledgeItemModel.findOneAndUpdate(
      { _id: id, workspaceId },
      { $set: patch },
      { new: true }
    );
  }

  async remove(id: string) {
    return KnowledgeItemModel.findByIdAndDelete(id);
  }

  async removeInWorkspace(id: string, workspaceId: string) {
    return KnowledgeItemModel.findOneAndDelete({ _id: id, workspaceId });
  }

  async findBestMatch(workspaceId: string, queryText: string) {
    const items = await KnowledgeItemModel.find({
      workspaceId,
      isActive: true,
    });

    if (!compactKnowledgeText(queryText)) {
      return null;
    }

    const ranked = items
      .map((item) =>
        rankKnowledgeItemMatch(
          {
            title: item.title,
            content: item.content,
            tags: item.tags,
          },
          queryText
        )
      )
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];

    if (!best || best.score < 0.45) {
      return null;
    }

    return {
      kind: "knowledge" as const,
      confidence: Math.min(0.92, best.score + 0.14),
      sourceHints: [best.title],
      text: best.content,
    };
  }

  async selectRelevantBundles(
    workspaceId: string,
    queryText: string,
    options?: {
      maxItems?: number;
      maxBundles?: number;
      useEntireLibraryWhenTotalItemsAtMost?: number;
    }
  ) {
    const items = await KnowledgeItemModel.find({
      workspaceId,
      isActive: true,
    }).lean();

    if (!compactKnowledgeText(queryText) || !items.length) {
      return [] as KnowledgeBundle[];
    }

    const ranked = items
      .map((item) => rankKnowledgeItemMatch(item, queryText))
      .sort((a, b) => b.score - a.score);

    const useEntireLibrary =
      items.length > 0 &&
      items.length <= (options?.useEntireLibraryWhenTotalItemsAtMost ?? 0);

    const selected = useEntireLibrary
      ? ranked
      : ranked.filter((item) => item.score >= 0.28).slice(0, options?.maxItems ?? 4);
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
      .slice(0, useEntireLibrary ? undefined : options?.maxBundles ?? 3);
  }
}

export const knowledgeService = new KnowledgeService();
