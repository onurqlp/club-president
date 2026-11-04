/**
 * ============================================================================
 * IN T1 — THE LOOK (抬头观察): SCANNING AS A BODY ACT
 * ============================================================================
 * Stage doc: `docs/world-model/IN-T1-THE-LOOK.md`.
 * Contract:  `docs/world-model/IN-SNAPSHOT-CONTRACT.md` §2 (M-IN.2 · M-IN.3 · M-IN.4).
 * Census:    `docs/world-model/IN-C0-PERCEPTION-SURFACE.md` §R3 (the o2Look inventory:
 *            "the look CANNOT TURN"; `ObserverGaze` unwired) — the extend-vs-new
 *            homework is ruled row by row in the stage doc's §P2(d).
 * Ordered by COMMANDER RULING #327 item 5.
 *
 * ⭐⭐ THE LAW (M-IN.2, "scanning as an ACT"). IN-T0 gave every body a PRIVATE BOOK and
 * refreshed it at ONE place only — the carrier's chooser gateway. A body therefore
 * refreshed only while he was carrying, and IN-T0 measured what that costs: the book
 * ages to a MEAN of 1,782.59 ticks = 29.71 sim-seconds, with a max of essentially a
 * whole match (IN-T0 §R1). THIS SEAM IS WHAT BUYS THAT BACK, and it buys it at a price:
 *
 *   · THE PASSIVE HALF — SIGHT IS FREE. At his own decision, EVERY body refreshes his
 *     book for the bodies inside the field centred on his HEADING. That is M-IN.1's own
 *     sentence ("refreshed each tick for bodies inside his VISION FIELD"); IN-T0 could
 *     only apply it at the carrier's gateway because #324 item 4 scoped it there. It
 *     costs nothing because having your eyes open costs nothing.
 *   · THE LOOK — A TURN PAID. A body may ELECT to aim his gaze at a body he REMEMBERS
 *     but cannot currently see. The aim is a direction he has to turn onto, so the act
 *     costs `turnTicks = ceil(theta / (TURN_RATE · DT))` — the SHIPPED BK facing-law
 *     turn form, taken by ANCHORED EXTRACTION from its named call site (canon, home
 *     BK-C0 §CORR item 1). During the window he DOES NOT RE-DECIDE and the passive half
 *     is SUSPENDED: his eyes are on the aim, so the picture in front of him goes on
 *     ageing. That is the whole cost, and it is paid in the engine's own time.
 *
 * ⭐ ANY BODY MAY LOOK (#327 item 5, the 接球前观察 story): carrier, off-ball, keeper —
 * one law, no role carve-out (a carve-out would be taste, #200). THE CONSUMER IS
 * UNCHANGED: only `decideCarrier`'s IN-T0 gateway ever PRICES anything off the book, so
 * an off-ball look buys a fresh book for the moment the ball arrives and nothing else.
 *
 * ⭐⭐ THE ELECTION IS PRICED, NOT COACHED (contract §4: an ALL-SCANNING world is a
 * FAILURE mode). ONE CURRENCY — BODY-TICKS OF STALENESS — and a DERIVED threshold of
 * ZERO. For an aim `a`:
 *
 *     gain(a) = Σ over remembered bodies INSIDE field(a) of min(ageTicks, AGE_CAP)
 *     loss(a) = turnTicks(a) × |remembered bodies INSIDE field(heading), OUTSIDE field(a)|
 *     elect argmax(gain − loss), take it iff gain > loss
 *
 * `gain` is the staleness the look erases; `loss` is the staleness it creates, because
 * every body he can see right now and would stop seeing ages for the whole window. Both
 * sides are BODY-TICKS, both are read from HIS OWN BOOK (never from truth — he prices
 * what he believes), and the threshold is 0. No pricing table, no attribute, no gene
 * (M-IN.3), no magnitude chosen by taste (#200).
 *
 * ⭐ THE AGE CAP IS DERIVED, NOT CHOSEN: `IN_LOOK_AGE_CAP_TICKS = ceil(π / (TURN_RATE ·
 * DT))` — the FULL REVERSAL of record, the widest turn the engine's own turn form can
 * charge for (BK-T0 §LAW's own words in `src/sim/Match.ts`: "θ ≤ π ⇒ turnTicks ≤ 29, the
 * full reversal of record"). A memory older than the time it takes to turn all the way
 * round is simply OLD; crediting more would make the benefit unbounded while the cost
 * stayed bounded, and a body would then scan for ever. It is the SAME algebra as the
 * cost, so the two sides cannot drift apart.
 *
 * ⚠ NO NEW MEMORY. The look writes IN-T0's OWN store through IN-T0's OWN writers
 * (`coldStart` / `refresh`, exported from `inSnapshotView.ts` for exactly this) — the
 * book is composed, never duplicated. This module is `inSnapshotView`'s SECOND consumer;
 * the precedent is #327 item 3's ratified second reader of the defence book.
 *
 * ⚠ PHYSICS STAYS TRUTH (M-IN.1). The look writes NO heading, NO `faceTarget`, NO
 * velocity and no action: the engine has ONE facing, and the contract's own §7 REALITY
 * audit fixes the approximation of record — "no eye/head model (the engine has ONE
 * facing — head-independent scanning is approximated by the look act's turn cost)". So
 * the look is charged ONCE, in TIME, and the BK facing law goes on charging the strike
 * turn from the body's untouched heading. Nothing here reads or writes the ball.
 *
 * ⚠ THE PRICE LANDS ON THE SHIPPED DECIDE CADENCE, stated not hidden: `decidePlayer`
 * runs at `AI_INTERVAL`, so a `turnTicks`-tick window costs the body the DECISIONS that
 * fall inside it. The ledger publishes both the ticks charged and the decisions actually
 * lost, so the two are never confused.
 *
 * ⚠ NO NEW TICK, NO NEW CALL SITE: the ONE fork lives at the head of `decidePlayer`,
 * before the carrier / keeper / off-ball dispatch, which is what makes it available to
 * ANY body without a second cadence.
 */
