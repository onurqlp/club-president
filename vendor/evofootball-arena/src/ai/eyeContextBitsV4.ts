// STAGE III V4-P3-PARTIAL (P3p-0) — the IN-SUPPORT LAW + the TWO S BITS, as
// FLAG-GATED DORMANT percept computations. Contract:
// docs/world-model/STAGE3-V4-P3-PARTIAL.md §2 (the in-support law) and §3 (the
// two bits), ratified by commander rulings #110 / #111.
//
// PURE. No world mutation, no RNG, no truth reads — every value here is a pure
// function of a body's OWN percept snapshot (I2, percept-honest) plus the
// public phase signal. Nothing in this module is reachable from a production
// path: the station eye is null in the shipped game and the `eye.v4` flags that
// gate its consumption (STAGE3-V4-P3-PARTIAL §2.3/§3.4) are absent everywhere
// but a probe / consumer config. These are the functions the P3p-1 census and
// the P3p-2 consumer call; P3p-0 builds only the dormant seam and proves the
// flag-off world is bit-identical.
import { BOX_WIDTH, HALF_L } from '../sim/constants';
import { TEAM_SIZE, type Side } from '../sim/types';
import type { PerceptionSnapshot } from './perceptionSnapshot';

// --- pinned thresholds (§2.2 / §3, #48.4; confirmed at the P3p-1/P3p-2 smoke) ---
/** §2.2: the freshness bound for "a fresh live perceived owner" (30 ticks = 0.5 s @ 60 Hz). */
export const SUPPORT_STALE_TICKS = 30;
/** §3.1: the freshness bound for a wide-occupancy observation (pinned as SUPPORT_STALE_TICKS). */
export const WIDTH_STALE_TICKS = 30;
/** §3.2: the freshness bound for a perceived-opponent line observation (pinned as SUPPORT_STALE_TICKS). */
export const LINE_STALE_TICKS = 30;
/**
 * §3.1: |y| ≥ WIDE_EDGE ⇒ "holding width". BOX_WIDTH/2 = 14·GOAL_AND_BOX_SCALE
 * ≈ 9.8 m — a body wider than the penalty box is holding the flank.
 */
export const WIDE_EDGE = BOX_WIDTH / 2;
/**
 * §3.2 / rulings #110–#111 (choice 4): OFFSIDE_EPS, the level-is-onside epsilon,
 * READ FROM THE SIM'S OWN OFFSIDE MACHINERY and recorded at the P3p-0 build.
 * The sim calls a target offside in `offsideAtKick` (src/sim/mechanics.ts) iff
 * `tx > line + 0.2`, and `offsideLineLocalX` (src/ai/formations.ts) documents
 * "level is onside (callers add their own epsilon)". The one caller's epsilon
 * is 0.2 m; pinned here.
 *
 * ⚠ FLAGGED: mechanics.ts holds `0.2` as an inline literal (it exports no named
 * constant), so this pin is MIRRORED, not imported. If the offside call's
 * epsilon ever moves, this pin must move with it (an X-form the P3p-1 census
 * should re-assert). The alternative — extracting a shared `OFFSIDE_EPS` in
 * mechanics.ts — was rejected for P3p-0 to keep the match/physics core untouched
 * (Road B, X-SRC-ZERO for the core).
 */
export const OFFSIDE_EPS = 0.2;

// --- §2: THE IN-SUPPORT LAW (remedy J) ---------------------------------------
/** The support outcome: IN_SUPPORT, or one of the four named abstention classes. */
export type SupportReason =
  | 'IN_SUPPORT'
  | 'E-OOS-PHASE'      // clause (1): the public phase is not 'playing' (the whistle)
  | 'E-OOS-UNSEEN'     // clause (2): no ball percept at all
  | 'E-OOS-INFLIGHT'   // clause (2): a perceived loose / in-flight ball (no live owner)
  | 'E-OOS-STALE';     // clause (2): a perceived owner, but older than SUPPORT_STALE_TICKS

