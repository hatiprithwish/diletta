import type * as Schemas from "@app/schemas";

// DEV_NOTE: The ranking math of knowledge search (M2-6), pure so it is unit-tested on its own. fuse merges the vector
// and keyword lists by reciprocal rank fusion: each list adds 1 / (k + rank) for a chunk it holds (rank from 1), so a
// chunk both sides found rises above one only a single side ranked, and neither side's raw scores (a distance and a
// ts_rank) need to be comparable. selectHits keeps the reranked candidates that scored at least minScore, best first,
// at most topK. Ties keep the earlier order (fused order, then first-seen), so the same input always ranks the same.
export default class KnowledgeRankingProvider {
  static fuse(
    sides: Schemas.KnowledgeChunkMatch[][],
    options: { k: number; limit: number },
  ): Schemas.FusedKnowledgeChunk[] {
    const fused = new Map<string, Schemas.FusedKnowledgeChunk>();
    for (const side of sides) {
      side.forEach((match, index) => {
        const contribution = 1 / (options.k + index + 1);
        const existing = fused.get(match.chunkId);
        if (existing) {
          existing.fusedScore += contribution;
        } else {
          fused.set(match.chunkId, { ...match, fusedScore: contribution });
        }
      });
    }
    // DEV_NOTE: Array.prototype.sort is stable, so equal scores keep first-seen order
    return [...fused.values()]
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, Math.max(0, options.limit));
  }

  static selectHits(
    candidates: Schemas.FusedKnowledgeChunk[],
    scores: number[],
    options: { minScore: number; topK: number },
  ): Schemas.KnowledgeSearchHit[] {
    return candidates
      .map(({ fusedScore: _fusedScore, ...match }, index) => ({
        ...match,
        score: scores[index] ?? 0,
      }))
      .filter((hit) => hit.score >= options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, options.topK));
  }
}
