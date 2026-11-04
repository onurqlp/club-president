// PC T0 — THE DORMANT REACTION-LATENCY SEAM (docs/world-model/PC-T0-LATENCY-SEAM.md).
// Contract: docs/world-model/PC-PERCEPTION-CONTRACT.md §2 — M-PC.1 (THE LATENCY LAW),
// M-PC.2 (STALE PLAN, NOT BLINDNESS), M-PC.3 (RECOGNITION IS AN EARNED BOOK),
// M-PC.4 (SELF-INITIATED = ZERO LATENCY), M-PC.5 (SCOPE & DEBTS).
// Doctrine: docs/world-model/INFO-DOCTRINE.md §0–§1 primitive 2 (两档处理延迟 + 神经底).
// Census: docs/world-model/PC-C0-REACTION-BASELINE.md (the class predicates, the seam map,
// the exposure arithmetic — read WITH its §COMMANDER CORRECTIONS).
// Rulings #296 (the contract bound, PC-C0 dispatched), ⭐⭐ #297 items 3/4/5/7 (the tiers
// derived twice over, the six holes ruled, the class list and order bound, PC-T0 dispatched).
//
// 处理时间在这个世界里根本不存在 — PC-C0 measured it: the steering channel re-targets the
// truth ball at the FIRST possible tick in 99.898 % of measurable cases (six of seven classes
// at 1.000000 exactly), and the only latency the world does pay is one flat event-BLIND
// cadence constant (99.2 % of all `decisionTimer` re-arms). This module is the CAPACITY for a
// body to be SURPRISED — to keep running his stale plan for a tier of processing time he pays
// per situation class, short where his own book covers it and long where it does not.
//
// ⭐⭐ IT GENERALISES A SHIPPED IDIOM, IT DOES NOT INVENT ONE (#297 item 3). `markAnchor`
// (actionExecutor.ts, the Phase-31.9 marker reaction lag) already freezes a steering target and
// re-reads it on `lag = 0.45 − defending·0.25` ∈ [0.20, 0.45] sim-s. The move here is from
// (sprinting mark ∧ near own goal ∧ attribute-keyed) to (any surprise class ∧ BOOK-keyed).
//
// ⭐ EPISTEMIC HONESTY, closed at the IMPORT LIST (the `defenceBook.ts` form): this module
// imports the engine's own tick constant and NOTHING else. It cannot name `Match`, `Player`,
// `Team`, a percept snapshot, an rng or any census artifact. Everything it is told arrives as
// PRIMITIVE NUMBERS AND STRINGS from its caller (`Match.pcLatencyObserve`, the one detector).
//
// ⭐ THERE IS NO GENE. This seam writes no genome field, adds no `GENE_KEYS` entry and
// serializes nothing, so it has no Lamarck surface at all (#270: nothing in `info.genome`).
//
// Dormant: `pcReactionLatency` is hard `false` in every production path, so no instance of
// anything in this file exists in the shipped game.
import { DT } from '../sim/constants';

/* ========================================================================== */
/* §1 THE TIERS — DERIVED TWICE OVER (#297 item 3), READ FROM ONE PLACE        */
/* ========================================================================== */

/**
 * ⭐⭐ THE SIMPLE TIER — 0.20 sim-s. Two independent derivations meeting on the same number:
 *   (1) the psychology literature's simple-reaction constant, ratified into the doctrine at
 *       #272 §0 and carried verbatim into the contract (§2 M-PC.1);
 *   (2) the SHIPPED band's lower endpoint — `markAnchor`'s `0.45 − defending·0.25` at
 *       `defending = 1`, in this engine since Phase 31.9 by a wholly independent route.
 * ⭐ CLOCK RULING (§2 M-PC.1): reaction constants live on the SIM clock because body physics
 * does. The 22.5× scoreboard mapping is display-only and appears nowhere in this file.
 */
