// L3 T0 — THE DORMANT DEFENCE-BOOK SEAM (docs/world-model/L3-T0-DEFENCE-BOOK-SEAM.md).
// Contract: docs/world-model/CB-L3-DEFENCE-BOOK-CONTRACT.md §2 — M-L3.1 (THE OBSERVABLE
// LUNGE LABEL), M-L3.2 (THE BOOK), M-L3.3 (CONSUMPTION, DECLINE-ONLY), M-L3.4 (SCOPE).
// Rulings #277 (the contract bound), #278 (the label pick NOT ratified — the window
// confound), ⭐⭐ #279.3 (THE LABEL RULED: carrier-anchored separation gained over an
// ENGINE-DERIVED COMMON window, grain g2 — reckless vs controlled), #279.4 (dispatched).
//
// 防守的账本: 扑了 → 被过 → 受罚. Nothing in this world learns from being beaten — a body
// that was taken away from five times dives exactly as readily the sixth (the #274 residual
// disease "还有点乱抢"; L3-C0 measured it at its purest: the armed standing challenge wins
// 6 % of the time and the swarm still throws it, and the restraint that already exists thins
// exactly where arrival is fastest). This module is the CAPACITY to remember one's OWN
// lunges and how they ended — and only that. It holds, per team:
//
//   (1) THE ACCOUNT BOOK (M-L3.2) — per ARRIVAL GROUP, how many labelled (missed) lunges this
//       team has experienced there and how many of them were PUNISHED. The belief it serves is
//       punished/lunges, the ZERO-CONSTANT running mean.
//       ⭐ An EMPTY book serves NO belief at all (`null`): a team that has learned nothing
//       knows nothing, and it can veto nothing.
//   (2) THE LABEL LEDGER (M-L3.1) — the state machine that decides, per MISSED lunge, whether
//       it was punished: did the carrier he dived at end up FURTHER AWAY once the common
//       window had run? The label CLOSES when that window closes, and the book moves only then.
//
// ⭐ EPISTEMIC HONESTY, closed at the IMPORT LIST: this module imports the engine's own motion
// constants and NOTHING else — the `carryBeat.ts` form. It cannot name `Match`, `Player`,
// `Team`, a percept snapshot, an rng, an opponent's internals or any census artifact.
// Everything else it is told arrives as PRIMITIVE NUMBERS from its caller:
//
//   * `noteMiss(side, group, tSim, takerGid, carrierGid, sep0)` — MY OWN body missed a lunge
//     from MY OWN arrival group, and this is how far he was from the man he dived at.
//   * `observeSeparation(key, sep, tSim)` — how far those two bodies are apart NOW, which
//     anyone standing on the pitch can see, and the PUBLIC clock.
//   * `censor(key)` / `flush()` — an unreadable pair, and the whistle.
//
// ⭐ NO PREDICATES (#200) beyond the ONE the contract asks for. Nothing here decides whether an
// action happens EXCEPT `DefenceAccountBook.declinesLunge`, the M-L3.3 veto, and that is a
// comparison of the team's OWN two ratios — no threshold, no constant, no subsidy.
//
// ⭐ THERE IS NO GENE. This seam writes no genome field, adds no `GENE_KEYS` entry and
// serializes nothing, so it has no Lamarck surface at all (the EK-T0 improvement, inherited as
// a prohibition rather than a mitigation — G-NOLAMARCK measures the absence).
//
// Dormant: `l3DefenceLearn` / `l3DefenceVeto` are hard `false` in every production path, so no
// instance of anything in this file exists in the shipped game.
import { ACCEL, TURN_RATE } from '../sim/Player';
import { CB_TACKLE_RADIUS } from '../sim/carryBeat';

/**
 * ⭐⭐ THE ARRIVAL CUT — `v* = sqrt(2·ACCEL·R_TACKLE)`, the arrival speed that CANNOT be braked
 * inside the challenge radius (`v*²/(2a) = R` exactly). CB-C0's overcommitment identity, and
 * the family L3-C0/L3-C0b banded every lunge by; RE-DERIVED here from the same two engine
 * constants rather than imported from either census (#247: the SHAPE is hand-built, the
 * ANSWERS are earned).
 *
 * ⚠ Deliberately NOT `carryBeat.overcommitSpeed(body.accel)`: that takes a body's OWN
 * pace-scaled acceleration, and the census's band edge is the population constant. The book
 * must index what the censuses measured, or T1's yardstick and the book speak different
 * languages (#256.2).
 */
