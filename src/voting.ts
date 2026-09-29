import crypto from "node:crypto";
import { CandidateResult, VoteOutcome, WorkflowVoteConfig } from "./types";

function stableHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 10);
}

function heuristicScore(text: string): number {
  let score = 0;
  if (text.includes("```diff")) {
    score += 5;
  }
  score += Math.min(50, Math.floor(text.length / 50));
  if (/error/i.test(text)) {
    score -= 2;
  }
  return score;
}

export function pickWinnerByHeuristic(candidates: CandidateResult[]): CandidateResult {
  const sorted = candidates
    .map((c) => ({ ...c, score: c.score ?? heuristicScore(c.text) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return sorted[0];
}

export function completeVote(
  vote: WorkflowVoteConfig | undefined,
  candidates: CandidateResult,
  allCandidates: CandidateResult[],
  judgeResult?: { index: number; reason: string }
): VoteOutcome {
  if (!vote) {
    return {
      strategy: "best_of_n_same_model",
      winner: candidates,
      candidates: allCandidates,
      reason: "No vote config; selected only candidate."
    };
  }

  if (vote.strategy === "judge_model" && judgeResult) {
    return {
      strategy: vote.strategy,
      winner: allCandidates[judgeResult.index] ?? allCandidates[0],
      candidates: allCandidates,
      reason: judgeResult.reason
    };
  }

  if (vote.strategy === "cross_model_vote") {
    const grouped = new Map<string, CandidateResult[]>();
    for (const c of allCandidates) {
      const key = stableHash(c.text.trim());
      const group = grouped.get(key) ?? [];
      group.push(c);
      grouped.set(key, group);
    }
    const major = [...grouped.values()].sort((a, b) => b.length - a.length)[0];
    if (major && major.length > 1) {
      const winner = pickWinnerByHeuristic(major);
      return {
        strategy: vote.strategy,
        winner,
        candidates: allCandidates,
        reason: `Majority match across ${major.length} candidates.`
      };
    }
  }

  const winner = pickWinnerByHeuristic(allCandidates);
  return {
    strategy: vote.strategy,
    winner,
    candidates: allCandidates,
    reason: "Selected highest heuristic score."
  };
}