export const PC_TIER_SIMPLE_SIM_S = 0.20;
/**
 * ⭐⭐ THE CHOICE TIER — 0.45 sim-s. Same two derivations: the literature's choice-reaction
 * band is 0.4–0.5 s, and `markAnchor`'s band UPPER endpoint (`defending = 0`) is 0.45 — which
 * sits inside it. #297 item 3 rules 0.45 the value of record.
 */
export const PC_TIER_CHOICE_SIM_S = 0.45;
/** APPLIED ticks (the #280 form): the ticks a body's executor is actually held for. */
export const PC_TIER_SIMPLE_TICKS = Math.round(PC_TIER_SIMPLE_SIM_S / DT); // 12
/** APPLIED ticks (the #280 form). */
export const PC_TIER_CHOICE_TICKS = Math.round(PC_TIER_CHOICE_SIM_S / DT); // 27

/** The two tiers, named. `simple` = his book covers the cell; `choice` = it does not. */
export type PcTier = 'simple' | 'choice';
/** The hold length of a tier, in APPLIED ticks. The ONE place either number is read. */
export const pcTierTicks = (tier: PcTier): number =>
  (tier === 'simple' ? PC_TIER_SIMPLE_TICKS : PC_TIER_CHOICE_TICKS);

/**
 * ⭐⭐ M-PC.1b — THE PRE-CUED HOLD (contract §2-AMENDMENT, ruling #369 item 5; built by
 * RC-T0, docs/world-model/RC-T0-PRECUE-SEAM.md).
 *
 * The two tier constants are DEFINED by stimulus uncertainty: simple RT = the stimulus is
 * known and only its TIMING is uncertain; choice RT = its IDENTITY is uncertain. A body who
 * has already resolved part of that identity from OUTWARD evidence (VISION §1's authority
 * model) is a PARTIAL surprise, so his hold INTERPOLATES the two certified tiers by his
 * belief:
 *
 * ```text
 * ticks = round(simple + (choice − simple) · (1 − w · belief))   clamped to [simple, choice]
 * ```
 *
 * `w` (the born-absent gene) and `belief` (a census table) are clamped to [0, 1] first, so
 * `w·belief ∈ [0, 1]` and the raw value already lies inside the band; the outer clamp is
 * belt-and-braces for a caller that hands in something else, and it is what makes
 * "never below SIMPLE, never above CHOICE" (M-PC.1b) structural rather than arithmetical.
 * `Math.round` is ROUND-HALF-UP on the positive values this law takes — stated, because whole
 * applied ticks are the engine's own grain (the #280 form) and the rounding is visible in the
 * ceiling: at `w = 1` and a belief of 0.681429 the hold is 17 ticks, not 12.
 *
 * ⭐ NO NEW CONSTANT: the endpoints are the caller's — in production always
 * `PC_TIER_SIMPLE_TICKS` / `PC_TIER_CHOICE_TICKS`, the two certified tiers, from the ONE place
 * either number is read. PURE.
 */
export const preCueTicks = (
  simple: number, choice: number, w: number, belief: number,
): number => {
  const wc = w < 0 ? 0 : w > 1 ? 1 : w;
  const bc = belief < 0 ? 0 : belief > 1 ? 1 : belief;
  const raw = Math.round(simple + (choice - simple) * (1 - wc * bc));
  return raw < simple ? simple : raw > choice ? choice : raw;
};

/* ========================================================================== */
/* §2 THE CLASSES — THE CENSUS'S OWN LIST, IN THE COMMANDER'S BUILD ORDER      */
/* ========================================================================== */

/**
 * ⭐ THE CLASS LIST AND ORDER, BOUND BY #297 item 5 (the census picks, the commander signs).
 * This array IS the priority order: when several classes fire on the same tick for the same
 * body, the EARLIEST entry here is the surprise he pays for (turnover first-class).
 * The predicates themselves are PC-C0's, reused verbatim; they live at the one detector
 * (`Match.pcLatencyObserve`) because they read public engine state.
 */
