// C5 T2 — THE WHETHER SEAT (docs/world-model/C5-T2-WHETHER-SEAT.md).
// Authority: rulings #63.3 (C5-T2 drafting), #64.1 (R-B adopted — the
// certification-boundary rule), #29.3 (the unpark predicate consumed per
// decision), #41.2 (a table under its OWN meaning), the E5h ×1.3 ban (absolute).
//
// The perceived chooser gains "keep holding" as a PRICED option. It is a PRICE
// PROBE, not a policy (#64.1): at an eligible decision moment the body pulls his
// OWN percept, places himself in the certified re-census cell, and — strict
// no-subsidy — may TAKE a HOLD-k ONLY where that cell's certified cost interval
// REACHES ZERO (upper CI >= 0, the #29.3 unpark test at per-decision
// granularity). Everywhere the price is resolved-negative the option is priced
// and DECLINED. Nothing is added to the price; no optimism term, no bonus.
//
// PURE except for the one percept pull (`match.perceivedSnapshot`, the E3R2 PULL
// #13.3 — the same pull the percept-compliant shield uses, C5-RECENSUS §1.3).
// The certified table is INJECTED by the probe; NO table is bundled in src (the
// P2 dormant-eye convention, STAGE3-P2-DORMANT-EYE §2). Dormant: `whetherEye` is
// null in every production path, so this module is never reached in the shipped
// game (X-FP / X-OFF-IDENT).
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { Side } from '../sim/types';

export type WhetherEyeArm = 'neutral';

type Band = 0 | 1 | 2;

/** One certified (cell, k) cost row from the re-census table (§0.1). */
export interface RecensusCostRow {
  readonly holdTicks: number;
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  /** The #29.3 unpark test for this (cell, k): upper CI >= 0. */
  readonly reachesZero: boolean;
}
/** One certified cell (pressureBand × staleBand × supportBand). */
export interface RecensusCostCell {
  readonly pressureBand: Band;
  readonly staleBand: Band;
  readonly supportBand: Band;
  readonly costs: readonly RecensusCostRow[];
}
/**
 * The certified re-census cost table the seat consumes, INJECTED by the probe.
 * The band cuts and the support window travel with it so the seat places its
 * PERCEIVED context under exactly the census's own cuts — no constant is baked
 * into src.
 */
export interface RecensusCostTable {
  readonly pressureBands: readonly [number, number];
  readonly staleBands: readonly [number, number];
  readonly supportCuts: { readonly low: number; readonly high: number };
  readonly supportWindowM: readonly [number, number];
  readonly cells: readonly RecensusCostCell[];
}

/** The seat's dormant configuration (Match.whetherEye), null in production. */
export interface WhetherEyeConfig {
  readonly arm: WhetherEyeArm;
  readonly scope:
    | { readonly kind: 'body'; readonly gid: number }
    | { readonly kind: 'team'; readonly side: Side }
    | { readonly kind: 'both' };
  readonly table: RecensusCostTable;
}

/**
 * The named decision classes at an eligible decision instant (§2.3, mutually
 * exclusive). Only `D-HOLD` issues a hold; the rest run act-now.
 */
export type WhetherDecisionClass =
  | 'D-HOLD' // perceived cell's k-interval reaches zero → the seat holds
  | 'E-ACTNOW-DECLINED' // cell placed, all k resolved-negative → priced and declined
  | 'E-ABSTAIN-UNSEEN' // no perceived ball / owner → no cell
  | 'E-NOCELL'; // perceived owner exists but no perceived opponents → cell unplaceable

export interface WhetherDecision {
  readonly cls: WhetherDecisionClass;
  /** The taken hold length in ticks (D-HOLD only), else null. */
  readonly k: number | null;
  /** The placed perceived cell key `p|s|sup`, null when no cell was placed. */
  readonly cell: string | null;
  /** The placed perceived bands (for the M-CTX mediator), null when no cell. */
  readonly perceived: { pressureBand: Band; staleBand: Band; supportBand: Band } | null;
}

/** Is this body inside the armed scope? */
export function whetherEyeInScope(eye: WhetherEyeConfig, p: Player): boolean {
  const s = eye.scope;
  if (s.kind === 'both') return true;
  if (s.kind === 'team') return p.side === s.side;
  return p.gid === s.gid;
}