import { DT } from '../sim/constants';
import { TURN_RATE } from '../sim/Player';
import type { Player } from '../sim/Player';
import type { Match } from '../sim/Match';
import {
  coldStart, inFieldDotMin, refresh,
  type InSeenBody, type InSnapshotField, type InSnapshotStore,
} from './inSnapshotView';

/**
 * ⭐ THE TURN FORM, taken from the SHIPPED BK facing law's own line (canon anchored
 * extraction, home BK-C0 §CORR item 1 — the pin suite asserts the named line occurs
 * EXACTLY ONCE in `src/sim/Match.ts` and cross-checks this function against the shipped
 * `bkFacingExtraTicks` itself, so the two can never drift):
 *
 *     `  const turnTicks = Math.ceil(theta / (TURN_RATE * DT));`
 *
 * The ceiling, not a round: the body is not aimed until the tick in which the sweep
 * completes (BK-T0 §LAW's own reasoning, quoted rather than re-derived).
 */
export function inLookTurnTicks(theta: number): number {
  return Math.ceil(theta / (TURN_RATE * DT));
}

/**
 * ⭐ THE AGE CAP — the full reversal, in ticks: `ceil(π / (TURN_RATE · DT))` = 29. The
 * widest turn the shipped form can charge for, used as the ceiling on what a stale
 * memory may be worth. Derived from the same two shipped quantities as the cost.
 */
export const IN_LOOK_AGE_CAP_TICKS = inLookTurnTicks(Math.PI);

/** reader gid → the tick his live look window closes at (exclusive). Per-match transient. */
export type InLookWindows = Map<number, number>;

/**
 * PURE BOOKKEEPING (the BK-T1 / IN-T0 ledger idiom): nothing in the sim ever READS these
 * fields, so they cannot influence a single tick, and every one stays 0 unless the door
 * is armed. They are this stage's receipts.
 */
export interface InLookLedger {
  /** decisions at which the fork ran at all (the denominator of every usage face) */
  decisionsSeen: number;
  /** …of those, decisions at which a look was ELECTED and taken */
  looks: number;
  /** …of those, decisions at which the election ran and DECLINED (no aim beat its price) */
  declines: number;
  /** …of those, decisions at which the body was already inside a live look window */
  lockedDecisions: number;
  /** Σ turnTicks charged over all looks (the look's paid TIME, in TICKS) */
  turnTicksPaid: number;
  /** windows that reached `untilTick` */
  completed: number;
  /** windows cut short by an EXISTING channel (the ball arrived · phase · stun · sent off) */
  aborted: number;
  /** …of those, cut short because the BALL ARRIVED (the 接球前观察 payoff moment) */
  abortedBallArrived: number;
  /** passive refresh passes run (one per non-locked decision) */
  passivePasses: number;
  /** bodies written into a book by the PASSIVE half */
  passiveBodies: number;
  /** bodies written into a book by a LOOK */
  lookBodies: number;
  /**
   * ⭐⭐ THE ATTRIBUTION, in BODY-TICKS: Σ (tick − entry.tick) over every entry each half
   * OVERWROTE. The armed arm arms BOTH halves, so this is what says how much of the
   * staleness buy-back the LOOK itself bought and how much free sight bought.
   */
  passiveAgeErasedTicks: number;
  lookAgeErasedTicks: number;
  /** Σ of the capped ages the elected looks claimed to erase (BODY-TICKS) */
  lookGain: number;
  /** Σ of the losses the elected looks accepted (BODY-TICKS) */
  lookLoss: number;
  /** looks by situation: [carrier, off-ball outfield, keeper] — the non-degeneracy face */
  looksBySituation: number[];
  /** decisions by the same three situations (the matched denominators) */
  decisionsBySituation: number[];
  /** looks per body gid — the body-grain degeneracy check (the DF-T2 lesson) */
  looksByGid: Map<number, number>;
}