export const L3_RECKLESS_ARRIVAL = Math.sqrt(2 * ACCEL * CB_TACKLE_RADIUS);

/**
 * ⭐⭐ THE LABEL'S WINDOW — DERIVED FROM ENGINE CONSTANTS ONLY (#279.3(2)), NEVER TYPED.
 *
 * #278.2(i)/#279 ruled the window confound: a label whose stopwatch is a function of the very
 * band it indexes learns its own clock (68 % of the original pick's gradient was exactly that).
 * The cure is a COMMON window — the same number of seconds for every group — and the ruling
 * names the family: THE STATIONARY MISSER'S RECOVERY BOUND, i.e. CB-T0's own three-leg recovery
 * law (`|v|/a + θ/TURN_RATE + sqrt(2d/a)`, banked #267) evaluated at the worst case a missed
 * challenge can present to a body carrying no momentum out of it:
 *
 *     brake = 0                        he arrived at rest
 *     turn  = π / TURN_RATE            the widest angle a body can be asked to turn through
 *     close = sqrt(2·R_TACKLE/ACCEL)   the gap is at most the challenge radius — the distance
 *                                      inside which the engine offers the duel at all, and
 *                                      exactly CB-T0's own duel horizon
 *
 * The only numerals are the algebra itself (the 2 of the braking identity, π as the half-turn).
 * No measured value from any census is reachable from `src/**` (G-NOTABLE), and no duration is
 * typed: change the engine's acceleration and this window moves with it, which is what makes it
 * the WORLD's stopwatch rather than the instrument's.
 */
export const L3_DEFENCE_WINDOW_S = Math.sqrt((2 * CB_TACKLE_RADIUS) / ACCEL) + Math.PI / TURN_RATE;

/**
 * The book's width: the arity of the RULED grain (#279.3(3) — **g2**, RECKLESS vs CONTROLLED).
 * The shape of the punishment is a STEP, not a ladder (both censuses); the football lesson is
 * binary ("don't dive at full tilt"); and the binding group's fill is least starved at the
 * coarsest grain. STRUCTURE, not an answer. g3 is the ruling's NAMED fallback, for T1.
 */
export const L3_DEFENCE_GROUPS = 2;

/** CONTROLLED — he arrived at a speed his own body could still have braked inside the radius. */
export const L3_GROUP_CONTROLLED = 0;
/** RECKLESS — the OVERCOMMITTED band: his own arrival speed was at or above `v*`. */
export const L3_GROUP_RECKLESS = 1;

/**
 * ⭐ THE INDEX (M-L3.1) — the group of an arrival, from the lunger's OWN speed at his own
 * decision tick. It is his self-percept: his own velocity, which his own motion already is.
 * The census's own g2 order is preserved (controlled first, OVERCOMMITTED second).
 */
export function arrivalGroup(speed: number): number {
  return speed >= L3_RECKLESS_ARRIVAL ? L3_GROUP_RECKLESS : L3_GROUP_CONTROLLED;
}

/**
 * ⭐ M-L3.2 — THE DEFENCE ACCOUNT BOOK. Per arrival group: how many labelled lunges, how many
 * punished. The belief it serves is `punished / lunges` — the MARGINAL rate (#256.2), which is
 * the quantity both censuses publish.
 *
 * ⚠ `lunges[g]` counts CLOSED LABELS, and only a MISSED lunge carries a label (§SHARP 1): the
 * ruling defines the label "after a MISSED lunge", and it FORMALLY REJECTED `P(won)` — a
 * denominator of every lunge would smuggle that rejected candidate back in through the
 * denominator. The fired-lunge count lives on the ledger as a read, never as a book cell.
 *
 * PURE: no rng, no world, no time. It counts what it is told and divides — except for
 * `declinesLunge`, which COMPARES two of its own ratios (the M-L3.3 veto).
 */
export class DefenceAccountBook {
  /** Closed labels per arrival group (0 controlled · 1 reckless — the census's g2 order). */
  readonly lunges: number[] = new Array<number>(L3_DEFENCE_GROUPS).fill(0);

  /** Of those, the punished ones. `punished[g] <= lunges[g]` by construction. */
  readonly punished: number[] = new Array<number>(L3_DEFENCE_GROUPS).fill(0);

