import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import { clamp, clamp01 } from '../utils/math';
import { lerpAngle } from './RenderStateAdapter';

export type CameraMode =
  | 'tactical' | 'tacfeed' | 'broadcast' | 'follow' | 'behindGoal' | 'thirdPerson' | 'penalty'
  | 'celebration';

/** How long the goal cut holds the camera before it eases back (seconds). */
export const CELEBRATION_DUR = 2.8;

export interface CameraGoal {
  px: number;
  py: number;
  pz: number;
  lx: number;
  ly: number;
  lz: number;
}

/**
 * Pure per-mode camera goal (position + look-at) from the ball state — kept
 * free of three.js math so it's trivially unit-testable. The controller
 * damps toward this goal; it never snaps.
 */
export function cameraGoalFor(
  mode: Exclude<CameraMode, 'thirdPerson'>,
  ball: { x: number; z: number; vx: number; vz: number },
): CameraGoal {
  switch (mode) {
    case 'tactical':
      // High angled full-pitch view: formations readable, both goals + corner
      // flags inside the frame.
      return { px: 0, py: 62, pz: 47, lx: 0, ly: 0, lz: 2 };
    case 'tacfeed':
      // The ANALYST feed (Phase 72, user design): the UEFA-tactical-cam
      // lesson — near-vertical, static, every player in frame at once, so
      // the SHAPES carry the information. The one camera where the
      // broadcast layer draws its tactical elements.
      return { px: 0, py: 84, pz: 26, lx: 0, ly: 0, lz: 0 };
    case 'broadcast': {
      // TV gantry on the +z sideline. Pans with play, pushes in as the ball
      // enters a final third (attack), pulls back through midfield
      // transitions. Look-ahead follows ball velocity so play leads the frame.
      const attack = clamp((Math.abs(ball.x) - 12) / 28, 0, 1);
      const px = clamp(ball.x * 0.72 + ball.vx * 0.35, -28, 28);
      return {
        px,
        py: 19 - attack * 4.5,
        pz: 39 - attack * 7,
        lx: clamp(ball.x * 0.88 + ball.vx * 0.45, -38, 38),
        ly: 0.5,
        lz: clamp(ball.z * 0.55, -9, 9),
      };
    }
    case 'follow': {
      // Chase cam: higher and further back than a drone shot, with velocity
      // look-ahead — damped hard in update() to avoid motion sickness.
      return {
        px: clamp(ball.x, -HALF_L + 4, HALF_L - 4),
        py: 13,
        pz: ball.z + 18,
        lx: ball.x + ball.vx * 0.6,
        ly: 0.4,
        lz: ball.z + ball.vz * 0.6,
      };
    }
    case 'behindGoal': {
      // Sit behind whichever goal the ball is closer to and frame the
      // goalmouth: look at a blend of the goal and the ball. Kept LOW
      // (Phase 27.1): from the old 7.5 m gantry the view looked down onto
      // the net roof and the goal read as a flat grate — from ~4 m the
      // posts, crossbar and back net read as a real box.
      const sign = ball.x >= 0 ? 1 : -1;
      const goalX = sign * HALF_L;
      return {
        px: sign * (HALF_L + 12),
        py: 5.0,
        pz: clamp(ball.z * 0.35, -6, 6),
        lx: goalX * 0.45 + ball.x * 0.55,
        ly: 1.0,
        lz: ball.z * 0.65,
      };
    }
    case 'celebration': {
      // The GOAL CUT (F7c). Every other camera here frames the BALL; this one
      // frames the celebration, because the ball is dead in the net and play
      // has stopped. Three things have to be in one shot: the flame jets at
      // the end the ball just crossed, the players' celebrate pose around it,
      // and the shells bursting high above the FAR stand — F7 shipped all
      // three and the default wide camera left the pyro in the top corner of
      // frame, half of it outside.
      //
      // Which is a framing problem with an arithmetic answer. From a corner
      // vantage 14 m beyond the goal line and 16 m up, the goalmouth sits ~28°
      // below the aim and a shell ~14° above it — both inside the 46° vertical
      // FOV's 23° half-angle. So aiming BETWEEN them (this look-at works out to
      // ~11° down) holds the whole celebration in one frame.
      //
      // `pz` is the subtle one, and it is a FLOODLIGHT clearance, not a framing
      // preference. The towers stand at |x| = HALF_L+8, |z| = HALF_W+7 with
      // 17 m masts, so a corner camera further out than that shoots straight
      // through one — at night the mast split the frame in half and the lamp
      // hung over the middle of the shot. Sitting INSIDE the tower ring in z
      // swings it ~70° off-axis, well outside the horizontal half-angle, while
      // the goal and the shells both stay in frame (the test does that sum).
      //
      // The end comes from the ball's side, the same way `behindGoal` and
      // `penalty` read it; the controller latches the ball at cut time so a
      // restart at the centre spot cannot swing the shot halfway through.
      const sign = ball.x >= 0 ? 1 : -1;
      return {
        px: sign * (HALF_L + 14),
        py: 16,
        pz: HALF_W + 4,
        lx: sign * HALF_L * 0.45,
        ly: 8,
        lz: -HALF_W * 0.25,
      };
    }
    case 'penalty': {
      // Pens TV shot (Phase 24): low, over the taker's shoulder, keeper and
      // goalmouth filling the frame — the behind-goal shot hides the diving
      // keeper behind the net at this range. Following the ball gives a
      // gentle damped push-in as the kick flies.
      const sign = ball.x >= 0 ? 1 : -1;
      return {
        px: ball.x - sign * 10.5,
        py: 4.6,
        pz: 5.2,
        lx: sign * HALF_L,
        ly: 1.3,
        lz: 0,
      };
    }
  }
}

