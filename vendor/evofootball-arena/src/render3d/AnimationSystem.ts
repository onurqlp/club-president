import { BOX_DEPTH, HALF_L, HALF_W } from '../sim/constants';
import type { ActionType } from '../sim/types';
import { lerpAngle, type RenderPlayer, type RenderState } from './RenderStateAdapter';
import type { PlayerModel } from './PlayerModel';

/**
 * Procedural animation: no keyframe assets — legs/arms swing from run phase,
 * bodies lean with effort, kicks/dives/celebrations are one-shot or stateful
 * poses driven by the player's current sim action. `animFor` is the pure
 * action->animation mapping (unit-tested); AnimationSystem applies it to a
 * PlayerModel's joints every frame.
 */
export type AnimName =
  | 'idle'
  | 'jog'
  | 'sprint'
  | 'dribble'
  | 'shield'
  | 'kick'
  | 'header'
  | 'lunge'
  | 'stumble'
  | 'gkReady'
  | 'gkDive'
  | 'receive'
  | 'celebrate';

export function animFor(
  action: ActionType, speed: number, celebrating: boolean, hasBall = false,
): AnimName {
  if (celebrating) return 'celebrate';
  switch (action) {
    case 'Pass':
    case 'LoftedPass':
    case 'ThroughBall':
    case 'Cross':
    case 'Shoot':
    case 'ClearBall':
      return 'kick';
    case 'Dribble':
      return 'dribble';
    case 'HoldUp':
      // The pivot's shield (Phase 38): ON the ball it is a wrestle — wide
      // base, arm fending the defender. Off the ball (waiting for it to
      // arrive) it is just movement.
      return hasBall ? 'shield' : 'dribble';
    case 'InterceptPass':
      return 'lunge';
    case 'GoalkeeperSave':
      return 'gkDive';
    case 'GoalkeeperPosition':
    case 'ThrowOut':
      return 'gkReady';
    default:
      break;
  }
  if (speed < 0.8) return 'idle';
  if (speed < 5.2) return 'jog';
  return 'sprint';
}

/** Leg-swing amplitude per animation (radians). Sprint reads clearly bigger than jog. */
const SWING_AMP: Partial<Record<AnimName, number>> = {
  idle: 0.05,
  jog: 0.6,
  sprint: 1.05,
  dribble: 0.48,
  gkReady: 0.08,
  kick: 0.3,
  lunge: 0.2,
  receive: 0.08,
};

/** Forward body lean per animation (radians). */
const LEAN: Partial<Record<AnimName, number>> = {
  idle: 0.02,
  jog: 0.1,
  sprint: 0.3,
  dribble: 0.15,
  lunge: 0.55,
  kick: 0.12,
  gkReady: 0.32,
  receive: 0.04,
};

/** Arm-swing factor relative to leg swing. */
const ARM_F: Partial<Record<AnimName, number>> = {
  jog: 0.65,
  sprint: 1.0, // full arm pump — sprints read urgent even at tactical range
  dribble: 0.55,
};

/**
 * Standing knee flexion per animation (radians, Phase 73) — athletes never
 * lock their knees. The RUN-cycle flexion (shin folding during the swing
 * phase) is added on top of this base in update().
 */
const KNEE_BASE: Partial<Record<AnimName, number>> = {
  idle: 0.05,
  jog: 0.1,
  sprint: 0.14,
  dribble: 0.12,
  shield: 0.4,
  gkReady: 0.55, // the set crouch
  stumble: 0.45,
  celebrate: 0.12,
  receive: 0.12,
};

/**
 * Elbow carry per animation (radians, Phase 73). NEGATIVE = forearm swings
 * FORWARD (limb pivots hang below the joint, so the sign mirrors the hips).
 * Runners carry ~90°; a diver's arms stretch with the body axis.
 */
const ELBOW: Partial<Record<AnimName, number>> = {
  idle: -0.3,
  jog: -0.9,
  sprint: -1.15,
  dribble: -0.85,
  shield: -0.55,
  gkReady: -0.85,
  kick: -0.5,
  header: -0.6,
  lunge: -0.35,
  stumble: -0.5,
  receive: -0.5,
  celebrate: -0.2,
  gkDive: -0.05,
};

