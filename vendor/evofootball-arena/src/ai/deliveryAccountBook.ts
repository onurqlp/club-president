// DV T2-T0 — THE DORMANT LEARNING SEAM (docs/world-model/DV-T2-T0-LEARNING-SEAM.md).
// Contract: docs/world-model/DV-T2-LEARNED-MAP-CONTRACT.md §2 — M-DV2.1 (THE PASS-LEVEL
// LABEL), M-DV2.2 (THE ACCOUNT BOOK), M-DV2.3 (THE WRITE PATH), M-DV2.4 (SCOPE).
// Rulings #255 (the contract bound, the six-source label ledger, the FIFTH REGISTRATION)
// and #256 (T2-C0 banked; the MARGINAL rate ratified as the book's own quantity; the
// rarity fact).
//
// 自己的账本: a team is born knowing nothing about what losing the ball anywhere costs
// (#247, DV-T0 §LAW). This module is the CAPACITY to remember one's own punishments —
// and only that. It holds, per team:
//
//   (1) THE ACCOUNT BOOK (M-DV2.2) — per AIM zone, how many deliveries this team has
//       played into that zone and how many of them were PUNISHED. The belief it serves
//       is the running frequency punished/deliveries, the ZERO-CONSTANT running mean
//       (a zone with no observations reads 0, exactly as `dvLossBeliefVector` degrades).
//       ⭐ An EMPTY book serves NO belief at all (`null`): a team that has learned
//       nothing knows nothing, so the born-absent semantics of the gene survive arming.
//   (2) THE LABEL LEDGER (M-DV2.1) — the state machine that decides, per delivery,
//       whether it was punished: the delivery's possession chain ended in a LOSS and a
//       concession followed inside the window. The label CLOSES when the window closes,
//       and the book is written only then.
//
// ⭐⭐ EPISTEMIC HONESTY IS THE LAW OF THIS FILE, and it is closed at the IMPORT LIST.
// This module imports the belief vector's WIDTH and nothing else. It cannot see `Match`,
// `Player`, `Team`, a percept snapshot, an opponent's internals or any census artifact —
// it takes four kinds of primitive event from its caller and no other input:
//
//   * `noteDelivery(side, zoneIndex)` — MY OWN ball, struck by ME, aimed by ME.
//   * `observeOwner(side, tSim)` / `observeLoose()` / `observeDeadBall()` — who has the
//     ball now, which is what every player on the pitch can see.
//   * `observeConcession(conceding, tSim)` — THE PUBLIC SCOREBOARD and THE PUBLIC CLOCK.
//   * `flush()` — the whistle.
//
// There is no channel here through which a team could learn anything that is not its own
// experience. G-EPI gates the import list and the named members; G-NOTABLE gates that no
// census value (DV-C0's or T2-C0's) is reachable from `src/**` at all.
//
// ⭐ NO PREDICATES (#200). Nothing in this file decides whether an action happens: it
// counts events after the fact. Its conditionals are the ZONE SELECTOR's arithmetic (the
// caller's, from the shipped seat), the window comparison (the label's own definition)
// and the empty-book test (the born-absent rule).
//
// Dormant: `dvLearnedMap` is a hard `false` in every production path, so no instance of
// anything in this file exists in the shipped game.
import { DV_BELIEF_SLOTS } from '../evolution/genome';

/**
 * ⭐⭐ THE LABEL'S WINDOW — 10 sim-seconds, the STRUCTURE of the question, not one of its
 * answers.
 *
 * M-DV2.1: *"a LOSS followed by a concession inside the census's OWN 10 s window"*. The
 * 10 s is DV-C0's primary window, which is itself a member of the #218 goal-genealogy
 * census's `dangerWindowsS` family, and it is T2-C0's pre-registered primary — the window
 * at which the frozen truth table (own 3.7 % > middle 3.0 % > final 1.9 %) was measured.
 *
 * ⚠ Per #247 / #248.1 the split is between the SHAPE of the question (structural, legally
 * hand-built: the zoning, the frame, the window) and its ANSWERS (the hazards, which must
 * be EARNED). This constant is on the SHAPE side, exactly as `DV_THIRD_BOUNDARY_LOCAL_X`
 * is. No measured rate appears in `src/**` (G-NOTABLE), and the probe's G-TRACE-WINDOW
 * proves this number IS the two committed censuses' own primary window by reading THEIR
 * artifacts and comparing — instrument → check, never code → table.
 */
export const DV_LEARN_WINDOW_S = 10;

