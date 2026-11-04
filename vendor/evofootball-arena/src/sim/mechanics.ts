import { clamp, clamp01 } from '../utils/math';
import {
  add, closestPointOnSegment, dist, dot, len, norm, rotate, scale, sub, v2, type V2,
} from '../utils/vec';
import { ballLanding, laneBlockers, opennessOf, pressureAt } from '../ai/perception';
import { offsideLineLocalX, runBurstPoint } from '../ai/formations';
import {
  BALL_FRICTION_K, BOX_DEPTH, CHEST_TRAP_MAX_HEIGHT, CHEST_TRAP_MAX_VZ, CHEST_TRAP_RADIUS,
  CORNER_CLEARANCE, CROSS_LEAD_FRAC, CROSS_LEAD_MAX, GK_CLAIM_HEIGHT, GOAL_WIDTH, GRAVITY, HALF_L,
  HALF_W, HEADER_MAX_HEIGHT, HEADER_MIN_HEIGHT, HEADER_RADIUS, SHOT_SPEED,
  GK_RUSH_ENVELOPE,
  CONTEST_RADIUS, DEFLECT_BLIND_PEN, TACKLE_LUNGE_COST, UNSET_BLOCK_WEIGHT,
  CROSS_FLIGHT_MIN_S,
  TOUCH_PUSH_BASE, TOUCH_PUSH_SPACE, TOUCH_RECOLLECT_BASE, TOUCH_RECOLLECT_PER_PUSH,
  PASS_POWER_EXECUTED_MAX, PASS_POWER_EXECUTED_MIN, PASS_POWER_MAX, PASS_POWER_MIN,
  PASS_POWER_NOISE_K,
} from './constants';
import * as cb from './carryBeat';
import type { Match } from './Match';
import type { Player } from './Player';
import type { Role } from './types';

/**
 * Ball mechanics: kicks, tackles, keeper saves and the xG model.
 * These are free functions over the Match so Match.ts stays a readable
 * state machine. All randomness comes from match.rng (deterministic).
 */

/** How far out the keeper can reach a ball (dive included). */
function keeperReach(defTeam: { genome: { keeperAggression: number } }, gk: Player): number {
  // The cat (Phase 39): elite-reflex keepers reach a hand further.
  return (
    2.05 + defTeam.genome.keeperAggression * 0.4 + (gk.attrs.reflexes - 0.5) * 0.5 +
    (gk.traits.includes('cat') ? 0.12 : 0)
  );
}

/** THE FINGERTIP STRETCH (Phase 119b): a save may be ATTEMPTED out to
 * reach × this. The old hard cliff at reach meant a ball 5cm beyond was
 * untouchable — onevone-anatomy measured 54%/23% of late-gen 1v1 shots
 * (65%/36% of the GOALS) never rolling a save at all; the composed
 * post-placed finish was engineered to shave exactly that boundary. The
 * frozen dive difficulty already prices the distance (floor 0.25), the
 * attempt fires only as the ball passes its closest approach (a catchable
 * ball is never pre-empted), and a stretch save can only PARRY. */
const SAVE_STRETCH = 1.35;

/** Dive difficulty, frozen at the moment of the strike: how far off the
 * shot's line the keeper stands, priced against his reach. Shared by the
 * open-play shot, the header and the placed free kick. */
function diveDifficulty(ballPos: V2, dir: V2, gk: Player, opp: { genome: { keeperAggression: number } }): number {
  const path = closestPointOnSegment(ballPos, add(ballPos, scale(dir, 40)), gk.pos);
  return clamp(1.15 - dist(path, gk.pos) / keeperReach(opp, gk), 0.25, 1);
}

/** ANGLE COVERED (Phase 119b): the share of the goal's angular window the
 * keeper's POSITION cut at the strike — his depth up the shot cone over the
 * shooter's distance, discounted as he stands off the shooter→goal line (a
 * dragged keeper covers nothing). Phase 103's closeIn paid proximity to the
 * SHOOTER; the anatomy probe caught evolution routing around it — striking
 * from 8-10m where closeIn ≈ 0.1 while a keeper 3m up the cone still cut
 * ~40% of the window for free. Frozen at shot time, like difficulty. */
function angleCoverage(gk: Player, shooterPos: V2, goal: V2): number {
  const sGoal = Math.max(dist(shooterPos, goal), 1);
  const kGoal = dist(gk.pos, goal);
  const lineOff = dist(closestPointOnSegment(shooterPos, goal, gk.pos), gk.pos);
  return clamp01(Math.min(kGoal / sGoal, 1) * clamp01(1 - lineOff / 3));
}

/* ------------------------------------------------------------------ */
/* Body orientation (Phase 27)                                         */
/* ------------------------------------------------------------------ */

/**
 * How far a kick direction is from where the body faces: (1 − cosθ) / 2.
 * 0 = striking dead ahead, 0.5 = square across the body, 1 = fully blind.
 * `dir` must be normalized.
 */
export function kickMisalignment(p: Player, dir: V2): number {
  return (1 - (p.heading.x * dir.x + p.heading.y * dir.y)) / 2;
}

/** Kicks across/against the body spray more; technique tames the penalty. */
export function orientationNoiseMul(misalign: number, technique: number): number {
  return 1 + misalign * (0.9 - technique * 0.6);
}

/** Kicks against the body lose power (up to −22%); technique recovers some. */
export function orientationPowerMul(misalign: number, technique: number): number {
  return 1 - misalign * 0.22 * (1 - technique * 0.4);
}

/**
 * First-touch difficulty (Phase 27): chance a moving ball gets away from the
 * receiver. Grows with ball speed, defender pressure and taking the ball from
 * behind the body; technique tames all of it. This is where pressing turns
 * into forced errors.
 */
/**
 * EDS E1b (docs/world-model/EDS-E1B-TOUCH-COST-CURVE.md): the two speed-cost
 * curves. `base` is the shipped one; `heavy` is C1-B §12.2's honest curve —
 * saturation moves from 14 m/s to the 22 m/s ground-pass launch cap, and the
 * rolled-versus-drilled spread lands at the same order as the 17.4pp
 * interception swing power buys. Selected per call, never globally.
 */
export const TOUCH_SPEED_COST = {
  base: { span: 8, weight: 0.07 },
  heavy: { span: 16, weight: 0.24 },
} as const;

export function touchFailChance(
  speed: number, pressure: number, misalign: number, technique: number, positioning = 0.5,
  heavyTouchCost = false,
): number {
  // POSITIONING (Phase 119j) reads the ball and shapes the body EARLY, so it
  // tames the PRESSURE and BLIND-SIDE penalties (the awareness half of a first
  // touch); technique still tames the whole thing (the clean contact). Neutral
  // at 0.5 — `aware` = 1.0 there, so the pre-119j curve is bit-for-bit intact
  // and backfilled 0.5 saves play unchanged; a reader (1.0) cuts the
  // pressure/blind penalty ~30%, a spatially-blind player (0) pays ~30% more.
  const aware = 1 - (positioning - 0.5) * 0.6; // 0.7 .. 1.3
  const cost = heavyTouchCost ? TOUCH_SPEED_COST.heavy : TOUCH_SPEED_COST.base;
  const raw = 0.01 + clamp01((speed - 6) / cost.span) * cost.weight
    + (pressure * 0.1 + misalign * 0.05) * aware;
  return clamp(raw * (1.3 - technique * 0.85), 0, 0.4);
}

/**
 * EDS E1a: one first-touch adjudication, decomposed into the exact terms the
 * roll used. Emitted only when `Match.traceFirstTouch` is on; nothing reads it
 * back and no branch above it depends on it.
 */
export interface FirstTouchTraceEntry {
  readonly tick: number;
  readonly gid: number;
  /** True when this body was the pending pass's intended target. */
  readonly intendedTarget: boolean;
  readonly relativeSpeed: number;
  readonly pressure: number;
  readonly misalign: number;
  readonly technique: number;
  readonly positioning: number;
  readonly pFail: number;
  readonly clean: boolean;
}

/** Frozen physical facts from the earlier contact, used by M3's later control attempt. */
export interface FirstTouchContactContext {
  readonly relativeSpeed: number;
  readonly incomingDir: Readonly<V2>;
}

/**
 * Roll the first touch for a player about to control a moving ball. Returns
 * true if the touch is clean (caller gives them the ball). A failed touch
 * knocks the ball loose ahead of the receiver — anyone can pounce on it.
 * Keepers are exempt (they catch); slow balls are trivially trapped.
 */
export function attemptFirstTouch(
  match: Match,
  p: Player,
  contact?: FirstTouchContactContext,
): boolean {
  const ball = match.ball;
  // A dropping ball is harder to kill than a rolled one (Phase 28): the
  // vertical speed counts toward touch difficulty. Ground balls: vz = 0.
  const speed = contact?.relativeSpeed ?? (len(ball.vel) + Math.abs(ball.vz) * 0.6);
  if (p.role === 'GK' || speed <= 6) return true;
  const hSpeed = Math.max(len(ball.vel), 1e-6);
  const inx = contact?.incomingDir.x ?? ball.vel.x / hSpeed;
  const iny = contact?.incomingDir.y ?? ball.vel.y / hSpeed;
  // Ball arriving at the face = 0, arriving from behind the body = 1.
  const misalign = (1 + (inx * p.heading.x + iny * p.heading.y)) / 2;
  const pressure = pressureAt(p.pos, match.teams[1 - p.side].players);
  let pFail = touchFailChance(
    speed, pressure, misalign, p.attrs.dribbling, p.attrs.positioning, match.edsTouchCost,
  );
  // Re-collecting your OWN pushed touch (Phase 36): the ball rolls away
  // from the body, which reads as a blind-side reception to the misalign
  // term — but he watched it leave his own boot. Priced well down, not
  // free: overhit knock-and-runs still get away.
  if (match.dribbleTouch !== null && match.dribbleTouch.gid === p.gid) pFail *= 0.45;
  const clean = !match.rng.chance(pFail);
  // EDS E1a instrument: log the adjudication with the exact terms the roll used.
  // The roll has already happened; this branch cannot influence it, and it is
  // inert unless the trace flag was explicitly enabled.
  if (match.traceFirstTouch) {
    match.firstTouchTrace.push({
      tick: match.simTick,
      gid: p.gid,
      intendedTarget: match.pendingPass !== null
        && match.pendingPass.targetGid === p.gid
        && match.pendingPass.side === p.side,
      relativeSpeed: speed,
      pressure,
      misalign,
      technique: p.attrs.dribbling,
      positioning: p.attrs.positioning,
      pFail,
      clean,
    });
  }
  if (clean) return true;

  match.teams[p.side].stats.miscontrols++;
  match.stat(p.gid).miscontrols++;
  ball.lastTouch = p; // a heavy touch out of play concedes the restart
  ball.vel = scale(rotate(v2(inx, iny), match.rng.range(-0.8, 0.8)), match.rng.range(3.5, 6.5));
  ball.vz = 0; // the touch kills any remaining flight — the ball drops
  p.kickCooldown = 0.5; // off balance — can't instantly regather
  return false;
}

/**
 * Offside judgment, frozen at kick time (Phase 29): is `target` in an
 * offside position right now, as `passer` strikes the ball? Opponent half
 * only; the line is the second-last defender counting the keeper, or the
 * ball (the passer) if deeper; level is onside (0.2m epsilon).
 */
function offsideAtKick(match: Match, passer: Player, target: Player): boolean {
  const team = match.teams[passer.side];
  const tx = team.localX(target.pos.x);
  if (tx <= 0) return false; // own half — never offside
  const line = offsideLineLocalX(team, match.teams[1 - passer.side].players, team.localX(passer.pos.x));
  return tx > line + 0.2;
}

/**
 * The single funnel for pass bookkeeping (Phase 29): every delivery that
 * names a target registers here, so the offside flag is judged exactly once,
 * at kick time. `exempt` = the real-law dead-ball exemptions (kick-ins,
 * corners, goal kicks — passed down from the restart taker's decision).
 */
function registerPass(match: Match, passer: Player, target: Player, exempt: boolean): void {
  const offside = !exempt && offsideAtKick(match, passer, target);
  // Third-man shape (Phase 34): A→B, and B bounces it FORWARD to a running
  // C within a beat of receiving — flagged at the kick, credited on arrival.
  const lp = match.lastCompletedPass;
  const team = match.teams[passer.side];
  const bounce =
    lp !== null &&
    lp.receiverGid === passer.gid &&
    lp.passerGid !== target.gid && // back to A is a one-two, not a third man
    match.simTime - lp.t < 1.5 &&
    target.action.type === 'MakeRun' &&
    team.localX(target.pos.x) > team.localX(passer.pos.x) + 3;
  match.pendingPass = {
    side: passer.side,
    passerGid: passer.gid,
    targetGid: target.gid,
    t: match.simTime,
    offside,
    offsideSpot: offside ? v2(target.pos.x, target.pos.y) : null,
    bounce,
  };
}

/**
 * One-touch penalty (Phase 31.9, 一脚出球): a pass struck inside the
 * receiver's first-touch window (set at a pressured reception, consumed by
 * any kick) sprays more — technique discounts it: tech 0.95 ≈ ×1.2, tech
 * 0.5 ≈ ×1.6, tech 0.1 ≈ ×2.0. Multiplies aim noise (and loft range error).
 */
function oneTouchMul(p: Player): number {
  return p.firstTouchWindow > 0 ? 1.15 + (1 - p.attrs.dribbling) * 0.9 : 1;
}

/** xG-like chance quality: distance falloff · central angle · pressure. */
export function shotQuality(match: Match, p: Player): number {
  const team = match.teams[p.side];
  const goal = team.oppGoal();
  const d = dist(p.pos, goal);
  const central = 1 - clamp01(Math.abs(p.pos.y) / HALF_W) * 0.5;
  const pressure = pressureAt(p.pos, match.teams[1 - p.side].players);
  return clamp(0.85 * Math.exp(-d / 10) * central * (1 - pressure * 0.3), 0.01, 0.8);
}

/**
 * The ground BENDER (Phase 71, the curve trilogy's last piece — user ask
 * 弧线直塞): when a defender pinches the passing lane, a technical passer
 * curls the ball AROUND his leg — the bulge leans away from the pincher
 * and the arc comes back to the designed receiving point. Compensation is
 * exact for grass decay (spin bleeds at 1.5/s, so the total rotation is
 * ω(1−e^{−1.5T})/1.5 — half of it rotated off the launch keeps the chord
 * endpoint honest). Nobody in the lane = no spin: the straight ball stays
 * the default, and interceptors/deflectors meet the ARC per frame, so the
 * bender beats exactly the leg it was played around. Returns the spin.
 */
function groundBend(
  passer: Player, to: V2, opponents: Player[], d: number,
): number {
  const from = passer.pos;
  const chord = norm(sub(to, from));
  let pinch: Player | null = null;
  let pinchPerp = 1.3; // a leg within reach of the straight lane
  for (const o of opponents) {
    if (o.sentOff) continue;
    const ox = o.pos.x - from.x;
    const oy = o.pos.y - from.y;
    const along = ox * chord.x + oy * chord.y;
    if (along < 2 || along > d - 2) continue; // passer's feet / receiver's trap
    const perp = Math.abs(ox * chord.y - oy * chord.x);
    if (perp < pinchPerp) {
      pinchPerp = perp;
      pinch = o;
    }
  }
  if (!pinch) return 0;
  // Magnitude scales with how TIGHT the pinch is — a leg 1.2m off the
  // chord needs a lean, not a banana (the first cut bent every through
  // ball at full whip: the last defender always stands near that chord,
  // so high lines were being beaten for free — press-23's measured block
  // height collapsed onto low-32's and the formations contract inverted).
  const tightness = clamp(1.4 - pinchPerp, 0.3, 1);
  // FLAT whip (the passing-scaled first cut inverted the skill gradient:
  // better passers took BIGGER bends and paid the deviation) — the bend
  // needed to clear a leg is geometry, the same for everyone; technique's
  // edge lives in the weight error below.
  const mag = 0.45 * tightness;
  const cross = chord.x * (pinch.pos.y - from.y) - chord.y * (pinch.pos.x - from.x);
  return (Math.sign(cross) || 1) * mag;
}

