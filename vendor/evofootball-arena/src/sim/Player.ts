import { v2, type V2 } from '../utils/vec';
import { facingCosine, facingFactor } from './bodyFacing';
import { PLAYER_CORE_RADIUS, STAMINA_DRAIN, STAMINA_RECOVERY } from './constants';
import type { PlayerAttributes } from '../evolution/playerGenome';
import { traitsOf, type Trait } from '../evolution/traits';
import { TEAM_SIZE, type ActionState, type Role, type Side } from './types';

/** Physical top speed by role (m/s) before pace/stamina scaling. */
const BASE_SPEED: Record<Role, number> = { GK: 6.4, DF: 7.0, MF: 7.3, WG: 7.9, ST: 7.7 };
export const ACCEL = 14; // m/s^2 toward desired velocity

/**
 * Body turn rate (rad/s), Phase 27: heading sweeps toward the movement
 * direction instead of snapping to it, so a 180° cut takes ~0.48s of visible
 * rotation. Velocity itself is already inertia-bound by ACCEL — this cap is
 * what the eye (and the kick-orientation mechanics) read as "facing".
 */
export const TURN_RATE = 6.5;
// cos/sin of the per-step turn cap, cached per dt (the sim always uses DT).
let turnDt = -1;
let turnCos = 1;
let turnSin = 0;

export class Player {
  /** Index within team (0..5, slot order GK/DF/MF/WGL/WGR/ST). */
  readonly index: number;
  /** Global id across both teams (0..11), = side * TEAM_SIZE + index. */
  readonly gid: number;
  readonly side: Side;
  readonly role: Role;
  /**
   * Roster row this body's stats land on (Phase 61): a starter's slot index,
   * a substitute's bench row. The PLAYER OBJECT is the pitch slot — a sub
   * swaps its identity in place (`becomeSub`), so every gid-keyed reference
   * (marks, renderer models, action targets) survives the change.
   */
  rosterIdx: number;
  /** Identity fields — mutated ONLY by becomeSub (the bench, Phase 61). */
  name: string;
  /** Attribute genes (squad DNA) — pace/technique/finishing/defending/reflexes. */
  attrs: PlayerAttributes;

  pos = v2();
  vel = v2();
  heading = v2(1, 0);
  /**
   * World-model body direction (M0): the existing capped-rate heading is the
   * canonical facing state. Exposing it by semantic name adds no second state
   * that could drift, and it remains independent of velocity direction.
   */
  get bodyDir(): Readonly<V2> {
    return this.heading;
  }
  /** Stable kinematic core; interaction reach lives outside this disc. */
  get coreRadius(): number {
    return PLAYER_CORE_RADIUS;
  }
  /** Set every frame by the action executor; physics chases it. */
  desiredVel = v2();
  /**
   * ⭐⭐ BF T0 — THE FACING-COST DEPTH (docs/world-model/BF-T0-FACING-COST-SEAM.md;
   * contract BF-BODY-FACING-CONTRACT.md §2 M-BF.1; ruling #375 item 3). ZERO on every
   * shipped body: `Match` writes `BF_DEPTH` onto every body of both teams (and onto a
   * substitute as he enters) ONLY when it was constructed with `bfFacingCost: true`.
   * `physicsStep` branches on `this.facingDepth > 0`, so the shipped path executes NO
   * new arithmetic — the branch reads a field and compares it, and nothing else.
   * ⚠ UNIT-NAME TRUTH (canon, ruling #294 item 3): a DEPTH (how much speed is taken
   * away at 90°+), not the fraction kept — the fraction kept is `1 − facingDepth`.
   */
  facingDepth = 0;
  /**
   * When set (by the executor, per frame), heading turns toward this point
   * instead of the movement direction — keepers backpedal FACING the play
   * (27.5). Holds a live reference (e.g. ball.pos); cleared each frame.
   */
  faceTarget: V2 | null = null;

  stamina = 1;
  staminaSpent = 0;
  distance = 0;