export const PC_CLASSES = [
  'turnover', 'knockRelease', 'deflection', 'passRelease', 'shotRelease', 'looseBallSpill',
  'dribblePush',
] as const;
export type PcClass = (typeof PC_CLASSES)[number];
/** Priority rank — lower wins. Derived from the array so the order has ONE home. */
export const PC_CLASS_RANK: Readonly<Record<PcClass, number>> =
  Object.fromEntries(PC_CLASSES.map((k, i) => [k, i])) as Record<PcClass, number>;

/**
 * ⭐ H6 (#297 item 4) — THE SPILLER PAYS. Self-initiated-therefore-free (M-PC.4) applies to
 * INTENDED outcomes; a miscontrol is precisely what processing time is for (承诺代价's own
 * boundary). So `looseBallSpill` is the ONE class whose initiator is inside his own surprise
 * set. Every other class excludes its initiator — which is how the five initiator paths stay
 * untouched without this seam ever naming them.
 */
export const PC_INITIATOR_PAYS: Readonly<Record<PcClass, boolean>> = {
  turnover: false, knockRelease: false, deflection: false, passRelease: false,
  shotRelease: false, looseBallSpill: true, dribblePush: false,
};

/**
 * The perceptual-relevance radius: who is AFFECTED by an event. PC-C0's own stated design
 * input (§FORM, §DOUBTS 6 — it is a choice, not an engine derivation), reused so the seam and
 * the census that sized it speak the same language.
 */
export const PC_RELEVANCE_M = 25;

/* ========================================================================== */
/* §3 THE RECOGNITION BOOK (M-PC.3, the self-cluster form, fifth instantiation)*/
/* ========================================================================== */

/** Whose side of the event a body was on. `own` = the initiator's side. */
export type PcRelation = 'own' | 'opp';

/**
 * ⭐⭐ THE KEY — `class × pressed × relation` (#297 item 4 H1). Every component is a context
 * bit the ENGINE ALREADY WRITES, so the key costs ZERO new information: the class is the
 * event, `pressed` is an opponent inside the engine's own `TOUCH_CONTROL_DIST` of the ball at
 * the event tick (PC-C0's own split, measured per class), and `relation` is which side of it
 * the body stood on (PC-C0 measured the two behave differently — knock action-change 43.5 %
 * opp vs 81.6 % own). The census's arithmetic FORCED this: keyed on the class alone the book
 * saturates inside one match and H-PC.1(a) is unfalsifiable by construction.
 */
export const pcRecognitionKey = (k: PcClass, pressed: boolean, rel: PcRelation): string =>
  `${k}|${pressed ? 'pressed' : 'open'}|${rel}`;

/** Every cell the key can take — 7 × 2 × 2 = 28. Stable order, for instruments. */
export const PC_BOOK_CELLS: readonly string[] = PC_CLASSES.flatMap(
  (k) => [true, false].flatMap((p) => (['own', 'opp'] as PcRelation[]).map(
    (r) => pcRecognitionKey(k, p, r),
  )),
);

/**
 * ⭐⭐ N_COVER — HOW MANY LIVED EXPOSURES OF A CELL COUNT AS RECOGNITION.
 *
 * Derived, not typed (#297 item 4 H1: "N_cover is DERIVED at PC-T0 from the programme's only
 * precedent of book-sufficiency"). The derivation, in full, is printed in the stage doc §N_COVER
 * and reproduced here because the number must not have a second home:
 *
 *   ANCHOR — the L3 τ yardstick (L3-T1-CONVERGENCE-EXAM.md, the programme's ONLY measured
 *   book-sufficiency figure): the rare cell needed **184 labels** before τ cleared.
 *
 *   THE DISCOUNT — L3's book had to ORDER two outcome rates (punished/lunges across two
 *   groups): it needs enough labels for two *rates* to separate at τ. A PC recognition book
 *   only needs COVERAGE of a cell (M-PC.3) — a count, not a comparison, with no second
 *   quantity and no separation to achieve. PC-C0 §DOUBTS 4 states the transfer's own bound in
 *   the census's words: a coverage book "plausibly needs an order of magnitude less".
 *
 *   ⇒ N_cover = floor(184 / 10) = **18**.
 *
 * The order-of-magnitude discount is the census's OWN stated bound, taken at face value; it is
 * a STRUCTURE choice, not an answer, and #297 item 4 H1 requires exactly that it be
 * SENSITIVITY-CHECKED at the exam — PC-T1 reports tier-transition curves at N/2 · N · 2N
 * (9 · 18 · 36; `PC_N_COVER_SENSITIVITY` below is the capability this stage builds).
 */
