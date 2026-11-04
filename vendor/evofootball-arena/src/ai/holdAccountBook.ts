// EK T0 — THE DORMANT HOLD-BELIEF SEAM (docs/world-model/EK-T0-HOLD-BELIEF-SEAM.md).
// Contract: docs/world-model/EK-HOLD-EARNED-BELIEF-CONTRACT.md §2 — M-EK.1 (THE
// OBSERVABLE HOLD LABEL), M-EK.2 (THE BELIEF + THE BOOK), M-EK.3 (CONSUMPTION),
// M-EK.4 (SCOPE). Rulings #259 (the contract bound), #260 (EK-C0's measured table),
// #261 (the 街机偏离 verdict + THE FOUR PICKS: W = 10 s · the target shape is the
// MEASURED truth free > pressed > mid · exploration = DOSED-HOLD DRILLS, the
// training-ground venue · consumption = a ZERO-CONSTANT COMPARATIVE VETO).
//
// 持球的账本: a team is born knowing nothing about what holding the ball under any
// perceived pressure costs (#247). The certified counterfactual table the whether seat
// consumes is world-price knowledge wired innate — the #248.2(i) archetype debt. This
// module is the CAPACITY to remember one's OWN holds and how they ended — and only that.
// It holds, per team:
//
//   (1) THE ACCOUNT BOOK (M-EK.2) — per PERCEIVED pressure band, how many holds this
//       team has experienced in that band and how many of them were PUNISHED. The belief
//       it serves is punished/holds, the ZERO-CONSTANT running mean.
//       ⭐ An EMPTY book serves NO belief at all (`null`): a team that has learned
//       nothing knows nothing, and it can veto nothing.
//   (2) THE LABEL LEDGER (M-EK.1) — the state machine that decides, per hold, whether it
//       was punished: the FIRST possession loss by the holding team inside the window.
//       The label CLOSES when the window closes (or at that first loss, or at the
//       whistle), and the book is written only then.
//
// ⭐⭐ EPISTEMIC HONESTY IS THE LAW OF THIS FILE, and it is closed at the IMPORT LIST:
// this module imports NOTHING AT ALL. It cannot see `Match`, `Player`, `Team`, a percept
// snapshot, an rng, an opponent's internals or any census artifact — it takes primitive
// events from its caller and no other input:
//
//   * `noteSeatBand(gid, band, tick)` — the band MY OWN seat placed for MY OWN body at
//     its own decision (no percept pull of this module's own; the seat already read it).
//   * `noteTakeHold(side, band, tSim)` / `noteDrillHold(side, gid, untilTick, tSim)` —
//     a hold MY OWN team EXPERIENCED: the seat's licensed take, or the training-ground
//     drill (`Match.forcedHold`, the venue of record #261.3(iii)).
//   * `observeOwner(side, tSim)` / `observeDeadBall()` — who has the ball and whether it
//     is in play, which every player on the pitch can see.
//   * `expire(tSim)` / `flush()` — the public clock, and the whistle.
//
// ⭐ NO PREDICATES (#200) beyond the ONE the contract asks for. Nothing here decides
// whether an action happens EXCEPT `HoldAccountBook.declinesHold`, the M-EK.3 veto, and
// that is a comparison of the team's OWN two ratios — no threshold, no constant, no
// subsidy (a hold the certified table did not license is never taken, here or anywhere).
//
// Dormant: `ekHoldLearn` / `ekHoldVeto` are hard `false` in every production path, and
// the band itself needs `whetherEye`, which is null in every production path — so no
// instance of anything in this file exists in the shipped game.

/**
 * ⭐⭐ THE LABEL'S WINDOW — 10 sim-seconds, the STRUCTURE of the question, not one of its
 * answers.
 *
 * M-EK.1 traces W from the census family's own committed definitions; EK-C0's frozen half
 * shows the trace (C5 owns no team-possession window, so the DECLARED fallback fires:
 * DV-C0's own loss semantics and its 10 s primary, itself a member of the #218
 * goal-genealogy family). Ruling #261.3(i) then PICKED 10 s of record — the only window
 * at which the world's ordering resolves.
 *
 * ⚠ Per #247 / #248.1 the split is between the SHAPE of the question (structural, legally
 * hand-built: the banding, the window) and its ANSWERS (the risks, which must be EARNED).
 * This constant is on the SHAPE side. No measured rate appears in `src/**` (G-NOTABLE),
 * and the probe's G-TRACE-WINDOW proves this number IS the committed censuses' own
 * primary window by reading THEIR artifacts — instrument → check, never code → table.
 */