/* -------- third person (2026-09-11, user ask 「第三人称视角，代替环绕」) -------- */

/** The body the third-person rig rides: a player's position and sim heading. */
export interface CameraSubject {
  gid: number;
  x: number;
  z: number;
  /** Sim heading, RenderStateAdapter's convention: 0 faces world +z. */
  yaw: number;
}

/**
 * Third-person rig geometry (world metres; the bodies are HUMAN_MODEL_SCALE-
 * sized, so these read as "over the shoulder" rather than as drone numbers).
 */
export const TP = {
  /** Eye distance behind the subject, along the rig's (smoothed) heading. */
  back: 6.5,
  /** Eye height at full distance. */
  height: 2.6,
  /** Extra height gained as the rig is pulled in at a boundary (see below). */
  lift: 5,
  /** The look-at sits this far ahead of the subject at full distance. */
  ahead: 3.5,
  lookY: 0.8,
  /**
   * How far past the lines the EYE may go. These are stand clearances, not
   * taste: the goal-end bank's front face is at |x| = HALF_L + 4.4, the near
   * (+z) bank's at HALF_W + 6.4, the far (−z) main stand's at HALF_W + 2.2 —
   * `terraceSlabs` in PitchModel, pinned by the bowl test in render3d.test.
   */
  marginX: 1.0,
  marginNear: 3.0,
  marginFar: 1.0,
  /**
   * The AIM never leaves the pitch plus this apron: a body on a touchline
   * facing the crowd would otherwise aim 3.5 m into the front row (the bowl
   * gate caught exactly that on the far side), and there is nothing to see
   * out there anyway — the shot stays on the line they stand on.
   */
  aimApron: 1.0,
  /** Aim bends toward the ball by at most this share of the offset… */
  ballPull: 0.25,
  /** …fading to nothing once the ball is this far from the subject. */
  ballReach: 15,
  /** Heading smoothing rate (1/s) — a 180° turn settles in about a second. */
  yawRate: 2.5,
} as const;

/**
 * Pull-in factor for the third-person eye: the largest t ∈ [0, 1] such that
 * `subject − heading · TP.back · t` stays inside the stand-clearance box.
 * 1 = the rig sits at full distance; 0 = the subject is already on (or over)
 * a line, so the eye stands right above them.
 */
export function thirdPersonPullIn(subject: { x: number; z: number }, dx: number, dz: number): number {
  let t = 1;
  const stepX = dx * TP.back; // eye.x = subject.x − stepX · t
  if (stepX > 1e-9) t = Math.min(t, (subject.x + HALF_L + TP.marginX) / stepX);
  else if (stepX < -1e-9) t = Math.min(t, (subject.x - HALF_L - TP.marginX) / stepX);
  const stepZ = dz * TP.back;
  if (stepZ > 1e-9) t = Math.min(t, (subject.z + HALF_W + TP.marginFar) / stepZ);
  else if (stepZ < -1e-9) t = Math.min(t, (subject.z - HALF_W - TP.marginNear) / stepZ);
  return clamp01(t);
}

