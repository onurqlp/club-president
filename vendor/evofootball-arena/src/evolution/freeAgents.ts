import type { Role } from '../sim/types';
import type { PlayerCareer } from './careers';
import type { PlayerAttributes } from './playerGenome';
import { ATTR_KEYS } from './playerGenome';
import type { PlayerStyle } from './playerStyle';

/**
 * THE FREE-AGENT FIRE-SALE (Phase 55 — Stage 3 W3, minimal first cut).
 * Until now a dying club's players simply VANISHED — their attribute genes
 * and personal styles left the gene pool forever unless a parent squad
 * happened to carry similar ones. Now they hit the open market: the
 * fire-sale pool is a SECOND genetic channel for player genes, exactly as
 * the coach pool is for tactical philosophies (Phase 53).
 *
 * Minimal by design (the blueprint's own scoping): players enter the pool
 * only through club death; clubs sign only at a natural vacancy (a
 * retirement), only when the signing fits under the squad budget, and only
 * when the market genuinely beats the academy option. No active transfer
 * window, no fees, no poaching — that ecology gets measured first.
 */

export interface FreeAgent {
  name: string;
  /** Slot role at his old club — signings fill a like-for-like vacancy. */
  role: Role;
  attrs: PlayerAttributes;
  style: PlayerStyle;
  age: number;
  career: PlayerCareer;
  /** Which club folded under him (display/story only). */
  lastClub: string;
  /** Generation he hit the market. */
  sinceGen: number;
}

/** The market never grows past this — the best (by total ability) stay. */
export const FREE_AGENT_POOL_MAX = 12;
/** Nobody signs a veteran on the brink: the age cutoff for signings. */
export const FREE_AGENT_MAX_AGE = 29;

export function agentTotal(a: FreeAgent): number {
  let t = 0;
  for (const k of ATTR_KEYS) t += a.attrs[k];
  return t;
}

/** Keep the pool bounded and deterministic: best totals first, then youth,
 * then name (stable across saves/platforms). */
export function trimPool(pool: FreeAgent[]): FreeAgent[] {
  return [...pool]
    .sort((a, b) => agentTotal(b) - agentTotal(a) || a.age - b.age || a.name.localeCompare(b.name))
    .slice(0, FREE_AGENT_POOL_MAX);
}
