// CB T2 — THE LAYER-2 CHOICE SEAT (docs/world-model/CB-T2-CHOICE-SEAT.md).
// Contract: CB-CARRY-BEAT-CONTRACT.md §2 M-CB.2, dispatched by ruling #268.4.
//
// 过人这一脚要不要踢: CB-T0 built the CAPABILITY (the aimed knock) and CB-T1 proved the
// EVENT is real. Neither built a chooser — every knock so far was an instrument's. This
// seat forms TOUCH-PAST CANDIDATES and hands them to the brain's ONE candidate table,
// beside the pass candidates, priced by the pass table's OWN pricer.
//
// ⭐⭐ ONE TABLE, NO PER-SEAM SCORING PATH (M-CB.2's own words). This module computes NO
// score. It emits candidate KNOCKS — each with the aim point the knock's own physics
// implies — and `PlayerBrain`'s hoisted `groundCandidate` (the very function that prices
// to-feet, led and strike-plane deliveries) prices them. The knock is a DELIVERY WHOSE
// RECEIVER IS THE CARRIER HIMSELF, so the shared pricer is applied to the actual receiver
// rather than adapted; the terms of that pricer which degenerate on a self-delivery are
// enumerated in the stage doc's §STRAIN and MEASURED, never special-cased away.
//
// ⭐ EVERY SCALE TRACES (#200). This file introduces NO numeral of its own beyond the
// algebra of its own closed forms (the `2` of a chord, the `2π` of a circle):
//   · the push law, the race window and the roll are `carryBeat`'s, which are the
//     ENGINE's own (`performDribbleTouch`'s push, `TOUCH_RECOLLECT_*`, the turf decay);
//   · the compass RESOLUTION is `CONTROL_RADIUS` — the engine's own answer to "how close
//     must a body be to do anything about a loose ball" — so two knocks whose landing
//     points are nearer than that are the same knock to every body on the pitch;
//   · the compass ANCHOR is the incumbent push's own bearing (`performDribbleTouch`:
//     the direction of TRAVEL, heading as the slow fallback), so step 0 IS today's knock.
//
// ⭐ THE ENGINE GIVES THE KNOCK EXACTLY ONE CONTROL — its DIRECTION (`performTouchPast`'s
// signature is `(match, p, dir)`; the push, the speed and the race window are all laws of
// the world). M-CB.2 names "direction × timing": the TIMING axis is therefore the
// ACROSS-TICK one — the table is re-priced at every decision and the argmax decides WHEN
// — and an in-tick timing axis is NOT invented here. Stage doc §STRAIN 2 states the fork.
//
// ⭐ THE STYLE GENE IS BORN ABSENT (`cbCarryProneness`, the riskTolerance family). Absent
// ⇒ this seat is `null` ⇒ no candidate is formed and the brain runs the shipped
// statements alone. The NEUTRAL FORM IS DERIVED, not chosen: requiring the
// present-at-zero world to equal the absent world forces the appetite to enter
// MULTIPLICATIVELY, and it is the gene itself that multiplies — no weight, no base, no
// width, no constant of any kind.
//
// Dormant: `cbChoiceSeat` is a hard `false` in every production path, so nothing in this
// file is reached in the shipped game.
import type { V2 } from '../utils/vec';
import type { Player } from '../sim/Player';
import type { TacticalGenome } from '../evolution/genome';
import { cbCarryPronenessOf } from '../evolution/genome';
import { CONTROL_RADIUS } from '../sim/constants';
import { rolledDistance, touchRaceWindow } from '../sim/carryBeat';
import { touchPastPushFor } from '../sim/mechanics';

/**
 * The seat as the brain holds it for ONE on-ball decision: the appetite, and nothing
 * else. There is no world state in here — the candidates are built from the body and the
 * opponents the pricer already scans.
 */
export interface CarryChoiceSeat {
  /** `cbCarryPronenessOf(g)` ∈ [0,1]. 0 ⇒ every knock candidate prices to exactly `0`. */
  readonly proneness: number;
}

/**
 * ⭐ THE ARMING RULE, in ONE place: the seat forms only when the flag's door is open (the
 * caller's single fork) AND the gene is NON-ABSENT. Returning `null` for an absent gene
 * is the BORN-ABSENT IDENTITY made STRUCTURAL rather than merely arithmetic — with no
 * seat there is no compass, no candidate, no pricing call and no allocation, so the
 * decision is the shipped one statement for statement (the DV-T0 / DLC-T0s precedent).
 *
 * PURE: no rng, no writes, no reads of anything but the genome.
 */
export function carryChoiceSeatOf(g: TacticalGenome): CarryChoiceSeat | null {
  if (g.cbCarryProneness === undefined) return null;
  return { proneness: cbCarryPronenessOf(g) };
}

/** One candidate knock, in the forms the pricing loop and the arming need. */
export interface KnockCandidate {
  /** 0 … n−1: the compass step off the incumbent bearing. **0 IS TODAY'S KNOCK.** */
  readonly step: number;
  /** The aimed unit direction — what `performTouchPast` is handed if this one wins. */
  readonly dir: Readonly<V2>;
  /** The engine's own push for THIS line (`touchPastPushFor`, the one owner). */
  readonly push: number;
  /** The ball's release speed: the carrier's own pace plus the push (the engine's law). */
  readonly speed: number;
  /** The knock's own race window — the interval the carrier cannot re-collect in. */
  readonly window: number;
  /** How far the ball has rolled when the race resolves (the engine's own decay). */
  readonly rolled: number;
  /** ⭐ THE RECEPTION POINT this candidate is PRICED AT: the ball where the race ends. */
  readonly aim: Readonly<V2>;
  /** Reported, prices nothing: is this knock into the BACK half of the compass? */
  readonly back: boolean;
}

