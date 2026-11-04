import * as THREE from 'three';
import { stylePreset, type StylePreset } from './stylePresets';
import { terraceSlabs } from './PitchModel';

/**
 * The LIVING crowd (Phase 66.1, user ask: the stands need actions too).
 * Same silhouette as the Phase-31.6 seated crowd — deterministic LCG
 * layout, two InstancedMeshes (~300 bodies + heads = 2 draw calls) — but
 * the instances now belong to the renderer's update loop:
 *
 *   idle    — a slow, quiet sway (alive, not a texture)
 *   ripple  — shots, saves, corners: a brief half-rise ("ooh")
 *   erupt   — goals: everybody jumps, each on his own beat, ~2.6s decay
 *
 * Per-frame cost is ~600 matrix writes + 2 buffer uploads — phone-safe.
 * Render-only; fed by FxSystem's deduped hooks, so live play, skip and
 * replay scrubbing each fire a reaction exactly once.
 */

/** Seconds between instance rewrites while the stands are calm (F7 perf). */
export const CALM_UPDATE_PERIOD = 1 / 20;

/** The player skin palette, so the stands are the same species as the pitch. */
const CROWD_SKINS = [0xf1c27d, 0xe0b089, 0xc68642, 0x9c6b3f, 0x6b4423, 0x4a2f1b];

interface Seat {
  x: number;
  y: number;
  z: number;
  /** Personal animation phase — the crowd never moves in lockstep. */
  phase: number;
  /** How high this fan jumps when the stands erupt (0.5–1). */
  eager: number;
}

export class CrowdSystem {
  readonly root = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly seats: Seat[] = [];
  private readonly m4 = new THREE.Matrix4();
  private t = 0;
  /** Current arousal 0..1 — jumps on events, decays toward calm. */
  private excitement = 0;
  private idleAccum = 0;
  private writes = 0;

  constructor(style: StylePreset = stylePreset()) {
    let lcg = 987654321;
    const rand = () => ((lcg = (lcg * 48271) % 2147483647) / 2147483647);
    // Skin tones draw from their OWN stream. Sharing `rand` made picking a
    // face colour advance the seat lottery, so F3's palette change silently
    // reseated the whole terrace (192 bodies -> 184). A cosmetic choice must
    // not perturb an unrelated deterministic layout.
    let skinLcg = 24681357;
    const skinRand = () => ((skinLcg = (skinLcg * 48271) % 2147483647) / 2147483647);
    // F-DIRECTION: the palette is data. The terrace was the last element no
    // preset owned — a night-navy crowd sat under the daylight arms' noon sky.
    const palette = style.crowd;
    const colors: number[] = [];
    const skins: number[] = [];
    for (const s of terraceSlabs()) {
      const usable = s.w - 2;
      const n = Math.floor(usable / 1.15);
      for (let i = 0; i < n; i++) {
        if (rand() < 0.22) continue; // empty seats keep it from reading as a texture
        const along = -usable / 2 + (i + 0.5) * (usable / n) + (rand() - 0.5) * 0.3;
        this.seats.push({
          x: s.x + Math.cos(s.rot) * along,
          y: s.y + 0.36 + rand() * 0.06,
          z: s.z - Math.sin(s.rot) * along,
          phase: rand() * Math.PI * 2,
          eager: 0.5 + rand() * 0.5,
        });
        colors.push(palette[Math.floor(rand() * palette.length)]);
        // One skin tone for a whole crowd was its own small incoherence:
        // the players have had six since Phase 76.
        skins.push(CROWD_SKINS[Math.floor(skinRand() * CROWD_SKINS.length)]);
      }
    }
    this.bodies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.42, 0.72, 0.34),
      new THREE.MeshStandardMaterial({ roughness: 0.9 }),
      this.seats.length,
    );
    this.heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.16, 6, 5),
      new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      this.seats.length,
    );
    const color = new THREE.Color();
    this.seats.forEach((s, i) => {
      this.m4.makeTranslation(s.x, s.y, s.z);
      this.bodies.setMatrixAt(i, this.m4);
      this.bodies.setColorAt(i, color.setHex(colors[i]));
      this.m4.makeTranslation(s.x, s.y + 0.5, s.z);
      this.heads.setMatrixAt(i, this.m4);
      this.heads.setColorAt(i, color.setHex(skins[i]));
    });
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
    // The stands span the whole diorama — default sphere culling blinks
    // them out at oblique camera angles once instances start moving.
    this.bodies.frustumCulled = false;
    this.heads.frustumCulled = false;
    this.root.add(this.bodies, this.heads);
  }

  /** A goal: the full eruption. */
  erupt(): void {
    this.excitement = 1;
  }

  /** A near-thing (shot, save, corner): rise toward `strength`, never calm DOWN. */
  ripple(strength: number): void {
    this.excitement = Math.max(this.excitement, strength);
  }

  /** Current arousal (debug/tests). */
  get arousal(): number {
    return this.excitement;
  }

  get count(): number {
    return this.seats.length;
  }

  /** Instance-buffer rewrites so far — the per-frame cost, for the perf test. */
  get matrixWrites(): number {
    return this.writes;
  }

  update(dt: number): void {
    this.t += dt;
    this.excitement = Math.max(0, this.excitement - dt / 2.6);
    const ex = this.excitement;
    // F6 doubled the terrace to 369 bodies and this loop rewrites AND
    // re-uploads every instance matrix, twice (bodies + heads), every frame.
    // While the stands are calm the only motion is a 3.5 cm idle bob, which
    // nobody can resolve at 20 Hz from a broadcast camera — so pay the full
    // 60 Hz cost only when the crowd is actually reacting to something.
    // Phone is the binding constraint (F-DIRECTION).
    if (ex <= 1e-3) {
      this.idleAccum += dt;
      if (this.idleAccum < CALM_UPDATE_PERIOD) return;
      this.idleAccum = 0;
    } else {
      this.idleAccum = 0;
    }
    this.writes++;
    const t = this.t;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      // Idle sway breathes; the jump is a personal beat — only its upward
      // half, so fans land back IN their seats, not below them.
      const bob = Math.sin(t * 1.1 + s.phase) * 0.035;
      const jump = ex * s.eager * Math.max(0, Math.sin(t * 7 + s.phase)) * 0.5;
      const y = s.y + bob + jump;
      this.m4.makeTranslation(s.x, y, s.z);
      this.bodies.setMatrixAt(i, this.m4);
      this.m4.makeTranslation(s.x, y + 0.5, s.z);
      this.heads.setMatrixAt(i, this.m4);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
  }
}