/** Vertical run bob amplitude (m) — makes strides read as steps, not sliding. */
const BOB: Partial<Record<AnimName, number>> = {
  jog: 0.04,
  sprint: 0.075,
  dribble: 0.05,
};

/** Run-cycle frequency multiplier — dribblers take short quick touches. */
const FREQ: Partial<Record<AnimName, number>> = {
  dribble: 1.4,
  sprint: 1.05,
};

const approach = (cur: number, target: number, maxDelta: number): number =>
  Math.abs(target - cur) <= maxDelta ? target : cur + Math.sign(target - cur) * maxDelta;

/**
 * Which leg slot handles a ball at world offset (dx,dz) from a player facing
 * `yaw` (Phase 73, pure): +1 = the model's local-+x leg (the `legR` field),
 * -1 = the local--x leg. Kicks and traps use the ball-side foot instead of
 * the old always-legR.
 */
export function lateralSlot(yaw: number, dx: number, dz: number): 1 | -1 {
  // Model local +x axis expressed in world coords is (cos yaw, -sin yaw).
  return dx * Math.cos(yaw) - dz * Math.sin(yaw) >= 0 ? 1 : -1;
}

/**
 * Torso bank into a turn (Phase 73, pure): yaw rate × speed, clamped. The
 * sign tips INTO the arc (negative rotation.z = toward local +x = the side
 * a positive yaw rate is turning toward). Kills the flat "ice-skater" turn.
 */
export function bankFor(yawRate: number, speed: number): number {
  if (speed < 2.5) return 0;
  const b = -yawRate * 0.085 * (Math.min(speed, 9) / 9);
  return Math.max(-0.32, Math.min(0.32, b));
}

/**
 * Shoulder-to-shoulder ride detection (Phase 38, pure — probed headlessly):
 * an OPPONENT within arm's reach, both at running pace, headings near
 * parallel, AND the ball in the duel — the classic ride on a driving
 * carrier. The ball gate is the discriminator that matters: every marking
 * pair on the pitch tracks at exactly PLAYER_MIN_DIST (the overlap
 * resolver's shell), so without it the whole defense permanently "leans"
 * (probed: 185–286 bouts/match; with the gate, the handful of real duels).
 * Returns which side of `p` the contact is on, or 0.
 */
