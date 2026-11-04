import type { PlayerMatchStats } from './types';

/**
 * Player match ratings (Phase 33) — the broadcast 6.0–10.0 scale, folded
 * from the passive per-player counters plus the team outcome. Pure and
 * deterministic: same stats + same score difference ⇒ same rating, so
 * ratings live in MatchResult and replay identically from a save.
 *
 * Weights (ROADMAP): goal 1.2 · assist 0.8 · save 0.25 · recovery 0.1 ·
 * miscontrol −0.1 · win +0.3 (draw +0.1). Base 6.5 = "did the job".
 */
export function matchRating(s: PlayerMatchStats, goalDiff: number): number {
  const outcome = goalDiff > 0 ? 0.3 : goalDiff === 0 ? 0.1 : 0;
  const r =
    6.5 +
    s.goals * 1.2 +
    s.assists * 0.8 +
    s.saves * 0.25 +
    s.recoveries * 0.1 -
    s.miscontrols * 0.1 +
    outcome;
  return Math.min(10, Math.max(6, r));
}
