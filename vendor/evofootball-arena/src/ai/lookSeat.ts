// O2 T0 — THE LOOK SEAT (docs/world-model/O2-T0-DORMANT-SEAM.md).
// Authority: contract `O2-LOOK-CONTRACT.md` §2 M-O2.1–M-O2.4, dispatched by
// ruling #193.2. Parent invariants inherited from `OUTLET-CONTRACT.md` §3
// (I1 NO FREE TIME · FLAG HYGIENE · EPISTEMIC HONESTY · Road B).
//
// M-O2.3, "the trigger is a DECISION, not a reflex": this module is that
// decision, and it is BORN INCUMBENT-EQUIVALENT — with the instrument seam
// (`Match.forcedLook`) null it never takes a look, so an armed world with no
// instrument plays exactly the unarmed one. The gene/attr expression is a LATER
// slice's work (the #148-family idiom: born equivalent, differentiation earned);
// this file is the seat it will sit in, and nothing else.
//
// PURE: no rng, no truth scan, no percept pull, no allocation. The look's
// epistemic content lives entirely in `Match.armO2Look` / `Match.stepO2Look`
// (extra scan MOMENTS through the existing recorder); the seat only decides
// WHETHER to spend the ticks.
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { ActionType } from '../sim/types';

export interface LookDecision {
  /** Spend a LOOK now? False in every production path (born incumbent-equivalent). */
  readonly take: boolean;
  /** The `scores[].why` string, so a trace can tell forced from elective. */
  readonly why: string;
}

/**
 * The eligible-LOOK predicate (M-O2.1: "while owning the ball and not in a
 * one-touch window"). It is the C5-T2 whether fork's OWN eligible-choice
 * predicate (`PlayerBrain` §whether: settled control · not a forced release ·
 * A0 not Shoot/ClearBall · not a keeper), deliberately identical so the LOOK and
 * the seat that CONSUMES it (M-O2.4) act on exactly the same population — plus
 * the two the contract adds in its own words: he must OWN the ball, and no look
 * may be stacked on a live one.
 */
export function o2LookEligible(
  p: Player, match: Match, topAction: ActionType, mustKick: boolean,
): boolean {
  return match.o2Look
    && match.o2LookWindow === null
    && match.ball.owner === p
    && !mustKick
    && p.role !== 'GK'
    && p.firstTouchWindow <= 0
    && topAction !== 'Shoot'
    && topAction !== 'ClearBall';
}

/**
 * The LOOK decision at one eligible fork. Caller enforces eligibility.
 *
 * Today there is exactly one way to take it: an INSTRUMENT names the body
 * (`Match.forcedLook`, the `forcedHold` idiom verbatim — null in every
 * production path). Everything else declines, which is the incumbent world.
 */
export function o2LookDecision(p: Player, match: Match): LookDecision {
  const forced = match.forcedLook;
  if (forced !== null && forced.gid === p.gid && match.simTick < forced.untilTick) {
    return { take: true, why: 'forced look (O2 T0 probe seam)' };
  }
  return { take: false, why: 'no look (incumbent-equivalent)' };
}