/** Kick a ground ball with bend: launch rotated half the DECAYED total
 * rotation so the arc's endpoint sits where the straight aim pointed. */
function bentKick(match: Match, p: Player, dir: V2, speed: number, spin: number, d: number): void {
  if (spin === 0) {
    match.kickBall(p, dir, speed);
    return;
  }
  const T = -Math.log(1 - Math.min((d * BALL_FRICTION_K) / speed, 0.85)) / BALL_FRICTION_K;
  const totalRot = (spin * (1 - Math.exp(-1.5 * T))) / 1.5;
  // The bender's PRICE: a curled ball is harder to weight — extra launch
  // noise grows with the whip and shrinks with technique. Free bending
  // farmed the offside line (see groundBend's tightness note).
  const weightErr = match.rng.gaussian() * Math.abs(spin) * 0.2 * (1.35 - p.attrs.passing);
  match.kickBall(p, rotate(dir, -totalRot * 0.5 + weightErr), speed);
  match.ball.spin = spin;
}

/**
 * C1-A (docs/world-model/PASS-POWER-SLICE.md §8): what the passer actually
 * strikes, given what he MEANT. Weighting a ball away from its natural pace is
 * a technique act, so the error grows with the reach and shrinks with passing.
 * At an intended 1.0 this is exactly 1.0 and consumes no RNG — the reason the
 * fingerprint gate can prove the plumbing inert.
 */
function executedPassPower(match: Match, passer: Player, intended: number): number {
  if (intended === 1) return 1;
  const error = match.rng.gaussian()
    * Math.abs(intended - 1) * PASS_POWER_NOISE_K * (1.35 - passer.attrs.passing);
  return clamp(intended + error, PASS_POWER_EXECUTED_MIN, PASS_POWER_EXECUTED_MAX);
}

export function performPass(
  match: Match, passer: Player, mate: Player, offsideExempt = false, powerChoice = 1,
  ptpLead: Readonly<V2> | null = null,
): void {
  if (match.ball.owner !== passer || passer.kickCooldown > 0) return;
  const team = match.teams[passer.side];
  const opp = match.teams[1 - passer.side];

  // Playing across/against the body (Phase 27) takes pace off the ball —
  // known up front, so the lead and the kick agree on the effective speed.
  const misalign = kickMisalignment(passer, norm(sub(mate.pos, passer.pos)));
  const orientation = orientationPowerMul(misalign, passer.attrs.passing);
  // Intended weight (C1-A) composes with the orientation loss. The lead uses
  // the INTENDED power and the strike uses the EXECUTED one: a passer knows
  // which way his body is turned, but not that he is about to overhit.
  const intended = clamp(powerChoice, PASS_POWER_MIN, PASS_POWER_MAX);
  const powerMul = orientation * intended;
  const executedMul = orientation * executedPassPower(match, passer, intended);

  // Lead the receiver by a fraction of the expected flight time.
  const flight = dist(passer.pos, mate.pos) / (16 * powerMul);
  const struckLead = add(mate.pos, scale(mate.vel, flight * 0.8));
  // PTP T0 (docs/world-model/PTP-T0-DORMANT-SEAM.md §SEAM — EXECUTION FOLLOWS
  // PRICING): when the chooser priced this pass against a LED point, the ball is
  // aimed there. `ptpLead` is the chooser's OWN priced displacement, handed in by
  // the single `ptpPassLead` fork in `PlayerBrain.decideOnBall`; it is `null` in
  // every production path and on every other caller, so this line is the shipped
  // strike verbatim (`lead === struckLead`, the incumbent object). The incumbent
  // strike-time correction above is NOT replaced — it is the passer's own body
  // knowledge and it stays; the gene's projection rides ON TOP of it, which is why
  // gene 0 is byte-identical rather than merely close.
  const lead = ptpLead === null ? struckLead
    : v2(struckLead.x + ptpLead.x, struckLead.y + ptpLead.y);
  const d = dist(passer.pos, lead);
  // d·0.55+7.5 → d·0.6+8.2 (31.6, user call 传球力度): zip beats the
  // in-flight interceptors (completion 64→68%) — the receiving cost is
  // priced by touchFailChance and stays mild.
  const speed = clamp(d * 0.6 + 8.2, 9, 22) * executedMul;

  // Accuracy: pressure sprays passes; a drilled team (passBias) and a
  // technical passer tighten them; kicks against the body spray more.
  const pressure = pressureAt(passer.pos, opp.players);
  const aim = norm(sub(lead, passer.pos));
  const noise =
    match.rng.gaussian() *
    (0.02 + pressure * 0.07 + d * 0.0015) *
    (1.15 - team.genome.passBias * 0.3) *
    (1 - team.confidence * 0.12) * // morale sharpens/frays the pass (Phase 111)
    (1.25 - passer.attrs.passing * 0.5) *
    oneTouchMul(passer) *
    orientationNoiseMul(misalign, passer.attrs.passing);
  const dir = rotate(aim, noise);

  const oneTouch = passer.firstTouchWindow > 0;
  // Circulation stays STRAIGHT — deliberately (Phase 70/71): the bender on
  // ordinary short passes defeated exactly the lane-jumping that IS the
  // pressing game, and the zonal press-23 block's measured height collapsed
  // onto low-32's (the formations contract inverted; isolation-probed —
  // through-ball and aerial curves alone leave it intact). Curl lives where
  // football actually spends it: through balls, switches, crosses, shots.
  match.lastPassKind = { kind: 'pass', t: match.simTime };
  match.kickBall(passer, dir, speed);
  team.stats.passes++;
  if (oneTouch) team.stats.oneTouch++;
  if (team.localX(mate.pos.x) - team.localX(passer.pos.x) > 2) team.stats.passesForward++;
  registerPass(match, passer, mate, offsideExempt);

  // ⭐⭐⭐ DS T0d — 「配合帽子 · 开关」 THE COOPERATION HATS' SWITCH, GATE 2 of 2
  // (docs/world-model/DS-T0-OWN-RUN-SEAM.md §SWITCH-D; contract DS-DESIGNATION-CONTRACT.md §2
  // M-DS.8; ruling #412 item 5(ii)). DORMANT (Road B) — armed by NO world and NO preset.
  // PURELY ADDITIVE: not one shipped statement below is deleted, reordered or reworded — they
  // are RE-INDENTED by two spaces and nothing else — and with `dsCoopHatsOff` absent the gate
  // is `!false` and the trigger fires exactly as it shipped. Armed, `passer.wallRun` is never
  // set, so the burst push and the passer's wall-return bonus have no input to read (MEASURED,
  // not edited). ⛔ `registerPass` above and everything else in `performPass` are UNTOUCHED.
  if (!match.dsCoopHatsOff) {
    // 2过1 (Phase 34): a short pass played UNDER PRESSURE licenses the passer
    // to burst past his marker for the return — the "go" half of the
    // give-and-go. Sides that play at speed (tempo + passBias) look for it;
    // slow ones take the touch and keep shape. Not from the defensive third
    // (a wall pass at your own box is how counters are born).
    // Window 2.3s: the round trip is ~0.7s out + the wall's touch + ~0.7s
    // back — a 1.15s license expired before any return could arrive (probed).
    // Attacking half only: granted from build-up, the flip bonus turned the
    // midfield into a wall-pass ping-pong that ate 0.3 goals/match (probed
    // against the same calibrate seeds) — the one-two is a PENETRATION device.
    // The gene score is scaled by the franchise's evolved wallPassW (Phase 45)
    // before the gate — appetite for the one-two is style, not a constant.
    if (
      passer.role !== 'GK' &&
      d < 15 &&
      pressure > 0.2 &&
      passer.stamina > 0.3 &&
      team.localX(passer.pos.x) > 0 &&
      ((team.genome.tempo + team.genome.passBias) / 2) * team.policies[passer.index].wallPassW > 0.35
    ) {
      passer.wallRun = { until: match.simTime + 2.3, partnerGid: mate.gid };
    }
  }
}

/**
 * Through ball (Phase 19): hit harder and led much further than a feet pass —
 * into the space the runner is attacking, not to where they stand. Riskier by
 * construction (longer flight, bigger lead), which is exactly the trade
 * riskTolerance gates in the carrier's scoring. `lofted` (Phase 28) chips it
 * over the defensive line instead — slower to arrive and harder to take down,
 * but nothing on the ground can cut it out.
 */
export function performThroughBall(
  match: Match, passer: Player, runner: Player, lofted = false, offsideExempt = false,
): void {
  if (match.ball.owner !== passer || passer.kickCooldown > 0) return;
  const team = match.teams[passer.side];
  const opp = match.teams[1 - passer.side];
  const oneTouch = passer.firstTouchWindow > 0; // read before any kick consumes it

  // Same body-orientation contract as performPass: effective speed known
  // up front so the projected meeting point stays honest.
  const misalign = kickMisalignment(passer, norm(sub(runner.pos, passer.pos)));
  const powerMul = orientationPowerMul(misalign, passer.attrs.passing);

  // Meet the run, not the hover (Phase 29): a runner held at the offside
  // line has ~zero velocity — the delivery projects the burst they make the
  // moment this kick releases the hold, instead of dropping at their feet.
  const oppPlayers = match.teams[1 - passer.side].players;
  if (lofted) {
    const flight0 = clamp(0.55 + dist(passer.pos, runner.pos) * 0.045, 0.8, 2.0);
    const lead = runBurstPoint(runner, team, oppPlayers, flight0 * 0.85);
    // The dink bends away from the recovering defender (Phase 70).
    const swing = aerialSwing(passer, passer.pos, lead, oppPlayers);
    loftKick(match, passer, lead, 0.55, 0.045, 0.8, 2.0, 1.0, swing);
    team.stats.longBalls++; // a chip is a lofted long ball too
  } else {
    const flight = dist(passer.pos, runner.pos) / (18 * powerMul);
    // Lead FURTHER since Phase 30 (flight ×1.25, pace cap 21→24): with a
    // sixth defender recovering, a ball met AT the line gets the runner
    // caught before the shot — the delivery must land deep enough that the
    // 17 through balls/match turn back into 1v1s (the high-xG chances the
    // 30.x structures had erased: 0.38/match → 0.08 before this).
    const lead = runBurstPoint(runner, team, oppPlayers, flight * 1.25);
    const d = dist(passer.pos, lead);
    // A touch softer since Phase 29: the ball is played into SPACE for a
    // runner arriving at a sprint — friction kills it into the path, and a
    // pace the runner can actually take down is what converts timed runs.
    const speed = clamp(d * 0.6 + 9, 10, 24) * powerMul;

    const pressure = pressureAt(passer.pos, opp.players);
    const aim = norm(sub(lead, passer.pos));
    const noise =
      match.rng.gaussian() *
      (0.025 + pressure * 0.07 + d * 0.0017) *
      (1.15 - team.genome.passBias * 0.3) *
    (1 - team.confidence * 0.12) * // morale sharpens/frays the pass (Phase 111)
      (1.25 - passer.attrs.passing * 0.5) *
      oneTouchMul(passer) *
      orientationNoiseMul(misalign, passer.attrs.passing);
    const dir = rotate(aim, noise);

    // The bent through ball (Phase 71) — around the last defender's leg.
    bentKick(match, passer, dir, speed, groundBend(passer, lead, oppPlayers, d), d);
  }
  team.stats.passes++;
  team.stats.throughBalls++;
  if (oneTouch) team.stats.oneTouch++;
  if (team.localX(runner.pos.x) - team.localX(passer.pos.x) > 2) team.stats.passesForward++;
  registerPass(match, passer, runner, offsideExempt);
}

/* ------------------------------------------------------------------ */
/* The aerial game (Phase 28)                                          */
/* ------------------------------------------------------------------ */

/**
 * Loft a ball to land at `target`: flight time grows with distance
 * (tBase + m·tPerM, clamped), horizontal speed = distance/time, and the
 * vertical launch is whatever brings it back down exactly at landing
 * (airborne balls fly friction-free, so the projectile math is exact).
 * Accuracy: direction noise like a ground pass plus a RANGE error — long
 * deliveries drift short/long; technique and passBias tame both.
 */
function loftKick(
  match: Match, p: Player, target: V2,
  tBase: number, tPerM: number, tMin: number, tMax: number, noiseMul: number,
  spin = 0,
): void {
  const team = match.teams[p.side];
  const opp = match.teams[1 - p.side];
  const aimDir = norm(sub(target, p.pos));
  const misalign = kickMisalignment(p, aimDir);
  const d = dist(p.pos, target);
  const pressure = pressureAt(p.pos, opp.players);
  const noise =
    match.rng.gaussian() *
    (0.03 + pressure * 0.05 + d * 0.0011) * noiseMul *
    (1.15 - team.genome.passBias * 0.3) *
    (1 - team.confidence * 0.12) * // morale sharpens/frays the pass (Phase 111)
    (1.3 - p.attrs.passing * 0.55) *
    oneTouchMul(p) *
    orientationNoiseMul(misalign, p.attrs.passing);
  const dir = rotate(aimDir, noise);
  // Range error + orientation power loss both shorten/stretch the delivery.
  let dEff = d * orientationPowerMul(misalign, p.attrs.passing);
  dEff *= 1 + match.rng.gaussian() * (0.02 + d * 0.0008) * (1.25 - p.attrs.passing * 0.5) * oneTouchMul(p);
  dEff = Math.max(dEff, 3);
  const T = clamp(tBase + dEff * tPerM, tMin, tMax);
  // Magnus pre-compensation (Phase 37): launch rotated −spin·T/2 so the
  // ARC's chord still points where the aim did — the designed landing
  // point (and the whole 31.9 corner chain) is invariant; only the path
  // between bends. ballLanding() projects the same closed form.
  match.lastPassKind = { kind: 'through', t: match.simTime };
  match.kickBall(p, spin === 0 ? dir : rotate(dir, -spin * T * 0.5), dEff / T, (GRAVITY * T) / 2);
  match.ball.spin = spin;
}

/**
 * Cross (Phase 28): whip a lofted ball from wide toward a target arriving in
 * the box, pulled a quarter of the way toward goal so deliveries drop into
 * the danger area rather than at a standing man's feet. Resolved in the air:
 * keeper claim or header contest (tryAerial), not a ground reception.
 */