  action: ActionState = { type: 'HoldPosition', scores: [] };
  decisionTimer = 0;
  kickCooldown = 0;
  tackleCooldown = 0;
  /**
   * Recovery stun (Phase 27): a dispossessed carrier stumbles and a beaten
   * lunger picks themself up — movement is heavily damped while it runs, and
   * a stunned player can't control a loose ball or tackle.
   */
  stunTimer = 0;
  /**
   * Keeper hold (Phase 27.2): after claiming the ball a keeper scoops it up
   * and holds it briefly — untackleable, ball carried in the hands — before
   * distributing. Never set for restart first touches (goal kicks stay quick).
   */
  gkHoldTimer = 0;
  /**
   * Discrete touches (Phase 36): time until this carrier may PUSH the ball
   * again. Set at capture so the first decision happens ON the ball (the
   * settle touch and the pass game keep their timing); a decision that
   * keeps Dribble releases the next push.
   */
  touchTimer = 0;
  /** Display-only: renderers play a lunge animation while this runs. */
  tackleAnimTimer = 0;
  /** Display-only: renderers play a keeper dive while this runs (27.4). */
  saveAnimTimer = 0;
  /**
   * ⭐⭐ GK T0b §M-GK.1 — THE DIVE LAW'S HANDS (docs/world-model/GK-T0-DIVE-LAW.md;
   * contract GK-KEEPER-BODY-CONTRACT.md §2 M-GK.1; ruling #399 item 3). The CONTACT
   * POINT of the save this keeper is inside: the BALL'S OWN POSITION at the tick
   * `tryKeeperSave` rolled the save, recorded on the KEEPER — the engine's own record of
   * where his hands went while his body stayed — plus the `caught` MARK that says which
   * branch of the save wrote it.
   *
   * ⭐ `caught: true` (the CATCH branch) — the keeper now OWNS the ball, and the ball WAITS
   * at this point until his body arrives (M-GK.3′) or until he loses ownership.
   * ⭐ `caught: false` (the PARRY branch) — STEER-ONLY: the ball is already away, so nothing
   * waits; the body still travels to where the hands went, and the mark ends with the
   * sprite's window (the decrement clear below).
   *
   * Written at exactly TWO sites in `src/**` (`tryKeeperSave`'s catch branch and its parry
   * branch) and only under `match.gkDiveBody`; read by the executor's ONE post-switch
   * override (M-GK.2′ — every tick, whatever the action) and by the carry law's ONE waiting
   * branch (M-GK.3′).
   *
   * ⭐⭐ THE WINDOW OF THE LAW IS NOT THE WINDOW OF THE SPRITE (ruling #399 item 3(ii)): a
   * `caught` contact is NOT cleared by `saveAnimTimer` — it lives until the body arrives or
   * until the ball's owner is no longer this keeper. Only a PARRY (`caught: false`) contact
   * dies with the animation timer, because steer-only has no ball to wait for.
   *
   * ⛔ FLAG OFF ⇒ NEVER WRITTEN ⇒ null for the whole match, and every clear below is
   * GUARDED on `!== null`, so the OFF path executes not one new assignment.
   */
  saveContact: { x: number; y: number; caught: boolean } | null = null;
  /** Display-only: renderers play a header jump while this runs (Phase 28). */
  headerAnimTimer = 0;
  /**
   * Keeper distribution mode (Phase 28.3): set while holding the ball in the
   * hands, cleared on the kick — a keeper who HELD the ball releases it
   * deliberately (throw/pass/switch), never with a panic hoof.
   */
  gkDistributing = false;
  /**
   * Shape-wait budget spent (Phase 30.3): while distributing, the keeper
   * re-arms the hold in small quanta until the outfielders settle into
   * shape; this counts what's been spent so a parked team can't stall the
   * match. Reset when a fresh hold starts.
   */
  gkShapeWait = 0;
  /**
   * One-touch window (Phase 31.9, 一脚出球): set at a PRESSURED reception —
   * the receiver decides immediately, and a pass kicked while this runs is
   * played first-time: extra aim noise, discounted by technique. Any kick
   * consumes it; expiry means they took a settle touch after all.
   */
  firstTouchWindow = 0;
  /**
   * Marker reaction lag (Phase 31.9, the headed-game pass): while the mark
   * SPRINTS near our goal, the marking stance target is frozen here and
   * only re-read on the marker's reaction cadence (0.2–0.45s by defending)
   * — frame-perfect shadowing had made the attacking header extinct.
   */
  markAnchor: V2 | null = null;
  markAnchorAge = 0;
  markAnchorIdx: number | null = null;
  /**
   * C4 T2-ARRIVAL, PROBE OBSERVABILITY ONLY — never read by any decision.
   * Written by the executor on the tick its cross meet-point re-route fires:
   * `meet` is what the branch computed, `applied` the target that survived the
   * downstream clamps. F2 is a per-record fidelity gate over exactly this pair
   * (contract §4.3), and without the trace it could only be asserted in a unit
   * test instead of measured over the run. Null on every other tick and in
   * every flags-off world.
   */
  c4Trace: { meet: V2; applied: V2 } | null = null;
  /**
   * Stage III P2, probe observability only: WHICH downstream clamp rewrote the
   * steering target this frame. Written by the executor, never read by the sim.
   * The P2 contract's X6 asks whether a clamp rewrote the eye's target, and
   * ruling #43.3 makes clamp COMPOSITION a reported mediator (per candidate ×
   * per context) — both are exact facts the engine already knows, and
   * reconstructing them from a pre-step guess is the P1 §4.6b defect.
   * Null on every other frame.
   */
  clampTrace: 'onside' | 'barred' | null = null;
  /**
   * 2过1 burst license (Phase 34): granted when this player plays a short
   * pass under pressure — for its ~1.1s he sprints past his marker and the
   * return ball INTO him (from `partnerGid`) is scored as the wall pass,
   * not the "handing it straight back" it would otherwise read as.
   */
  wallRun: { until: number; partnerGid: number } | null = null;
  /**
   * Containment hysteresis (Phase 101): whether this chaser is currently
   * JOCKEYING the carrier. The phase-92 goal-side test was a razor-edge
   * boolean — a chaser dancing on the −0.2 offset flipped between the
   * standoff point and the ball 66-70 times/match (`hold-jitter.ts`), a
   * brain-level whip the render reads as twitching. Enter containment only
   * clearly goal-side, hold it until clearly not. Runtime-only state.
   */
  containing = false;