export const EK_HOLD_WINDOW_S = 10;

/**
 * The book's width: the arity of the whether seat's OWN perceived pressure band type
 * (`Band = 0 | 1 | 2` in `whetherEye.ts`), which is the certified table's two pressure
 * cuts plus one. STRUCTURE, not an answer; G-TRACE-BANDS reads the cut count off the
 * committed certified table rather than trusting this line.
 */
export const EK_HOLD_BANDS = 3;

/**
 * ⭐ M-EK.2 — THE HOLD ACCOUNT BOOK. Per perceived band: how many holds, how many
 * punished. The belief it serves is `punished / holds` per band — the MARGINAL rate,
 * which is the quantity ruling #256.2 ratified as the book's own (and the quantity
 * EK-C0's table publishes). Zero-constant: a band the team has never held in reads 0.
 *
 * PURE: no rng, no world, no time. It counts what it is told and divides — except for
 * `declinesHold`, which COMPARES two of its own ratios (the M-EK.3 veto).
 */
export class HoldAccountBook {
  /** Closed labels per perceived band (0 free · 1 mid · 2 pressed — the seat's order). */
  readonly holds: number[] = new Array<number>(EK_HOLD_BANDS).fill(0);
  /** Of those, the punished ones. `punished[b] <= holds[b]` by construction. */
  readonly punished: number[] = new Array<number>(EK_HOLD_BANDS).fill(0);

  /** One CLOSED label. Called by the ledger when the label's window has run out. */
  note(band: number, wasPunished: boolean): void {
    if (band < 0 || band >= EK_HOLD_BANDS) return;
    this.holds[band]++;
    if (wasPunished) this.punished[band]++;
  }

  /** Closed labels in the book, all bands. */
  get total(): number {
    let n = 0;
    for (let i = 0; i < EK_HOLD_BANDS; i++) n += this.holds[i];
    return n;
  }

  /**
   * ⭐⭐ THE BELIEF THE BOOK SERVES — or `null` when the book is EMPTY.
   *
   * `null` is not a detail: it is the born-absent semantics preserved through arming. A
   * team that has closed no label at all believes nothing, so nothing can be declined and
   * an armed-but-unlearned world is the shipped world (the G-ZERO analogue, measured).
   */
  beliefVector(): number[] | null {
    if (this.total === 0) return null;
    const out = new Array<number>(EK_HOLD_BANDS).fill(0);
    for (let i = 0; i < EK_HOLD_BANDS; i++) {
      const n = this.holds[i];
      if (n > 0) out[i] = this.punished[i] / n;
    }
    return out;
  }

  /**
   * ⭐⭐ M-EK.3 — THE COMPARATIVE VETO, in its PRE-REGISTERED form (EK-T0 §LAW).
   *
   * `true` ⇔ this team's own book says holding in THIS band is strictly worse than its
   * own pooled experience of EVERY OTHER band:
   *
   *     holds[b] > 0                                   my book speaks HERE
   *     Σ_{b'≠b} holds[b'] > 0                         my book has a CROSS-BAND reference
   *     belief[b] > (Σ punished[b']) / (Σ holds[b'])   strictly worse than my own reference
   *
   * written as an integer cross-multiplication so no float, no epsilon and no tuned
   * number enters. ⭐ THE ONLY LITERAL IS `0`, and it is an EMPTINESS test, not a
   * threshold: an empty book, a one-band book and a tie all decline NOTHING, which is
   * exactly why an armed-but-unlearned world is byte-identical (G-EMPTY).
   *
   * ⭐ NEVER A SUBSIDY (R-B, #64.1): the caller consults this ONLY where the certified
   * table already licensed a hold. It can remove a licensed hold; it can never create
   * one, lengthen one, or price one up.
   */
  declinesHold(band: number): boolean {
    if (band < 0 || band >= EK_HOLD_BANDS) return false;
    const here = this.holds[band];
    if (here === 0) return false;
    let otherHolds = 0;
    let otherPunished = 0;
    for (let i = 0; i < EK_HOLD_BANDS; i++) {
      if (i === band) continue;
      otherHolds += this.holds[i];
      otherPunished += this.punished[i];
    }
    if (otherHolds === 0) return false;
    return this.punished[band] * otherHolds > otherPunished * here;
  }