export const PC_N_COVER = Math.floor(184 / 10);
/** ⭐ #297 item 4 H1: the band the exam must report tier-transition curves across. */
export const PC_N_COVER_SENSITIVITY: readonly number[] = [
  Math.floor(PC_N_COVER / 2), PC_N_COVER, PC_N_COVER * 2,
];

/**
 * ⭐ M-PC.3 — THE RECOGNITION BOOK. Per BODY (by roster slot, the durable identity a
 * substitution carries — `Player.rosterIdx`), per cell, how many exposures HE HAS LIVED.
 *
 *   gene-free · born ABSENT (every count starts at 0, so every body pays CHOICE on his first
 *   encounter with every cell — the novice pays long BY CONSTRUCTION, never by a written rule)
 *   · own exposures only (`note` is called for a body only when HE was inside the relevance
 *   radius of the event) · match-local views (the match holds a reference, never a copy) ·
 *   season reset (`reset` at the League's season boundary) · no franchise writes · nothing in
 *   `info.genome` (#270).
 *
 * PURE: no rng, no world, no time. It counts what it is told and compares to a threshold.
 */
export class PcRecognitionBook {
  /** rosterIdx → (cell key → exposures lived). Absent = born absent, the whole point. */
  private readonly cells = new Map<number, Map<string, number>>();

  /** ONE lived exposure of `key` by the body in roster slot `rosterIdx`. */
  note(rosterIdx: number, key: string): void {
    let row = this.cells.get(rosterIdx);
    if (row === undefined) {
      row = new Map<string, number>();
      this.cells.set(rosterIdx, row);
    }
    row.set(key, (row.get(key) ?? 0) + 1);
  }

  /** How many exposures this body has lived in this cell. 0 for a body who has lived none. */
  count(rosterIdx: number, key: string): number {
    return this.cells.get(rosterIdx)?.get(key) ?? 0;
  }

  /**
   * ⭐ COVERAGE ⇒ THE SIMPLE TIER. `nCover` is a PARAMETER, not a constant read from module
   * scope, so PC-T1 can sweep N/2 · N · 2N over a walked book without re-walking the world
   * (#297 item 4 H1's sensitivity capability). Production always passes `PC_N_COVER`.
   */
  covers(rosterIdx: number, key: string, nCover: number = PC_N_COVER): boolean {
    return this.count(rosterIdx, key) >= nCover;
  }

  /** The tier a body pays for a cell RIGHT NOW. Born absent ⇒ `choice`. */
  tierFor(rosterIdx: number, key: string, nCover: number = PC_N_COVER): PcTier {
    return this.covers(rosterIdx, key, nCover) ? 'simple' : 'choice';
  }

  /** THE SEASON BOUNDARY (M-PC.3). Structural: the whole book is wiped, no decay, no window. */
  reset(): void {
    this.cells.clear();
  }

  /** Read-only view for instruments: rosterIdx → cell → count. Sorted, so it is diffable. */
  snapshot(): Record<number, Record<string, number>> {
    const out: Record<number, Record<string, number>> = {};
    for (const ri of [...this.cells.keys()].sort((a, b) => a - b)) {
      const row = this.cells.get(ri) as Map<string, number>;
      const o: Record<string, number> = {};
      for (const k of [...row.keys()].sort()) o[k] = row.get(k) as number;
      out[ri] = o;
    }
    return out;
  }

  /** Total exposures noted, all bodies, all cells — the fill receipt. */
  get totalExposures(): number {
    let n = 0;
    for (const row of this.cells.values()) for (const v of row.values()) n += v;
    return n;
  }
}

/* ========================================================================== */
/* §4 THE HOLD (M-PC.2) — ONE PER-BODY GATE, COPIED VECTORS                    */
/* ========================================================================== */