/**
 * ⭐ M-DV2.2 — THE ACCOUNT BOOK. Per zone: how many deliveries, how many punished.
 *
 * The belief it serves is `punished / deliveries` per zone — the MARGINAL rate, which is
 * the quantity ruling #256.2 ratified as the book's own (and therefore the quantity
 * T2-C0's frozen truth table publishes). Zero-constant: a zone the team has never played
 * into reads 0, which is exactly what `dvLossBeliefVector` serves for a missing slot.
 *
 * PURE: no rng, no world, no time. It counts what it is told and divides.
 */
export class DeliveryAccountBook {
  /** Closed labels per zone, in the shipped `DV_ZONES` order (own · middle · final). */
  readonly deliveries: number[] = new Array<number>(DV_BELIEF_SLOTS).fill(0);
  /** Of those, the punished ones. `punished[z] <= deliveries[z]` by construction. */
  readonly punished: number[] = new Array<number>(DV_BELIEF_SLOTS).fill(0);

  /** One CLOSED label. Called by the ledger when the label's window has run out. */
  note(zoneIndex: number, wasPunished: boolean): void {
    if (zoneIndex < 0 || zoneIndex >= DV_BELIEF_SLOTS) return;
    this.deliveries[zoneIndex]++;
    if (wasPunished) this.punished[zoneIndex]++;
  }

  /** Closed labels in the book, all zones. */
  get total(): number {
    let n = 0;
    for (let i = 0; i < DV_BELIEF_SLOTS; i++) n += this.deliveries[i];
    return n;
  }

  /**
   * ⭐⭐ THE BELIEF THE BOOK SERVES — or `null` when the book is EMPTY.
   *
   * `null` is not a detail: it is the born-absent semantics preserved through arming. A
   * team that has closed no label at all writes no gene, so the DV seat stays `null` and
   * an armed-but-unlearned world is the shipped world (the G-ZERO analogue, measured).
   */
  beliefVector(): number[] | null {
    if (this.total === 0) return null;
    const out = new Array<number>(DV_BELIEF_SLOTS).fill(0);
    for (let i = 0; i < DV_BELIEF_SLOTS; i++) {
      const n = this.deliveries[i];
      if (n > 0) out[i] = this.punished[i] / n;
    }
    return out;
  }

  /**
   * THE SEASON BOUNDARY (M-DV2.2, *"one season's book, reset at the season boundary"*).
   * Structural and untuned: there is no decay, no window and no half-life in slice one —
   * a named later slice owns those, and this stage builds no configurability the contract
   * does not word.
   */
  reset(): void {
    for (let i = 0; i < DV_BELIEF_SLOTS; i++) { this.deliveries[i] = 0; this.punished[i] = 0; }
  }
}

/** One possession chain of one team, while it is still open or still labelling. */
interface OpenChain {
  readonly side: number;
  /** How many deliveries this chain played into each zone. */
  readonly zoneCounts: number[];
}

/** A chain that ended in a LOSS, waiting out its window before its label closes. */
interface PendingLoss {
  readonly side: number;
  readonly zoneCounts: number[];
  /** the public clock at the moment the ball was lost. */
  readonly tLoss: number;
  /** set by the attribution rule; frozen when the window runs out. */
  punished: boolean;
  /** ⭐ one concession attributes to at most ONE loss (the frozen one-to-one rule). */
  used: boolean;
}

/**
 * ⭐⭐ M-DV2.1 — THE LABEL LEDGER, in-world.
 *
 * The label, restated: a delivery aimed into zone z is PUNISHED iff the possession chain
 * it was struck inside ended in a LOSS and a concession by the same team followed inside
 * `DV_LEARN_WINDOW_S`. Every other delivery — the chain survived, or it was lost with no
 * concession behind it — closes UNPUNISHED. The three classes partition the deliveries,
 * which is the accounting T2-C0 gate-checked.
 *
 * ⭐ THE ATTRIBUTION RULE IS T2-C0's / DV-C0's, TRACED, not re-invented: concessions are
 * taken in chronological order and each goes to the LATEST not-yet-attributed loss by the
 * conceding team whose stamp lies in `[t_goal − W, t_goal]`; a loss with no concession is
 * UNPUNISHED. In-world this is causal rather than retrospective — a concession can only
 * ever be offered the losses that have already happened — and that is the SAME assignment,
 * because the census processes goals chronologically too and a later goal can never take a
 * loss an earlier goal already used.
 *
 * ⭐ THE LABEL CLOSES AFTER THE WINDOW, and only then does the book move: a loss whose
 * window is still open is not yet knowledge. At the whistle every still-open label closes
 * with what it knows, because no further concession can arrive.
 *
 * PURE apart from the book it writes: no rng, no world, no time of its own — every clock
 * reading is handed in by the caller from the public match clock.
 */
export class DeliveryLabelLedger {
  private chain: OpenChain | null = null;
  private readonly pending: PendingLoss[] = [];