  /**
   * Slalom COMMITMENT (Phase 41.2, user report "带球转一大圈然后突然丢
   * 球"): the side picked to beat the current blocker, held until the
   * timestamp. Without it a defender shadowing the carrier on the goal
   * axis flipped the perp sign every few ticks — the turn-rate cap
   * integrated the flip-flop into a full pirouette at walking pace
   * (momentum gone = no pace protection) until the tackle landed. A real
   * dribbler picks a shoulder and goes.
   */
  slalomSide: 1 | -1 = 1;
  slalomUntil = -1;

  /** Age in seasons (Phase 26) — display only, set by Team from TeamInfo. */
  age?: number;
  /** Has a yellow card this match — a second booking is a red (Phase 25). */
  booked = false;
  /** Sent off: parked on the apron, excluded from every sim interaction. */
  sentOff = false;
  /** Injury state (Phase 118): a 'knock' plays on visibly slower; 'serious'
   * comes off (the league ban rides MatchResult.injuries). Reset on sub. */
  injured?: 'knock' | 'serious';

  baseSpeed: number;
  accel: number;
  /** Traits (Phase 39) — derived from attrs+role, ≤2. Recomputed on becomeSub. */
  traits: readonly Trait[];
  /** Cached engine-trait drain factor (hot path — no includes() per step). */
  staminaDrainMul: number;

  constructor(side: Side, index: number, role: Role, name: string, attrs: PlayerAttributes) {
    this.side = side;
    this.index = index;
    this.gid = side * TEAM_SIZE + index;
    this.rosterIdx = index;
    this.role = role;
    this.name = name;
    this.attrs = attrs;
    // pace: ±12% top speed, ±10% acceleration around the role baseline.
    this.baseSpeed = BASE_SPEED[role] * (0.88 + attrs.pace * 0.24);
    this.accel = ACCEL * (0.9 + attrs.pace * 0.2);
    // Traits (Phase 39): derived, never stored — a developing player grows
    // into (or out of) them. Hot-path effects are cached as plain numbers.
    this.traits = traitsOf(attrs, role);
    this.staminaDrainMul = this.traits.includes('engine') ? 0.9 : 1;
  }

  /**
   * The SUBSTITUTION (Phase 61, N2): this pitch slot changes bodies. The
   * object survives so every reference keyed by gid stays valid; the
   * identity — name, genes, traits, speed — becomes the bench player's.
   * Fresh legs are the bench's whole payoff: stamina resets to 1. Cards
   * are personal (the new man is unbooked). distance/staminaSpent are NOT
   * reset — they fold into TEAM totals at full time and must keep the
   * outgoing man's work.
   */
  /** A KNOCK (Phase 118): hurt but playing on — pace and close control
   * degrade for the rest of his match. The attrs object is REPLACED, never
   * mutated: the roster row is shared with the franchise. */
  takeKnock(): void {
    this.injured = 'knock';
    this.attrs = { ...this.attrs, pace: this.attrs.pace * 0.8, dribbling: this.attrs.dribbling * 0.85 };
    this.baseSpeed = BASE_SPEED[this.role] * (0.88 + this.attrs.pace * 0.24);
    this.accel = ACCEL * (0.9 + this.attrs.pace * 0.2);
  }