export function rideSide(
  p: RenderPlayer, players: RenderPlayer[], ball: { x: number; z: number; ownerGid: number | null },
): -1 | 0 | 1 {
  if (p.speed < 4) return 0;
  const bdx = ball.x - p.x;
  const bdz = ball.z - p.z;
  if (bdx * bdx + bdz * bdz > 3.5 * 3.5) return 0; // the duel is FOR the ball
  const fx = Math.sin(p.yaw);
  const fz = Math.cos(p.yaw);
  for (const q of players) {
    if (q.side === p.side || q.gid === p.gid) continue;
    if (q.speed < 4) continue;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    if (dx * dx + dz * dz > 1.2 * 1.2) continue;
    let dyaw = Math.abs(q.yaw - p.yaw) % (Math.PI * 2);
    if (dyaw > Math.PI) dyaw = Math.PI * 2 - dyaw;
    if (dyaw > 0.55) continue;
    // BESIDE, not in the wake: a chaser tucked directly behind is a chase.
    const lat = fx * dz - fz * dx;
    const along = fx * dx + fz * dz;
    if (Math.abs(along) > Math.abs(lat) * 1.5) continue;
    return lat > 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The shield wrestle (Phase 38, pure): a carrier at walking pace with a
 * defender in grabbing range is holding the man off — Phase 36's close
 * control IS this state (the glue only survives under pressure now).
 * HoldUp-with-ball routes here via animFor; this catches the pressured
 * slow carry the HoldUp action's 0.3s decision window is too brief for.
 */
export function shielding(p: RenderPlayer, state: RenderState): boolean {
  if (state.ball.ownerGid !== p.gid || p.speed > 2.2 || p.role === 'GK') return false;
  for (const q of state.players) {
    if (q.side === p.side) continue;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    if (dx * dx + dz * dz < 1.6 * 1.6) return true;
  }
  return false;
}

/**
 * Pre-corner box jostle (Phase 38, pure): during a corner setup, a
 * near-stationary player with an opponent in grabbing range is WRESTLING
 * for position, not standing politely.
 */
export function jostling(p: RenderPlayer, state: RenderState): boolean {
  if (state.phase !== 'restart' || p.speed > 1.6) return false;
  const b = state.ball;
  // The ball sits at a corner flag during a corner setup.
  if (Math.abs(b.x) < HALF_L - 4 || Math.abs(b.z) < HALF_W - 6) return false;
  // Jostle near the goalmouth the flag belongs to, not across the pitch.
  if (Math.sign(p.x) !== Math.sign(b.x) || Math.abs(p.x) < HALF_L - BOX_DEPTH - 2) return false;
  for (const q of state.players) {
    if (q.side === p.side || q.gid === p.gid) continue;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    if (dx * dx + dz * dz < 1.7 * 1.7) return true;
  }
  return false;
}

export class AnimationSystem {
  /** Previous frame's ball, for the trap trigger (Phase 73): update() runs
   * once per player per frame, so the shift is keyed on state.t. */
  private frameT = NaN;
  private prevBall = { ownerGid: null as number | null, vx: 0, vz: 0, speed: 0 };
  private curBall = { ownerGid: null as number | null, vx: 0, vz: 0, speed: 0 };

  /**
   * F-Q: this body just entered another body's shell at speed
   * (`contactCues.ts`). Arm the brace/recoil — the contact direction is
   * frozen in the body's own frame at impact, so the pose does not swing
   * around as he turns. `nx,nz` point FROM this body TOWARD the other.
   */
  bump(model: PlayerModel, p: RenderPlayer, nx: number, nz: number, closing: number): void {
    // A bump that lands mid-dive, mid-lunge or mid-header must not fight the
    // one-shot already owning the body.
    if (model.diveT >= 0 || model.headerT >= 0 || p.tackling || p.saving) return;
    model.bumpT = 0;
    model.bumpLat = lateralSlot(p.yaw, nx, nz);
    // Forward component in the body frame: +1 = the other man is in front.
    model.bumpFwd = Math.max(-1, Math.min(1, nx * Math.sin(p.yaw) + nz * Math.cos(p.yaw)));
    model.bumpStrength = Math.min(1, closing / 5);
  }

  update(model: PlayerModel, p: RenderPlayer, state: RenderState, dt: number): void {
    if (state.t !== this.frameT) {
      this.frameT = state.t;
      this.prevBall = this.curBall;
      this.curBall = {
        ownerGid: state.ball.ownerGid,
        vx: state.ball.vx,
        vz: state.ball.vz,
        speed: state.ball.speed,
      };
    }
    const celebrating = state.celebratingSide === p.side && p.role !== 'GK';
    let anim = animFor(p.action, p.speed, celebrating, state.ball.ownerGid === p.gid);
    // The pressured slow carry wrestles too (Phase 38) — Phase 36 made the
    // glued ball MEAN close control, so show the body fight it implies.
    if (anim === 'dribble' && shielding(p, state)) anim = 'shield';
    // Phase 27 overrides: a live keeper dive / tackle lunge / recovery
    // stumble beats the action-derived pose (celebrations still win).
    if (!celebrating) {
      if (p.saving) anim = 'gkDive';
      else if (p.header) anim = 'header';
      else if (p.tackling) anim = 'lunge';
      else if (p.stunned) anim = 'stumble';
    }
    // The ACTION-derived dive (GoalkeeperSave) holds a SET crouch until the
    // ball is genuinely arriving (34.2, user report: the keeper hit the full
    // stretch at the strike and lay waiting for the ball). Choreography
    // only — the sim's save roll happens elsewhere; `p.saving` (an actual
    // resolved dive) is never gated. Launch at ETA ≈ the 0.32s stretch.
    if (anim === 'gkDive' && !p.saving) {
      const dx = state.ball.x - p.x;
      const dz = state.ball.z - p.z;
      const d = Math.hypot(dx, dz) || 1e-6;
      const closing = -(dx * state.ball.vx + dz * state.ball.vz) / d;
      const eta = closing > 4 ? d / closing : Infinity;
      if (eta > 0.38 && d > 1.6) anim = 'gkReady';
    }

    // One-shot trap trigger (Phase 73): a fast ball ARRIVED and stuck this
    // frame — the most frequent event in football gets a body: the ball-side
    // leg reaches to meet it, then gives. Keepers catch instead; a same-frame
    // first-time kick wins outright.
    if (
      state.ball.ownerGid === p.gid && this.prevBall.ownerGid !== p.gid &&
      this.prevBall.speed > 6.5 && p.role !== 'GK' && model.kickT < 0 && !celebrating
    ) {
      model.receiveT = 0;
      // The ball came FROM the reverse of its (previous) flight direction.
      model.receiveSlot = lateralSlot(p.yaw, -this.prevBall.vx, -this.prevBall.vz);
    }
    if (model.receiveT >= 0) {
      model.receiveT += dt;
      if (model.receiveT >= 0.34) model.receiveT = -1;
    }
    if (
      model.receiveT >= 0 &&
      (anim === 'idle' || anim === 'jog' || anim === 'sprint' || anim === 'dribble' || anim === 'shield')
    ) {
      anim = 'receive';
    }

    // One-shot kick trigger on entering the kick state. The kicking foot is
    // the ball-side one, frozen here (Phase 73) — kicks were always right-legged.
    if (anim === 'kick' && model.prevAnim !== 'kick') {
      model.kickT = 0;
      model.kickPower =
        p.action === 'Shoot' || p.action === 'ClearBall' ? 1
        : p.action === 'ThroughBall' || p.action === 'Cross' || p.action === 'LoftedPass' ? 0.85
        : 0.65;
      model.kickSlot = lateralSlot(p.yaw, state.ball.x - p.x, state.ball.z - p.z);
    }
    // One-shot header jump on entering the header state (Phase 28).
    if (anim === 'header' && model.prevAnim !== 'header') model.headerT = 0;
    // Freeze the dive side at dive START (29.1): the ball keeps moving —
    // often straight past the keeper — and a per-frame side recompute
    // mirror-flipped the full-stretch pose mid-dive (the save "twitch").
    if (anim === 'gkDive' && model.prevAnim !== 'gkDive') {
      const toBall = Math.atan2(state.ball.x - p.x, state.ball.z - p.z);
      model.diveSide = Math.sign(Math.sin(toBall - p.yaw)) || 1;
      model.diveT = 0;
      model.yawLock = p.yaw;
      model.diveX = p.x;
      model.diveZ = p.z;
    }
    // The dive freezes the FACING too (34.1, user report: the keeper kept
    // rotating with the ball mid-save — sim heading tracks the ball and
    // setPose applied it raw to a horizontal body). Locked for the dive,
    // eased back to the live heading as he picks himself up.
    if (anim === 'gkDive') {
      model.root.rotation.y = model.yawLock;
      model.yawEase = 1;
      // TRACK the sim keeper through the LUNGE (diveT < ~full stretch) so he
      // actually reaches the ball and catches it in-hand: freezing at the
      // dive-START spot (below) left the model up to ~3m BEHIND the catch
      // point (the sim keeper steers to the save at full speed during the
      // dive), so at the claim the ball snapped onto the sim keeper away from
      // the frozen model and the root then lurched over when the save timer
      // expired (user report: "最后一刻拿到球突然瞬移"). Once GROUNDED we pin
      // the spot so the sim keeper's drift BACK toward his position can't slide
      // the lying body (the original "feet slid back after landing" fix). Pure
      // display; the sim is untouched.
      if (model.diveT < 0.45) {
        model.diveX = p.x;
        model.diveZ = p.z;
      }
      model.root.position.x = model.diveX;
      model.root.position.z = model.diveZ;
    } else if (model.yawEase > 0) {
      model.yawEase = Math.max(0, model.yawEase - dt / 0.45);
      model.root.rotation.y = lerpAngle(p.yaw, model.yawLock, model.yawEase);
      // EASE the root back from the planted dive spot to the live position
      // (the same recovery blend as the facing) — without this the model
      // TELEPORTED from the dive spot to where the sim keeper drifted the
      // instant the dive ended (user report: 门将拿球瞬间瞬移).
      model.root.position.x = p.x + (model.diveX - p.x) * model.yawEase;
      model.root.position.z = p.z + (model.diveZ - p.z) * model.yawEase;
    }
    model.prevAnim = anim;

    // Run cycle phase: distance-driven so feet match ground speed.
    model.phase += Math.max(p.speed, anim === 'celebrate' ? 4 : 0.6) * dt * 1.7 * (FREQ[anim] ?? 1);
    model.animTime += dt;
    // Amplitudes EASE between anims (31.9, user report "跑的时候眼花"): a
    // player hovering on the jog↔sprint threshold (or braked at a clamp,
    // idle↔jog) re-picks the anim every few frames, and the instant
    // 0.6↔1.05 swing flip read as a strobe. The rotations were already
    // approach()-smoothed — the amplitude was the one raw switch left.
    model.swingAmpCur = approach(model.swingAmpCur, SWING_AMP[anim] ?? 0, 3.2 * dt);
    model.armFCur = approach(model.armFCur, ARM_F[anim] ?? 0.7, 3.2 * dt);
    const swing = Math.sin(model.phase) * model.swingAmpCur;
    const armF = model.armFCur;

    const r = 10 * dt; // smoothing rate for poses
    let legL = swing;
    let legR = -swing;
    let armL = -swing * armF;
    let armR = swing * armF;
    let armLz = 0.12;
    let armRz = -0.12;
    let leanX = LEAN[anim] ?? 0.04;
    let leanZ = 0;
    // Run bob: feet strike twice per cycle.
    let hop = (BOB[anim] ?? 0) * Math.abs(Math.sin(model.phase));
    let legLz = 0;
    let legRz = 0;
    // Whole-body dive pose (pivot at the feet) — 0 for everything but gkDive.
    let bodyTilt = 0;
    let bodyY = 0;
    // Knees (Phase 73): base flexion + the swing-phase fold — a shin folds
    // while its leg swings forward (airborne) and is near-straight in
    // stance, which is what a real stride looks like. legL's hip is
    // +sin(phase) with positive = backward, so its recovery half is cos < 0.
    const kneeAmp = model.swingAmpCur * 1.15;
    let kneeL = (KNEE_BASE[anim] ?? 0.08) + kneeAmp * Math.max(0, -Math.cos(model.phase));
    let kneeR = (KNEE_BASE[anim] ?? 0.08) + kneeAmp * Math.max(0, Math.cos(model.phase));
    // Elbows (Phase 73) carry bent; a light pump rides the run cycle.
    const elbowBase = ELBOW[anim] ?? -0.4;
    let elbowL = elbowBase;
    let elbowR = elbowBase;
    if (anim === 'jog' || anim === 'sprint' || anim === 'dribble') {
      elbowL -= Math.abs(Math.sin(model.phase)) * 0.15;
      elbowR -= Math.abs(Math.cos(model.phase)) * 0.15;
    }

    if (model.kickT >= 0) {
      // Kick (rebuilt Phase 73): cock BACK with the knee folded, snap
      // THROUGH forward as the knee extends into contact, follow through.
      // The old one-shot had the whole swing mirrored — limbs hang BELOW
      // their pivot, so positive rotation.x is backward (verified against
      // three.js), and the "snap-through" was sweeping the foot backward.
      // Shots swing harder than passes; the foot is the ball-side one.
      model.kickT += dt;
      const k = model.kickT / 0.38;
      const pw = model.kickPower;
      if (k >= 1) model.kickT = -1;
      else {
        let hip: number;
        let knee: number;
        if (k < 0.35) {
          const w = k / 0.35;
          hip = 0.6 * w * pw; // cocked back
          knee = 0.2 + 1.3 * w * pw; // heel drawn toward the hip
          leanX = -0.1;
        } else {
          const s = (k - 0.35) / 0.65;
          hip = 0.6 * pw - 1.7 * pw * Math.sin(Math.min(s * 1.15, 1) * (Math.PI / 2));
          knee = (0.2 + 1.3 * pw) * Math.max(0, 1 - s * 2.2) + 0.3 * pw * Math.max(0, s - 0.55) + 0.06;
          leanX = 0.3 * pw;
        }
        const kickR = model.kickSlot > 0;
        legL = kickR ? -0.14 : hip;
        legR = kickR ? hip : -0.14;
        kneeL = kickR ? 0.22 : knee;
        kneeR = kickR ? knee : 0.22;
        // The balance arm OPPOSITE the kicking leg drives forward.
        armL = kickR ? -0.55 : 0.55;
        armR = kickR ? 0.55 : -0.55;
      }
    }

    if (anim === 'header') {
      // Aerial duel (Phase 28): a real jump — up off the turf, arms driving,
      // neck snapping through the ball at the apex.
      if (model.headerT >= 0) {
        model.headerT += dt;
        const k = model.headerT / 0.55;
        if (k >= 1) model.headerT = -1;
        else {
          hop = Math.sin(Math.PI * k) * 0.55;
          leanX = k < 0.45 ? -0.22 : 0.28; // arch back, snap through
          armLz = 1.1;
          armRz = -1.1;
          legL = 0.25;
          legR = -0.15;
          kneeL = 0.55; // legs tuck under the jump
          kneeR = 0.35;
        }
      }
    } else if (anim === 'lunge') {
      // Tackle/interception: low, one leg thrust forward, arms out for balance.
      legL = 0.95;
      legR = -0.5;
      kneeL = 0.65; // trailing leg folded under, front leg extended to the ball
      kneeR = 0.12;
      armLz = 0.7;
      armRz = -0.7;
      hop = 0;
    } else if (anim === 'stumble') {
      // Dispossessed / beaten lunger (Phase 27): low, off balance, arms
      // flailing for support while they pick themself up.
      const w = Math.sin(model.animTime * 14);
      leanX = 0.32;
      leanZ = w * 0.18;
      armLz = 0.9 + w * 0.25;
      armRz = -0.9 + w * 0.25;
      legL = 0.35;
      legR = -0.25;
      kneeL = 0.45 + w * 0.12;
      kneeR = 0.45 - w * 0.12;
      hop = 0;
    } else if (anim === 'receive') {
      // The trap (Phase 73): the ball-side leg reaches to MEET the arriving
      // ball, then gives — knee softens, weight sits back into the cushion.
      const kk = Math.min(model.receiveT / 0.34, 1);
      const reach = kk < 0.45 ? kk / 0.45 : Math.max(0, 1 - (kk - 0.45) / 0.55);
      const rHip = -0.5 * reach; // forward, meeting the ball
      const rKnee = 0.12 + 0.4 * (1 - reach); // extend to meet, soften on the give
      const recvR = model.receiveSlot > 0;
      legL = recvR ? 0.1 : rHip;
      legR = recvR ? rHip : 0.1;
      kneeL = recvR ? 0.25 : rKnee;
      kneeR = recvR ? rKnee : 0.25;
      leanX = 0.05 - 0.12 * reach;
      armLz = 0.5;
      armRz = -0.5;
      hop = 0;
    } else if (anim === 'shield') {
      // The pivot's wrestle (Phase 38): wide low base, backside into the
      // defender, one arm barred across him, weight shifting foot to foot.
      const w = Math.sin(model.animTime * 2.6);
      legLz = 0.32;
      legRz = -0.32;
      legL = 0.18 + w * 0.1;
      legR = -0.18 - w * 0.1;
      leanX = -0.1; // leaning INTO the man behind, not over the ball
      leanZ = w * 0.08;
      armLz = 1.25; // the fending arm, barred
      armRz = -0.5;
      armL = -0.3;
      armR = 0.2;
      elbowL = -0.3; // the bar holds straighter than the balance arm
      elbowR = -0.7;
      hop = 0;
    } else if (anim === 'gkReady') {
      armLz = 0.85;
      armRz = -0.85;
      bodyY = -0.06; // the set crouch sits INTO the bent knees (Phase 73)
    } else if (anim === 'gkDive') {
      // Full-body dive toward the side frozen at dive start (29.1). The old
      // pose tilted only the `lean` group — the keeper folded at the hips
      // while his legs stood planted (the "只有上半身动" report). Now the
      // whole body group (legs included) tilts around the feet and rides a
      // launch arc: push off, horizontal at full stretch, land low, and the
      // slow approach() recovery below reads as him picking himself up.
      const side = model.diveSide;
      model.diveT += dt;
      const t = model.diveT;
      const stretch = Math.min(1, t / 0.32);
      bodyTilt = -side * 1.2 * (0.25 + 0.75 * stretch);
      bodyY = Math.max(0.03, Math.sin(Math.min(t / 0.55, 1) * Math.PI) * 0.38);
      leanZ = -side * 0.18; // a touch of arch on top of the body tilt
      leanX = -0.08;
      armL = 0; // both arms stretch with the body axis, toward the ball
      armR = 0;
      armLz = side > 0 ? 2.9 : 2.2; // top arm reaches further
      armRz = side > 0 ? -2.2 : -2.9;
      legL = side > 0 ? 0.45 : -0.3; // scissor: one leg drives, one trails
      legR = side > 0 ? -0.3 : 0.45;
      kneeL = side > 0 ? 0.4 : 0.12; // driving leg folded, reaching leg long
      kneeR = side > 0 ? 0.12 : 0.4;
      legLz = side * 0.2;
      legRz = side * 0.12;
      hop = 0;
    } else if (anim === 'celebrate') {
      // The scorer leaps; teammates raise arms with a lighter bounce.
      const isScorer = state.celebratingGid === model.gid;
      const wave = Math.abs(Math.sin(model.animTime * (isScorer ? 9 : 6)));
      armLz = 2.5;
      armRz = -2.5;
      armL = 0;
      armR = 0;
      hop = wave * (isScorer ? 0.62 : 0.16);
      kneeL = 0.12 + (1 - wave) * 0.3; // knees flex on each landing
      kneeR = kneeL;
      leanX = isScorer ? -0.15 : -0.06;
    }

    // Banking into turns (Phase 73): the torso tips into the arc by yaw
    // rate × speed — kills the flat "ice-skater" turn. The 1.2 rad
    // frame-jump guard swallows kickoff teleports and replay scrubs.
    let yawRate = 0;
    if (model.yawPrev !== null && dt > 0) {
      let dy = (p.yaw - model.yawPrev) % (Math.PI * 2);
      if (dy > Math.PI) dy -= Math.PI * 2;
      if (dy < -Math.PI) dy += Math.PI * 2;
      if (Math.abs(dy) < 1.2) yawRate = dy / dt;
    }
    model.yawPrev = p.yaw;
    const bankT =
      anim === 'jog' || anim === 'sprint' || anim === 'dribble' ? bankFor(yawRate, p.speed) : 0;
    model.bankCur = approach(model.bankCur, bankT, 2.2 * dt);
    leanZ += model.bankCur;

    // Body contact modifiers (Phase 38) — LAYERED on the run cycle, never
    // replacing it: the wrestle is in the torso, the legs keep running.
    if (anim === 'jog' || anim === 'sprint' || anim === 'dribble') {
      // Shoulder-to-shoulder: two bodies riding each other down the line —
      // both lean INTO the contact, the inner arm bars across.
      const side = rideSide(p, state.players, state.ball);
      if (side !== 0) {
        leanZ += side * 0.22;
        if (side > 0) armRz -= 0.55;
        else armLz += 0.55;
      }
    } else if (anim === 'idle' && jostling(p, state)) {
      // Pre-corner grappling: braced arms, weight wrestling side to side —
      // phase offset by gid so a pair never sways in lockstep.
      const w = Math.sin(model.animTime * 3.1 + model.gid * 1.7);
      leanZ += w * 0.13;
      leanX += 0.08;
      armLz = Math.max(armLz, 0.55 + w * 0.15);
      armRz = Math.min(armRz, -0.55 + w * 0.15);
    }

    // F-Q body bump (render-only, LAYERED like the ride): for ~0.42 s after
    // entering another body's shell at speed, the torso recoils AWAY from
    // the contact, the near arm comes up to brace, and the stride dips —
    // fast in, eased out. Without this the sim's overlap solver read as two
    // bodies gliding into each other and stopping dead (the user's 「不真实
    // 碰撞」). The legs keep whatever they were doing.
    if (model.bumpT >= 0) {
      model.bumpT += dt;
      const BUMP_DUR = 0.42;
      if (model.bumpT >= BUMP_DUR) {
        model.bumpT = -1;
      } else {
        const k = model.bumpT / BUMP_DUR;
        const env = (k < 0.18 ? k / 0.18 : 1 - (k - 0.18) / 0.82) * (0.55 + 0.45 * model.bumpStrength);
        // Lateral recoil: positive rotation.z tips the torso toward local -x,
        // so a hit from the +x side (bumpLat = +1) leans the body to -x.
        leanZ += model.bumpLat * 0.3 * env * (1 - Math.abs(model.bumpFwd) * 0.5);
        // Frontal hit: rock back; hit from behind: pitch forward.
        leanX -= model.bumpFwd * 0.22 * env;
        // The arm on the contact side bars across, the other flies out for balance.
        if (model.bumpLat > 0) {
          armRz = Math.min(armRz, -0.85 * env - 0.12);
          armLz = Math.max(armLz, 0.45 * env + 0.12);
        } else {
          armLz = Math.max(armLz, 0.85 * env + 0.12);
          armRz = Math.min(armRz, -0.45 * env - 0.12);
        }
        // Knees give on impact.
        kneeL += 0.25 * env;
        kneeR += 0.25 * env;
        bodyY -= 0.05 * env;
      }
    }

    model.legL.rotation.x = approach(model.legL.rotation.x, legL, r * 1.6);
    model.legR.rotation.x = approach(model.legR.rotation.x, legR, r * 1.6);
    model.legL.rotation.z = approach(model.legL.rotation.z, legLz, r);
    model.legR.rotation.z = approach(model.legR.rotation.z, legRz, r);
    model.kneeL.rotation.x = approach(model.kneeL.rotation.x, kneeL, r * 1.8);
    model.kneeR.rotation.x = approach(model.kneeR.rotation.x, kneeR, r * 1.8);
    model.elbowL.rotation.x = approach(model.elbowL.rotation.x, elbowL, r * 1.2);
    model.elbowR.rotation.x = approach(model.elbowR.rotation.x, elbowR, r * 1.2);
    model.armL.rotation.x = approach(model.armL.rotation.x, armL, r * 1.6);
    model.armR.rotation.x = approach(model.armR.rotation.x, armR, r * 1.6);
    model.armL.rotation.z = approach(model.armL.rotation.z, armLz, r);
    model.armR.rotation.z = approach(model.armR.rotation.z, armRz, r);
    model.lean.rotation.x = approach(model.lean.rotation.x, leanX, r);
    model.lean.rotation.z = approach(model.lean.rotation.z, leanZ, r);
    // The run bob lives on the BODY, not the root (31.9.1, user report:
    // the action label "小幅度颤动…眼花") — the label/ring/blob are root
    // children, and a 4-7.5cm stride bob at ~5Hz made the floating TEXT
    // tremble. The body steps; the billboard holds still.
    model.root.position.y = approach(model.root.position.y, 0, 8 * dt);
    // The dive launches fast; the recovery (targets back to 0 once the save
    // ends) runs at half rate — the keeper visibly gets back to his feet.
    model.body.rotation.z = approach(model.body.rotation.z, bodyTilt, (anim === 'gkDive' ? 7 : 2.8) * dt);
    model.body.position.y = approach(model.body.position.y, bodyY + hop, 6 * dt);
  }
}