export function performCross(
  match: Match, crosser: Player, target: Player, offsideExempt = false, pull = 0.18, at?: V2,
): void {
  if (match.ball.owner !== crosser || crosser.kickCooldown > 0) return;
  const team = match.teams[crosser.side];
  // C4 T1-FLIGHT (docs/world-model/C4-T1-FLIGHT.md): armed, a cross's flight
  // time floors at the apex that clears the outfield header band. `peak =
  // g·T²/8`, so a delivery under ~14.45 m could not previously reach a head at
  // all — H0, 56.78% of the T0b ladder. The floor is DERIVED from
  // HEADER_MIN_HEIGHT and GRAVITY, applies to crosses ONLY, and technique does
  // not scale it (the placing half is already priced four ways in `loftKick`).
  // C4 O1: the forced profile overrides the match-wide policy at exactly this
  // one choice and nothing else (contract §2.1). Null in production, so the
  // expression below is `match.c4Flight` verbatim when the seam is shut.
  const loft = match.forcedCrossProfile === null
    ? match.c4Flight : match.forcedCrossProfile === 'lofted';
  const tMinCross = loft ? CROSS_FLIGHT_MIN_S : 0.7;
  // The run-lead consumes the SAME law: "lead a meetable fraction of the
  // flight" has to read the flight the ball will actually have. Holding this
  // at the stale estimate would be a second, hidden change to the aim rule
  // (ruling #31.1); `c4FlightStaleLead` is the probe-only arm that measures
  // the alternative rather than arguing it.
  const tMinLead = loft && !match.c4FlightStaleLead ? tMinCross : 0.7;
  const flight0 = clamp(0.5 + dist(crosser.pos, at ?? target.pos) * 0.038, tMinLead, 1.7);
  // Corner routines pass `at` (Phase 31.9): the delivery attacks the
  // routine's KEY ZONE and the crasher times his burst onto it. Open play
  // (Phase 63) leads a MEETABLE fraction of the target's run, capped —
  // the full vel·flight lead was the same 31.9 bug in open-play clothes
  // (constants.ts has the anatomy numbers).
  let leadX = target.vel.x * flight0 * CROSS_LEAD_FRAC;
  let leadY = target.vel.y * flight0 * CROSS_LEAD_FRAC;
  const leadLen = Math.hypot(leadX, leadY);
  if (leadLen > CROSS_LEAD_MAX) {
    leadX *= CROSS_LEAD_MAX / leadLen;
    leadY *= CROSS_LEAD_MAX / leadLen;
  }
  const arrive = at ?? v2(target.pos.x + leadX, target.pos.y + leadY);
  const goal = team.oppGoal();
  // Pulled toward goal, but NOT into the six-yard area — a delivery that
  // drops on the keeper's claim radius is a delivery wasted (28.1: this
  // pull was 0.25 and fed the keeper instead of the penalty spot).
  // Corner routines pass a SMALLER pull (Phase 31): the marker stands
  // goal-side of the crasher by construction, so pulling the drop toward
  // goal handed every corner duel to the defence (probed: attackers won
  // 0.00 duels/corner) — the routine delivery meets the RUN instead.
  const spot = v2(arrive.x + (goal.x - arrive.x) * pull, arrive.y + (goal.y - arrive.y) * pull);
  const oneTouch = crosser.firstTouchWindow > 0;
  // The whipped delivery (Phase 37): crosses and corners curl TOWARD the
  // goal — the inswinger. Sign from the chord×to-goal cross product;
  // technique whips harder. (The landing point is pre-compensated in
  // loftKick, so the 31.9 corner chain sees the same scatter.)
  const chord = norm(sub(spot, crosser.pos));
  const toGoal = norm(sub(goal, crosser.pos));
  const swing = Math.sign(chord.x * toGoal.y - chord.y * toGoal.x) || 1;
  const spin = swing * (0.28 + crosser.attrs.passing * 0.3);
  loftKick(match, crosser, spot, 0.5, 0.038, tMinCross, 1.7, 1.1, spin);
  // C4 T2-ARRIVAL: the licence survives the delivery. Read AFTER the kick, so
  // `ballLanding` sees the real launch and the window is exactly the flight —
  // no invented duration (the corner's 2.8 s carries hand-off slack open play
  // does not have). Armed only when no corner crash is running, so a corner
  // delivery keeps its own machinery and can never be licensed twice.
  if (match.c4Arrival && team.cornerCrash === null) {
    team.crossFlight = {
      until: match.simTime + ballLanding(match.ball).t,
      runners: [...team.runners],
      arriver: team.arriver,
    };
  }
  team.stats.passes++;
  team.stats.crosses++;
  if (oneTouch) team.stats.oneTouch++;
  if (team.localX(target.pos.x) - team.localX(crosser.pos.x) > 2) team.stats.passesForward++;
  registerPass(match, crosser, target, offsideExempt);
}

/**
 * Keeper throw (Phase 28.3): an ACCURATE hand distribution — a gentle ARC
 * (Phase-120, feel: overarm throw, not a flat drive), half the noise of a
 * kicked ball, 8–30m. What a keeper who held the ball does instead of hoofing
 * 50/50s: find a body, hit the body.
 */
export function performKeeperThrow(match: Match, gk: Player, mate: Player): void {
  if (match.ball.owner !== gk || gk.kickCooldown > 0) return;
  const team = match.teams[gk.side];
  const flight0 = clamp(0.62 + dist(gk.pos, mate.pos) * 0.03, 0.9, 1.5);
  const lead = add(mate.pos, scale(mate.vel, flight0 * 0.7));
  // Phase-120 (feel): raise the ARC of the hand throw — the flat-quick tune
  // read like a drive, not a thrown ball. Higher T floor (0.7→0.9) lofts it to
  // a visible ~1.1m peak at short range; still accurate (noiseMul 0.45).
  loftKick(match, gk, lead, 0.62, 0.03, 0.9, 1.5, 0.45);
  team.stats.passes++;
  if (team.localX(mate.pos.x) - team.localX(gk.pos.x) > 2) team.stats.passesForward++;
  registerPass(match, gk, mate, false); // a hand throw is regular play — offside applies
}

/**
 * Cutback (Phase 31): the byline pull-back — a HARD, flat ball driven from
 * the touchline zone to the edge-of-box arc, where the licensed arriver
 * meets it first-time (giveBall's snap-decision window). Faster than a
 * regular pass at the same range so it beats the box defenders' recovery
 * slide across; registered like any pass (interceptions, assists and the
 * offside judgment all apply — the arriver runs from DEEP, so flags are
 * rare by construction).
 */
export function performCutback(match: Match, passer: Player, mate: Player): void {
  if (match.ball.owner !== passer || passer.kickCooldown > 0) return;
  const team = match.teams[passer.side];
  const misalign = kickMisalignment(passer, norm(sub(mate.pos, passer.pos)));
  const powerMul = orientationPowerMul(misalign, passer.attrs.passing);
  const flight = dist(passer.pos, mate.pos) / (18 * powerMul);
  const lead = add(mate.pos, scale(mate.vel, flight * 0.8));
  const d = dist(passer.pos, lead);
  const speed = clamp(d * 0.6 + 10, 11, 23) * powerMul;
  const pressure = pressureAt(passer.pos, match.teams[1 - passer.side].players);
  const aim = norm(sub(lead, passer.pos));
  const noise =
    match.rng.gaussian() *
    (0.02 + pressure * 0.06 + d * 0.0012) *
    (1.15 - team.genome.passBias * 0.3) *
    (1 - team.confidence * 0.12) * // morale sharpens/frays the pass (Phase 111)
    (1.25 - passer.attrs.passing * 0.5) *
    oneTouchMul(passer) *
    orientationNoiseMul(misalign, passer.attrs.passing);
  const oneTouch = passer.firstTouchWindow > 0;
  match.lastPassKind = { kind: 'cross', t: match.simTime };
  match.kickBall(passer, rotate(aim, noise), speed);
  team.stats.passes++;
  team.stats.cutbacks++;
  if (oneTouch) team.stats.oneTouch++;
  match.lastCutback = { side: passer.side, t: match.simTime };
  registerPass(match, passer, mate, false);
}

/**
 * Lofted switch (Phase 28): the big diagonal — a 25m+ ball over the press to
 * a receiver in space. What the 32m ground-pass penalty used to suppress.
 */
/**
 * The curled DELIVERY's swing (Phase 70, user ask 弧线长传 — the second of
 * the curve trilogy): a lofted ball bends its BULGE away from the nearest
 * threat to the landing zone (the recovering defender chases a flight that
 * leans out of his line), or a gentle outswing toward the flank when the
 * drop is clean. Technique whips harder; the landing point itself is
 * pre-compensated inside loftKick, so completion changes only through the
 * geometry of who can meet the ARC — never through a moved drop.
 */
function aerialSwing(passer: Player, from: V2, landing: V2, opponents: Player[]): number {
  const chord = norm(sub(landing, from));
  let threat: Player | null = null;
  let best = 8; // only a defender who can actually work the drop zone
  for (const o of opponents) {
    if (o.sentOff) continue;
    const d = dist(o.pos, landing);
    if (d < best) {
      best = d;
      threat = o;
    }
  }
  const mag = 0.12 + passer.attrs.passing * 0.18;
  if (threat) {
    const cross = chord.x * (threat.pos.y - from.y) - chord.y * (threat.pos.x - from.x);
    return (Math.sign(cross) || 1) * mag;
  }
  // Clean drop: swing away from the pitch's center line — the outswinger
  // a wide receiver runs onto without breaking stride.
  const midY = (from.y + landing.y) / 2;
  const cross = chord.x * (0 - midY);
  return (Math.sign(cross) || 1) * mag * 0.6;
}

export function performLoftedPass(match: Match, passer: Player, mate: Player, offsideExempt = false): void {
  if (match.ball.owner !== passer || passer.kickCooldown > 0) return;
  const team = match.teams[passer.side];
  // Driven, not floated (Phase 30.5): at the old 0.8+d·0.045 a 30m switch
  // hung 2.15s — any defender within ~12m of the drop reached it, and the
  // receiving WINGER is the worst header in the game (AERIAL_ROLE 0.06 vs
  // DF 0.3), so the diagonal completed ~20% and wing play starved. A flat
  // 1.4–1.6s ball reaches the flank before the fullback does.
  const flight0 = clamp(0.55 + dist(passer.pos, mate.pos) * 0.033, 1.1, 2.1);
  const lead = add(mate.pos, scale(mate.vel, flight0 * 0.7));
  const oneTouch = passer.firstTouchWindow > 0;
  // The switch swings (Phase 70) — bulge away from whoever works the drop.
  const swing = aerialSwing(passer, passer.pos, lead, match.teams[1 - passer.side].players);
  loftKick(match, passer, lead, 0.55, 0.033, 1.1, 2.1, 0.9, swing);
  team.stats.passes++;
  team.stats.longBalls++;
  if (oneTouch) team.stats.oneTouch++;
  if (team.localX(mate.pos.x) - team.localX(passer.pos.x) > 2) team.stats.passesForward++;
  registerPass(match, passer, mate, offsideExempt);
}

/** Aerial presence by role: centre-backs and strikers attack the ball. */
const AERIAL_ROLE: Record<Role, number> = { GK: 0, DF: 0.3, MF: 0.14, WG: 0.06, ST: 0.26 };

/**
 * How good this player is in the air — the same formula the header contest
 * rolls against, so cross targeting (PlayerBrain) and duel resolution agree.
 *
 * Phase 63 (the target-man gradient): STRENGTH owns the air. The old
 * weights (defending 0.3, strength 0.1) made the classic big-man
 * investment invisible — +0.45 strength bought +0.045 of duel score
 * against a 0-0.45 random roll, and the probe showed a budget-neutral
 * target man changing NOTHING about cross outcomes. Now strength 0.3 /
 * defending 0.15: the aerial payoff phase-47 assigned to strength is
 * real, and the COUNTER is evolvable the same way — a back line that
 * buys strength out-jumps the big man (the tall-CB answer).
 */
export function aerialSense(p: Player): number {
  return AERIAL_ROLE[p.role] + p.attrs.defending * 0.15 + p.attrs.strength * 0.3;
}

/**
 * Resolve a ball flying through the contest band (Phase 28). Keepers first —
 * hands beat heads: a keeper under the ball claims it (crowd pressure and
 * reflexes decide). Then outfielders within reach jump: position + role
 * aerial sense + attributes pick the winner, who heads for goal in the
 * opponent box, powers it clear near their own, or cushions it to a teammate.
 * `order` alternates per step (the same fairness contract as tryCapture).
 */
export function tryAerial(match: Match, order: Player[]): void {
  const ball = match.ball;
  if (ball.z < HEADER_MIN_HEIGHT || ball.z > GK_CLAIM_HEIGHT) return;

  for (const gk of order) {
    if (gk.role !== 'GK' || gk.sentOff || gk.stunTimer > 0 || gk.tackleCooldown > 0) continue;
    // Hands only inside the box (Phase 28.5): a keeper stranded off his line
    // can't PLUCK a high ball out of the air — outside his area the delivery
    // is an outfield header contest, not a keeper claim.
    if (!match.inPenaltyBox(gk.pos, gk.side)) continue;
    const dx = gk.pos.x - ball.pos.x;
    const dy = gk.pos.y - ball.pos.y;
    if (dx * dx + dy * dy > 1.9 * 1.9) continue;
    // Committed to the jump either way (pickup stays free). 0.5 → 0.9 in
    // 29.1: a ball hanging/bouncing through the claim band re-rolled every
    // half second, and the restarting dive pose read as convulsions.
    gk.tackleCooldown = 0.9;
    gk.saveAnimTimer = 0.6;
    const crowd = pressureAt(gk.pos, match.teams[1 - gk.side].players);
    const pClaim = clamp(0.62 + (gk.attrs.reflexes - 0.5) * 0.5 - crowd * 0.3, 0.2, 0.9);
    if (match.rng.chance(pClaim)) {
      // A claimed opponent shot is a save (a dropping header, typically).
      const shot = match.pendingShot;
      if (shot && !shot.resolved && shot.side !== gk.side) {
        shot.resolved = true;
        match.teams[shot.side].stats.shotsOnTarget++;
        match.teams[gk.side].stats.saves++;
        match.stat(gk.gid).saves++;
        match.markShotOutcome('saved');
      }
      match.pushEvent('save', gk.side, `${gk.name} claims the high ball`);
      match.giveBall(gk);
      return;
    }
    // Flapped at it under pressure — the ball sails on.
  }

  if (ball.z > HEADER_MAX_HEIGHT) return;
  // Chest / thigh trap (Phase 28.6): before anyone HEADS a hanging ball,
  // an unpressured man under a dropping ball in the lower band takes it DOWN.
  if (tryChestTrap(match, order)) return;
  let winner: Player | null = null;
  let best = -Infinity;
  const contenders: Player[] = [];
  for (const p of order) {
    if (p.role === 'GK' || p.sentOff || p.stunTimer > 0 || p.kickCooldown > 0) continue;
    const dx = p.pos.x - ball.pos.x;
    const dy = p.pos.y - ball.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > HEADER_RADIUS * HEADER_RADIUS) continue;
    contenders.push(p);
    // Position + aerial sense + a seeded jump-timing roll pick the winner.
    // Attackers meeting a delivery in the opponent box arrive with momentum
    // — a real edge over the defender jumping from a standing start. Raised
    // 0.12 → 0.2 in 29.1: un-marking the corner taker freed a defender to
    // mark in the box (3v3, everyone tracked) and corner threat collapsed
    // to 3.5% — the crasher's running jump is what beats a set marker.
    // 0.2 → 0.3 (Phase 31): with routine deliveries finally meeting the
  // crashers' runs, the running jump's edge over the goal-side marker's
  // standing start is what wins the zone — at 0.2 the position term still
  // handed every corner duel to the defence.
  const attacking = match.teams[p.side].localX(ball.pos.x) > HALF_L - BOX_DEPTH ? 0.3 : 0;
    const s =
      aerialSense(p) +
      attacking +
      (1 - Math.sqrt(d2) / HEADER_RADIUS) * 0.35 +
      match.rng.range(0, 0.45);
    if (s > best) {
      best = s;
      winner = p;
    }
  }
  if (!winner) return;
  // Let it DROP for the chest trap (Phase 28.6): a player with TIME and SPACE
  // shouldn't nod a dropping midfield ball on — that header is exactly what
  // kept the aerial rally alive. If nobody's contesting (no opponent within
  // header reach), the ball is falling (vz < 0), and it's neither a header
  // chance on goal nor a clearance near our own, decline the header and let
  // it come down — `tryChestTrap` takes it to the feet a few steps later (or
  // it just lands and is controlled on the ground). Attacking free headers
  // and defensive clears are UNCHANGED (they fall outside the gate).
  const wteam = match.teams[winner.side];
  const dOppGoal = dist(ball.pos, wteam.oppGoal());
  const nearOwnGoal = dist(ball.pos, wteam.ownGoal()) < 20;
  let oppNear = false;
  for (const o of match.teams[1 - winner.side].players) {
    if (o.sentOff || o.role === 'GK') continue;
    if (dist(o.pos, ball.pos) < HEADER_RADIUS) { oppNear = true; break; }
  }
  if (!oppNear && ball.vz < 0 && dOppGoal >= 16.5 && !nearOwnGoal) return;
  // Committed to the header — every contender jumped (brief recovery so a
  // ball hanging through the band doesn't re-roll into a convulsion).
  for (const p of contenders) {
    p.kickCooldown = 0.45;
    p.headerAnimTimer = 0.55;
  }
  // Offside (Phase 29): the flagged target meeting the delivery in the air
  // IS the touch that completes the offence — whistle instead of the header.
  const pass = match.pendingPass;
  if (pass && pass.offside && winner.side === pass.side && winner.gid === pass.targetGid) {
    match.pendingPass = null;
    match.callOffside(winner, pass.offsideSpot ?? winner.pos);
    return;
  }
  headBall(match, winner);
}