/**
 * A body's live latency window. `target`/`face` are the STALE plan: the steering target and
 * facing point his executor produced on the tick BEFORE the event was observable.
 *
 * ⭐⭐ COPIED, NEVER ALIASED — the starred hazard (#297 item 5 and PC-C0 §COMMANDER
 * CORRECTIONS 1). `p.faceTarget = ball.pos` in `GoalkeeperPosition`, `GoalkeeperRush` AND
 * `GoalkeeperSave` holds a LIVE REFERENCE to the ball's own position vector: freezing that
 * reference would freeze nothing at all and leave the keeper omniscient through the hold.
 * These are plain `{x, y}` numbers copied out at capture, and copied again on every read.
 */
export interface PcHold {
  /** The hold is live while `simTick < untilTick`. */
  untilTick: number;
  /** APPLIED ticks the hold was armed for (the tier's own length). */
  ticks: number;
  tier: PcTier;
  /** The class he is paying for — the priority winner at arm time. */
  klass: PcClass;
  /** The book cell that decided the tier. */
  key: string;
  /**
   * ⭐⭐ M-PC.1b (RC-T0): was this arm PRE-CUED — i.e. did an outward-evidence belief reach
   * `arm()` AND survive the book's precedence (a covered cell IGNORES the pre-cue, because the
   * earned route to SIMPLE already wins)? `false` on every arm in every other world, which is
   * every arm in the shipped game.
   */
  preCued: boolean;
  /**
   * ⭐ M-PC.1b (RC-T0): the belief the hold was priced with — a PROBABILITY in [0, 1] (the
   * unit its name claims; canon: "a field carries the unit its name claims"). Exactly `0` when
   * `preCued` is false, so the field never implies a belief nobody formed.
   */
  belief: number;
  /** The tick the hold was (re-)armed on. */
  armedTick: number;
  /** The stale steering target, COPIED. `null` = the stale plan had no target. */
  target: { x: number; y: number } | null;
  /** The stale facing point, COPIED. `null` = he was facing his own motion. */
  face: { x: number; y: number } | null;
  /**
   * The action label his executor was running when the plan was frozen — a STRING, so this
   * module still cannot name a `Player`. Used for ONE thing: H3's receipt (the team layer
   * rewrote his job mid-hold and his legs did not care). It steers nothing.
   */
  actionAtArm: string;
}

/** The per-body memory of the last plan his executor actually applied, COPIED. */
interface PcMemory {
  target: { x: number; y: number } | null;
  face: { x: number; y: number } | null;
  actionType: string;
}