  becomeSub(sub: { rosterIdx: number; name: string; attrs: PlayerAttributes; age?: number }, pos: V2): void {
    this.name = sub.name;
    this.attrs = sub.attrs;
    this.age = sub.age;
    this.rosterIdx = sub.rosterIdx;
    this.baseSpeed = BASE_SPEED[this.role] * (0.88 + sub.attrs.pace * 0.24);
    this.accel = ACCEL * (0.9 + sub.attrs.pace * 0.2);
    this.traits = traitsOf(sub.attrs, this.role);
    this.staminaDrainMul = this.traits.includes('engine') ? 0.9 : 1;
    this.stamina = 1;
    this.booked = false;
    this.injured = undefined; // the new man arrives whole (Phase 118)
    this.pos = v2(pos.x, pos.y);
    this.vel = v2();
    this.desiredVel = v2();
    this.heading = v2(0, pos.y > 0 ? -1 : 1); // facing the pitch he steps onto
    this.faceTarget = null;
    this.action = { type: 'MoveToFormationSpot', scores: [] };
    this.kickCooldown = 0;
    this.tackleCooldown = 0;
    this.stunTimer = 0;
    this.touchTimer = 0;
    this.gkHoldTimer = 0;
    this.gkDistributing = false;
    this.gkShapeWait = 0;
    this.tackleAnimTimer = 0;
    this.saveAnimTimer = 0;
    // GK T0 §M-GK.1: the hands go with the window. Guarded — OFF, this is never entered.
    if (this.saveContact !== null) this.saveContact = null;
    this.headerAnimTimer = 0;
    this.firstTouchWindow = 0;
    this.markAnchor = null;
    this.markAnchorAge = 0;
    this.markAnchorIdx = null;
    this.wallRun = null;
  }

  /** Effective top speed — tired players slow down but never stop. */
  get topSpeed(): number {
    return this.baseSpeed * (0.62 + 0.38 * this.stamina);
  }