const bandOf2 = (value: number, cuts: readonly [number, number]): Band =>
  (value < cuts[0] ? 0 : value < cuts[1] ? 1 : 2);
const supportBandOf = (
  value: number, cuts: { readonly low: number; readonly high: number },
): Band => (value < cuts.low ? 0 : value >= cuts.high ? 2 : 1);

/**
 * The WHETHER decision at one eligible decision instant. The eligibility
 * predicate (settled control · not a forced release · A0 not Shoot/Clear, §2.2)
 * is enforced by the CALLER — this reads the percept and prices the option.
 *
 * The three context features are computed from the body's OWN snapshot and
 * nothing else, save STALE (the body's own possession clock — his own touch
 * state, not a percept of others, §2.3). No truth is consulted for the threat
 * or the support geometry.
 */
export function whetherEyeDecision(p: Player, match: Match, table: RecensusCostTable): WhetherDecision {
  const snapshot = match.perceivedSnapshot(p);
  // E-ABSTAIN-UNSEEN: the snapshot carried no perceived ball / owner (§2.3).
  if (snapshot === null || snapshot.ball === null || snapshot.ball.ownerGid === null) {
    return { cls: 'E-ABSTAIN-UNSEEN', k: null, cell: null, perceived: null };
  }
  // PRESSURE — from the PERCEIVED nearest opponents' proximity (census
  // pressureAt formula, over perceivedSnapshot opponents). No perceived
  // opponent ⇒ the cell cannot be honestly placed (perceiving nobody is NOT
  // perceiving no pressure) → E-NOCELL.
  let nearD = Infinity;
  let sawOpponent = false;
  for (const other of snapshot.players) {
    if (other.side === p.side) continue;
    sawOpponent = true;
    const d = Math.hypot(other.pos.x - p.pos.x, other.pos.y - p.pos.y);
    if (d < nearD) nearD = d;
  }
  if (!sawOpponent) return { cls: 'E-NOCELL', k: null, cell: null, perceived: null };
  const pressure = Math.max(0, Math.min(1, 1 - nearD / 6));
  const pressureBand = bandOf2(pressure, table.pressureBands);

  // STALE — the body's OWN possession clock (own touch state, not a percept).
  const staleBand = bandOf2(match.teams[p.side].staleTime, table.staleBands);

  // SUPPORT — own non-GK non-sent-off teammates in the [min,max] window,
  // counted from the SNAPSHOT (remembered positions included; a teammate not in
  // the percept is not counted). Role/sent-off is registered roster truth (the
  // §5(c) window), the POSITION is the percept.
  const [supportMin, supportMax] = table.supportWindowM;
  const perceivedPos = new Map<number, Readonly<{ x: number; y: number }>>();
  for (const other of snapshot.players) {
    if (other.side === p.side) perceivedPos.set(other.gid, other.pos);
  }
  let support = 0;
  for (const mate of match.teams[p.side].players) {
    if (mate.gid === p.gid || mate.role === 'GK' || mate.sentOff) continue;
    const pos = perceivedPos.get(mate.gid);
    if (pos === undefined) continue;
    const d = Math.hypot(pos.x - p.pos.x, pos.y - p.pos.y);
    if (d >= supportMin && d <= supportMax) support += 1;
  }
  const supportBand = supportBandOf(support, table.supportCuts);

  const cell = `${pressureBand}|${staleBand}|${supportBand}`;
  const perceived = { pressureBand, staleBand, supportBand };
  const row = table.cells.find(
    (c) => c.pressureBand === pressureBand && c.staleBand === staleBand && c.supportBand === supportBand,
  );
  if (row === undefined) return { cls: 'E-NOCELL', k: null, cell, perceived };

  // R-B (#64.1), strict no-subsidy: among the priced HOLD-k options TAKE only a
  // (cell, k) whose certified cost interval REACHES ZERO (upper CI >= 0). If
  // several reach zero the least commitment (smallest k) is taken; nothing is
  // added to the price. Everywhere resolved-negative the option is DECLINED.
  let chosenK: number | null = null;
  for (const cost of row.costs) {
    if (cost.reachesZero && (chosenK === null || cost.holdTicks < chosenK)) chosenK = cost.holdTicks;
  }
  if (chosenK === null) return { cls: 'E-ACTNOW-DECLINED', k: null, cell, perceived };
  return { cls: 'D-HOLD', k: chosenK, cell, perceived };
}
