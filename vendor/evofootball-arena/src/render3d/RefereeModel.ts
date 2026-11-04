import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import { barrel, bodyMat, HUMAN_MODEL_SCALE, limb, shoe, TORSO_RADIAL_SEG } from './PlayerModel';
import { lerpAngle, type RenderState } from './RenderStateAdapter';

/**
 * The REFEREE (Phase 75) — render-only: the sim adjudicates fouls/cards as
 * pure state and the feed narrates them, this is the body those calls come
 * from. His position is SYNTHESIZED here (the classic diagonal patrol:
 * shadow play up the pitch, hold the center channel, stand off the ball,
 * never enter the goalmouth picture) — the sim knows nothing about him.
 * Fouls stop him and raise the whistle arm; cards raise the card itself
 * (yellow, or red when the feed says sent off) — both consumed from the fx
 * stream, deduped by event time exactly like FxSystem.
 *
 * RB-2 (2026-08-19): his anatomy boxes became BODIES OF REVOLUTION with the
 * player's own primitives (`barrel` / `limb` / `shoe` from `PlayerModel.ts`) —
 * RB rounded the players and left the officials as the old box-person, so the
 * man giving the decisions read as a different species from the men taking
 * them. Same invariants as RB: every part fills exactly the bounding box of
 * the box it replaces, non-circular cross-sections are baked into the geometry
 * (never onto a mesh scale), and every pivot / translate-to-pivot offset is
 * byte-identical, so the patrol, gait and call poses below are untouched.
 */

/** Where the referee wants to stand for a ball at (ballX, ballZ). Pure. */
export function refereeTarget(ballX: number, ballZ: number): { x: number; z: number } {
  const d = ballX / HALF_L; // -1 .. 1, which end play is at
  let x = Math.max(-HALF_L + 6, Math.min(HALF_L - 6, ballX * 0.8));
  let z = Math.max(-HALF_W + 5, Math.min(HALF_W - 5, d * 9 + ballZ * 0.25));
  // Stand-off: never crowd the ball — hold ~7m of adjudicating distance.
  const dx = x - ballX;
  const dz = z - ballZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 7) {
    const nx = dist < 1e-6 ? 0 : dx / dist;
    const nz = dist < 1e-6 ? 1 : dz / dist;
    x = ballX + nx * 7;
    z = ballZ + nz * 7;
  }
  return { x, z };
}

const MAX_SPEED = 8; // he keeps up with play but never outruns the wingers

export class RefereeModel {
  readonly root = new THREE.Group();
  private readonly lean = new THREE.Group();
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly card: THREE.Mesh;
  private readonly cardMat: THREE.MeshBasicMaterial;
  private phase = 0;
  private armUp = 0; // eased 0..1 blend of the raised call arm
  private whistleT = -1;
  private cardT = -1;
  private seen = new Set<string>();