export function createInLookLedger(): InLookLedger {
  return {
    decisionsSeen: 0,
    looks: 0,
    declines: 0,
    lockedDecisions: 0,
    turnTicksPaid: 0,
    completed: 0,
    aborted: 0,
    abortedBallArrived: 0,
    passivePasses: 0,
    passiveBodies: 0,
    lookBodies: 0,
    passiveAgeErasedTicks: 0,
    lookAgeErasedTicks: 0,
    lookGain: 0,
    lookLoss: 0,
    looksBySituation: [0, 0, 0],
    decisionsBySituation: [0, 0, 0],
    looksByGid: new Map<number, number>(),
  };
}

/** 0 = he has the ball · 1 = off-ball outfield · 2 = keeper. Situation, never a carve-out. */
export function inLookSituation(p: Player, match: Match): number {
  if (match.ball.owner === p) return 0;
  return p.role === 'GK' ? 2 : 1;
}

/** The elected look: an aim (UNIT vector), its price and the two sides of its price. */
export interface InLookElection {
  /** the gid of the remembered body the aim is taken from */
  aimGid: number;
  ux: number;
  uy: number;
  /** the shipped turn form's own answer for this aim, in TICKS */
  turnTicks: number;
  /** BODY-TICKS of capped staleness this look erases */
  gain: number;
  /** BODY-TICKS of staleness this look creates (what he stops seeing, for the window) */
  loss: number;
}

const bookOf = (store: InSnapshotStore, gid: number): Map<number, InSeenBody> => {
  let book = store.get(gid);
  if (book === undefined) {
    book = new Map<number, InSeenBody>();
    store.set(gid, book);
  }
  return book;
};

/**
 * ⭐ THE REFRESH PASS — IN-T0's refresh law, with the CENTRE as a parameter. A body inside
 * the field centred on (`ux`,`uy`) is written to the reader's book at TRUTH; a body
 * outside it is NOT READ AT ALL (no truth read leaks out of the field). The degenerate
 * guard is IN-T0's, verbatim in shape: a body on top of the reader is FELT, not seen.
 *
 * ⚠ This function WRITES the book and returns its receipt; it prices nothing and hands
 * nothing back to a chooser, so no decision can read a body through it.
 */
export interface InLookRefreshReceipt {
  /** bodies written (cold-started or refreshed) */
  written: number;
  /** BODY-TICKS of staleness this pass ERASED (0 for a cold start — there was no age) */
  erased: number;
}

export function inLookRefreshField(
  reader: Player,
  bodies: readonly Player[],
  ux: number,
  uy: number,
  book: Map<number, InSeenBody>,
  tick: number,
  dotMin: number,
): InLookRefreshReceipt {
  let written = 0;
  let erased = 0;
  for (const body of bodies) {
    if (body === reader || body.sentOff) continue;
    const dx = body.pos.x - reader.pos.x;
    const dy = body.pos.y - reader.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (!(d <= 1e-9 || (ux * dx + uy * dy) / d >= dotMin)) continue;
    const entry = book.get(body.gid);
    if (entry === undefined) {
      book.set(body.gid, coldStart(body, tick));
    } else {
      erased += tick - entry.tick;
      refresh(entry, body, tick);
    }
    written += 1;
  }
  return { written, erased };
}

/**
 * ⭐⭐ THE ELECTION. Reads the reader's OWN BOOK and nothing else about the other bodies —
 * he aims at where he BELIEVES a man is, not at where the man is, and he prices the
 * staleness he BELIEVES he carries. (The roster is walked for identity only; every
 * position in this function comes out of `book`.)
 *
 * A candidate aim is the direction to a remembered body who is OUTSIDE the reader's
 * CURRENT field — because a look at something you can already see is not a look, it is
 * the passive half, and it is free.
 *
 * Deterministic by construction: the roster order is the sim's own, and the improvement
 * test is STRICT, so the first best aim wins every tie.
 */
