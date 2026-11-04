/**
 * ============================================================================
 * IN T0 — THE SNAPSHOT LAW AT THE CARRIER'S CHOOSER GATEWAY
 * ============================================================================
 * Stage doc: `docs/world-model/IN-T0-SNAPSHOT-LAW.md`.
 * Contract:  `docs/world-model/IN-SNAPSHOT-CONTRACT.md` §2 (M-IN.1 · M-IN.3 · M-IN.4).
 * Census:    `docs/world-model/IN-C0-PERCEPTION-SURFACE.md` §R-FIX (the numbers of
 *            record: 255 interpose sites · 79 named-collection gateways · the 81
 *            alias-bound gateway sites this slice's call-graph homework discharges
 *            for the carrier surface).
 * Ordered by COMMANDER RULING #324 item 4.
 *
 * ⭐⭐ THE LAW (M-IN.1, scoped by #324 item 4 to the CARRIER'S CHOOSER ONLY): the
 * body who owns the ball prices his options against a PRIVATE SNAPSHOT of the other
 * bodies. A body inside his VISION FIELD refreshes to TRUTH this decision; a body
 * OUTSIDE it is read at his LAST-SEEN position and velocity. Wrongness during
 * staleness is FREE — no penalty term is added anywhere (M-IN.1's 延迟期间 principle
 * extended from time to space).
 *
 * ⭐ THE VISION FIELD IS THE ENGINE'S OWN BLIND ALGEBRA, ANGLE-ONLY — never a taste
 * cone (#200). Canon, anchored extraction (home BK-C0 §CORR item 1): both fields are
 * derived from ONE named call site each, never a re-typed literal.
 *
 *   · **F2 squareAcross** (the field OF RECORD, IN-C0 §R2's engine-own midpoint):
 *     `kickMisalignment` is `(1 − cosθ)/2` and its OWN doc comment in
 *     `src/sim/mechanics.ts` names the midpoint — the ANCHOR LINE, verbatim:
 *     ` * 0 = striking dead ahead, 0.5 = square across the body, 1 = fully blind.`
 *     The field is therefore `misalign ≤ 0.5`, i.e. a 90° half-angle.
 *   · **F4 contactHalfPrice** (the DECLARED SENSITIVITY ARM, IN-C0 §R2): the CONTACT
 *     blind price at HALF. The ANCHOR LINE, verbatim, in `src/sim/Match.ts`:
 *     `          (0.95 - (speed - 7) * 0.04) * (1 - blind * CONTACT_BLIND_PEN),`
 *     — that factor equals 0.5 exactly when `blind = 0.5 / CONTACT_BLIND_PEN`, so the
 *     field is `misalign ≤ 0.5 / CONTACT_BLIND_PEN` (115.3768°, `dotMin = −0.428571…`,
 *     the census's published value reproduced BY DERIVATION and never typed).
 *
 * ⚠ LINE NUMBERS ARE REPORTED BY THE ARTIFACT, NEVER PINNED HERE — canon anchored
 * extraction fixes the extraction to the NAMED CALL SITE's text (home BK-C0 §CORR
 * item 1); the line number is the thing that drifts.
 *
 * ⚠ NO DISTANCE TERM (IN-C0 §R2 `visionAlgebra.honestLimit`, verbatim): "the blind
 * algebra prices FACING and nothing else — it carries NO distance term, so F1–F4 are
 * ANGLE-ONLY fields." The only shipped range lives in the TASTE-labelled F5 cone,
 * which this slice does not use. A body therefore "sees" a mate 50 m away if he faces
 * him: a NAMED FORK (IN-C0 §R8), not a defect of the derivation.
 *
 * ⚠ POSITION AND VELOCITY ONLY (#324 item 4, verbatim: "returns his LAST-SEEN
 * position/velocity"). `heading` / `bodyDir` reads are NOT staled — the one
 * other-body facing read on the carrier surface (`blockReadiness` inside
 * `effectiveBlockers`) is NAMED OUT in the stage doc's seam map with that provenance.
 *
 * ⚠ NO LOOK (IN-T1's business): nothing here spends time, turns a body, or opens a
 * scan. The field is read off the body's SHIPPED heading, whatever the executor left
 * it at. No new attributes and no new genes (M-IN.3).
 *
 * ⚠ PHYSICS STAYS TRUTH (M-IN.1): this module is imported by exactly one consumer —
 * `decideCarrier` in `src/ai/PlayerBrain.ts` — and the bodies it hands back are used
 * for SCORING only. Every winner is resolved back to its TRUTH object before it
 * reaches an action, a heading or a `perform*` call, so the executor, the steering
 * layer, the contact layer and the ball are untouched.
 */
import { CONTACT_BLIND_PEN } from '../sim/constants';
import type { Player } from '../sim/Player';
import type { Team } from '../sim/Team';

/** The two fields this slice is parameterised over (#324 item 4: the exam walks both). */
export type InSnapshotField = 'F2squareAcross' | 'F4contactHalfPrice';