  /**
   * THE SEASON BOUNDARY (M-EK.2, the M-DV2.2 clause replayed: one season's book, reset at
   * the season boundary). Structural and untuned: no decay, no window, no half-life in
   * slice one, and no configurability the contract does not word.
   */
  reset(): void {
    for (let i = 0; i < EK_HOLD_BANDS; i++) { this.holds[i] = 0; this.punished[i] = 0; }
  }
}

/** A hold the team EXPERIENCED, waiting out its window before its label closes. */
interface PendingHold {
  readonly side: number;
  readonly band: number;
  /** the public clock at the moment the hold was committed. */
  readonly tHold: number;
}

/** One noted hold, published for the instruments only (a dormancy read, never an input). */
export interface NotedHold {
  readonly side: number;
  readonly band: number;
  readonly tSim: number;
  /** 'take' = the seat's own licensed D-HOLD · 'drill' = the training-ground dose. */
  readonly kind: 'take' | 'drill';
  /** ticks between the seat's band placement and this hold (drills only; 0 for a take). */
  readonly bandLagTicks: number;
}

/**
 * ⭐⭐ M-EK.1 — THE HOLD LABEL LEDGER, in-world.
 *
 * The label, restated: a hold experienced by team T at perceived band b is PUNISHED iff
 * the FIRST possession loss by T after that moment is stamped within `EK_HOLD_WINDOW_S`.
 * Every other hold — no loss inside the window at all — closes UNPUNISHED.
 *
 * ⭐ THE LOSS SEMANTICS ARE EK-C0's (thence DV-C0 / #215.3-H1), TRACED not re-invented: a
 * possession segment is a maximal interval of same-owner-TEAM control while the ball is in
 * play, SUSPENDED while it is loose, ended by an OPPONENT ESTABLISHING OWNERSHIP (a LOSS,
 * stamped there) or by the ball going dead (NOT a loss — the chain simply ends). The
 * mechanical rule counts the first loss by T even if a dead ball and a regain intervened,
 * exactly as the census's does.
 *
 * ⭐ THE LABEL CLOSES WHEN THE WINDOW CLOSES, and only then does the book move. At the
 * whistle every still-open label closes UNPUNISHED, because no further loss can arrive
 * (the censored class — declared in §HONESTY, never hidden).
 *
 * PURE apart from the books it writes: no rng, no world, no time of its own — every clock
 * reading is handed in by the caller from the public match clock.
 */
export class HoldLabelLedger {
  /** the team currently in control, or null while the chain is ended/unopened. */
  private chainSide: number | null = null;
  private readonly pending: PendingHold[] = [];
  /** the band the seat last placed per body, with the tick — the drill's index source. */
  private readonly seatBand = new Map<number, { band: number; tick: number }>();
  /** commitments already counted, so a k-tick hold is ONE moment, not k of them. */
  private readonly seenCommitments = new Set<string>();

  constructor(
    /** The two books, indexed by side — owned by the caller so a SEASON can own them. */
    readonly books: readonly [HoldAccountBook, HoldAccountBook],
  ) {}

  /** Closed labels this ledger has written, all teams — the non-vacuity counter. */
  closedLabels = 0;
  /** Holds noted, by provenance — the dormancy reads. */
  takeHolds = 0;
  drillHolds = 0;
  /** ⚠ drill commitments with no usable band: NOT counted, but COUNTED — split by cause. */
  drillHoldsUnbanded = 0;
  /** …because the seat had never placed a band for that body at all. */
  drillHoldsUnseen = 0;
  /** …because the placement was STALE (not the decision this drill displaced). */
  drillHoldsStale = 0;
  /** the widest staleness seen among refused drill holds — a dormancy read. */
  drillStaleMaxTicks = 0;
  /** band placements the seat has handed in — the non-vacuity counter for the index. */
  seatPlacements = 0;
  /** vetoes served (incremented by the caller's one consumption site) — a read, not an input. */
  vetoes = 0;
  /** every noted hold, for the instruments (G-LABEL's re-labelling and the smoke). */
  readonly noted: NotedHold[] = [];