export function chooseInLook(
  reader: Player,
  bodies: readonly Player[],
  book: ReadonlyMap<number, InSeenBody>,
  tick: number,
  dotMin: number,
): InLookElection | null {
  let best: InLookElection | null = null;
  for (const cand of bodies) {
    if (cand === reader || cand.sentOff) continue;
    const seen = book.get(cand.gid);
    if (seen === undefined) continue; // he cannot aim at a man he has never seen
    const ax = seen.x - reader.pos.x;
    const ay = seen.y - reader.pos.y;
    const al = Math.sqrt(ax * ax + ay * ay);
    if (!(al > 1e-9)) continue; // a remembered position ON him names no direction
    const ux = ax / al;
    const uy = ay / al;
    const c = reader.heading.x * ux + reader.heading.y * uy;
    if (c >= dotMin) continue; // already in field — not a LOOK
    const turnTicks = inLookTurnTicks(Math.acos(c < -1 ? -1 : c > 1 ? 1 : c));
    let gain = 0;
    let loss = 0;
    for (const other of bodies) {
      if (other === reader || other.sentOff) continue;
      const held = book.get(other.gid);
      if (held === undefined) continue; // no memory ⇒ no staleness to erase or to lose
      const qx = held.x - reader.pos.x;
      const qy = held.y - reader.pos.y;
      const ql = Math.sqrt(qx * qx + qy * qy);
      if (!(ql > 1e-9)) continue;
      if ((ux * qx + uy * qy) / ql >= dotMin) {
        const age = tick - held.tick;
        gain += age > IN_LOOK_AGE_CAP_TICKS ? IN_LOOK_AGE_CAP_TICKS : age;
      } else if ((reader.heading.x * qx + reader.heading.y * qy) / ql >= dotMin) {
        loss += turnTicks;
      }
    }
    if (gain <= loss) continue;
    if (best === null || gain - loss > best.gain - best.loss) {
      best = { aimGid: cand.gid, ux, uy, turnTicks, gain, loss };
    }
  }
  return best;
}

/**
 * ⭐⭐ THE ONE FORK's engine half. Returns TRUE when the body must NOT re-decide this
 * decision — either because he is inside a live look window (the time price, being paid)
 * or because he has just spent this decision taking a look (the look IS the act).
 *
 * Every abort is an EXISTING channel (the C7 I3 form): the ball arriving, the phase
 * leaving `playing`, a stun, a sending-off. The seam adds no attack surface and draws no
 * rng.
 *
 * Caller (`PlayerBrain.decidePlayer`) has already established that the door is armed.
 */
export function inLookGate(p: Player, match: Match): boolean {
  const led = match.inLookLedger;
  const tick = match.simTick;
  const open = match.inLookWindows.get(p.gid);
  if (open !== undefined) {
    // ⭐ THE BALL ARRIVING ENDS A LOOK — and it is the 接球前观察 payoff moment: he stops
    // looking and decides immediately, on the book the look just refreshed.
    const ballArrived = match.ball.owner === p;
    const dead = p.sentOff || p.stunTimer > 0 || match.phase !== 'playing';
    if (tick >= open) {
      match.inLookWindows.delete(p.gid);
      led.completed += 1;
    } else if (ballArrived || dead) {
      match.inLookWindows.delete(p.gid);
      led.aborted += 1;
      if (ballArrived && !dead) led.abortedBallArrived += 1;
    } else {
      led.lockedDecisions += 1;
      return true; // the price, being paid: he does not re-decide
    }
  }
  if (p.sentOff) return false;
  const situation = inLookSituation(p, match);
  led.decisionsSeen += 1;
  led.decisionsBySituation[situation] += 1;
  const book = bookOf(match.inSnapshotStore, p.gid);
  const dotMin = inFieldDotMin(match.inSnapshotField as InSnapshotField);
  /* THE PASSIVE HALF — sight is free, and it is what an unlooking body still knows. */
  led.passivePasses += 1;
  const passive = inLookRefreshField(
    p, match.allPlayers, p.heading.x, p.heading.y, book, tick, dotMin,
  );
  led.passiveBodies += passive.written;
  led.passiveAgeErasedTicks += passive.erased;
  /* THE LOOK — priced, elective, and never a pattern. */
  const election = chooseInLook(p, match.allPlayers, book, tick, dotMin);
  if (election === null) {
    led.declines += 1;
    return false;
  }
  const looked = inLookRefreshField(
    p, match.allPlayers, election.ux, election.uy, book, tick, dotMin,
  );
  led.lookBodies += looked.written;
  led.lookAgeErasedTicks += looked.erased;
  match.inLookWindows.set(p.gid, tick + election.turnTicks);
  led.looks += 1;
  led.turnTicksPaid += election.turnTicks;
  led.lookGain += election.gain;
  led.lookLoss += election.loss;
  led.looksBySituation[situation] += 1;
  led.looksByGid.set(p.gid, (led.looksByGid.get(p.gid) ?? 0) + 1);
  return true; // the look IS this decision
}