/**
 * ⭐ THE ANCHORED CEILINGS, in `kickMisalignment`'s own units ((1 − cosθ)/2).
 * F2 is the engine's own NAMED midpoint literal (mechanics.ts:76); F4 is the CONTACT
 * blind price at half, derived from the shipped constant and never typed.
 */
export const IN_FIELD_MISALIGN_MAX: Readonly<Record<InSnapshotField, number>> = {
  F2squareAcross: 0.5,
  F4contactHalfPrice: 0.5 / CONTACT_BLIND_PEN,
};

/** `misalign ≤ max` ⇔ `cosθ ≥ 1 − 2·max`. F2 ⇒ 0; F4 ⇒ −0.42857142857142855. */
export function inFieldDotMin(field: InSnapshotField): number {
  return 1 - 2 * IN_FIELD_MISALIGN_MAX[field];
}

/** One remembered body, as this reader last saw him. Ticks, per the field's name. */
export interface InSeenBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** the sim tick this entry was written at (refresh, or the cold-start seeding) */
  tick: number;
}

/** reader gid → (seen gid → last-seen state). Per-match transient; never serialized. */
export type InSnapshotStore = Map<number, Map<number, InSeenBody>>;

/**
 * PURE BOOKKEEPING (the BK-T1 ledger idiom): nothing in the sim ever READS these
 * fields, so they cannot influence a single tick, and every one stays 0 unless the
 * law is armed. They are the stage's staleness receipts.
 */
export interface InSnapshotLedger {
  /** views built = carrier decisions served by the law */
  viewsBuilt: number;
  /** other bodies resolved through the law (sent-off bodies excluded — see below) */
  bodiesViewed: number;
  /** resolved to TRUTH because the body was inside the reader's field */
  readsInField: number;
  /** resolved to a LAST-SEEN entry (the staleness itself) */
  readsStale: number;
  /** resolved to truth because this reader had never had occasion to see him */
  readsColdStart: number;
  /** Σ (thisTick − entry.tick) over stale reads, in TICKS */
  staleAgeTickSum: number;
  /** max (thisTick − entry.tick) over stale reads, in TICKS */
  staleAgeMaxTicks: number;
}

export function createInSnapshotLedger(): InSnapshotLedger {
  return {
    viewsBuilt: 0,
    bodiesViewed: 0,
    readsInField: 0,
    readsStale: 0,
    readsColdStart: 0,
    staleAgeTickSum: 0,
    staleAgeMaxTicks: 0,
  };
}

/**
 * The per-reader view handed to the chooser: two INDEX-PRESERVING arrays (so
 * `team.players[team.arriver]` still lands on the same body) and the resolution back
 * to truth.
 */
export interface InSnapshotView {
  /** this reader's own side, HIMSELF included as his own TRUTH object */
  readonly mates: Player[];
  /** the opposition, as this reader believes them to stand */
  readonly opps: Player[];
  /** the truth body behind a view body (identity for a body that was never viewed) */
  real(body: Player): Player;
}

/**
 * A stale body is a PROTOTYPE-DELEGATING view of the truth body with its own `pos`
 * and `vel`: `gid`, `role`, `index`, `name`, `attrs`, `traits`, `action`, `wallRun`,
 * `topSpeed`, `sentOff` and every other field resolve through the prototype chain to
 * the real body, so nothing but POSITION and VELOCITY is affected and no field can
 * silently go missing when `Player` grows one.
 */
function staleViewOf(truth: Player, seen: InSeenBody): Player {
  const view = Object.create(truth) as Player;
  (view as { pos: { x: number; y: number } }).pos = { x: seen.x, y: seen.y };
  (view as { vel: { x: number; y: number } }).vel = { x: seen.vx, y: seen.vy };
  return view;
}

/**
 * ⭐⭐ THE COLD-START RULE, PRE-REGISTERED (#324 item 4 asks for it stated AND
 * justified): a body this reader has NEVER had occasion to resolve is seeded with
 * TRUTH at the first read, then ages normally.
 *
 * WHY THIS AND NOT THE ALTERNATIVES:
 *   (a) **Absent ⇒ unreadable** would make the seam a candidate FILTER — a body you
 *       have never looked at would vanish from the pass ladder entirely. That is a
 *       different (and much larger) mechanism than staleness, and #324 item 4 scopes
 *       this slice to "returns his LAST-SEEN position/velocity", not to deletion.
 *   (b) **Seeded from the formation table** would write a POSITION THE READER NEVER
 *       SAW out of a hand-authored lattice — a taste constant in the exact place
 *       #200 forbids one, and `formationSpot` is a live emergent function of the
 *       whole team's state, not a lineup card.
 *   (c) **Truth at first read** is the CONSERVATIVE cold start: it is the only
 *       seeding that adds no error of its own, so every stale read the receipts
 *       count was EARNED by a body leaving the field and moving. The doctrine's
 *       books are born absent; a footballer, by contrast, walks out knowing the
 *       lineup — the first read is that knowledge, and everything after it is
 *       bought by looking.
 *
 * Operationally the first read of a body happens at the reader's FIRST carrier
 * decision, so "seeded at kickoff truth" and "seeded at first read" coincide for
 * every body already on the pitch at kickoff, and a substitute is seeded when he is
 * first priced rather than being born invisible.
 *
 * ⭐ EXPORTED FOR IN-T1 (the LOOK, `src/ai/inLookAct.ts`): the look writes THIS store
 * through THIS writer, so the book is COMPOSED and never duplicated. The rule is
 * unchanged by the export.
 */