/** Receipt counters — plumbing, never an effect size (#289 item 1). */
export interface PcLatencyLedger {
  /** Events detected, per class (every firing, before relevance). */
  firings: Record<PcClass, number>;
  /** Holds armed, per class. */
  armedByClass: Record<PcClass, number>;
  /** Holds armed, per tier. */
  armedByTier: Record<PcTier, number>;
  /**
   * ⭐⭐ M-PC.1b (RC-T0): arms whose ticks came from the PRE-CUE interpolation instead of
   * `pcTierTicks(tier)`. A plumbing receipt, never an effect size (#289 item 1) — it counts
   * arms that took the branch, including the ones the interpolation returned CHOICE for (a
   * zero gene, a zero belief), which is exactly what makes G-ZERO's "the path is LIVE"
   * observable while the world stays byte-identical.
   */
  preCuedArms: number;
  /** ⭐ THE OVERLAP RULE's own counter: arms that landed on an already-live hold. */
  overlapRestarts: number;
  /** Overlap arms that did NOT extend the expiry (the monotone rule refusing to shorten). */
  overlapNoExtend: number;
  /** Executor ticks actually spent held. */
  heldExecutorTicks: number;
  /** Decision slots suppressed by the AND-gate. */
  decisionsHeld: number;
  /** Exposures written into the books. */
  exposuresNoted: number;
  /** Arms whose stale plan came from a live memory (should equal every arm). */
  armedWithMemory: number;
  /**
   * ⭐ H4: bodies skipped because they were inside the PRE-PROCESSING window.
   * ⭐ AMENDMENT (c) (#298 item 4): counted ON THE CENSUS GRAIN — i.e. AFTER the
   * relevance-radius filter, in PC-C0's own ordering (sentOff → initiator → distance →
   * pre-processed). Before the amendment this counted every pre-processed body ANYWHERE on the
   * pitch, which is not the H4 channel: the H4 channel is bodies who WOULD have been armed.
   */
  preProcessedSkips: number;
  /** ⭐ H3: executor ticks held while the team layer had rewritten the body's action. */
  heldThroughReassignment: number;
  /**
   * ⭐ AMENDMENT (a) (#298 item 4): bodies whose per-gid seat state was CLEARED because a
   * substitution swapped a new identity into the pitch slot. A sub must not inherit the
   * departed body's hold and frozen target.
   */
  subClears: number;
  /** ⭐ AMENDMENT (a): of those, how many were carrying a LIVE hold at the swap. */
  subClearedLiveHolds: number;
  /** ⭐ AMENDMENT (a): of those, how many were carrying a stale-plan MEMORY at the swap. */
  subClearedMemories: number;
  /**
   * ⭐ AMENDMENT (b) (#298 item 4): dead-ball transitions at which live holds were wiped —
   * "a restart voids the surprise's context — closes the clock-skew class".
   */
  deadBallClears: number;
  /** ⭐ AMENDMENT (b): live holds actually wiped by those transitions. */
  deadBallClearedHolds: number;
}

const emptyLedger = (): PcLatencyLedger => ({
  firings: Object.fromEntries(PC_CLASSES.map((k) => [k, 0])) as Record<PcClass, number>,
  armedByClass: Object.fromEntries(PC_CLASSES.map((k) => [k, 0])) as Record<PcClass, number>,
  armedByTier: { simple: 0, choice: 0 },
  preCuedArms: 0,
  overlapRestarts: 0, overlapNoExtend: 0, heldExecutorTicks: 0, decisionsHeld: 0,
  exposuresNoted: 0, armedWithMemory: 0, preProcessedSkips: 0, heldThroughReassignment: 0,
  subClears: 0, subClearedLiveHolds: 0, subClearedMemories: 0,
  deadBallClears: 0, deadBallClearedHolds: 0,
});

/**
 * ⭐ AMENDMENT (d) (#298 item 4) — THE FLAG, RENAMED TO WHAT IT MEASURES, WITH ONE HOME.
 *
 * PC-T0's probe published this predicate as `extended`, which names the OPPOSITE of what
 * happens: the record's expiry differs from `armedTick + 1 + ticks` exactly when the overlap
 * rule's `max()` KEPT THE OLDER EXPIRY — i.e. when the newer, shorter window was REFUSED. (It
 * is the same phenomenon as the ledger's `overlapNoExtend`, observed at record grain instead of
 * arm grain.) The predicate lives here so the name has exactly one home and every instrument
 * reads it rather than re-deriving it under a name of its own choosing.
 */
export const pcHoldKeptOlderExpiry = (
  h: { untilTick: number; armedTick: number; ticks: number },
): boolean => h.untilTick !== h.armedTick + 1 + h.ticks;

/**
 * ⭐⭐ THE SEAT — non-null ONLY in a `pcReactionLatency` world, which is what makes every
 * statement downstream UNREACHABLE rather than merely inert. It owns:
 *   (1) the two season books (handed in by the League, or match-local when nobody hands any);
 *   (2) the per-body HOLDS, and
 *   (3) the per-body MEMORY of the stale plan.
 *
 * PURE with respect to the world: it is told gids, roster slots, ticks and coordinates.
 */
export class PcLatencySeat {
  readonly books: readonly [PcRecognitionBook, PcRecognitionBook];
  /** The N_COVER this seat judges coverage at — `PC_N_COVER` unless an instrument sweeps it. */
  readonly nCover: number;
  readonly ledger: PcLatencyLedger = emptyLedger();
  private readonly holds = new Map<number, PcHold>();
  private readonly memory = new Map<number, PcMemory>();