/**
 * §2.1/§2.2 — the V3-P1 support predicate, evaluated PERCEPT-HONESTLY. IN
 * SUPPORT iff (1) the public phase is 'playing' AND (2) the body's OWN pulled
 * snapshot carries a FRESH LIVE perceived owner
 * (`snap.ball.ownerGid !== null && ageTicks ≤ SUPPORT_STALE_TICKS`). Every
 * out-of-support outcome is one of the four named classes; at the consumption
 * point each is a holdIncumbent (the eye is not consulted — the incumbent
 * machinery governs, #110.2(i)).
 *
 * The law reads the LIVE perceived owner, NOT the retained-owner ledger — an
 * in-flight ball defers to the incumbent regardless of retention (the mechanism
 * that closes the ~32% in-flight extrapolation, §2.2).
 *
 * ⚠ FLAGGED (§2.2 / §10.1): clause (1) is checked FIRST, so a restart with a
 * loose ball classes as E-OOS-PHASE (the whistle), not E-OOS-INFLIGHT — the
 * DISPOSITION (out of support) is identical either way; only the counter class
 * differs. `phaseIsPlaying` is passed in: the caller reads `match.phase`, the
 * public game-state signal audible to all (#8(l) — not truth by the back door);
 * this module never reaches into the sim.
 */
export function evaluateInSupport(
  snap: PerceptionSnapshot | null,
  phaseIsPlaying: boolean,
): SupportReason {
  if (!phaseIsPlaying) return 'E-OOS-PHASE';
  if (snap === null || snap.ball === null) return 'E-OOS-UNSEEN';
  if (snap.ball.ownerGid === null) return 'E-OOS-INFLIGHT';
  if (snap.ball.ageTicks > SUPPORT_STALE_TICKS) return 'E-OOS-STALE';
  return 'IN_SUPPORT';
}

/** True only for the IN_SUPPORT outcome; every abstention class is false. */
export const isInSupport = (r: SupportReason): boolean => r === 'IN_SUPPORT';

// --- §3: THE TWO S BITS ------------------------------------------------------
/** A percept-honest context bit — tri-state: 0, 1, or UNKNOWN (a named abstention). */
export type BitValue = 0 | 1 | 'UNKNOWN';

/**
 * §3.1 — the DELIVERY WIDE-OCCUPANCY bit `widthHeld` (a MOMENT property, one
 * value shared by all 18 candidates). `1` iff the body PERCEIVES a FRESH
 * own-side outfield teammate holding the wide channel (|y| ≥ WIDE_EDGE) in the
 * attacking half (own-team-local x ≥ 0). Percept-honest: only observations
 * within WIDTH_STALE_TICKS are scanned.
 *
 * Abstention (E-ABSTAIN-WIDTH-STALE) → 'UNKNOWN': a false `0` could be a true
 * absence OR a wide-blind spot, so `0` is emitted ONLY when the attacking half
 * is FRESHLY OBSERVED (≥ 1 fresh own-side outfield teammate seen there) and none
 * is wide. With no fresh own-side percept of the attacking half at all, the bit
 * is UNKNOWN and the consumer reads the v3 BASE cell (never a guessed child, §4.3).
 *
 * ⚠ FLAGGED (§10.3): "the wide channel is freshly observed" is operationalised
 * as "≥1 fresh own-side outfield teammate seen in the attacking half" — a
 * percept snapshot carries no region-coverage channel (only observed bodies),
 * so a proxy is unavoidable. The stricter alternative (never emit 0 — UNKNOWN
 * whenever no wide teammate is seen) is noted for the commander; the proxy here
 * is confirmed against the P3p-1 smoke's lateral/age distributions.
 */