/**
 * ⭐ THE COMPASS ANCHOR — the incumbent push's own bearing, verbatim from
 * `performDribbleTouch`: "knock it along the direction of TRAVEL, not the instantaneous
 * facing", with `heading` as the slow fallback. Step 0 of the compass is therefore
 * exactly the knock the engine already plays, and every other step is that knock turned.
 */
export function knockAnchor(p: Player): Readonly<V2> {
  const v = Math.hypot(p.vel.x, p.vel.y);
  return v > 0.5 ? { x: p.vel.x / v, y: p.vel.y / v } : { x: p.heading.x, y: p.heading.y };
}

/**
 * ⭐⭐ THE COMPASS RESOLUTION — DERIVED, never chosen.
 *
 * Two knocks are the SAME knock to every body on the pitch if their landing points sit
 * closer together than the reach a body needs to do anything about a loose ball. So the
 * compass is sampled at exactly the angular step whose CHORD, at the distance the knock
 * has rolled when its race resolves, is one `CONTROL_RADIUS`:
 *
 * ```text
 *   L  = rolledDistance( speedMax, touchRaceWindow(pushMax) )   [the reach of the knock]
 *   Δ  = 2 · asin( CONTROL_RADIUS / (2·L) )                     [the chord condition]
 *   n  = ceil( 2π / Δ )                                         [the whole compass]
 * ```
 *
 * `pushMax` is the engine's OWN push law at its OWN open-field ceiling for this body
 * (`touchPastPush`'s `clamp(aheadD − 2, 0, 9)` saturates at `aheadD = 14`, the cone's own
 * ceiling), so `L` is a per-body scalar and the resolution does not depend on which
 * direction is being sampled — the circularity of "the push depends on the line" is cut
 * at the body's own maximum rather than by a chosen number.
 *
 * ⭐ THE WHOLE COMPASS, deliberately: CB-C0 proved the duel FRONTAL BY CONSTRUCTION (0 of
 * 9,956 challenges from behind) and CB-T0 opened the back half for the first time. A
 * chooser that could only sample the front would re-close it by omission.
 *
 * ⚠ K IS THE COST LEVER (the OBM-T0 / DLC-T0 lesson: sampling is where a chooser's cost
 * lives). It is DERIVED, it is reported per decision in the smoke, and it is never
 * widened quietly.
 */
export function knockCompassSteps(p: Player): number {
  const pushMax = touchPastPushFor(p, knockAnchor(p), []);
  const speedMax = Math.hypot(p.vel.x, p.vel.y) + Math.max(pushMax, 0.8);
  const L = rolledDistance(speedMax, touchRaceWindow(pushMax));
  // GUARD (not a predicate): a knock that cannot out-roll its own contest radius has no
  // distinguishable directions at all, so the compass degenerates to the incumbent one.
  if (!(L > CONTROL_RADIUS / 2)) return 1;
  const delta = 2 * Math.asin(CONTROL_RADIUS / (2 * L));
  return Math.max(1, Math.ceil((2 * Math.PI) / delta));
}

/**
 * ⭐⭐ THE CANDIDATE KNOCKS: the whole compass, in a FROZEN order (step ascending from the
 * incumbent bearing, rotating positively), each priced at the point the ball has reached
 * when ITS OWN RACE RESOLVES.
 *
 * ```text
 *   dir(k)   = anchor rotated by k · (2π/n)          k = 0 … n−1, k = 0 IS TODAY'S KNOCK
 *   push(k)  = touchPastPushFor(p, dir(k), opponents)   the ENGINE's own law, one owner
 *   speed(k) = |carrier's velocity| + max(push(k), 0.8) the ENGINE's own release
 *   W(k)     = touchRaceWindow(push(k))                 the ENGINE's own race window
 *   aim(k)   = ballPos + dir(k) · rolledDistance(speed(k), W(k))
 * ```
 *
 * ⭐ WHY THE RACE WINDOW IS THE PRICING HORIZON, and not a chosen one: `W` is the very
 * interval the carrier cannot re-collect in, which IS how long the loose-ball race lasts
 * (CB-T0 §LAW) and the interval `beatsDefender` samples over. The ball at `t = W` is the
 * ball at the moment the world decides whose it is — the reception point of a knock, in
 * exactly the sense `mate.pos` is the reception point of a pass.
 *
 * PURE: no rng, no writes, no match, no percept.
 */
export function knockCandidates(
  p: Player, ballPos: Readonly<V2>, opponents: readonly Player[],
): readonly KnockCandidate[] {
  const anchor = knockAnchor(p);
  const n = knockCompassSteps(p);
  const vmag = Math.hypot(p.vel.x, p.vel.y);
  const out: KnockCandidate[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k * 2 * Math.PI) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dir = { x: anchor.x * c - anchor.y * s, y: anchor.x * s + anchor.y * c };
    const push = touchPastPushFor(p, dir, opponents);
    const speed = vmag + Math.max(push, 0.8);
    const window = touchRaceWindow(push);
    const rolled = rolledDistance(speed, window);
    out.push({
      step: k,
      dir,
      push,
      speed,
      window,
      rolled,
      aim: { x: ballPos.x + dir.x * rolled, y: ballPos.y + dir.y * rolled },
      back: anchor.x * dir.x + anchor.y * dir.y < 0,
    });
  }
  return out;
}