  constructor() {
    // Same material language as the players (F0): PBR or toon ramp.
    const kit = bodyMat(0x16181d, 0.75);
    const trim = bodyMat(0xfacc15, 0.7);
    const skin = bodyMat(0xe0b089, 0.8);

    this.lean.position.y = 1.06;
    // RB-2: the chest is a barrel on the old 0.78 × 0.95 × 0.44 box — the
    // 0.44/0.78 z-squash reproduces the depth, the 0.20 corner (the player
    // chest's own) keeps a readable shoulder line and hem.
    const torso = new THREE.Mesh(
      barrel(0.39, 0.475, 0.2, TORSO_RADIAL_SEG).scale(1, 1, 0.44 / 0.78),
      kit,
    );
    torso.position.y = 0.62;
    torso.castShadow = true;
    // A collar flash of yellow — "that's the ref" from any camera.
    // RB-2: a short cylinder hugging the round chest (was a flat slab).
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 0.12, TORSO_RADIAL_SEG).scale(1, 1, 0.46 / 0.8),
      trim,
    );
    collar.position.y = 1.04;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), skin);
    head.position.y = 1.34;
    head.castShadow = true;

    // F2 toy anatomy: officials thicken with the players, shoulders tuck in.
    // RB-2: one-piece round arm on the old 0.26 × 0.74 × 0.26 box; the -0.32
    // translate-to-shoulder is unchanged, so the call pose still reads.
    const armGeo = limb(0.13, 0.74);
    armGeo.translate(0, -0.32, 0);
    this.armL = new THREE.Group();
    this.armL.position.set(-0.44, 1.0, 0);
    this.armL.add(new THREE.Mesh(armGeo, kit));
    this.armR = new THREE.Group();
    this.armR.position.set(0.44, 1.0, 0);
    this.armR.add(new THREE.Mesh(armGeo.clone(), kit));

    // The card, palmed at the end of the calling (right) arm — visible only
    // while a booking plays. Double-sided so every camera reads it.
    this.cardMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide });
    this.card = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.28), this.cardMat);
    this.card.position.set(0, -0.78, 0.02);
    this.card.visible = false;
    this.armR.add(this.card);
    this.lean.add(torso, collar, head, this.armL, this.armR);

    // RB-2: round one-piece leg on the old 0.30 × 1.0 × 0.32 box (the 0.32/0.30
    // depth is baked in, exactly as the player's sock is).
    const legGeo = limb(0.15, 1.0, 0.32 / 0.30);
    legGeo.translate(0, -0.5, 0);
    this.legL = new THREE.Group();
    this.legL.position.set(-0.21, 1.06, 0);
    this.legL.add(new THREE.Mesh(legGeo, kit));
    this.legR = new THREE.Group();
    this.legR.position.set(0.21, 1.06, 0);
    this.legR.add(new THREE.Mesh(legGeo.clone(), kit));
    // RB-2: the player's boot primitive on the old 0.30 × 0.15 × 0.38 box.
    const shoeGeo = shoe(0.30, 0.15, 0.38);
    const shoeL = new THREE.Mesh(shoeGeo, kit);
    shoeL.position.set(0, -1.0, 0.07);
    this.legL.add(shoeL);
    const shoeR = new THREE.Mesh(shoeGeo.clone(), kit);
    shoeR.position.set(0, -1.0, 0.07);
    this.legR.add(shoeR);

    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.52, 14),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;

    // F1 scale honesty: officials are the same box-person skeleton as the
    // players and share their shrink — otherwise the ref towers over the game.
    const bodyScale = new THREE.Group();
    bodyScale.scale.setScalar(HUMAN_MODEL_SCALE);
    bodyScale.add(this.lean, this.legL, this.legR, blob);
    this.root.add(bodyScale);
    const start = refereeTarget(0, 0);
    this.root.position.set(start.x, 0, start.z);
  }

  /** Debug/tests: a call (whistle or card) is currently playing. */
  get calling(): boolean {
    return this.whistleT >= 0 || this.cardT >= 0;
  }

  get pos(): { x: number; z: number } {
    return { x: this.root.position.x, z: this.root.position.z };
  }

  /** Re-arm the fx dedupe and walk-in position (match attach / replay scrub). */
  reset(): void {
    this.seen.clear();
    this.whistleT = -1;
    this.cardT = -1;
    const start = refereeTarget(0, 0);
    this.root.position.set(start.x, 0, start.z);
  }

  update(state: RenderState, dt: number): void {
    // The shootout theater stages its own picture — the ref stays out of it.
    this.root.visible = !state.shootout;
    if (!this.root.visible) return;

    // Consume calls from the fx stream (deduped by t, like FxSystem).
    for (const fx of state.fx) {
      if (fx.type !== 'foul' && fx.type !== 'card') continue;
      const key = `${fx.type}:${fx.t.toFixed(2)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 400) this.seen.clear();
      if (fx.type === 'foul') this.whistleT = 0.9;
      else {
        this.cardT = 1.5;
        this.cardMat.color.setHex(fx.red ? 0xdc2626 : 0xfacc15);
      }
    }
    if (this.whistleT >= 0) this.whistleT -= dt;
    if (this.cardT >= 0) this.cardT -= dt;
    const calling = this.calling;

    // Patrol — unless he's stopped mid-call.
    const target = refereeTarget(state.ball.x, state.ball.z);
    const dx = target.x - this.root.position.x;
    const dz = target.z - this.root.position.z;
    const dist = Math.hypot(dx, dz);
    let speed = 0;
    if (!calling && dist > 0.4) {
      speed = Math.min(MAX_SPEED, dist * 1.8);
      const step = Math.min((speed * dt) / (dist || 1e-6), 1);
      this.root.position.x += dx * step;
      this.root.position.z += dz * step;
    }

    // Face the run while moving, the ball while standing/calling.
    const faceYaw =
      speed > 2 && !calling
        ? Math.atan2(dx, dz)
        : Math.atan2(state.ball.x - this.root.position.x, state.ball.z - this.root.position.z);
    this.root.rotation.y = lerpAngle(this.root.rotation.y, faceYaw, Math.min(1, dt * 5));

    // Gait: same distance-driven cycle as the players, one-piece legs.
    this.phase += Math.max(speed, 0.4) * dt * 1.7;
    const amp = speed < 0.8 ? 0.04 : speed < 5.2 ? 0.55 : 0.95;
    const swing = Math.sin(this.phase) * amp;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.lean.rotation.x = 0.04 + Math.min(speed / MAX_SPEED, 1) * 0.22;

    // The call: right arm straight up (whistle or card), eased.
    this.armUp += ((calling ? 1 : 0) - this.armUp) * Math.min(1, dt * 8);
    const up = this.armUp;
    this.armL.rotation.x = -swing * 0.7 * (1 - up);
    this.armR.rotation.x = swing * 0.7 * (1 - up);
    this.armL.rotation.z = -0.1 * (1 - up);
    this.armR.rotation.z = 0.1 * (1 - up) - 2.7 * up;
    this.card.visible = this.cardT >= 0 && up > 0.5;
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