  /** One CLOSED label. Called by the ledger when the label's window has run out. */
  note(group: number, wasPunished: boolean): void {
    if (group < 0 || group >= L3_DEFENCE_GROUPS) return;
    this.lunges[group]++;
    if (wasPunished) this.punished[group]++;
  }

  /** Closed labels in the book, all groups. */
  get total(): number {
    let n = 0;
    for (let i = 0; i < L3_DEFENCE_GROUPS; i++) n += this.lunges[i];
    return n;
  }

  /**
   * ⭐⭐ THE BELIEF THE BOOK SERVES — or `null` when the book is EMPTY.
   *
   * `null` is not a detail: it is the born-absent semantics preserved through arming. A team
   * that has closed no label at all believes nothing, so nothing can be declined and an
   * armed-but-unlearned world is the shipped world (the G-ZERO analogue, measured).
   */
  beliefVector(): number[] | null {
    if (this.total === 0) return null;
    const out = new Array<number>(L3_DEFENCE_GROUPS).fill(0);
    for (let i = 0; i < L3_DEFENCE_GROUPS; i++) {
      const n = this.lunges[i];
      if (n > 0) out[i] = this.punished[i] / n;
    }
    return out;
  }

  /**
   * ⭐⭐ M-L3.3 — THE DECLINE-ONLY VETO, in the EK-T0 form PORTED VERBATIM (that stage's
   * `HoldAccountBook.declinesHold`, identifier-for-identifier; gPort proves the port by token
   * comparison rather than asserting it).
   *
   * `true` ⇔ this team's own book says lunging from THIS arrival group is strictly worse than
   * its own pooled experience of EVERY OTHER group:
   *
   *     lunges[g] > 0                                    my book speaks HERE
   *     Σ_{g'≠g} lunges[g'] > 0                          my book has a CROSS-GROUP reference
   *     belief[g] > (Σ punished[g']) / (Σ lunges[g'])    strictly worse than my own reference
   *
   * written as an integer cross-multiplication so no float, no epsilon and no tuned number
   * enters. ⭐ THE ONLY LITERAL IS `0`, and it is an EMPTINESS test, not a threshold: an empty
   * book, a one-group book and a tie all decline NOTHING, which is exactly why an
   * armed-but-unlearned world is byte-identical (gZero).
   *
   * ⭐ NEVER A SUBSIDY (R-B, #64.1): the caller consults this ONLY where the engine's own gates
   * have already licensed the challenge. It can remove a lunge; it can never create one, and
   * there is no branch on which a belief makes a lunge MORE likely. A wrong book therefore
   * costs PATIENCE, never recklessness — the fail-safe direction #279.3(4) names.
   */
  declinesLunge(group: number): boolean {
    if (group < 0 || group >= L3_DEFENCE_GROUPS) return false;
    const here = this.lunges[group];
    if (here === 0) return false;
    let otherLunges = 0;
    let otherPunished = 0;
    for (let i = 0; i < L3_DEFENCE_GROUPS; i++) {
      if (i === group) continue;
      otherLunges += this.lunges[i];
      otherPunished += this.punished[i];
    }
    if (otherLunges === 0) return false;
    return this.punished[group] * otherLunges > otherPunished * here;
  }

  /**
   * THE SEASON BOUNDARY (M-L3.2): one season's book, wiped at the boundary. Structural and
   * untuned: no decay, no window, no half-life in slice one, and no configurability the
   * contract does not word.
   */
  reset(): void {
    for (let i = 0; i < L3_DEFENCE_GROUPS; i++) { this.lunges[i] = 0; this.punished[i] = 0; }
  }
}

/** A missed lunge whose label is still open — waiting out the common window. */
export interface PendingLunge {
  readonly key: number;
  /** the side whose book this label will move — the LUNGER's own team (G-OWNEVENTS). */
  readonly side: number;
  readonly group: number;
  /** the public clock at the instant the lunge missed (t0). */
  readonly tMiss: number;
  readonly takerGid: number;
  /** ⭐ the CARRIER he dived at (#266.2(i)): the anchor is the man, never the ball. */
  readonly carrierGid: number;
  /** `|taker − carrier|` at t0. */
  readonly sep0: number;
}

/** One closed label, published for the instruments only (a dormancy read, never an input). */
export interface NotedLunge {
  readonly side: number;
  readonly group: number;
  readonly tMiss: number;
  readonly tClose: number;
  readonly sep0: number;
  readonly sepClose: number;
  readonly punished: boolean;
}