/** What the header winner does with it — shot, clearance or knockdown. */
function headBall(match: Match, p: Player): void {
  const ball = match.ball;
  const team = match.teams[p.side];
  ball.lastTouch = p;
  team.stats.headersWon++;

  // Delivery bookkeeping: a teammate's cross/loft met in the air is a
  // completed pass (assist credit if the header goes in); an opponent's
  // delivery headed away is an interception.
  const pass = match.pendingPass;
  if (pass && pass.side === p.side && pass.passerGid !== p.gid) {
    team.stats.passesCompleted++;
    match.lastCompletedPass = { passerGid: pass.passerGid, receiverGid: p.gid, t: match.simTime };
  } else if (pass && pass.side !== p.side) {
    team.stats.interceptions++;
    match.stat(p.gid).recoveries++;
  }
  match.pendingPass = null;

  const dGoal = dist(ball.pos, team.oppGoal());
  if (dGoal < 16.5) {
    performHeaderShot(match, p);
    return;
  }
  if (dist(ball.pos, team.ownGoal()) < 20) {
    // Defensive header: power it away from goal, high and wide.
    const dir = norm(v2(team.attackDir, match.rng.range(-0.9, 0.9)));
    ball.vel = scale(dir, match.rng.range(11, 15));
    ball.vz = match.rng.range(3.5, 5.2);
    team.stats.clearances++;
    return;
  }
  // Knockdown: cushion it toward the best-placed teammate in range.
  let mate: Player | null = null;
  let bestS = -Infinity;
  for (const q of team.players) {
    if (q === p || q.sentOff) continue;
    const d = dist(q.pos, ball.pos);
    if (d > 16) continue;
    const s = opennessOf(q, match.teams[1 - p.side].players) - (d / 16) * 0.4;
    if (s > bestS) {
      bestS = s;
      mate = q;
    }
  }
  const to = mate ? norm(sub(mate.pos, ball.pos)) : v2(team.attackDir, 0);
  ball.vel = scale(to, match.rng.range(7, 9.5));
  ball.vz = 0.8; // nodded down — drops quickly to feet
}

/**
 * Chest / thigh trap (Phase 28.6, user report "球在两个球员之间弹来弹去 —
 * 是不是没有胸部停球"). A ball DROPPING through the lower header band that no
 * opponent is contesting can be CUSHIONED to the feet instead of headed — the
 * missing alternative that turned every hanging ball into an endless nod-it-
 * back-and-forth rally. Only the man almost directly under it, only a
 * descending/apex ball below chest height, only when it is NOT a live aerial
 * duel (an opponent within header reach = head it, as before). The take-down
 * is priced by first-touch (same `touchFailChance` surface as a ground
 * reception, +a small aerial malus) and SPILLS under pressure — a failed trap
 * drops the ball loose, so the scramble is preserved, just not perpetual.
 * Returns true if the trap fired (clean OR spilled); the caller then skips the
 * header contest for this step.
 */
function tryChestTrap(match: Match, order: Player[]): boolean {
  const ball = match.ball;
  if (ball.z > CHEST_TRAP_MAX_HEIGHT || ball.vz > CHEST_TRAP_MAX_VZ) return false;
  // The man almost directly under it (tighter than a header reach).
  let trapper: Player | null = null;
  let bestD = CHEST_TRAP_RADIUS;
  for (const p of order) {
    if (p.role === 'GK' || p.sentOff || p.stunTimer > 0 || p.kickCooldown > 0) continue;
    const d = dist(p.pos, ball.pos);
    if (d < bestD) {
      bestD = d;
      trapper = p;
    }
  }
  if (!trapper) return false;
  // A contested ball is an aerial DUEL — let it be headed (unchanged).
  for (const o of match.teams[1 - trapper.side].players) {
    if (o.sentOff || o.role === 'GK') continue;
    if (dist(o.pos, ball.pos) < HEADER_RADIUS) return false;
  }
  // Price the cushion: drop speed (vz counts, like a ground first touch),
  // pressure, and taking it on the blind side; technique tames all of it.
  const hSpeed = Math.max(len(ball.vel), 1e-6);
  const inx = ball.vel.x / hSpeed;
  const iny = ball.vel.y / hSpeed;
  const speed = len(ball.vel) + Math.abs(ball.vz) * 0.6;
  const misalign = (1 + (inx * trapper.heading.x + iny * trapper.heading.y)) / 2;
  const pressure = pressureAt(trapper.pos, match.teams[1 - trapper.side].players);
  const pFail = clamp(
    touchFailChance(
      speed, pressure, misalign, trapper.attrs.dribbling, trapper.attrs.positioning,
      match.edsTouchCost,
    ) + 0.05, 0, 0.5,
  );
  trapper.kickCooldown = 0.3; // committed to the touch either way
  if (!match.rng.chance(pFail)) {
    match.giveBall(trapper); // clean take-down: giveBall snaps it dead to feet + does pass/offside bookkeeping
    return true;
  }
  // Spilled the cushion — a heavy touch knocks it loose and low (the scramble).
  match.teams[trapper.side].stats.miscontrols++;
  match.stat(trapper.gid).miscontrols++;
  ball.lastTouch = trapper;
  ball.vel = scale(rotate(v2(inx, iny), match.rng.range(-0.9, 0.9)), match.rng.range(3, 5.5));
  ball.vz = 0; // knocked down — it drops
  return true;
}

/**
 * Headed shot: meeting a cross in the box. Converts worse than feet (tight
 * distance falloff, capped quality) and sprays more, but arrives from the
 * exact spot defenders least want — the same pendingShot machinery as
 * performShot, difficulty frozen at contact.
 */
function performHeaderShot(match: Match, shooter: Player): void {
  match.endPassMove(shooter.side); // the header ends the move (Phase 33)
  const team = match.teams[shooter.side];
  const opp = match.teams[1 - shooter.side];
  const gk = opp.goalkeeper;
  const ball = match.ball;

  const goalX = team.attackDir * HALF_L;
  const aimMargin = 1.6 - shooter.attrs.finishing * 0.8;
  const aimY = (gk.pos.y >= 0 ? -1 : 1) * (GOAL_WIDTH / 2 - aimMargin);
  const target = v2(goalX, aimY);
  const d = dist(ball.pos, target);
  const pressure = pressureAt(shooter.pos, opp.players);
  const central = 1 - clamp01(Math.abs(ball.pos.y) / HALF_W) * 0.5;
  const q = clamp(0.5 * Math.exp(-d / 8.5) * central * (1 - pressure * 0.25), 0.01, 0.45);

  const aim = norm(sub(target, ball.pos));
  const spread = (0.05 + d * 0.004 + pressure * 0.04) * (1.35 - shooter.attrs.finishing * 0.65);
  const dir = rotate(aim, match.rng.gaussian() * spread);
  ball.vel = scale(dir, 15 + shooter.attrs.finishing * 4);
  ball.vz = -1.2; // headed down toward the goal

  team.stats.shots++;
  team.stats.xg += q;
  match.stat(shooter.gid).shots++;

  const difficulty = diveDifficulty(ball.pos, dir, gk, opp);
  const lp = match.lastCompletedPass;
  const assistGid =
    lp && lp.receiverGid === shooter.gid && match.simTime - lp.t < 3 ? lp.passerGid : null;

  match.markShotOutcome('miss');
  match.shotLog.push({
    t: match.simTime, minute: match.minute(), side: shooter.side, xg: q, outcome: 'pending',
    blockers: laneBlockers(ball.pos, team.oppGoal(), opp.players),
    channel: match.goalChannelFor(shooter),
  });
  match.pendingShot = {
    side: shooter.side,
    shooterGid: shooter.gid,
    closeIn: clamp01((7 - dist(gk.pos, shooter.pos)) / 7),
    coverage: angleCoverage(gk, shooter.pos, team.oppGoal()),
    xg: q,
    t: match.simTime,
    resolved: false,
    logIndex: match.shotLog.length - 1,
    difficulty,
    assistGid,
  };
  if (assistGid !== null) {
    team.stats.keyPasses++;
    const passer = match.allPlayers[assistGid];
    if (passer) match.pushEvent('keypass', shooter.side, `${passer.name} with the delivery`);
  }
  match.pushEvent('shot', shooter.side, `${shooter.name} heads it at goal! (xG ${q.toFixed(2)})`);
}

/** Attacked-goal center for a shooter's team (helper for 1v1 detection). */
function goalCenterFor(team: { oppGoal(): V2 }): V2 {
  return team.oppGoal();
}

/**
 * The CHIP (Phase 69): loft the finish over a keeper who has left his
 * line, dropping under the bar behind him. Mirrors the free kick's
 * two-constraint closed form — z ≥ the claim ceiling as it passes the
 * keeper (tryKeeperSave cannot touch a ball above GK_CLAIM_HEIGHT),
 * z = the drawn arrival height as it crosses the line (over the bar =
 * the classic overhit, exactly like the FK's blaze-over). The counters
 * are all emergent: a keeper IN THE FACE smothers the launch while it's
 * still low (the save window before z clears 2.55), a keeper at home
 * leaves no gap (feasibility fails), a floaty lob is rejected up front
 * (hang time returns the line), and a short chip drops into the claim.
 * Returns true when the chip replaced the ground strike.
 */
function tryChip(match: Match, shooter: Player, qGround: number, pressure: number): boolean {
  const team = match.teams[shooter.side];
  const opp = match.teams[1 - shooter.side];
  const gk = opp.goalkeeper;
  if (gk.sentOff) return false;
  const goalX = team.attackDir * HALF_L;
  // Cross the line off-center, away from the keeper's side — the open half.
  // Geometry from the SHOOTER (the ground path's convention): the carried
  // ball rides at his feet and kickBall re-bases the release at his body.
  const target = v2(goalX, (gk.pos.y >= 0 ? -1 : 1) * 1.4);
  const d = dist(shooter.pos, target);
  if (d < 7 || d > 30) return false; // not a toe-poke, not a halfway lob
  const aim = norm(sub(target, shooter.pos));
  const toGkX = gk.pos.x - shooter.pos.x;
  const toGkY = gk.pos.y - shooter.pos.y;
  const along = toGkX * aim.x + toGkY * aim.y;
  // The keeper must sit ON the chord with real space BEHIND him; a keeper
  // in the shooter's face is the smother's problem, not the solver's.
  if (along < 2.5 || along > d - 5.5) return false;
  if (Math.abs(toGkX * aim.y - toGkY * aim.x) > 3.5) return false;
  // CAUGHT OUT, not merely positioned (first probe: the routine line at
  // KA 0.5 fired 3.9 chips/match — a lob festival): the chip demands the
  // keeper genuinely stranded, ≥7.5m off his goal center. The sweeper's
  // rushes and the high line (keeperAggression) are what put him there.
  const og = opp.ownGoal();
  if (Math.hypot(gk.pos.x - og.x, gk.pos.y - og.y) < 7.5) return false;

  // Feasibility + price at the NOMINAL arrival (rng only spends on a
  // taken chip, so untaken chips leave every other shot's stream alone).
  const a = clamp(along / d, 0.15, 0.8);
  const clearK = GK_CLAIM_HEIGHT + 0.25;
  const t2Nom = (clearK - a * 1.3) / ((GRAVITY / 2) * a * (1 - a));
  if (t2Nom <= 0) return false;
  const tNom = Math.sqrt(t2Nom);
  if (tNom > 1.45) return false; // hang time hands the keeper his line back
  const qChip = clamp(
    0.36 - (tNom - 0.9) * 0.22 - pressure * 0.12 + shooter.attrs.finishing * 0.06,
    0.03, 0.38,
  );
  // Clearly better or nothing — a marginal chip is a shot wasted on
  // spectacle (the volume gate that keeps the lob an EVENT).
  if (qChip < qGround * 1.2 + 0.03) return false;

  // Execute: the arrival height draws high (over-bar = the honest miss),
  // finishing narrows the draw AND the lateral spray.
  const zg = 0.8 + match.rng.range(0, 1.9 - shooter.attrs.finishing * 0.5);
  const T = Math.sqrt(Math.max(0.4, (clearK - a * zg) / ((GRAVITY / 2) * a * (1 - a))));
  const vz = (zg + (GRAVITY / 2) * T * T) / T;
  const misalign = kickMisalignment(shooter, aim);
  const spread =
    (0.03 + d * 0.0012) * (1.3 - shooter.attrs.finishing * 0.6) *
    orientationNoiseMul(misalign, shooter.attrs.dribbling);
  const dir = rotate(aim, match.rng.gaussian() * spread);
  match.lastPassKind = { kind: 'lofted', t: match.simTime };
  match.kickBall(shooter, dir, d / T, vz);

  team.stats.shots++;
  team.stats.xg += qChip;
  match.stat(shooter.gid).shots++;
  const lp = match.lastCompletedPass;
  const assistGid =
    lp && lp.receiverGid === shooter.gid && match.simTime - lp.t < 3 ? lp.passerGid : null;
  match.markShotOutcome('miss'); // close out any still-pending previous shot
  match.shotLog.push({
    t: match.simTime, minute: match.minute(), side: shooter.side, xg: qChip, outcome: 'pending',
    blockers: laneBlockers(shooter.pos, goalCenterFor(team), opp.players),
    chip: true,
    channel: match.goalChannelFor(shooter),
  });
  match.pendingShot = {
    side: shooter.side,
    shooterGid: shooter.gid,
    xg: qChip,
    t: match.simTime,
    resolved: false,
    logIndex: match.shotLog.length - 1,
    // A keeper scrambling BACK under a dropping ball saves awkwardly.
    difficulty: 0.8,
    assistGid,
  };
  match.pushEvent('shot', shooter.side, `${shooter.name} chips the keeper! (xG ${qChip.toFixed(2)})`);
  return true;
}

