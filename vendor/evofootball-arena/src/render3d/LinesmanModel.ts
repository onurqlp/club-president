import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import { barrel, bodyMat, HUMAN_MODEL_SCALE, limb, TORSO_RADIAL_SEG } from './PlayerModel';
import { lerpAngle, type RenderPlayer, type RenderState } from './RenderStateAdapter';

/**
 * The ASSISTANT REFEREE (Phase 77) — render-only, like the referee (75).
 * Two of them, on opposite touchlines, each covering one half; each runs
 * the REAL assistant's law: stay level with the second-last defender, or
 * with the ball when the ball is nearer the goal line. That running line
 * IS the offside line — the phase-71 offside law finally has a moving
 * body that shows it in every camera, not just the tacfeed flash.
 * OFFSIDE calls raise the flag (the sim pushes them as `foul` events
 * whose text starts with "Offside" — mined into fx.offside by the
 * adapter); a corner at his end gets a short flag point too.
 *
 * RB-2 (2026-08-19): rounded with the player's own primitives (`barrel` /
 * `limb` from `PlayerModel.ts`) — see `RefereeModel.ts` for the reasoning and
 * the invariants (per-part bounding boxes identical to the boxes replaced,
 * cross-sections baked into the geometry, every pivot byte-identical).
 */

/** The defending team's line: x of its second-deepest outfielder toward
 * its OWN goal. Side 0 defends −x, side 1 defends +x (BroadcastLayer's
 * convention). Pure. */
export function defensiveLineX(
  players: Array<Pick<RenderPlayer, 'side' | 'role' | 'x'>>, side: 0 | 1,
): number {
  const xs: number[] = [];
  for (const p of players) {
    if (p.side === side && p.role !== 'GK') xs.push(p.x);
  }
  xs.sort((a, b) => (side === 0 ? a - b : b - a));
  return xs[1] ?? 0;
}

/**
 * Where the assistant stands for the half ending at `end` (±1): level with
 * the second-last defender OR the ball, whichever is nearer the goal line,
 * clamped between the halfway line and the goal line. Pure.
 */
export function linesmanTargetX(end: 1 | -1, defLineX: number, ballX: number): number {
  const m = Math.max(end * defLineX, end * ballX);
  return end * Math.min(HALF_L - 0.5, Math.max(0, m));
}

const MAX_SPEED = 8.5; // assistants sprint to stay level

export class LinesmanModel {
  readonly root = new THREE.Group();
  private readonly end: 1 | -1;
  private readonly lean = new THREE.Group();
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private phase = 0;
  private flagT = -1;
  private armUp = 0;
  private seen = new Set<string>();