/**
 * The third-person shot: behind and just above ONE player, looking the way
 * they face, so the viewer runs with them instead of watching from a gantry.
 * Pure, like `cameraGoalFor`; the controller damps toward it.
 *
 * `camYaw` is the RIG's heading, not the subject's raw one — the controller
 * smooths it on the shortest arc (`lerpAngle`), because a body that spins
 * 180° would otherwise drag a Cartesian-damped eye straight through itself.
 *
 * Two things keep every frame honest:
 * - At a touchline or goal line the full-distance eye would sit inside a
 *   stand (or the net). Instead of clamping the position — which parks the
 *   eye against a body's back — the rig PULLS IN along its heading and LIFTS
 *   as it does (`TP.lift`), so a keeper on their line reads as an over-the-
 *   shoulder overhead rather than a wall of shirt. The aim shortens with the
 *   pull-in so the subject stays inside the vertical FOV (test-pinned).
 * - The aim bends a little toward the ball when it is close AND ahead of the
 *   subject, so a marked runner's shot still shows what they are running at;
 *   it fades out as the ball comes level so a turn never snaps the aim.
 * - The aim is then clamped to the pitch apron (`TP.aimApron`), and kept at
 *   least a metre off the eye's own foot so `lookAt` never goes vertical.
 */
export function thirdPersonGoalFor(
  subject: { x: number; z: number },
  camYaw: number,
  ball: { x: number; z: number },
): CameraGoal {
  const dx = Math.sin(camYaw);
  const dz = Math.cos(camYaw);
  const t = thirdPersonPullIn(subject, dx, dz);
  const px = subject.x - dx * TP.back * t;
  const pz = subject.z - dz * TP.back * t;
  const py = TP.height + TP.lift * (1 - t);

  const aheadDist = TP.ahead * (0.35 + 0.65 * t);
  let lx = subject.x + dx * aheadDist;
  let lz = subject.z + dz * aheadDist;
  const bx = ball.x - subject.x;
  const bz = ball.z - subject.z;
  const dist = Math.hypot(bx, bz);
  const forward = bx * dx + bz * dz; // > 0: the ball is ahead of the subject
  const w = TP.ballPull * clamp01(1 - dist / TP.ballReach) * clamp01(forward / 3);
  lx += (ball.x - lx) * w;
  lz += (ball.z - lz) * w;
  lx = clamp(lx, -HALF_L - TP.aimApron, HALF_L + TP.aimApron);
  lz = clamp(lz, -HALF_W - TP.aimApron, HALF_W + TP.aimApron);
  if (Math.hypot(lx - px, lz - pz) < 1) {
    // Eye straight above the aim (a body over the line, facing out): nudge
    // the aim one metre along the heading rather than look straight down.
    lx = px + dx;
    lz = pz + dz;
  }
  return { px, py, pz, lx, ly: TP.lookY, lz };
}

/**
 * Whose shoulder the third-person rig rides (pure; unit-tested). The viewer's
 * tap wins — selecting a player already drives the card on the right, and in
 * this camera it also hands them the lens. With nobody selected the rig
 * follows the ball's protagonist: the holder, else whoever touched it last
 * (so a pass in flight stays with the passer until it arrives), else the
 * nearest body to a loose ball.
 */
export function pickCameraSubject(
  players: ReadonlyArray<{ gid: number; x: number; z: number; yaw: number }>,
  ball: { x: number; z: number; ownerGid: number | null; lastTouchGid?: number | null },
  selectedGid: number | null,
): CameraSubject | null {
  const byGid = (gid: number | null | undefined) =>
    gid === null || gid === undefined ? undefined : players.find((p) => p.gid === gid);
  let p = byGid(selectedGid) ?? byGid(ball.ownerGid) ?? byGid(ball.lastTouchGid);
  if (!p) {
    let best = Infinity;
    for (const q of players) {
      const d = (q.x - ball.x) ** 2 + (q.z - ball.z) ** 2;
      if (d < best) {
        best = d;
        p = q;
      }
    }
  }
  return p ? { gid: p.gid, x: p.x, z: p.z, yaw: p.yaw } : null;
}