export function coldStart(truth: Player, tick: number): InSeenBody {
  return { x: truth.pos.x, y: truth.pos.y, vx: truth.vel.x, vy: truth.vel.y, tick };
}

/** The refresh half of the law. ⭐ Exported for IN-T1's look — composed, not duplicated. */
export function refresh(entry: InSeenBody, truth: Player, tick: number): void {
  entry.x = truth.pos.x;
  entry.y = truth.pos.y;
  entry.vx = truth.vel.x;
  entry.vy = truth.vel.y;
  entry.tick = tick;
}

/**
 * ⭐⭐ THE ONE GATEWAY. Builds this reader's snapshot view of both enumerations, and
 * updates his store as a side effect (a body inside the field is SEEN — that is the
 * refresh law; there is no separate "look").
 *
 * SENT-OFF BODIES are returned as TRUTH and excluded from the ledger: they are not on
 * the pitch, every consumer skips them on `sentOff` (which delegates either way), and
 * counting them would pollute the staleness share with bodies nobody reads.
 *
 * THE READER HIMSELF is his own TRUTH OBJECT, by identity — so the chooser's
 * `mate === p` guards behave exactly as they always did, and a body's knowledge of
 * where his own feet are is not a perception question.
 */
export function buildCarrierSnapshotView(
  reader: Player,
  mates: readonly Player[],
  opps: readonly Player[],
  store: InSnapshotStore,
  tick: number,
  field: InSnapshotField,
  ledger: InSnapshotLedger,
): InSnapshotView {
  const dotMin = inFieldDotMin(field);
  let seen = store.get(reader.gid);
  if (seen === undefined) {
    seen = new Map<number, InSeenBody>();
    store.set(reader.gid, seen);
  }
  const back = new Map<Player, Player>();
  ledger.viewsBuilt += 1;

  const resolve = (body: Player): Player => {
    if (body === reader || body.sentOff) return body;
    ledger.bodiesViewed += 1;
    const dx = body.pos.x - reader.pos.x;
    const dy = body.pos.y - reader.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    // A body ON TOP of the reader has no direction to be facing: he is felt, not
    // seen, and reads as in-field (the degenerate guard, never a range term).
    const inField = d <= 1e-9
      || (reader.heading.x * dx + reader.heading.y * dy) / d >= dotMin;
    const entry = seen!.get(body.gid);
    if (inField) {
      if (entry === undefined) seen!.set(body.gid, coldStart(body, tick));
      else refresh(entry, body, tick);
      ledger.readsInField += 1;
      return body;
    }
    if (entry === undefined) {
      // COLD START: never had occasion to see him ⇒ truth once, then it ages.
      seen!.set(body.gid, coldStart(body, tick));
      ledger.readsColdStart += 1;
      return body;
    }
    const age = tick - entry.tick;
    ledger.readsStale += 1;
    ledger.staleAgeTickSum += age;
    if (age > ledger.staleAgeMaxTicks) ledger.staleAgeMaxTicks = age;
    const view = staleViewOf(body, entry);
    back.set(view, body);
    return view;
  };

  return {
    mates: mates.map(resolve),
    opps: opps.map(resolve),
    real: (body: Player): Player => back.get(body) ?? body,
  };
}

/**
 * ⭐⭐ THE SEAM'S SHAPE, and WHY IT IS THIS SHAPE (the pinned-source constraint, made a
 * virtue): the carrier's chooser consumes its bodies through the two `Team.players`
 * enumerations, and a dozen of those exact source lines are PINNED VERBATIM by other
 * seams' permanent test suites (`ptpPassLead` · `dlcDeliveryChoice` · `dlcStrikePlane` ·
 * `dvDeliveryValue`). ⭐ A PINNED TEST IS A STOP, NEVER AN EDIT (the house rule stated in
 * `PlayerBrain.ts`'s own DLC-T0s §SEAM comment). So the law may not RENAME a single read:
 * it SHADOWS the two `Team` bindings instead, and every one of the chooser's ~30 gateway
 * consumptions stays byte-identical in source while resolving to a snapshot at run time.
 *
 * The shadow is a PROTOTYPE-DELEGATING view whose only own property is `players`:
 * `localX`, `attackDir`, `oppGoal`, `genome`, `policies`, `mode`, `mentality`, `arriver`,
 * `overlapper`, `staleTime` and everything else resolve through the chain to the real
 * team, so nothing but the ENUMERATION is affected.
 *
 * ⚠ READ-ONLY BY CONTRACT: the carrier's chooser writes nothing onto `team`/`opp` (a
 * write would land on the shadow and be lost). That invariant is pinned by the suite, not
 * assumed here.
 */
export function snapshotTeamView(team: Team, players: readonly Player[]): Team {
  const view = Object.create(team) as Team;
  (view as { players: readonly Player[] }).players = players;
  return view;
}