/**
 * ⭐⭐ M-L3.1 — THE LUNGE LABEL LEDGER, in-world.
 *
 * The label, restated (#279.3(1), the ruled one): a MISSED lunge by team T from arrival group g
 * is PUNISHED iff the CARRIER he dived at had gained separation over the COMMON window —
 * `sep(t0 + W) − sep(t0) ≥ 0`, with `sep(t) = |taker − CARRIER|` and the threshold ZERO metres.
 * A won lunge carries no label; a withheld challenge carries no label; and a window the whistle
 * (or an unreadable pair) truncates is CENSORED — it LEAVES the denominator and is counted, it
 * is never a zero (L3-C0/C0b's own rule, inherited so the book and T1's yardstick measure the
 * same quantity).
 *
 * PURE apart from the books it writes: no rng, no world, no geometry and no time of its own —
 * every position, every distance and every clock reading is handed in by the caller.
 */
export class LungeLabelLedger {
  constructor(
    /** The two books, indexed by side — owned by the caller so a SEASON can own them. */
    readonly books: readonly [DefenceAccountBook, DefenceAccountBook],
  ) {}

  /** Lunges the engine FIRED, per group — a read (the no-subsidy meter), never a book cell. */
  readonly fired: number[] = new Array<number>(L3_DEFENCE_GROUPS).fill(0);

  /** Missed lunges this ledger opened a label for — the non-vacuity counter. */
  opened = 0;

  /** Labels this ledger has CLOSED and written, all teams. */
  closedLabels = 0;

  /** Labels that left the denominator (whistle-truncated or unreadable) — counted, never zeroed. */
  censored = 0;

  /** vetoes served (incremented by the caller's one consumption site) — a read, not an input. */
  vetoes = 0;

  /** every closed label, for the instruments (gLabel's re-labelling and the smoke). */
  readonly noted: NotedLunge[] = [];

  private nextKey = 0;

  private readonly pending: PendingLunge[] = [];

  /** A lunge the engine fired — the meter the DECLINE-ONLY property is measured against. */
  noteFired(group: number): void {
    if (group < 0 || group >= L3_DEFENCE_GROUPS) return;
    this.fired[group]++;
  }

  /**
   * ⭐ A MISSED LUNGE: the label opens here, at t0. `sep0` is the carrier-anchored separation
   * the caller read at this very instant; the ledger computes no geometry of its own.
   */
  noteMiss(
    side: number, group: number, tSim: number, takerGid: number, carrierGid: number, sep0: number,
  ): void {
    if (group < 0 || group >= L3_DEFENCE_GROUPS) return;
    if (side < 0 || side >= this.books.length) return;
    this.opened++;
    this.nextKey++;
    this.pending.push({
      key: this.nextKey, side, group, tMiss: tSim, takerGid, carrierGid, sep0,
    });
  }

  /** The labels still waiting on their window — the caller reads the pair off each one. */
  get open(): readonly PendingLunge[] { return this.pending; }

  /** Labels still open — a dormancy read, never a mechanic input. */
  get openLabels(): number { return this.pending.length; }

  /**
   * THE WINDOW TEST, applied to ONE open label with the separation its two bodies show NOW.
   * Before `t0 + W` nothing happens (the label is not yet knowledge); at or after it the label
   * CLOSES, punished iff the carrier gained (or held) separation over the window.
   */
  observeSeparation(key: number, sep: number, tSim: number): void {
    const i = this.pending.findIndex((p) => p.key === key);
    if (i < 0) return;
    const p = this.pending[i];
    if (tSim < p.tMiss + L3_DEFENCE_WINDOW_S) return;
    this.pending.splice(i, 1);
    // ⭐ THE RULED PREDICATE, and the threshold is ZERO METRES (no constant is introduced).
    const punished = sep - p.sep0 >= 0;
    this.noted.push({
      side: p.side, group: p.group, tMiss: p.tMiss, tClose: tSim,
      sep0: p.sep0, sepClose: sep, punished,
    });
    const book = this.books[p.side];
    if (book !== undefined) book.note(p.group, punished);
    this.closedLabels++;
  }

  /** An unreadable pair: CENSORED — out of the denominator, counted, never a zero. */
  censor(key: number): void {
    const i = this.pending.findIndex((p) => p.key === key);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.censored++;
  }

  /** THE WHISTLE: every window the full-time whistle truncated is CENSORED, not resolved. */
  flush(): void {
    this.censored += this.pending.length;
    this.pending.length = 0;
  }
}