  constructor(end: 1 | -1, zSide: 1 | -1) {
    this.end = end;
    // Same material language as the players (F0): PBR or toon ramp.
    const kit = bodyMat(0x16181d, 0.75);
    const trim = bodyMat(0xfacc15, 0.7);
    const skin = bodyMat(0xe0b089, 0.8);
    const flagCloth = new THREE.MeshBasicMaterial({ color: 0xf97316, side: THREE.DoubleSide });

    this.lean.position.y = 1.06;
    // RB-2: barrel chest on the old 0.72 × 0.92 × 0.42 box. Same half-width as
    // the player's chest (TORSO_BASE.w / 2 = 0.36), same 0.20 corner.
    const torso = new THREE.Mesh(
      barrel(0.36, 0.46, 0.2, TORSO_RADIAL_SEG).scale(1, 1, 0.42 / 0.72),
      kit,
    );
    torso.position.y = 0.6;
    torso.castShadow = true;
    // RB-2: the collar is a short cylinder on the old 0.74 × 0.11 × 0.44 box.
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.37, 0.37, 0.11, TORSO_RADIAL_SEG).scale(1, 1, 0.44 / 0.74),
      trim,
    );
    collar.position.y = 1.01;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.31, 12, 10), skin);
    head.position.y = 1.30;
    head.castShadow = true;

    // F2 toy anatomy: officials thicken with the players, shoulders tuck in.
    // RB-2: round one-piece arm on the old 0.25 × 0.72 × 0.25 box.
    const armGeo = limb(0.125, 0.72);
    armGeo.translate(0, -0.31, 0);
    this.armL = new THREE.Group();
    this.armL.position.set(-0.41, 0.98, 0);
    this.armL.add(new THREE.Mesh(armGeo, kit));
    this.armR = new THREE.Group();
    this.armR.position.set(0.41, 0.98, 0);
    this.armR.add(new THREE.Mesh(armGeo.clone(), kit));
    // The flag lives in the right hand always (assistants never put it
    // down): a short stick + orange cloth, readable when the arm goes up.
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), trim);
    stick.position.set(0, -0.85, 0);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.2), flagCloth);
    cloth.position.set(0.13, -0.72, 0);
    this.armR.add(stick, cloth);
    this.lean.add(torso, collar, head, this.armL, this.armR);

    // RB-2: round one-piece leg on the old 0.28 × 1.0 × 0.30 box.
    const legGeo = limb(0.14, 1.0, 0.30 / 0.28);
    legGeo.translate(0, -0.5, 0);
    this.legL = new THREE.Group();
    this.legL.position.set(-0.20, 1.06, 0);
    this.legL.add(new THREE.Mesh(legGeo, kit));
    this.legR = new THREE.Group();
    this.legR.position.set(0.20, 1.06, 0);
    this.legR.add(new THREE.Mesh(legGeo.clone(), kit));

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.48, 14),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;

    // F1 scale honesty: same shrink as the players and the referee.
    const bodyScale = new THREE.Group();
    bodyScale.scale.setScalar(HUMAN_MODEL_SCALE);
    bodyScale.add(this.lean, this.legL, this.legR, blob);
    this.root.add(bodyScale);
    this.root.position.set(0, 0, zSide * (HALF_W + 0.8));
  }

  /** Debug/tests: the flag is currently raised. */
  get flagging(): boolean {
    return this.flagT >= 0;
  }

  get pos(): { x: number; z: number } {
    return { x: this.root.position.x, z: this.root.position.z };
  }

  /** Re-arm the fx dedupe and walk back to halfway (attach / replay scrub). */
  reset(): void {
    this.seen.clear();
    this.flagT = -1;
    this.root.position.x = 0;
  }

  update(state: RenderState, dt: number): void {
    this.root.visible = !state.shootout;
    if (!this.root.visible) return;

    // Flags from the fx stream (deduped by t, like FxSystem/the referee):
    // offside anywhere toward HIS end, or a corner at his end.
    for (const fx of state.fx) {
      const mine = Math.sign(state.ball.x) === this.end;
      if (!((fx.type === 'foul' && fx.offside) || fx.type === 'corner') || !mine) continue;
      const key = `${fx.type}:${fx.t.toFixed(2)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 400) this.seen.clear();
      this.flagT = fx.type === 'corner' ? 1.0 : 1.6;
    }
    if (this.flagT >= 0) this.flagT -= dt;
    const flagging = this.flagT >= 0;

    // The assistant's law: level with the second-last defender or the
    // ball, whichever is nearer his goal line. He owns the whole line —
    // no standing off, unlike the referee.
    const defSide = this.end === 1 ? 1 : 0;
    const target = linesmanTargetX(this.end, defensiveLineX(state.players, defSide), state.ball.x);
    const dx = target - this.root.position.x;
    let speed = 0;
    if (!flagging && Math.abs(dx) > 0.25) {
      speed = Math.min(MAX_SPEED, Math.abs(dx) * 2.2);
      this.root.position.x += Math.sign(dx) * Math.min(speed * dt, Math.abs(dx));
    }

    // Face the sprint while moving hard; square up to the pitch otherwise
    // (assistants side-step short distances, turn and run long ones).
    const faceYaw = speed > 3.5 ? (Math.sign(dx) * Math.PI) / 2 : Math.atan2(0, -this.root.position.z);
    this.root.rotation.y = lerpAngle(this.root.rotation.y, faceYaw, Math.min(1, dt * 5));

    this.phase += Math.max(speed, 0.4) * dt * 1.7;
    const amp = speed < 0.8 ? 0.04 : speed < 5.2 ? 0.55 : 0.95;
    const swing = Math.sin(this.phase) * amp;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.lean.rotation.x = 0.04 + Math.min(speed / MAX_SPEED, 1) * 0.2;

    // The flag arm: straight up while a call plays, carried low otherwise.
    this.armUp += ((flagging ? 1 : 0) - this.armUp) * Math.min(1, dt * 8);
    const up = this.armUp;
    this.armL.rotation.x = -swing * 0.7;
    this.armR.rotation.x = swing * 0.5 * (1 - up);
    this.armL.rotation.z = -0.1;
    this.armR.rotation.z = 0.12 * (1 - up) - 2.75 * up;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) (m as THREE.Material).dispose();
    });
  }
}