export function performShot(match: Match, shooter: Player): void {
  if (match.ball.owner !== shooter || shooter.kickCooldown > 0) return;
  match.endPassMove(shooter.side); // a strike ends the passing move (Phase 33)
  const team = match.teams[shooter.side];
  const opp = match.teams[1 - shooter.side];
  const gk = opp.goalkeeper;

  // Aim for the corner away from the keeper. Finishing has two channels:
  // confident finishers aim closer to the post (bigger keeper-evasion, riskier
  // margin) AND group their shots tighter.
  const goalX = team.attackDir * HALF_L;
  // 1.5 → 1.2 in Phase 30.4 (dare the corners), → 1.3 in Phase 31's
  // retune: with chance volume restored (open runs, cutbacks, routines)
  // the trade flips back toward failure mode 16a — a slightly safer aim
  // keeps more strikes on the frame while the keeper still can't reach
  // the corner.
  // The clinical trait (Phase 39) shaves another 0.1 off the post —
  // floored at 0.4 (the base formula's own minimum at finishing 1.0):
  // an elite finisher who ALSO shaved 0.1 aimed past the optimum and
  // converted less (caught by the finishing-conversion invariant test).
  // Finishing slope 0.9 → 0.6 (Phase 47): the eras of churn since 31.5
  // (36.1 carries, 38 contact, 46 keeper envelope) had pushed the corner
  // dare past its optimum again — by phase-46 the hi-fin conversion edge
  // measured +1.3pp ≈ noise and the invariant test finally flipped.
  // Swept {0.9, 0.75, 0.6, 0.5} at 540 matches: 0.6 restores +2.1pp
  // (hi 28.9% vs lo 26.8%) — the finisher backs off the post just enough
  // that the tight grouping cashes.
  const aimMargin = Math.max(
    0.4,
    1.3 - shooter.attrs.finishing * 0.6 - (shooter.traits.includes('clinical') ? 0.1 : 0),
  );
  const aimY = (gk.pos.y >= 0 ? -1 : 1) * (GOAL_WIDTH / 2 - aimMargin);
  const target = v2(goalX, aimY);

  const q = shotQuality(match, shooter);
  const d = dist(shooter.pos, target);
  const pressure = pressureAt(shooter.pos, opp.players);
  // CONTESTED FINISHING (Phase 85, the inflation fix the user chose):
  // pressureAt is distance-only — a 0.9-defending stopper closing on the
  // strike degraded it exactly like a statue, so defense had NO evolvable
  // gradient at the conversion point and late leagues converted 58-77% of
  // all shots (phase-84 anatomy). The nearest closing OUTFIELDER's quality
  // now scales the pressure the strike feels: ×1.0 at defending 0.5
  // (early-gen behavior preserved by construction), ×0.55 vs a statue,
  // ×1.45 vs a master. The xG model stays blind to defender quality —
  // like real xG — so evolved defending shows up as UNDER-performance.
  let contest = pressure;
  if (pressure > 0) {
    let bestD = Infinity;
    let presser: Player | null = null;
    for (const o of opp.players) {
      if (o.sentOff || o.role === 'GK') continue;
      const dd = dist(o.pos, shooter.pos);
      if (dd < bestD) {
        bestD = dd;
        presser = o;
      }
    }
    if (presser) contest = pressure * (0.55 + presser.attrs.defending * 0.9);
  }
  // THE CHIP (Phase 69, user ask 挑射/吊射): a keeper OFF HIS LINE can be
  // beaten over the top — the ecology's first mechanism that PUNISHES
  // keeperAggression (the sweeper's line height is exactly what opens the
  // gap behind him). Geometry decides feasibility, the price comparison
  // decides the attempt; a taken chip replaces this ground strike.
  if (tryChip(match, shooter, q, pressure)) return;
  // Composed 1v1 (Phase 28.4): nobody goal-side but the keeper — the shooter
  // PICKS a spot: tighter to the post, tighter grouping. Without this the
  // breakaway-finish appetite just fed the keeper from 15m.
  let oneVone = true;
  for (const o of opp.players) {
    if (o.role === 'GK' || o.sentOff) continue;
    if (dist(o.pos, goalCenterFor(team)) < d - 1) {
      oneVone = false;
      break;
    }
  }
  // Composure EARNED (Phase 93): the 28.4 gift was attribute-blind — every
  // breakaway shooter got the tighter aim + grouping for free, and the
  // shot-context anatomy measured that pipe at 76-81% of late-gen goals.
  // Scale the gift by finishing instead: at 0.5 the oneVone branch is a
  // no-op (a plain shot), a 0.9+ finisher keeps the full old gift
  // (aim ×0.72, spread ×0.7), and a 0.2 finisher PANICS — alone in front
  // of goal with nothing to trust, he sprays WIDER than a contested shot.
  // Composure is now a thing the budget must buy, not a flag.
  const composure = clamp((shooter.attrs.finishing - 0.5) / 0.4, -0.75, 1);
  const aimTarget = oneVone
    ? v2(goalX, (gk.pos.y >= 0 ? -1 : 1) * (GOAL_WIDTH / 2 - aimMargin * (1 - 0.28 * composure)))
    : target;
  const aim = norm(sub(aimTarget, shooter.pos));
  // Long-range and pressured shots spray more; finishers spray less. A shot
  // snatched against the body's facing (Phase 27) sprays more and loses power.
  const misalign = kickMisalignment(shooter, aim);
  // Spread base 0.029 → 0.025 in 29.1, → 0.022 in Phase 30: set defences
  // (formations) mean almost every shot is a contested one now — tighter
  // base grouping keeps the on-target share honest without touching the
  // pressure physics (failure mode 16: aim/spread beat reach/saveP here).
  const spread =
    (0.022 + d * 0.0028 + contest * 0.05) *
    (1.45 - shooter.attrs.finishing * 0.9) *
    (1 - team.confidence * 0.12) * // the finish rides confidence too (Phase 111)
    (oneVone ? 1 - 0.3 * composure : 1) *
    orientationNoiseMul(misalign, shooter.attrs.dribbling);
  const dir = rotate(aim, match.rng.gaussian() * spread);

  // The placed curler (Phase 37): technique bends the strike around the
  // dive. Launch pre-compensated by −spin·T/2 so the chord still crosses
  // the frame where the aim pointed; lateral drift = spin·vx, so the sign
  // that bends AWAY from the keeper is sign(Δy·dirx).
  const curl =
    (Math.sign((aimTarget.y - gk.pos.y) * dir.x) || 1) * (0.1 + shooter.attrs.dribbling * 0.2);
  const v0 = SHOT_SPEED * orientationPowerMul(misalign, shooter.attrs.dribbling);
  const shotT = -Math.log(1 - Math.min((d * BALL_FRICTION_K) / v0, 0.85)) / BALL_FRICTION_K;
  match.kickBall(shooter, rotate(dir, -curl * shotT * 0.5), v0);
  match.ball.spin = curl;
  team.stats.shots++;
  team.stats.xg += q;
  match.stat(shooter.gid).shots++;

  // Dive difficulty, frozen at the moment of the strike (keeper reaction) —
  // priced on the CHORD, discounted for the bend the dive can't fully read.
  const difficulty = Math.max(
    0.25,
    diveDifficulty(match.ball.pos, dir, gk, opp) * (1 - Math.abs(curl) * 0.12),
  );

  // Assist credit if this shot scores: the completed pass that set it up.
  const lpForAssist = match.lastCompletedPass;
  const assistGid =
    lpForAssist && lpForAssist.receiverGid === shooter.gid && match.simTime - lpForAssist.t < 3
      ? lpForAssist.passerGid
      : null;

  match.markShotOutcome('miss'); // close out any still-pending previous shot
  match.shotLog.push({
    t: match.simTime, minute: match.minute(), side: shooter.side, xg: q, outcome: 'pending',
    blockers: laneBlockers(shooter.pos, goalCenterFor(team), opp.players),
    pressure,
    oneVone,
    assist:
      match.lastCutback && match.lastCutback.side === shooter.side && match.simTime - match.lastCutback.t < 5
        ? 'cutback'
        : match.lastPassKind && match.simTime - match.lastPassKind.t < 2.5
          ? match.lastPassKind.kind
          : 'none',
    channel: match.goalChannelFor(shooter),
  });
  match.pendingShot = {
    side: shooter.side,
    shooterGid: shooter.gid,
    xg: q,
    t: match.simTime,
    resolved: false,
    logIndex: match.shotLog.length - 1,
    difficulty,
    assistGid,
    closeIn: clamp01((7 - dist(gk.pos, shooter.pos)) / 7),
    coverage: angleCoverage(gk, shooter.pos, goalCenterFor(team)),
  };

  // Key pass: shot within 3s of receiving.
  const lp = match.lastCompletedPass;
  if (lp && lp.receiverGid === shooter.gid && match.simTime - lp.t < 3) {
    team.stats.keyPasses++;
    const passer = match.allPlayers[lp.passerGid]; // allPlayers is gid-indexed
    if (passer) match.pushEvent('keypass', shooter.side, `${passer.name} with the key pass`);
  }
  match.pushEvent('shot', shooter.side, `${shooter.name} shoots! (xG ${q.toFixed(2)})`);
}

/**
 * Direct free kick (Phase 32): the curl over the wall. Closed-form
 * parabola through TWO constraints — z ≥ 2.6m at the wall line (above the
 * outfield header band, 2.5m: a wall that can contest the climb eats
 * every kick, the 31.9 corner-sentry lesson) and a chosen arrival height
 * under the bar — then the usual shot bookkeeping so saves/goals/xG all
 * ride the pendingShot machinery.
 */
export function performFreeKick(match: Match, taker: Player): void {
  if (match.ball.owner !== taker || taker.kickCooldown > 0) return;
  const team = match.teams[taker.side];
  const opp = match.teams[1 - taker.side];
  const gk = opp.goalkeeper;
  const ball = match.ball;

  const goalX = team.attackDir * HALF_L;
  // Specialists shave the post; timid takers aim well inside it.
  const aimMargin = 1.05 - taker.attrs.finishing * 0.55;
  const aimY = (gk.pos.y >= 0 ? -1 : 1) * (GOAL_WIDTH / 2 - aimMargin);
  const target = v2(goalX, aimY);
  const d = dist(ball.pos, target);

  // Solve the flight: z(a·T) = 2.6 at the wall (a = wallDist/d) and
  // z(T) = zg at the goal ⇒ T² = (2.6 − a·zg) / (G/2 · a(1−a)).
  // The arrival height DRAWS high (up to ~2.75): everything above the bar
  // is the classic blazed-over-the-wall miss — without it every strike
  // arrived under the bar by construction and conversion tripled.
  const zg = 0.85 + match.rng.range(0, 1.9);
  // The wall's REAL distance from the release point (the taker may stand
  // up to ~1.3m off the spot and kickBall releases 0.9m ahead — assuming
  // a spot-kick left the climb at ~2.2m over the heads, inside the header
  // band, instead of the designed 2.6).
  let wallD = CORNER_CLEARANCE - 0.9;
  if (match.fkWall) {
    const own = v2(team.attackDir * HALF_L, 0);
    const center = add(match.fkWall.pos, scale(norm(sub(own, match.fkWall.pos)), CORNER_CLEARANCE + 0.15));
    wallD = dist(ball.pos, center) - 1.4; // release offset + safety margin
  }
  // The banana's price (Phase 37): a curled launch leaves the straight
  // line, and the climb's header-band segment sweeps past the wall's edge
  // bodies — the solver buys extra clearance per unit of spin (the first
  // cut at spin ≤0.7 with plain 2.6 put 4/30 walls back in the header
  // game, the exact 31.9 sentry failure the invariant test pins).
  const spinMag = 0.25 + taker.attrs.passing * 0.25;
  const a = clamp(wallD / d, 0.12, 0.6);
  const wallClear = 2.6 + spinMag * 0.5;
  const T = clamp(Math.sqrt(Math.max(0.4, (wallClear - a * zg) / ((GRAVITY / 2) * a * (1 - a)))), 0.9, 1.9);
  const vz = (zg + (GRAVITY / 2) * T * T) / T;
  const speed = d / T;

  // Placed ball, full run-up: no orientation penalties, tight spread that
  // finishing tames — the free kick is the specialist's shot.
  const spread = (0.034 + d * 0.001) * (1.35 - taker.attrs.finishing * 0.7);
  const aim = norm(sub(target, ball.pos));
  const dir = rotate(aim, match.rng.gaussian() * spread);

  // Direct FKs convert ~4-8% in the real game — the xG entry says so.
  const q = clamp(0.09 - (d - 17) * 0.003, 0.02, 0.12);

  // The banana ball (Phase 37): the specialist's strike curls AWAY from
  // the keeper toward the chosen corner — over the wall on the solver's
  // flight, bending across the frame. Launch pre-compensated by −spin·T/2
  // (the chord still crosses at the aim point); the curl prices the dive.
  // Lateral (y) drift of a spinning ball = spin·vx, so the sign that
  // drifts from the keeper toward the chosen corner is sign(Δy·vx).
  const curlSign = Math.sign((target.y - gk.pos.y) * dir.x) || 1;
  const spin = curlSign * spinMag;
  const kickPos = v2(ball.pos.x, ball.pos.y);
  match.kickBall(taker, rotate(dir, -spin * T * 0.5), speed, vz);
  ball.spin = spin;
  team.stats.shots++;
  team.stats.xg += q;
  match.stat(taker.gid).shots++;

  // The dive prices the CHORD (where the arc actually crosses the frame)
  // plus the late bend the keeper cannot fully read.
  const difficulty = Math.max(0.25, diveDifficulty(kickPos, dir, gk, opp) * (1 - Math.abs(spin) * 0.12));

  match.markShotOutcome('miss'); // close out any still-pending previous shot
  match.shotLog.push({
    t: match.simTime, minute: match.minute(), side: taker.side, xg: q, outcome: 'pending',
    blockers: 0, // the wall is cleared by construction; blocks don't apply
    channel: match.goalChannelFor(taker), // the FK stamp lands it as `setpiece`
  });
  match.pendingShot = {
    side: taker.side,
    shooterGid: taker.gid,
    xg: q,
    t: match.simTime,
    resolved: false,
    logIndex: match.shotLog.length - 1,
    difficulty,
    assistGid: null, // a placed ball has no assist
    placed: true,
  };
  match.pushEvent('shot', taker.side, `${taker.name} bends the free kick! (xG ${q.toFixed(2)})`);
}

/**
 * The dribble PUSH (Phase 36, 可见的触球): the carrier knocks the ball
 * ahead along his heading and chases it. The ball is a free body until he
 * re-collects (the push-scaled poke window an opponent in
 * the path plays the BALL in). Push length grows with open field ahead
 * (knock-and-run down the wing) and wobbles with poor technique; sprint
 * speed carries into the ball, so close control at walking pace stays
 * naturally tight.
 */