  constructor(
    /** The two books, indexed by side — owned by the caller so a SEASON can own them. */
    readonly books: readonly [DeliveryAccountBook, DeliveryAccountBook],
    /** ⭐ raised on every closed label, so the caller can re-write the belief it serves. */
    private readonly onBookChanged: (side: number) => void,
  ) {}

  /** Closed labels this ledger has written, all teams — the non-vacuity counter. */
  closedLabels = 0;

  /**
   * ⭐ MY OWN DELIVERY. The chain is opened here if the strike is the first sight of this
   * team's possession: a passer owns the ball by the engine's own guard, so his team
   * having it is not an inference, it is the fact that let the kick through.
   */
  noteDelivery(side: number, zoneIndex: number, tSim: number): void {
    this.observeOwner(side, tSim);
    const c = this.chain;
    if (c === null || c.side !== side) return;
    if (zoneIndex < 0 || zoneIndex >= DV_BELIEF_SLOTS) return;
    c.zoneCounts[zoneIndex]++;
  }

  /** The ball is under a team's control. A change of team is a LOSS by the old one. */
  observeOwner(side: number, tSim: number): void {
    const c = this.chain;
    if (c !== null && c.side === side) return;
    if (c !== null) this.closeLost(c, tSim);
    this.chain = { side, zoneCounts: new Array<number>(DV_BELIEF_SLOTS).fill(0) };
  }

  /**
   * The ball is dead (or a goal was scored): the chain ends WITHOUT a loss.
   * ⚠ A ball merely LOOSE in open play is neither — the chain is SUSPENDED, not ended
   * (T2-C0's inherited chain rule), so the caller simply says nothing on those ticks.
   */
  observeDeadBall(): void {
    const c = this.chain;
    if (c === null) return;
    this.chain = null;
    this.closeSafe(c);
  }

  /**
   * ⭐ THE PUBLIC SCOREBOARD — team `conceding` has just conceded at clock `tSim`. The
   * frozen attribution: the LATEST unused loss of that team inside the window takes it.
   */
  observeConcession(conceding: number, tSim: number): void {
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.side !== conceding || p.used) continue;
      if (p.tLoss > tSim || p.tLoss < tSim - DV_LEARN_WINDOW_S) continue;
      if (best < 0 || p.tLoss > this.pending[best].tLoss) best = i;
    }
    if (best < 0) return;
    this.pending[best].used = true;
    this.pending[best].punished = true;
  }

  /** THE WINDOW SWEEP: every label whose window has run out closes, now, as it stands. */
  expire(tSim: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (tSim <= p.tLoss + DV_LEARN_WINDOW_S) continue;
      this.pending.splice(i, 1);
      this.write(p.side, p.zoneCounts, p.punished);
    }
  }

  /** THE WHISTLE: no concession can arrive now, so everything closes with what it knows. */
  flush(): void {
    const c = this.chain;
    this.chain = null;
    if (c !== null) this.closeSafe(c);
    while (this.pending.length > 0) {
      const p = this.pending.shift()!;
      this.write(p.side, p.zoneCounts, p.punished);
    }
  }

  /** Deliveries still waiting on a label — the dormancy read, never a mechanic input. */
  get openLabels(): number {
    let n = this.chain === null ? 0 : sumOf(this.chain.zoneCounts);
    for (const p of this.pending) n += sumOf(p.zoneCounts);
    return n;
  }

  /**
   * ⚠ EVERY loss enters the pending list, INCLUDING one that carried no delivery. That is
   * not bookkeeping fat: the frozen attribution is ONE-TO-ONE over the team's LOSSES, so a
   * delivery-less loss can legitimately absorb a concession that would otherwise land on
   * an older chain. Dropping it here would silently make this book punish MORE than the
   * census's own rule does. It closes writing nothing.
   */
  private closeLost(c: OpenChain, tSim: number): void {
    this.pending.push({
      side: c.side, zoneCounts: c.zoneCounts, tLoss: tSim, punished: false, used: false,
    });
  }

  private closeSafe(c: OpenChain): void {
    if (sumOf(c.zoneCounts) === 0) return;
    this.write(c.side, c.zoneCounts, false);
  }

  private write(side: number, zoneCounts: readonly number[], punished: boolean): void {
    const book = this.books[side];
    if (book === undefined) return;
    let wrote = false;
    for (let z = 0; z < DV_BELIEF_SLOTS; z++) {
      for (let k = 0; k < zoneCounts[z]; k++) { book.note(z, punished); wrote = true; }
    }
    if (!wrote) return;
    this.closedLabels += sumOf(zoneCounts);
    this.onBookChanged(side);
  }
}

function sumOf(a: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i];
  return n;
}