  /**
   * ⭐ THE BAND, from the seat's OWN placement. Called at the whether seat's own decision
   * instant with the band it just placed from this body's own percept — this module
   * pulls no percept of its own and cannot (it imports nothing).
   */
  noteSeatBand(gid: number, band: number, tick: number): void {
    if (band < 0 || band >= EK_HOLD_BANDS) return;
    this.seatPlacements++;
    this.seatBand.set(gid, { band, tick });
  }

  /** ⭐ A TAKE: the armed seat's own licensed D-HOLD, banded by that same decision. */
  noteTakeHold(side: number, band: number, tSim: number): void {
    if (band < 0 || band >= EK_HOLD_BANDS) return;
    this.takeHolds++;
    this.noted.push({ side, band, tSim, kind: 'take', bandLagTicks: 0 });
    this.pending.push({ side, band, tHold: tSim });
  }

  /**
   * ⭐ A DRILL HOLD: the training-ground venue of record (#261.3(iii)). The team really
   * held the ball, so it really experiences the outcome; the INDEX is the band the seat
   * placed AT THE DECISION THE DRILL DISPLACED — the placement on the tick immediately
   * before this commitment began, and no other.
   *
   * ⭐ THE FRESHNESS RULE, and it is not a tuned number: a body under a drill takes the
   * C5 early-return branch, so the seat's LAST placement for it can be arbitrarily old
   * (measured: thousands of ticks). A stale band is not the band at the decision, so a
   * drill hold whose placement is not the immediately preceding tick carries NO band and
   * is NOT counted — it is counted as UNBANDED and published instead. Never guessed.
   * One commitment = one moment.
   */
  noteDrillHold(side: number, gid: number, untilTick: number, tick: number, tSim: number): void {
    const sig = `${gid}|${untilTick}`;
    if (this.seenCommitments.has(sig)) return;
    this.seenCommitments.add(sig);
    const placed = this.seatBand.get(gid);
    if (placed === undefined) { this.drillHoldsUnbanded++; this.drillHoldsUnseen++; return; }
    if (tick - placed.tick > 1) {
      this.drillHoldsUnbanded++;
      this.drillHoldsStale++;
      this.drillStaleMaxTicks = Math.max(this.drillStaleMaxTicks, tick - placed.tick);
      return;
    }
    this.drillHolds++;
    this.noted.push({
      side, band: placed.band, tSim, kind: 'drill', bandLagTicks: tick - placed.tick,
    });
    this.pending.push({ side, band: placed.band, tHold: tSim });
  }

  /**
   * The ball is under a team's control. A change of controlling team is a LOSS by the old
   * one, stamped here — and it closes every one of that team's open labels.
   */
  observeOwner(side: number, tSim: number): void {
    const prev = this.chainSide;
    this.chainSide = side;
    if (prev === null || prev === side) return;
    this.closeOnLoss(prev, tSim);
  }

  /**
   * The ball is dead (or a goal was scored): the chain ends WITHOUT a loss.
   * ⚠ A ball merely LOOSE in open play is neither — the chain is SUSPENDED, not ended
   * (the census's inherited chain rule), so the caller simply says nothing on those ticks.
   */
  observeDeadBall(): void {
    this.chainSide = null;
  }

  /** THE WINDOW SWEEP: every label whose window has run out closes, now, as it stands. */
  expire(tSim: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (tSim <= p.tHold + EK_HOLD_WINDOW_S) continue;
      this.pending.splice(i, 1);
      this.write(p.side, p.band, false);
    }
  }

  /** THE WHISTLE: no loss can arrive now, so everything closes with what it knows. */
  flush(): void {
    while (this.pending.length > 0) {
      const p = this.pending.shift()!;
      this.write(p.side, p.band, false);
    }
  }

  /** Holds still waiting on a label — the dormancy read, never a mechanic input. */
  get openLabels(): number { return this.pending.length; }

  /** THE FIRST LOSS: every open label of the losing team closes, punished iff in-window. */
  private closeOnLoss(side: number, tSim: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.side !== side) continue;
      this.pending.splice(i, 1);
      this.write(p.side, p.band, tSim <= p.tHold + EK_HOLD_WINDOW_S);
    }
  }

  private write(side: number, band: number, punished: boolean): void {
    const book = this.books[side];
    if (book === undefined) return;
    book.note(band, punished);
    this.closedLabels++;
  }
}