export function performDribbleTouch(match: Match, p: Player): void {
  const ball = match.ball;
  if (ball.owner !== p) return;
  const opp = match.teams[1 - p.side];
  // Open field ahead: nearest opponent inside a forward cone prices the push.
  const hx = p.heading.x;
  const hy = p.heading.y;
  let aheadD = 14;
  for (const o of opp.players) {
    if (o.sentOff) continue;
    const dx = o.pos.x - p.pos.x;
    const dy = o.pos.y - p.pos.y;
    const along = dx * hx + dy * hy;
    // The keeper's stopping power starts upfield of his body (Phase 46):
    // a loose roll entering his rush envelope is collected, full stop —
    // outfielders must WIN the ball, so they price at body position.
    const eff = o.role === 'GK' ? along - GK_RUSH_ENVELOPE : along;
    if (along < 0 || eff > 14) continue;
    const perp = Math.abs(dx * hy - dy * hx);
    if (perp > along * 0.7 + 1) continue; // outside the ~70° cone
    if (eff < aheadD) aheadD = Math.max(eff, 0);
  }
  // Carry regimes (36.1): the open cone ahead PRICES the touch — a
  // stride-length nudge in traffic (一步一带), a real knock into open
  // grass (爆趟). Technique shortens and steadies both.
  const open = Math.min(Math.max(aheadD - 2, 0), 9);
  let push = (TOUCH_PUSH_BASE + open * TOUCH_PUSH_SPACE) * (1.05 - p.attrs.dribbling * 0.15);
  // The line guard (36.1): a knock that would roll into touch is halved —
  // real wingers shorten the touch at the line (12.9% of pushes rolled
  // dead/out at the first cut).
  const rollEst = push; // rolled meters ≈ push m/s over ~1s of decay
  if (
    Math.abs(p.pos.y + hy * (rollEst + 2)) > HALF_W - 1 ||
    Math.abs(p.pos.x + hx * (rollEst + 2)) > HALF_L - 1
  ) {
    push *= 0.5;
  }
  const vmag = Math.hypot(p.vel.x, p.vel.y);
  const speed = vmag + Math.max(push, 0.8);
  // A heavy first touch is a WOBBLY one: direction noise priced by technique.
  const noise = match.rng.gaussian() * 0.07 * (1.35 - p.attrs.dribbling * 0.7);
  // Knock it along the direction of TRAVEL, not the instantaneous facing.
  // `heading` is rate-capped (TURN_RATE) and lags the velocity through a turn,
  // so aiming at the old facing sent the freed ball off on a line the carrier
  // was already turning away from — it "flew out" on a spin (play report:
  // "带球转身,球偶尔会飞出去"). The ball now follows where he is actually
  // running, so it stays on his path through the turn (gate needs v>2.5 m/s,
  // so `travel` is always well-defined here; heading is only the slow fallback).
  const travel = vmag > 0.5 ? v2(p.vel.x / vmag, p.vel.y / vmag) : v2(hx, hy);
  const dir = rotate(travel, noise);
  ball.owner = null;
  ball.lastTouch = p;
  ball.vel = scale(dir, speed);
  ball.z = 0;
  ball.vz = 0;
  // The regather window follows the push: a knock is a chase, a dribble
  // touch comes back underfoot within the stride.
  p.kickCooldown = TOUCH_RECOLLECT_BASE + push * TOUCH_RECOLLECT_PER_PUSH;
  match.dribbleTouch = { gid: p.gid, until: match.simTime + 1.6 };
}

/**
 * ⭐⭐ CB T0 §SEAM (b) — THE DIRECTIONAL TOUCH-PAST (contract §2 M-CB.1(b);
 * docs/world-model/CB-T0-DORMANT-LAYER1-SEAM.md).
 *
 * The carrier knocks the ball a real distance into a CHOSEN direction. The ball GENUINELY
 * leaves his feet: this is `performDribbleTouch`'s own release, verbatim — `ball.owner = null`,
 * the ball integrates as a free body from the next step, the carrier's own regather window is
 * the engine's push-scaled one, and `match.dribbleTouch` marks it as his knock — so the race
 * that follows is the engine's EXISTING loose-ball race (`tryCapture` / the control-contact
 * ladder), which anyone can win. Nothing about pickup is re-invented here.
 *
 * TWO differences from the incumbent push, and only two: (i) it goes where the carrier AIMED
 * instead of where he happens to be travelling — the back half of the compass is reachable for
 * the first time (CB-C0: today's duel is frontal by construction); (ii) it draws NO RNG — the
 * push's wobble is the incumbent carry's technique noise, and a touch-past's success must be
 * geometry alone (M-CB.1(b): never a dice roll), so the aimed knock is exact and whether a
 * defender is BEATEN is read off `cb.beatsDefender`, a closed geometric test.
 *
 * ⚠ WHO calls this, and when, is NOT this stage's question: in CB-T0 the only caller is the
 * probe-only `Match.forcedTouchPast` seam (the `forcedHold` idiom), which is null in every
 * production path. The choice seat is CB-T2's (M-CB.2).
 */
/**
 * ⭐ CB T2 (M-CB.2) — THE KNOCK'S LENGTH ALONG A CHOSEN LINE, hoisted out of
 * `performTouchPast` so that the CHOOSER and the EXECUTION share ONE OWNER and can never
 * become two drifting copies of the same law. PURE CODE MOTION: the statements, their
 * order and their operands are `performTouchPast`'s own, verbatim — the cone read (the
 * same 70° cone, the same keeper envelope, the same 14 m ceiling), the engine's push law
 * and the line guard. Nothing about the release, the ledger or the beaten set moved.
 *
 * `opponents` is passed rather than reached for, so the seat may price a line against the
 * same array the pricer already scans. PURE: no rng, no writes.
 */
export function touchPastPushFor(
  p: Player, dir: Readonly<V2>, opponents: readonly Player[],
): number {
  // Open field along the CHOSEN line (the incumbent cone read, re-aimed): the same forward
  // cone, the same keeper envelope, the same 14m ceiling — `performDribbleTouch`'s law.
  const hx = dir.x;
  const hy = dir.y;
  let aheadD = 14;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const dx = o.pos.x - p.pos.x;
    const dy = o.pos.y - p.pos.y;
    const along = dx * hx + dy * hy;
    const eff = o.role === 'GK' ? along - GK_RUSH_ENVELOPE : along;
    if (along < 0 || eff > 14) continue;
    const perp = Math.abs(dx * hy - dy * hx);
    if (perp > along * 0.7 + 1) continue;
    if (eff < aheadD) aheadD = Math.max(eff, 0);
  }
  let push = cb.touchPastPush(aheadD, p.attrs.dribbling);
  // The line guard, verbatim from the incumbent push: a knock that would roll into touch is
  // halved — a real carrier shortens the touch at the line.
  const rollEst = push;
  if (
    Math.abs(p.pos.y + hy * (rollEst + 2)) > HALF_W - 1 ||
    Math.abs(p.pos.x + hx * (rollEst + 2)) > HALF_L - 1
  ) {
    push *= 0.5;
  }
  return push;
}

export function performTouchPast(match: Match, p: Player, dir: Readonly<V2>): void {
  const ball = match.ball;
  if (ball.owner !== p) return;
  const opp = match.teams[1 - p.side];
  const push = touchPastPushFor(p, dir, opp.players);
  const vmag = Math.hypot(p.vel.x, p.vel.y);
  const speed = vmag + Math.max(push, 0.8);
  // The beaten set, decided BEFORE the release and by geometry alone: every opponent whose own
  // motion model cannot meet this ball inside the race window the push itself sets. Pure
  // bookkeeping — nothing in the sim reads it back.
  let beaten = 0;
  let challengers = 0;
  for (const o of opp.players) {
    if (o.sentOff) continue;
    if (dist(o.pos, ball.pos) > CB_CHALLENGER_RANGE) continue;
    challengers++;
    if (cb.beatsDefender(ball.pos, dir, speed, push, o)) beaten++;
  }
  ball.owner = null;
  ball.lastTouch = p;
  ball.vel = scale(dir, speed);
  ball.z = 0;
  ball.vz = 0;
  p.kickCooldown = TOUCH_RECOLLECT_BASE + push * TOUCH_RECOLLECT_PER_PUSH;
  // ⭐ FIX ① KNOCK-AND-GO (#272.4(a)): 趟球和启动是同一个动作 — a self-initiated action costs
  // ZERO latency (INFO-DOCTRINE §0), so the release re-opens his own decision at the very next
  // decision phase instead of leaving him on the stale `AI_INTERVAL` slot, which made the
  // knocker the LAST body on the pitch to react to his OWN knock (a deterministic 10-tick stale
  // `Dribble` label while every defender re-targeted the truth ball within 1 tick, #272.3). The
  // engine's own idiom for "think now, not on a stale slot's cadence" (`Match.trySubstitution`,
  // `forceSubstitution`, the kick-off striker); the value is the decision gate's own threshold
  // (`if (p.decisionTimer <= 0)`), never a second copy of a hand constant. NOTHING PHYSICAL is
  // written — he still has to brake, turn and run — and nothing about any other body is read.
  p.decisionTimer = 0;
  // ⭐ FIX ③ (#272.4(a)): the knock's own claim horizon, DERIVED (see `cb.knockClaimLifetime`),
  // replacing the flat 1.6 s hand constant on this aimed path. The production push above keeps
  // its incumbent marker — flags-off byte-identity is the hard gate.
  match.dribbleTouch = {
    gid: p.gid,
    until: match.simTime + cb.knockClaimLifetime(p, p.heading, ball.pos, dir, speed, push),
  };
  match.cbLedger.touchPasts++;
  match.cbLedger.touchPastChallengers += challengers;
  match.cbLedger.touchPastBeaten += beaten;
  // ⭐ THE COMMENSURABLE DENOMINATOR (#272.4(b)): a knock released with an EMPTY contest radius
  // is not a take-on as football counts one — it cannot beat anybody — so the population a
  // published take-on success rate is comparable with is the CONTESTED one. Pure additive
  // bookkeeping: this field is written here and read NOWHERE in `src/**`.
  if (challengers > 0) match.cbLedger.touchPastContested++;
  if (challengers > 0 && beaten === challengers) match.cbLedger.touchPastCleanBeats++;
  match.cbLedger.touchPastPushMetres += push;
}

/**
 * Who counts as a CHALLENGER of a touch-past for the beaten-event bookkeeping: an opponent
 * inside the engine's own contest radius of the ball (`CONTEST_RADIUS`, the substrate map's
 * "both sides within this of a loose ball = a genuine contest"). Ledger scope only — it gates
 * no mechanic.
 */
const CB_CHALLENGER_RANGE = CONTEST_RADIUS;

export function performClear(match: Match, p: Player): void {
  if (match.ball.owner !== p || p.kickCooldown > 0) return;
  match.endPassMove(p.side); // a hoof is not part of a passing move (Phase 33)
  const team = match.teams[p.side];
  // Hoof it upfield with a wide lateral component — safety over precision.
  // Panicked clears regularly cross the touchline: conceding a kick-in beats
  // losing the ball in front of your own goal (this is where kick-ins come from).
  const lat = match.rng.range(-1.0, 1.0);
  const aim = norm(v2(team.attackDir, lat));
  const dir = rotate(aim, match.rng.gaussian() * 0.08);
  // A clear hammered against the body's facing comes off weaker (Phase 27) —
  // at half strength: a panic hoof is a compromise, not a fifty-fifty gift.
  // Since Phase 28 the hoof goes UP as well as out: it hangs uninterceptable
  // over midfield and comes down as an aerial contest, like a real clearance.
  match.kickBall(
    p,
    dir,
    23 * (1 - kickMisalignment(p, aim) * 0.15 * (1 - p.attrs.passing * 0.4)),
    match.rng.range(3.2, 5.4),
  );
  team.stats.clearances++;
}

/**
 * Deflection (Phase 27): a ball too fast to control (a drilled pass) can
 * still be knocked loose by a player standing in its path — reading the lane
 * pays off even when the pass is hit hard. Rolled once per crossing (the
 * kick cooldown stops re-rolls while the ball is still in reach).
 */
export function tryDeflection(match: Match, p: Player): boolean {
  const ball = match.ball;
  const speed = len(ball.vel);
  // Committed to the stretch either way — no second bite at the same ball.
  p.kickCooldown = 0.3;
  // Blind-side honesty (Phase 59): same convention as attemptFirstTouch —
  // ball arriving at the face = 0, from behind the body = 1. The retreating
  // defender with a pull-back zipping behind his heels mostly whiffs; the
  // set, facing interceptor keeps his old numbers. This is what makes the
  // collapsed block's ceded arc a REAL payoff (the N1.5 counter surface).
  const dir = norm(ball.vel);
  const blind = (1 + (dir.x * p.heading.x + dir.y * p.heading.y)) / 2;
  const pDef = clamp(
    (0.24 + p.attrs.defending * 0.4 - (speed - 14) * 0.02) * (1 - blind * DEFLECT_BLIND_PEN),
    0.05, 0.6);
  if (!match.rng.chance(pDef)) return false; // it zips past the outstretched leg
  ball.lastTouch = p;
  ball.vel = scale(rotate(norm(ball.vel), match.rng.range(-1.2, 1.2)), match.rng.range(4, 8));
  p.tackleAnimTimer = 0.4; // the stretch is visible (display only)
  return true;
}

/**
 * Smother (Phase 27.5): a rushing keeper who reaches the carrier's ball
 * dives on it. Reflexes vs the carrier's close control decide it; a win is
 * a keeper claim (hands, hold state), a loss leaves the keeper on the floor
 * — and occasionally a clumsy challenge that concedes the foul (a penalty,
 * in the box where rushes live). Since Phase 28 a keeper does NOT need to
 * be mid-rush: a carrier who dribbles into the keeper's face inside the box
 * gets smothered at the feet the same way — you can go past the keeper,
 * you cannot stand on their toes and keep the ball forever.
 */
export function trySmother(match: Match): void {
  const owner = match.ball.owner;
  if (!owner || owner.gkHoldTimer > 0) return;
  const gk = match.teams[1 - owner.side].goalkeeper;
  if (gk.sentOff || gk.stunTimer > 0 || gk.kickCooldown > 0 || gk.tackleCooldown > 0) return;
  const rushing = gk.action.type === 'GoalkeeperRush';
  // Hands only inside the box (Phase 28.5, user report "门将出击到禁区外用手
  // 接球了"): the smother IS a dive ONTO the ball with the hands, so it may
  // only happen in the keeper's own area — even mid-rush. A sweeper who
  // rushes past his line closes the angle, but a ball out there he takes
  // with his feet — and his FEET were always live: the tryTackles tackler
  // scan never excluded keepers, so a rushing keeper duels the carrier on
  // the phase-41 substrate like any defender (Phase 103 verified this and
  // DELETED its own first cut — a custom out-box poke layered a worse-
  // priced coin flip with a 0.9s stun on top of the tuned duel, and the
  // sweeper school bled goals through exactly that branch).
  if (!match.inPenaltyBox(match.ball.pos, gk.side)) return;
  if (dist(gk.pos, match.ball.pos) >= 1.3) return;

  gk.saveAnimTimer = 0.7; // the dive at the feet is visible either way
  const pWin = clamp(0.56 + (gk.attrs.reflexes - 0.5) * 0.5 - (owner.attrs.dribbling - 0.5) * 0.35, 0.2, 0.85);
  if (match.rng.chance(pWin)) {
    match.teams[gk.side].stats.saves++;
    match.stat(gk.gid).saves++;
    owner.kickCooldown = 0.4;
    owner.stunTimer = 0.4; // ran into a wall of keeper
    match.pushEvent('save', gk.side, `${gk.name} smothers at ${owner.name}'s feet!`);
    match.giveBall(gk); // hold state engages — hands, untackleable
  } else {
    gk.stunTimer = 0.8; // beaten — picking himself up off the turf
    // A long recovery before RE-CHALLENGING (Phase 28.2): a keeper who dove
    // again every 1.3s read as convulsing. tackleCooldown — NOT kickCooldown
    // — so a loose ball at his feet can still be scooped up the moment the
    // stun ends (kickCooldown also gates ball pickup in tryCapture).
    gk.tackleCooldown = 1.2;
    // A full-speed rush is clumsier than a standing challenge at the feet.
    if (match.rng.chance(rushing ? 0.12 : 0.03)) match.awardFoul(gk, owner);
  }
}