/** Which camera best presents a replayed event (pure; unit-tested). */
export function cameraForEvent(type: 'goal' | 'shot' | 'save' | 'interception'): CameraMode {
  switch (type) {
    case 'goal':
      return 'behindGoal';
    case 'shot':
      return 'broadcast';
    case 'save':
      return 'behindGoal';
    case 'interception':
      return 'tactical';
  }
}

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'tactical';
  private look = new THREE.Vector3(0, 0, 0);
  /** Third-person rig heading (rad), smoothed toward the subject's on the shortest arc. */
  private camYaw = 0;
  private pulseT = -1;
  /** Goal cut: elapsed seconds (-1 = idle) and the ball as it crossed. */
  private celebrateT = -1;
  private celebrateBall = { x: 0, z: 0, vx: 0, vz: 0 };

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(46, aspect, 0.5, 500);
    const g = cameraGoalFor('tactical', { x: 0, z: 0, vx: 0, vz: 0 });
    this.camera.position.set(g.px, g.py, g.pz);
    this.look.set(g.lx, g.ly, g.lz);
    this.camera.lookAt(this.look);
  }

  setMode(mode: CameraMode): void {
    if (mode === 'thirdPerson' && this.mode !== 'thirdPerson') {
      // Start the rig's heading where the camera already looks, so the cut
      // into third person swings from the current shot instead of spinning
      // in from a stale heading.
      this.camYaw = Math.atan2(this.look.x - this.camera.position.x, this.look.z - this.camera.position.z);
    }
    this.mode = mode;
  }

  /** The third-person rig's smoothed heading (rad) — for tests and tooling. */
  get rigYaw(): number {
    return this.camYaw;
  }

  /** Brief push-in toward the action (used on shots). */
  pulse(): void {
    this.pulseT = 0;
  }

  /**
   * Cut to the celebration for `CELEBRATION_DUR`, then ease back to whatever
   * the viewer had chosen. `mode` is deliberately NOT reassigned: the cut is a
   * borrow, so the camera buttons keep showing the real selection and there is
   * no state to restore if a match ends mid-celebration.
   *
   * The ball is COPIED, not referenced. The kickoff that follows a goal puts it
   * back on the centre spot, and a live reference would swing the shot to the
   * wrong end halfway through the fireworks.
   */
  goalCut(ball: { x: number; z: number; vx: number; vz: number }): void {
    this.celebrateT = 0;
    this.celebrateBall = { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz };
  }

  /** For tooling and tests: is the goal cut currently holding the camera? */
  get celebrating(): boolean {
    return this.celebrateT >= 0;
  }

  /**
   * @param subject the body the third-person rig rides (ignored by every
   *   other mode). `null` — nobody on the pitch, or between matches — falls
   *   back to the ball chase framing so the mode never shows a dead camera.
   */
  update(
    ball: { x: number; z: number; vx: number; vz: number },
    dt: number,
    subject: CameraSubject | null = null,
  ): void {
    if (this.celebrateT >= 0) {
      this.celebrateT += dt;
      if (this.celebrateT >= CELEBRATION_DUR) this.celebrateT = -1;
    }
    // While the cut holds, the celebration framing REPLACES the mode's own —
    // damping does the rest, so the cut in and the return are both eased and
    // neither needs a second code path.
    let g: CameraGoal;
    if (this.celebrateT >= 0) {
      g = cameraGoalFor('celebration', this.celebrateBall);
    } else if (this.mode === 'thirdPerson') {
      if (subject) {
        this.camYaw = lerpAngle(this.camYaw, subject.yaw, 1 - Math.exp(-dt * TP.yawRate));
        g = thirdPersonGoalFor(subject, this.camYaw, ball);
      } else {
        g = cameraGoalFor('follow', ball);
      }
    } else {
      g = cameraGoalFor(this.mode, ball);
    }

    // Shot pulse: momentarily move the position goal toward the look target.
    if (this.pulseT >= 0) {
      this.pulseT += dt;
      const DUR = 0.9;
      if (this.pulseT >= DUR) this.pulseT = -1;
      else {
        const w = Math.sin((this.pulseT / DUR) * Math.PI) * 0.12;
        g.px += (g.lx - g.px) * w;
        g.py += (g.ly - g.py) * w;
        g.pz += (g.lz - g.pz) * w;
      }
    }

    // Exponential damping — frame-rate independent smoothing, no snapping.
    // Follow cam damps harder (motion-sickness guard); look leads slightly.
    // Third person damps LESS: the eye has to keep up with a sprinting body
    // from 6.5 m back, and its heading is already smoothed separately.
    const base = this.mode === 'follow' ? 1.9 : this.mode === 'thirdPerson' ? 4.5 : 2.6;
    const k = 1 - Math.exp(-dt * base);
    const kl = 1 - Math.exp(-dt * base * 1.35);
    this.camera.position.x += (g.px - this.camera.position.x) * k;
    this.camera.position.y += (g.py - this.camera.position.y) * k;
    this.camera.position.z += (g.pz - this.camera.position.z) * k;
    this.look.x += (g.lx - this.look.x) * kl;
    this.look.y += (g.ly - this.look.y) * kl;
    this.look.z += (g.lz - this.look.z) * kl;
    this.camera.lookAt(this.look);
  }
}