  constructor(
    books: readonly [PcRecognitionBook, PcRecognitionBook],
    nCover: number = PC_N_COVER,
  ) {
    this.books = books;
    this.nCover = nCover;
  }

  /**
   * M-PC.2's memory. Called by the executor for every body on every tick he is NOT held —
   * with the target that SURVIVED the clamps, i.e. the plan he actually walked. COPIES.
   */
  remember(gid: number, target: { x: number; y: number } | null,
    face: { x: number; y: number } | null, actionType: string): void {
    this.memory.set(gid, {
      target: target === null ? null : { x: target.x, y: target.y },
      face: face === null ? null : { x: face.x, y: face.y },
      actionType,
    });
  }

  /** The live hold for a body, or `null`. `simTick` is the engine's own tick. */
  holdFor(gid: number, simTick: number): PcHold | null {
    const h = this.holds.get(gid);
    if (h === undefined) return null;
    if (simTick >= h.untilTick) {
      this.holds.delete(gid);
      return null;
    }
    return h;
  }

  /**
   * ⭐ ARM (or RE-ARM) a body's latency window.
   *
   * `nowTick` is the tick the detector ran on; the hold covers the NEXT `ticks` applied ticks
   * (`nowTick + 1 … nowTick + ticks`), which is exactly the census's k = 1 grain: k = 1 is the
   * first executor call after the step in which the event became observable.
   *
   * ⭐⭐ THE OVERLAP RULE — MONOTONE RESTART, pinned. A new surprise during a live hold
   * RESTARTS the timer at the NEW event's tier, and the expiry never moves EARLIER:
   * `untilTick = max(oldUntil, nowTick + 1 + ticks)`. Two reasons, both stated so the choice
   * is auditable rather than natural-looking: (i) a body who has not finished processing the
   * first surprise cannot be *helped* by a second one, so a SIMPLE event must not cut a live
   * CHOICE hold short; (ii) monotonicity makes the hold length a deterministic function of the
   * event stream with no ordering hazard inside a tick. ⚠ The stale plan is NOT re-captured on
   * a restart: he has reacted to nothing yet, so there is no newer plan to freeze.
   *
   * ⭐⭐ M-PC.1b — THE OPTIONAL PRE-CUE (contract §2-AMENDMENT; RC-T0's ONE seam in this file).
   * `preCue` absent or `null` ⇒ this method is BYTE-FOR-BYTE what it was: `pcTierTicks(tier)`,
   * nothing else touched. Present:
   *   • the BOOK STILL WINS — if his own earned book covers the cell (`tier === 'simple'`) the
   *     pre-cue is IGNORED entirely (M-PC.3's route to SIMPLE is untouched and an anticipating
   *     experienced body is not faster than simple — the §7 REALITY floor, G-BOOK);
   *   • otherwise the hold length INTERPOLATES the two certified tiers (`preCueTicks`) — and
   *     the `tier` LABEL stays the BOOK's decision, so `armedByTier` keeps counting what the
   *     book decided and no instrument silently re-reads the tier as the hold.
   * The OVERLAP RULE above is untouched and applies to the interpolated `ticks` unchanged. On a
   * restart the record's `preCued`/`belief` describe THIS arm (the newest evidence), while
   * `target`/`face`/`actionAtArm` still inherit the older hold's frozen plan.
   */
  arm(gid: number, rosterIdx: number, side: 0 | 1, klass: PcClass, key: string,
    nowTick: number, preCue?: { belief: number; weight: number } | null): PcHold {
    const tier = this.books[side].tierFor(rosterIdx, key, this.nCover);
    const preCued = preCue !== undefined && preCue !== null && tier !== 'simple';
    const ticks = preCued
      ? preCueTicks(
        PC_TIER_SIMPLE_TICKS, PC_TIER_CHOICE_TICKS,
        (preCue as { belief: number; weight: number }).weight,
        (preCue as { belief: number; weight: number }).belief,
      )
      : pcTierTicks(tier);
    if (preCued) this.ledger.preCuedArms++;
    const mem = this.memory.get(gid);
    if (mem !== undefined) this.ledger.armedWithMemory++;
    const until = nowTick + 1 + ticks;
    const live = this.holds.get(gid);
    const isOverlap = live !== undefined && nowTick < live.untilTick;
    if (isOverlap) {
      this.ledger.overlapRestarts++;
      if (until <= (live as PcHold).untilTick) this.ledger.overlapNoExtend++;
    }
    const hold: PcHold = {
      untilTick: isOverlap ? Math.max((live as PcHold).untilTick, until) : until,
      ticks, tier, klass, key, armedTick: nowTick,
      preCued,
      belief: preCued ? (preCue as { belief: number }).belief : 0,
      // ⭐ the stale plan survives a restart untouched (see the overlap rule above)
      target: isOverlap ? (live as PcHold).target : (mem?.target ?? null),
      face: isOverlap ? (live as PcHold).face : (mem?.face ?? null),
      actionAtArm: isOverlap ? (live as PcHold).actionAtArm : (mem?.actionType ?? ''),
    };
    this.holds.set(gid, hold);
    this.ledger.armedByClass[klass]++;
    this.ledger.armedByTier[tier]++;
    return hold;
  }