/**
 * The professional foul (Phase 29.1): a breakaway carrier has beaten the
 * field — nobody but the keeper goal-side — and a chasing defender close
 * enough to reach the shirt but not the ball hauls them down from behind.
 * Play stops (the carrier does NOT keep the ball, so the advantage rule
 * cannot apply): free kick + a near-automatic card via `awardTacticalFoul`.
 * Never in the defender's own box — professionals concede the free kick,
 * not the penalty. This is the counterweight to offside-era breakaways
 * where the chasing pack could only eat exhaust fumes: pace still wins the
 * race (a >1.7m gap is uncatchable), but a caught runner gets fouled.
 */
/**
 * THE RECOVERY SLIDE (Phase 110, the carry-through counter — lever 1).
 * The 106 anatomy measured the walk-in's pursuit converging at 1.7-2.4m
 * behind the carrier and STAYING there: the tackle radius is 1.15m and
 * the tactical grab 1.7m, so the duel never rolled (lunges fired in 2-4%
 * of breakaway goals) and 69-78% of breakaways were clean carry-throughs.
 * Real football's answer is the desperation slide: a from-behind lunge
 * covering the 1.2-2.2m band that sometimes wins the ball, often fouls
 * (the phase-62 card economics — in the box that is a PENALTY), and
 * leaves the slider on the grass either way. Selection prices the
 * appetite through markingAggression; a booked man holds off.
 */
export function trySlideTackle(match: Match): void {
  const owner = match.ball.owner;
  if (!owner || owner.gkHoldTimer > 0) return;
  const attTeam = match.teams[owner.side];
  const defTeam = match.teams[1 - owner.side];
  const goal = attTeam.oppGoal();
  const dGoal = dist(owner.pos, goal);
  // The walk-in kill zone and its approach — deeper than the tactical
  // grab dares (that band stops at 16m; the measured strikes land 6-9m).
  if (dGoal > 30) return;
  // Only a DRIVING carrier (the walk-in), and only from BEHIND — a set
  // defender in front owns the honest tryTackles duel instead.
  if (len(owner.vel) < 4.0) return;
  if (dot(owner.vel, sub(goal, owner.pos)) <= 0) return;
  let slider: Player | null = null;
  let best = Infinity;
  for (const o of defTeam.players) {
    if (o.role === 'GK' || o.sentOff || o.tackleCooldown > 0 || o.stunTimer > 0) continue;
    const d = dist(o.pos, match.ball.pos);
    if (d < 1.2 || d > 2.2) continue; // inside 1.2 the standing tackle already rolls
    const bx = o.pos.x - owner.pos.x;
    const by = o.pos.y - owner.pos.y;
    if (bx * owner.vel.x + by * owner.vel.y > 0) continue; // must be chasing
    if (d < best) {
      best = d;
      slider = o;
    }
  }
  if (!slider) return;
  // The slide is a CHOICE, aggression-flavored and rare per chase — and a
  // booked man mostly keeps his feet (the second yellow is the deterrent).
  let attempt = 0.05 + defTeam.genome.markingAggression * 0.12;
  if (slider.booked) attempt *= 0.35;
  if (!match.rng.chance(attempt)) return;
  slider.tackleCooldown = 2.5; // committed — he is on the grass either way
  slider.tackleAnimTimer = 0.5;
  slider.spendBurst(TACKLE_LUNGE_COST);
  // Win small: reaching through a shielding body from behind at full tilt.
  const win = clamp(
    0.16 + slider.attrs.defending * 0.14 - owner.attrs.dribbling * 0.1,
    0.05,
    0.4,
  );
  if (match.rng.chance(win)) {
    defTeam.stats.tackles++;
    match.stat(slider.gid).recoveries++;
    match.ball.owner = null;
    match.ball.lastTouch = slider;
    // Directional like the standing tackle (the 乱抢 fix): the sweeping leg
    // carries the slider's momentum — a recovery slide hooks the ball on
    // down-pitch (often out, often to the keeper), it does not spray it
    // uniformly. Same ±~69° noise cone, same speed band.
    match.ball.vel = scale(rotate(slider.heading, match.rng.range(-1.2, 1.2)), match.rng.range(5.5, 10));
    owner.kickCooldown = 0.3;
    owner.stunTimer = 0.6;
    match.possessionSide = -1;
    slider.stunTimer = 0.5; // he won it from the ground — up he gets
    return;
  }
  slider.stunTimer = 0.8; // beaten and grounded — the carrier runs on
  // Fouling from behind at speed: the whistle comes often. In the box the
  // awardFoul machinery makes it the PENALTY; a card rides via maybeCard.
  const foulP = 0.4 + defTeam.genome.markingAggression * 0.15;
  if (match.rng.chance(foulP)) match.awardFoul(slider, owner);
}

export function tryTacticalFoul(match: Match): void {
  const owner = match.ball.owner;
  if (!owner || owner.gkHoldTimer > 0) return;
  const attTeam = match.teams[owner.side];
  const defTeam = match.teams[1 - owner.side];
  const goal = attTeam.oppGoal();
  const dGoal = dist(owner.pos, goal);
  // Only DESPERATE territory: the carrier is bearing down on the edge of
  // the danger zone (16–34m out — inside is the box/keeper duel, further
  // out the defence still trusts the recovery). The high offside line
  // makes "nobody goal-side" routine, so without this band every line
  // break got hauled down and cards hit 8/match.
  if (dGoal < 16 || dGoal > 34) return;
  // Only a genuine breakaway: carrier at a real sprint, driving at goal.
  if (len(owner.vel) < 4.5) return;
  if (dot(owner.vel, sub(goal, owner.pos)) <= 0) return;
  if (match.inPenaltyBox(match.ball.pos, defTeam.side)) return;
  for (const o of defTeam.players) {
    if (o.role === 'GK' || o.sentOff) continue;
    if (dist(o.pos, goal) < dGoal - 1) return; // covered — let the race run
  }
  // The nearest ready chaser in grab range BEHIND the carrier (a defender
  // in FRONT can still play the ball honestly — that's tryTackles' job).
  let grabber: Player | null = null;
  let best = Infinity;
  for (const o of defTeam.players) {
    if (o.role === 'GK' || o.sentOff || o.tackleCooldown > 0 || o.stunTimer > 0) continue;
    const d = dist(o.pos, owner.pos);
    if (d > 1.7) continue;
    const bx = o.pos.x - owner.pos.x;
    const by = o.pos.y - owner.pos.y;
    if (bx * owner.vel.x + by * owner.vel.y > 0) continue;
    if (d < best) {
      best = d;
      grabber = o;
    }
  }
  if (!grabber) return;
  grabber.tackleCooldown = 2.0; // committed either way — one grab per chase, not spam
  grabber.spendBurst(TACKLE_LUNGE_COST); // the grab is a burst too (Phase 58)
  // Cynicism is RARE (~1/match), aggression-flavored, and a booked man keeps
  // his hands to himself (the second yellow is the whole deterrent).
  let p = 0.06 + defTeam.genome.markingAggression * 0.1;
  if (grabber.booked) p *= 0.3;
  // The free kick has TEETH now (Phase 32): hauling a man down inside the
  // direct-FK band hands the specialist a real strike at goal — the
  // professional weighs that and lets some breaks run.
  if (dGoal < 28) p *= 0.6;
  if (!match.rng.chance(p)) return;
  grabber.tackleAnimTimer = 0.4;
  match.awardTacticalFoul(grabber, owner);
}

/**
 * Tackling: the nearest ready opponent within reach of a dribbler attempts to
 * win the ball. Success odds: markingAggression helps the tackler, the
 * carrier's dribbleBias (close control) protects them. A failed tackle puts
 * the defender on a 1.2s cooldown — beaten players can't spam.
 */
export function tryTackles(match: Match): void {
  const ball = match.ball;
  const owner = ball.owner;
  if (!owner) return;
  // A keeper holding the ball in their hands can't be tackled (Phase 27.2).
  if (owner.gkHoldTimer > 0) return;
  const oppTeam = match.teams[1 - owner.side];

  let tackler: Player | null = null;
  let best = Infinity;
  for (const o of oppTeam.players) {
    if (o.sentOff || o.tackleCooldown > 0 || o.stunTimer > 0) continue;
    const d = dist(o.pos, ball.pos);
    if (d < 1.15 && d < best) {
      best = d;
      tackler = o;
    }
  }
  if (!tackler) return;
  // THE JOCKEY (Phase 87): the goal-side contain man of a jockeying team
  // refuses the full-momentum duel — he delays and challenges only a
  // loose touch or a dying drive. The dive-in school (low gene) keeps the
  // old reflex; the momentum gate (Phase 41) still pays the carrier who
  // finds a duel, but a jockeyed carrier has to EARN one.
  const jockeyG = oppTeam.genome.jockeyBias ?? 0.5;
  const driveNow = clamp(len(owner.vel) / 9, 0, 1);
  const goalSide = oppTeam.localX(tackler.pos.x) < oppTeam.localX(owner.pos.x) - 0.2;
  const looseTouch = dist(ball.pos, owner.pos) > 0.85;
  // Phase 92 (the A/B verdict): jockeying is delay UNTIL HELP ARRIVES —
  // without an endgame a patient carrier was never dispossessed. A second
  // defender inside 3m collapses the containment into the challenge.
  let helpClose = false;
  for (const o of oppTeam.players) {
    if (o === tackler || o.sentOff || o.role === 'GK') continue;
    if (dist(o.pos, owner.pos) < 3) {
      helpClose = true;
      break;
    }
  }
  // No containment in the danger zone (Phase 92): inside ~28m of goal
  // the challenge is mandatory — jockeying a shooter is just watching.
  const dangerZone = oppTeam.localX(owner.pos.x) < -17;
  if (goalSide && !looseTouch && !helpClose && !dangerZone && driveNow > 0.9 - jockeyG * 0.55) return;
  // ⭐⭐ L3 T0 §SEAM — THE LUNGE GATE (contract §2 M-L3.3; docs/world-model/
  // L3-T0-DEFENCE-BOOK-SEAM.md). THIS is the decision seat: the candidate scan has chosen the
  // one tackler and the JOCKEY GATE above (untouched — M-L3.4) has had its say, and the very
  // next line commits the body. The learned veto is a NEW gate in SERIES, never a rewrite of
  // the containment logic, and it is DECLINE-ONLY: it can only make a lunge NOT happen, and a
  // declined lunge takes exactly the early return the withheld challenge already takes.
  // The arrival group is read ONCE here (the lunger's own speed at his own decision tick) and
  // shared by the veto and the label below, so they can never disagree. `-1` — hence no read
  // at all — in every production path.
  const l3Group = match.l3DefenceGroup(tackler);
  if (l3Group >= 0) {
    if (match.l3DefenceDeclines(oppTeam.side, l3Group)) return;
    match.l3DefenceNoteFired(l3Group);
  }
  tackler.tackleAnimTimer = 0.4; // the lunge is visible either way (display only)
  tackler.spendBurst(TACKLE_LUNGE_COST); // win or whiff, the lunge costs legs (Phase 58)

  // Team aggression + the tackler's defending vs the carrier's evasion. The
  // carrier resists two UNBIASED ways (attrs/genes, never role): close control
  // — technique + the team's dribble philosophy — shields and turns a standing
  // challenge; PACE only pays with a running start. `drive` is the carrier's
  // momentum (~0 jostling in a crowd, ~0.5 at the 4.5 m/s the cynical-foul code
  // already treats as a "real sprint", ~1 flat out), so a quick player driving
  // into space is hard to dispossess while a fast one hemmed in gets nothing
  // from it. That momentum gate is the space payoff — you can only build speed
  // where there's room ahead (the flanks, the channels), so wide/quick play
  // earns a duel edge the compact clump can't, giving width a gradient to climb
  // (the master gate, Phase 41). Base carries Phase 27's whiff-stun raise.
  const drive = driveNow;
  // strength SHIELDS the standing challenge (Phase 47 — the hold-up/pivot
  // payoff): base 0.21→0.25 with −strength·0.10 so the POPULATION mean
  // (backfill 0.4) lands exactly where phase-46 left it; the gradient is
  // what's new, not the league tackle rate.
  // defending 0.24→0.34 (Phase 48): the wage cap exposed defending as
  // UNDER-PRICED — whole leagues drained DF points to fund attack (evo-drift
  // DFdef 0.63→0.52, goals →3.1-3.4). A stronger per-point payoff makes the
  // defensive spend competitive again (swept {0.24,0.30,0.34}: reference-seed
  // goals 3.07→2.87→2.65).
  let p =
    0.25 +
    oppTeam.genome.markingAggression * 0.2 +
    tackler.attrs.defending * 0.34 -
    match.teams[owner.side].genome.dribbleBias * 0.08 -
    owner.attrs.dribbling * 0.18 -
    owner.attrs.strength * 0.1 -
    // 0.20 → 0.16 (Phase 41.2): the slalom COMMITMENT fix stopped carriers
    // bleeding their momentum in pirouettes, so the same coefficient bought
    // far more protection than Phase 41 priced (3-seed paired calibrate
    // +0.74 goals; evo-drift dribbleBias railed 0.40→0.80 and width
    // re-collapsed 0.52→0.14 — a dribble monoculture). The trim restores
    // the DESIGNED effective protection at the new, honest drive levels;
    // the space/pace gradient itself stays (the master-gate principle).
    owner.attrs.pace * drive * 0.16;
  if (oppTeam.mode === 'Press') p += 0.06;
  if (tackler.traits.includes('enforcer')) p += 0.04; // the destroyer (Phase 39)
  // THE OUTNUMBERED DUEL (Phase 104, Route A user-ratified): a STALLED
  // carrier with a second defender inside 3m has his escape angles cut —
  // the duel was priced 1v1 no matter how many bodies converged, so a
  // containment that DELAYED until help arrived (the whole jockey design,
  // 87/92) won its collapse at coin-flip rates and the school starved.
  // Physics, no gene named: the momentum gate still lets a DRIVING carrier
  // burn through a double (a flat +0.1 also fed the press swarm and cost
  // the jockey side the neutral A/B — measured, then narrowed); it is the
  // stopped-and-doubled carrier who is dead meat, and engineering exactly
  // that situation is what the contain school does for a living.
  if (helpClose && drive < 0.45) p += 0.12;
  p = clamp(p, 0.06, 0.7);

  // ⭐⭐ CB T0 §SEAM (a) — COMMITMENT-HONEST DISPOSSESSION (contract §2 M-CB.1(a);
  // docs/world-model/CB-T0-DORMANT-LAYER1-SEAM.md). Everything above this line is
  // GEOMETRY-BLIND — CB-C0 proved from this very expression that the TAKER's speed, heading
  // and motion state enter nowhere, so diving in costs nothing. Armed, the clamped incumbent
  // odds are scaled by his own COMMITMENT FACTOR χ: the share of the challenge radius his own
  // motion model still has to spare on the ball over his own duel horizon. χ = 0 — a body his
  // own momentum carries past the ball — is a MISS by geometry, with no roll left to save it.
  // The roll itself is still drawn (the stream's shape is the incumbent's) and the whistle
  // path below is untouched.
  const cbArmed = match.cbCommitPhysics;
  if (cbArmed) {
    p *= cb.commitmentFactor(tackler, ball.pos, ball.vel);
    match.cbLedger.armedChallenges++;
    if (p === 0) match.cbLedger.geometricMisses++;
  }

  if (match.rng.chance(p)) {
    oppTeam.stats.tackles++;
    match.stat(tackler.gid).recoveries++;
    // No feed event — tackles are too frequent to narrate; stats + debug show them.
    ball.owner = null;
    ball.lastTouch = tackler;
    // The won ball travels (Phase 28.4, further in 29.1): a real tackle
    // knocks it CLEAR of the boot zone — short squirts re-fed the same
    // scramble endlessly, and the offside-compressed midfield made every
    // re-contest pull in more bodies.
    // DIRECTIONAL (the 乱抢 re-examination): a standing tackle is won with
    // INTENT — the winner steers the poke toward safety the way real
    // hurried defensive contacts go: WIDE, toward the near touchline, never
    // through the middle. ±~69° of noise keeps it far too wild to be a
    // pass. Two prior models were A/B-refuted on the way here: a pure
    // heading-cone (chase-from-behind tacklers face their own goal — their
    // pokes fed the very walk-ins this fix hunts) and a straight
    // away-from-own-goal cone (a free VERTICAL out-ball over the press to
    // the deliberately-high defend-shape ST — goals-warming re-inflated to
    // the arc highs and evolution railed press/transitionPress to 0.75+).
    // The slide keeps its momentum physics below — you cannot steer from
    // the grass. scramble-anatomy.ts is the A/B yardstick.
    const clear = norm(sub(ball.pos, oppTeam.ownGoal()));
    const toTouch = Math.sign(ball.pos.y) || 1;
    const wide = norm(v2(clear.x, clear.y + toTouch));
    ball.vel = scale(rotate(wide, match.rng.range(-1.2, 1.2)), match.rng.range(5.5, 10));
    owner.kickCooldown = 0.3;
    owner.stunTimer = 0.6; // dispossessed: stumble before rejoining play (Phase 27)
    tackler.tackleCooldown = 0.5;
    // The tackle knocks it LOOSE — it does not hand it over (Phase 31.9,
    // user report "抢断后几乎直接被对方控制,和拦截没有区别"): the tackler
    // is committed to the lunge and may not hoover his own squirt. Probed
    // before this line: 85% of won tackles were re-captured BY THE TACKLER
    // within 0.19s — the squirt was cosmetic and every dispossession read
    // as an instant possession flip. Now the loose ball belongs to the
    // third man: interception = clean takeaway, tackle = contested ball.
    tackler.kickCooldown = 0.5;
    match.possessionSide = -1;
  } else {
    // ⭐⭐ L3 T0 §SEAM — THE LABEL OPENS (M-L3.1, the #279.3 label): he MISSED, so the book has
    // something to learn. The carrier-anchored separation at t0 is read inside the Match
    // method; the window, the sign and the closure are the ledger's. A WON lunge and a
    // withheld challenge carry no label. Inert (`l3Group < 0`) in every production path.
    if (l3Group >= 0) match.l3DefenceNoteMiss(tackler, owner, l3Group);
    if (cbArmed) {
      // ⭐⭐ CB T0 §SEAM (a) — THE PHYSICS-DERIVED RECOVERY INTERVAL. He is carried through by
      // his own momentum (the stun damps his steering, `physicsStep` integrates the velocity he
      // already had) and pays the time his OWN motion model needs to be back in the duel:
      // brake + turn + close, all three closed forms of ACCEL / TURN_RATE and his own state.
      // The incumbent price on this branch is the constant pair below — the same for a walk-in
      // and a full-tilt dive.
      const rec = cb.recoveryInterval(tackler, ball.pos, tackler.heading);
      tackler.tackleCooldown = rec.total;
      tackler.stunTimer = rec.brake;
      match.cbLedger.recoveries++;
      match.cbLedger.recoverySeconds += rec.total;
      match.cbLedger.carryThroughSeconds += rec.brake;
    } else {
      tackler.tackleCooldown = 1.2;
      tackler.stunTimer = 0.35; // whiffed lunge: pick yourself up first (Phase 27)
    }
    // A failed lunge is sometimes a foul (Phase 20): free kick, or a penalty
    // in the tackler's own box. Aggressive markers give more away.
    const foulP =
      0.06 + oppTeam.genome.markingAggression * 0.1 +
      (tackler.traits.includes('enforcer') ? 0.02 : 0) +
      (match.derby ? 0.01 : 0); // derbies bite (Phase 40)
    if (match.rng.chance(foulP)) match.awardFoul(tackler, owner);
  }
}