  physicsStep(dt: number): void {
    // In-place integration — this ran as clampLen/approachV/add/norm, which
    // allocated ~6 vectors per player per step (860k per match). The exact
    // same operations in the exact same IEEE order, written out flat:
    // results are bit-identical (regression: same seed ⇒ same save JSON).
    const dv = this.desiredVel;
    const max = this.topSpeed;
    const dl = Math.sqrt(dv.x * dv.x + dv.y * dv.y); // clampLen
    let tx = dv.x;
    let ty = dv.y;
    if (dl > max && dl > 1e-8) {
      const s = max / dl;
      tx = dv.x * s;
      ty = dv.y * s;
    }
    // ⭐⭐ BF T0 — THE ONE SEAM (ruling #376 item 2, CORRECTING #374 item 4(iv)): when this
    // body carries a facing depth, the CLAMPED TARGET is scaled — by the same factor in
    // both components, so the DIRECTION never moves — by how far its heading is from where
    // it intends to go. The price lands AFTER the top-speed clamp and BEFORE the stun
    // multiplier and the accel approach: applied to the RAW intent it was a silent no-op
    // wherever the executor over-saturates (any |desiredVel| ≥ topSpeed / f is clamped
    // straight back to topSpeed and pays nothing), which is exactly the sprinting case.
    // Shipped path: `facingDepth` is 0, this branch is not taken, and nothing below moves.
    if (this.facingDepth > 0) {
      const tl = Math.sqrt(tx * tx + ty * ty);
      if (tl > 1e-8) {
        const f = facingFactor(
          facingCosine(this.heading.x, this.heading.y, tx / tl, ty / tl),
          this.facingDepth,
        );
        tx *= f;
        ty *= f;
      }
    }
    // Stunned (Phase 27): stumbling players can barely move until they recover.
    if (this.stunTimer > 0) {
      tx *= 0.15;
      ty *= 0.15;
    }
    const maxDelta = this.accel * dt; // approachV
    const ax = tx - this.vel.x;
    const ay = ty - this.vel.y;
    const al = Math.sqrt(ax * ax + ay * ay);
    if (al <= maxDelta || al < 1e-8) {
      this.vel.x = tx;
      this.vel.y = ty;
    } else {
      const s = maxDelta / al;
      this.vel.x = this.vel.x + ax * s;
      this.vel.y = this.vel.y + ay * s;
    }
    this.pos.x = this.pos.x + this.vel.x * dt;
    this.pos.y = this.pos.y + this.vel.y * dt;

    const sp = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
    // Rotate heading toward the face target (backpedal, 27.5) or, failing
    // that, the movement direction — capped at TURN_RATE either way.
    // No trig in the loop: the per-step rotation's cos/sin are cached per dt.
    if (dt !== turnDt) {
      turnDt = dt;
      turnCos = Math.cos(TURN_RATE * dt);
      turnSin = Math.sin(TURN_RATE * dt);
    }
    const ft = this.faceTarget;
    let wx = 0;
    let wy = 0;
    let turn = false;
    if (ft) {
      const fx = ft.x - this.pos.x;
      const fy = ft.y - this.pos.y;
      const fl = Math.sqrt(fx * fx + fy * fy);
      if (fl > 1e-6) {
        wx = fx / fl;
        wy = fy / fl;
        turn = true;
      }
    } else if (sp > 0.5) {
      wx = this.vel.x / sp;
      wy = this.vel.y / sp;
      turn = true;
    }
    if (turn) {
      const hx = this.heading.x;
      const hy = this.heading.y;
      if (hx * wx + hy * wy >= turnCos) {
        this.heading = { x: wx, y: wy };
      } else {
        const s = hx * wy - hy * wx >= 0 ? turnSin : -turnSin;
        this.heading = { x: hx * turnCos - hy * s, y: hx * s + hy * turnCos };
      }
    }
    this.distance += sp * dt;

    // Stamina: quadratic drain above ~55% effort, slow recovery when jogging/idle.
    // The engine trait (Phase 39) drains 10% slower — the motor runs all day.
    const effort = sp / this.baseSpeed;
    // The stamina ATTRIBUTE scales drain and recovery (Phase 47): neutral
    // at the 0.4 backfill so the league's energy economy doesn't move —
    // the motor is now a dimension evolution can spend on.
    // Phase 58: drain/recovery repriced so the economy BINDS in-match
    // (constants.ts has the story) — legs are a resource, not a gauge.
    if (effort > 0.55) {
      const drain =
        STAMINA_DRAIN * effort * effort * dt * this.staminaDrainMul * (1.24 - this.attrs.stamina * 0.6);
      this.stamina = Math.max(0.05, this.stamina - drain);
      this.staminaSpent += drain;
    } else {
      this.stamina = Math.min(1, this.stamina + STAMINA_RECOVERY * dt * (0.88 + this.attrs.stamina * 0.3));
    }

    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.tackleCooldown = Math.max(0, this.tackleCooldown - dt);
    this.touchTimer = Math.max(0, this.touchTimer - dt);
    this.stunTimer = Math.max(0, this.stunTimer - dt);
    this.gkHoldTimer = Math.max(0, this.gkHoldTimer - dt);
    this.tackleAnimTimer = Math.max(0, this.tackleAnimTimer - dt);
    this.saveAnimTimer = Math.max(0, this.saveAnimTimer - dt);
    // ⭐⭐ GK T0b §M-GK.3′ (c): the animation's clock ends a PARRY contact and NOTHING ELSE.
    // A steer-only contact has no ball waiting on it, so it may die with the sprite; a
    // `caught` contact is released by ARRIVAL or by the LOSS OF OWNERSHIP (Match.stepBall),
    // never by this timer — that conflation is exactly what ruling #399 item 1(i) struck.
    // GUARDED on `!== null` so the OFF path (where the field is never written) executes no
    // assignment at all — the dormancy is structural, not arithmetic.
    if (this.saveContact !== null && !this.saveContact.caught && this.saveAnimTimer === 0) this.saveContact = null;
    this.headerAnimTimer = Math.max(0, this.headerAnimTimer - dt);
    this.firstTouchWindow = Math.max(0, this.firstTouchWindow - dt);
    this.decisionTimer -= dt;
  }

  /**
   * An instantaneous burst the movement drain never saw — a tackle lunge
   * (Phase 58). Same per-player modifiers as the running drain, so engines
   * and high-stamina players absorb bursts better too.
   */
  spendBurst(cost: number): void {
    const drain = cost * this.staminaDrainMul * (1.24 - this.attrs.stamina * 0.6);
    this.stamina = Math.max(0.05, this.stamina - drain);
    this.staminaSpent += drain;
  }

  resetForKickoff(pos: V2): void {
    this.pos = pos;
    this.vel = v2();
    this.desiredVel = v2();
    this.action = { type: 'MoveToFormationSpot', scores: [] };
    this.kickCooldown = 0;
    this.tackleCooldown = 0;
    this.stunTimer = 0;
    this.gkHoldTimer = 0;
    this.gkDistributing = false;
    this.gkShapeWait = 0;
    this.tackleAnimTimer = 0;
    this.saveAnimTimer = 0;
    // GK T0 §M-GK.1: the hands go with the window. Guarded — OFF, this is never entered.
    if (this.saveContact !== null) this.saveContact = null;
    this.headerAnimTimer = 0;
    this.firstTouchWindow = 0;
    this.slalomUntil = -1;
  }
}