  /**
   * ⭐ THE EXPOSURE WRITE (M-PC.3, own exposures only) — AFTER the tier decision, so the event
   * a body is currently paying for never makes itself recognised.
   */
  noteExposure(rosterIdx: number, side: 0 | 1, key: string): void {
    this.books[side].note(rosterIdx, key);
    this.ledger.exposuresNoted++;
  }

  /**
   * ⭐ AMENDMENT (a) (#298 item 4) — A SUB INHERITS NOTHING. `Player.becomeSub` swaps a NEW
   * identity into the SAME pitch slot, so the gid survives while the body does not; without
   * this the arriving man would walk the departed man's live hold and his frozen target.
   *
   * The two maps below are the seat's COMPLETE per-gid state (the holds and the stale-plan
   * memory) — the ledger is aggregate and has no per-gid rows — so clearing both is the whole
   * of "the seat's per-gid state". The BOOK is deliberately untouched: it is keyed by
   * `rosterIdx`, i.e. by the MAN, and the arriving man brings his own row (born absent).
   */
  forgetBody(gid: number): void {
    this.ledger.subClears++;
    if (this.holds.delete(gid)) this.ledger.subClearedLiveHolds++;
    if (this.memory.delete(gid)) this.ledger.subClearedMemories++;
  }

  /**
   * ⭐ AMENDMENT (b) (#298 item 4) — HOLDS CLEAR AT DEAD-BALL TRANSITIONS. The ruling's own
   * words: "a restart voids the surprise's context — closes the clock-skew class". PC-T0
   * §DOUBTS 1 measured the class: `simTick` advances through `kickoff` / `goalPause` /
   * `halftime` while `Match.step` returns before the decide and execute loops, so a hold armed
   * just before a stoppage expired without the body ever paying those ticks (122 of 16,953
   * records straddled one). After this amendment no hold can straddle a stoppage at all, and
   * the football reading matches: everybody got time to process while the ball was dead.
   */
  clearHoldsAtDeadBall(nowTick: number): void {
    this.ledger.deadBallClears++;
    // counted HONESTLY: a map entry whose expiry has already passed is a swept-lazily corpse,
    // not a hold this transition cut short.
    for (const h of this.holds.values()) if (nowTick < h.untilTick) this.ledger.deadBallClearedHolds++;
    this.holds.clear();
  }

  /** Live holds right now (instruments; also the receipt that the map does not leak). */
  get liveHolds(): number { return this.holds.size; }

  /** Read-only view of every live hold, gid-sorted (instruments only). */
  holdSnapshot(): { gid: number; hold: PcHold }[] {
    return [...this.holds.keys()].sort((a, b) => a - b)
      .map((gid) => ({ gid, hold: this.holds.get(gid) as PcHold }));
  }
}