export function widthHeldBit(
  snap: PerceptionSnapshot | null,
  observerGid: number,
  observerSide: Side,
  localXOf: (worldX: number) => number,
): BitValue {
  if (snap === null) return 'UNKNOWN';
  let attackingHalfFresh = false;
  for (const q of snap.players) {
    if (q.side !== observerSide) continue;
    if (q.gid === observerGid) continue;
    if (q.gid % TEAM_SIZE === 0) continue;          // non-GK (keeper excluded, as P1R excludes him)
    if (q.ageTicks > WIDTH_STALE_TICKS) continue;   // FRESH observations only
    if (localXOf(q.pos.x) < 0) continue;            // attacking half (own-team-local x ≥ 0)
    attackingHalfFresh = true;
    if (Math.abs(q.pos.y) >= WIDE_EDGE) return 1;   // holding width
  }
  return attackingHalfFresh ? 0 : 'UNKNOWN';
}

/**
 * §3.2 — the perceived second-last-opponent line in observer-team-local x,
 * mirroring `offsideLineLocalX` (src/ai/formations.ts): the second-last
 * perceived opponent local-x (KEEPER COUNTED), floored at the perceived
 * ball-local-x and at 0 (no offside in one's own half). Built over FRESH
 * perceived opponents only (ageTicks ≤ LINE_STALE_TICKS).
 *
 * Returns `null` = UNKNOWN (E-ABSTAIN-LINE-STALE) when fewer than two opponents
 * are freshly observed (the second-last is undefined otherwise).
 *
 * ⚠ FLAGGED: `offsideLineLocalX` takes full `Player[]` (it reads `o.sentOff`),
 * which a percept `ObservedPlayer` cannot carry (perception cannot report
 * sent-off — perceptionSnapshot.ts), so its last / second-last / floor
 * arithmetic is MIRRORED here over the fresh perceived-opponent local-x values,
 * keeper counted, exactly as the source (which filters only `o.sentOff`).
 */
export function perceivedOffsideLine(
  snap: PerceptionSnapshot | null,
  observerSide: Side,
  localXOf: (worldX: number) => number,
): number | null {
  if (snap === null) return null;
  let last = -HALF_L;
  let secondLast = -HALF_L;
  let seen = 0;
  for (const o of snap.players) {
    if (o.side === observerSide) continue;          // opponents only
    if (o.ageTicks > LINE_STALE_TICKS) continue;    // FRESH observations only
    seen += 1;
    const lx = localXOf(o.pos.x);
    if (lx > last) { secondLast = last; last = lx; }
    else if (lx > secondLast) secondLast = lx;
  }
  if (seen < 2) return null;                         // E-ABSTAIN-LINE-STALE
  const ballLocalX = snap.ball ? localXOf(snap.ball.pos.x) : 0;
  return Math.max(secondLast, ballLocalX, 0);
}

/**
 * §3.2 — the OFFSIDE BEYOND-LINE bit `beyondLine` (a per-CANDIDATE property).
 * `1` iff the candidate's forced target lies beyond the perceived line by more
 * than the sim's own onside epsilon: `targetLocalX > perceivedLine +
 * OFFSIDE_EPS`. `targetLocalX = ballLocalX + candidateDx` — the candidate offset
 * `dx` is already in the observer's attack frame, so
 * `localX(ball.x + attackDir·dx) = ballLocalX + dx` (§3.2 (iii), the fold handled
 * by `localX`). A `null` line (UNKNOWN) ⇒ the bit ABSTAINS to 'UNKNOWN' for that
 * candidate and the consumer reads the v3 BASE cell (§4.3). A behind-ball
 * candidate (dx ≤ 0) is never beyond the line, since the line is floored at the
 * ball (`perceivedOffsideLine`).
 */
export function beyondLineBit(
  perceivedLine: number | null,
  ballLocalX: number,
  candidateDx: number,
): BitValue {
  if (perceivedLine === null) return 'UNKNOWN';
  const targetLocalX = ballLocalX + candidateDx;
  return targetLocalX > perceivedLine + OFFSIDE_EPS ? 1 : 0;
}