/**
 * Shot blocks (Phase 31): a defender the ball passes within reach of gets a
 * real chance to throw a body in — the cost of daring a blocked lane that
 * `laneBlockers` warned the shooter about. Explicitly ON the pendingShot
 * path: 30.4 removed shots from the leg-deflection window because that
 * friction accident silently ate the league's goals (failure mode 18c);
 * this is the honest, tuned replacement. Ground-height drives only — a
 * rising ball clears the legs. One roll per defender per shot (the lunge
 * commits their kickCooldown either way); a successful block kills the
 * shot into a slow ricochet off the blocker — lastTouch transfers, so a
 * deflection behind the line is a corner, real-law.
 */
export function tryShotBlock(match: Match): void {
  const shot = match.pendingShot;
  const ball = match.ball;
  if (!shot || shot.resolved || ball.owner !== null) return;
  if (ball.z > 1.1) return; // over the legs and bodies
  const defTeam = match.teams[1 - shot.side];
  if (dist(ball.pos, defTeam.ownGoal()) < 6) return; // the goalmouth is the keeper's
  for (const o of defTeam.players) {
    if (o.role === 'GK' || o.sentOff || o.stunTimer > 0 || o.kickCooldown > 0) continue;
    const dx = o.pos.x - ball.pos.x;
    if (dx >= 0.9 || dx <= -0.9) continue;
    const dy = o.pos.y - ball.pos.y;
    if (dy >= 0.9 || dy <= -0.9) continue;
    if (Math.sqrt(dx * dx + dy * dy) >= 0.9) continue;
    o.kickCooldown = 0.45; // committed to the block, ball met or not
    o.tackleAnimTimer = 0.4;
    // The UNSET WALL (Phase 60): a set, facing body keeps its full block;
    // the mid-collapse retreater mostly fails to organize in front of a
    // first-time hit. Same principle the shoot appetite prices via
    // blockReadiness — but at CONTACT range the bearing to the ball is
    // unstable (a drive shaving past reads perpendicular), so the facing
    // term here is the ball's INCOMING direction (the tryDeflection blind
    // convention): you block what you can see coming.
    const bdir = norm(ball.vel);
    const blind = (1 + (bdir.x * o.heading.x + bdir.y * o.heading.y)) / 2;
    const stillness = clamp01((3.5 - len(o.vel)) / 2.5);
    const readiness = UNSET_BLOCK_WEIGHT + (1 - UNSET_BLOCK_WEIGHT) * (1 - blind) * stillness;
    if (!match.rng.chance((0.32 + o.attrs.defending * 0.25) * readiness)) continue;
    defTeam.stats.blocks++;
    ball.lastTouch = o;
    const away = match.rng.chance(0.5) ? 1 : -1;
    ball.vel = scale(rotate(norm(ball.vel), away * match.rng.range(0.7, 2.4)), match.rng.range(4.5, 9));
    ball.vz = 0;
    match.pushEvent('info', o.side, `${o.name} throws a body in front of it!`);
    match.markShotOutcome('miss');
    match.pendingShot = null;
    return;
  }
}

/**
 * Keeper save: while a shot is unresolved and the ball is within the keeper's
 * reach heading goalward, roll one save attempt. Save odds fall with shot
 * quality. Catches kill the ball dead; parries push it away from goal.
 */
export function tryKeeperSave(match: Match): void {
  const shot = match.pendingShot;
  const ball = match.ball;
  if (!shot || shot.resolved || ball.owner !== null) return;

  const defSide = (1 - shot.side) as 0 | 1;
  const defTeam = match.teams[defSide];
  const gk = defTeam.goalkeeper;
  const goal = defTeam.ownGoal();
  if (ball.z > GK_CLAIM_HEIGHT) return; // sailing over the keeper's hands
  const speed = len(ball.vel);
  if (speed < 6) return;
  if (dot(ball.vel, sub(goal, ball.pos)) <= 0) return;

  const reach = keeperReach(defTeam, gk);
  const dNow = dist(gk.pos, ball.pos);
  if (dNow > reach) {
    // The fingertip stretch (119b): beyond reach, attempt ONLY as the ball
    // passes its closest approach (receding) — inside-reach behavior is
    // bit-identical, the new roll exists solely for the ball that would
    // never have entered the corridor at all.
    const receding = dot(ball.vel, sub(gk.pos, ball.pos)) <= 0;
    if (dNow > reach * SAVE_STRETCH || !receding) return;
  }

  shot.resolved = true;
  gk.saveAnimTimer = 0.7; // the dive is visible whether it saves or not (27.4)
  const shooterTeam = match.teams[shot.side];
  // Reflexes swing save odds by ±11 percentage points around the xG baseline;
  // the shot's frozen dive difficulty then discounts it — accurate corner
  // finishes stay hard to save even though the keeper converges on the path.
  // 0.70 → 0.66 in Phase 29, → 0.63 in 29.1, → 0.48 in Phase 30: every
  // 30.x structure (6th defender, formations, set keeper distributions)
  // deleted another slice of the cheap goals-above-xG (breakaways,
  // scrambles, gifted distributions) that used to carry the scoreline —
  // 29.2's goals ran +36% OVER xG, 30.3's ran dead even. The shots that
  // survive a set defence are earned; they convert better. Same trade as
  // 28.1/29.1, one size bigger.
  // A placed ball (Phase 32): the keeper is SET and expecting the strike —
  // the reaction-time difficulty discount barely applies (floor 0.85) and
  // the base is a set keeper's, not a scrambling one's. Without this the
  // far-corner curl carried difficulty ~0.25 and 67% of on-target free
  // kicks went in (probed) — real keepers save most on-frame FKs.
  let saveP = shot.placed
    ? clamp(0.7 - shot.xg * 0.6 + (gk.attrs.reflexes - 0.5) * 0.22, 0.08, 0.92) *
      Math.max(shot.difficulty, 0.85)
    // Phase 85: the xG discount collapsed saveP to the floor at the meta's
    // 0.3-0.5 xG (0.48−0.6·xG ⇒ ~0.2), where reflexes' ±11pp couldn't
    // matter — the keeper had no evolvable answer to manufactured sitters.
    // Softer collapse (−0.45·xG), stronger reflexes swing (±14pp): elite
    // keepers now save SOME big chances (real big-chance save% 15-45%),
    // early-gen shots (xG≈0.16) move ≤+2pp.
    : clamp(0.48 - shot.xg * 0.45 + (gk.attrs.reflexes - 0.5) * 0.28, 0.1, 0.92) * shot.difficulty;

  // ANGLE CLOSED (Phase 103): a keeper who stood NEAR the shooter at the
  // strike made the goal small — the one credit the save model never paid,
  // which is why closing down (and the whole 出击 school) could never win.
  // Frozen at shot time; chips and placed balls carry 0 (the chip is the
  // designed counter to the advanced keeper). Early-gen shots from range
  // are untouched by construction (closeIn ≈ 0 beyond 7m).
  // (Phase 106 swept a closeIn DIFFICULTY FLOOR here — max(difficulty,
  // cI·0.85) and ·1.2 — against the measured walk-in strike (goals hit
  // ~6.5m out, keeper ~3.4m, difficulty 0.35, cI 0.52, conversion 72-79%):
  // per-shot arithmetic moved, 24-gen warming totals did NOT (15.88/17.36
  // vs baseline 15.72 — re-roll noise), keeperAggression adoption didn't
  // shift, and one world held conv 72% regardless. Deleted per the
  // phase-95 anchor discipline; evidence in scripts/probes/final15-anatomy.ts.)
  // Angle covered (119b) shares closeIn's slope via max() — the two credits
  // describe the same physical fact (a smaller goal) from different ranges
  // and must never compound.
  saveP = Math.min(0.95, saveP * (1 + Math.max(shot.closeIn ?? 0, shot.coverage ?? 0) * 0.9));

  if (match.rng.chance(saveP)) {
    shooterTeam.stats.shotsOnTarget++;
    defTeam.stats.saves++;
    match.stat(gk.gid).saves++;
    match.markShotOutcome('saved');
    // ⭐⭐ GK T0b §M-GK.1 — THE CONTACT POINT (docs/world-model/GK-T0-DIVE-LAW.md; contract
    // GK-KEEPER-BODY-CONTRACT.md §2 M-GK.1; ruling #399 item 3(ii)). THE TWO `saveContact`
    // writes in `src/**` — one per branch of the save, because the two branches mean
    // different things. Both record the SAME quantity: the BALL'S OWN POSITION at the tick
    // the save was rolled, where the hands are, on the keeper who reached with them. Both
    // sit AFTER their branch's roll has already succeeded, so neither changes a roll, an
    // outcome or an rng draw.
    //
    // ⭐⭐ GK-T0c — THE CATCH WRITE IS THE BRANCH'S LAST STATEMENT, AFTER `giveBall`
    // (ruling #400 item 3). `giveBall` retires any STALE caught contact on the body that
    // GAINS the ball, so a write placed BEFORE it would be wiped by the very gain that the
    // save just produced. `giveBall` never writes `ball.pos` — it zeroes the velocity and
    // sets `z` / `vz` / `spin` — so the value recorded here is the same ball position the
    // struck GK-T0b ordering recorded. The PARRY write stays FIRST in its branch: a parry
    // takes no `giveBall`, and everything below it moves the ball.
    //
    // ⭐ The CATCH mark (`caught: true`) is what M-GK.3′'s waiting law keys on: the keeper
    // now owns the ball and it waits at his hands until his body arrives. The PARRY mark
    // (`caught: false`) is STEER-ONLY — the ball is already away, nothing waits, and the
    // contact dies with the sprite's window (`Player.physicsStep`). Ruling #399 item 1(iii)
    // struck the premise that parries never enter the waiting law: they did, through a
    // REGATHER, and the mark is the fix.
    //
    // Flag off ⇒ neither statement runs and the field stays null forever.
    if (dNow <= reach && speed < 21 && match.rng.chance(0.8)) {
      match.pushEvent('save', defSide, `${gk.name} catches it`);
      match.giveBall(gk);
      if (match.gkDiveBody) gk.saveContact = { x: ball.pos.x, y: ball.pos.y, caught: true };
    } else {
      if (match.gkDiveBody) gk.saveContact = { x: ball.pos.x, y: ball.pos.y, caught: false };
      // A parry deflects the shot rather than reversing it: the ball is
      // pushed wide of the goal — often behind for a corner, sometimes loose
      // in the box for a scramble. (The old inward "bounce-back" parry is why
      // corners never happened.)
      const inDir = norm(ball.vel);
      const side = ball.pos.y >= 0 ? 1 : -1;
      const ang = side * Math.sign(inDir.x || 1) * match.rng.range(0.55, 1.15);
      ball.vel = scale(rotate(inDir, ang), clamp(len(ball.vel) * 0.45, 7, 12));
      ball.lastTouch = gk;
      gk.kickCooldown = 0.6; // let the parry leave the keeper's feet
      match.pushEvent('save', defSide, `${gk.name} parries!`);
    }
  }
  // A failed attempt just lets the ball continue — goal or miss.
}
