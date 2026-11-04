import * as THREE from 'three';
import { GOAL_WIDTH, HALF_L, HALF_W } from '../sim/constants';
import type { FxEvent, RenderState } from './RenderStateAdapter';
import { stylePreset, type StylePreset } from './stylePresets';

/**
 * Event feedback: particle bursts (saves, interceptions) and floating xG
 * markers (shots). Consumes the RenderState `fx` stream and dedupes by event
 * time, so live play, fast-forward and replay scrubbing all trigger each
 * effect exactly once (reset() re-arms them for replays).
 * Pools are pre-allocated; per-frame work is position writes only.
 */

const BURST_N = 16;
/** Jets per goal (F7). */
const PYRO_JETS = 4;
/** Particles in one firework shell's burst (F7). */
const SHELL_N = 70;

/**
 * A pyrotechnic flame jet (F7, user: "进球得有点特效比如烟花喷火之类的").
 *
 * ONE billboard per jet, not a particle column. The first cut was 90
 * `THREE.Points` per jet and rendered absolutely nothing — with vertex
 * colours removed, at 6m point size, moved into open view, rewritten to
 * mirror `Firework` exactly, console clean and the scene-graph probe all
 * green. Never root-caused. Sprites are the known-good path in this codebase
 * (every player label is one), and a stretched billboard with a procedural
 * gradient is both a better flame and 4 draw calls instead of 360.
 *
 * Fires only on a goal, when play is already stopped, so it can never hide
 * the ball or the shape (F-DIRECTION's rule).
 */
class Pyro {
  readonly sprite: THREE.Sprite;
  private life = -1;
  private mat: THREE.SpriteMaterial;
  private static readonly DUR = 1.5;
  private static readonly RISE = 0.28;
  /** 7.5m towered over 1.7m players; a jet should read as tall, not absurd. */
  private static readonly H = 4.6;
  private static readonly W = 1.35;

  constructor(blending: THREE.Blending) {
    this.mat = new THREE.SpriteMaterial({
      map: flameTexture(), transparent: true, opacity: 0, depthWrite: false, blending,
    });
    this.sprite = new THREE.Sprite(this.mat);
    // Grow from the ground up, not from the middle out.
    this.sprite.center.set(0.5, 0);
    this.sprite.visible = false;
  }

  fire(x: number, z: number): void {
    this.sprite.position.set(x, 0.05, z);
    this.sprite.scale.set(Pyro.W, 0.2, 1);
    this.life = 0;
    this.sprite.visible = true;
  }

  update(dt: number): void {
    if (this.life < 0) return;
    this.life += dt;
    if (this.life >= Pyro.DUR) {
      this.life = -1;
      this.sprite.visible = false;
      return;
    }
    // Whoosh up fast, then burn down and fade.
    const climb = Math.min(1, this.life / Pyro.RISE);
    const burn = Math.max(0, (this.life - Pyro.RISE) / (Pyro.DUR - Pyro.RISE));
    const h = Pyro.H * (climb ** 0.55) * (1 - burn * 0.45);
    // Flicker so the column is alive rather than a static cone.
    const flick = 1 + Math.sin(this.life * 34) * 0.06;
    this.sprite.scale.set(Pyro.W * (0.75 + climb * 0.25) * flick, h, 1);
    this.mat.opacity = Math.min(1, climb * 1.4) * (1 - burn ** 1.8);
  }
}

/** Vertical flame gradient, drawn once: white-hot base into orange smoke. */
let FLAME_TEX: THREE.CanvasTexture | null = null;
function flameTexture(): THREE.CanvasTexture {
  if (FLAME_TEX) return FLAME_TEX;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  // Saturated, not white-hot: against bright daylight grass a pale gradient
  // reads as haze. Orange is what separates flame from fog here.
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, 'rgba(255,248,214,1)');
  g.addColorStop(0.14, 'rgba(255,198,54,1)');
  g.addColorStop(0.42, 'rgba(255,118,16,0.97)');
  g.addColorStop(0.72, 'rgba(214,52,8,0.72)');
  g.addColorStop(1, 'rgba(140,28,6,0)');
  ctx.fillStyle = g;
  // Taper toward the tip so it reads as a jet, not a bar.
  ctx.beginPath();
  ctx.moveTo(2, 128);
  ctx.lineTo(30, 128);
  ctx.lineTo(20, 0);
  ctx.lineTo(12, 0);
  ctx.closePath();
  ctx.fill();
  FLAME_TEX = new THREE.CanvasTexture(c);
  FLAME_TEX.colorSpace = THREE.SRGBColorSpace;
  return FLAME_TEX;
}

/**
 * A firework shell (F7): rises above the stand on a fuse, then bursts into a
 * ring of coloured stars that fall under gravity. Pure celebration, and it now
 * goes up at the default quality — see `FxSystem.quality` for why the phone
 * budget was never the thing standing in its way.
 */
class Firework {
  readonly points: THREE.Points;
  private vels = new Float32Array(SHELL_N * 3);
  private origin = new THREE.Vector3();
  private life = -1;
  private delay = 0;
  private mat: THREE.PointsMaterial;
  private static readonly FUSE = 0.75;
  private static readonly DUR = 2.4;

  constructor(blending: THREE.Blending, size: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SHELL_N * 3), 3));
    this.mat = new THREE.PointsMaterial({
      size, color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  fire(x: number, z: number, peak: number, color: number, delay: number): void {
    this.origin.set(x, peak, z);
    this.delay = delay;
    this.mat.color.setHex(color);
    for (let i = 0; i < SHELL_N; i++) {
      // Spherical-ish shell, flattened so it reads as a ring from the side.
      const a = (i / SHELL_N) * Math.PI * 2;
      const tilt = (Math.random() - 0.5) * 1.1;
      const sp = 8 + Math.random() * 3.5;
      this.vels[i * 3] = Math.cos(a) * sp;
      this.vels[i * 3 + 1] = tilt * sp;
      this.vels[i * 3 + 2] = Math.sin(a) * sp;
    }
    this.life = 0;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.life < 0) return;
    this.life += dt;
    const t = this.life - this.delay;
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (t < 0) { this.mat.opacity = 0; return; }
    if (this.life >= this.delay + Firework.DUR) {
      this.life = -1;
      this.points.visible = false;
      return;
    }
    if (t < Firework.FUSE) {
      // The shell itself, climbing. All stars ride the same rising point.
      const rise = this.origin.y * (t / Firework.FUSE);
      for (let i = 0; i < SHELL_N; i++) pos.setXYZ(i, this.origin.x, rise, this.origin.z);
      this.mat.opacity = 0.85;
    } else {
      const b = t - Firework.FUSE;
      for (let i = 0; i < SHELL_N; i++) {
        pos.setXYZ(
          i,
          this.origin.x + this.vels[i * 3] * b,
          this.origin.y + this.vels[i * 3 + 1] * b - 4.2 * b * b,
          this.origin.z + this.vels[i * 3 + 2] * b,
        );
      }
      this.mat.opacity = Math.max(0, 1 - b / (Firework.DUR - Firework.FUSE)) ** 1.4;
    }
    pos.needsUpdate = true;
  }
}


class Burst {
  readonly points: THREE.Points;
  private vels = new Float32Array(BURST_N * 3);
  private life = -1;
  private mat: THREE.PointsMaterial;

  constructor(blending: THREE.Blending) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BURST_N * 3), 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.35,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  fire(x: number, y: number, z: number, color: number): void {
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < BURST_N; i++) {
      pos.setXYZ(i, x, y, z);
      const a = (i / BURST_N) * Math.PI * 2;
      const up = 2 + Math.random() * 3;
      const out = 1.5 + Math.random() * 2.5;
      this.vels[i * 3] = Math.cos(a) * out;
      this.vels[i * 3 + 1] = up;
      this.vels[i * 3 + 2] = Math.sin(a) * out;
    }
    pos.needsUpdate = true;
    this.mat.color.setHex(color);
    this.life = 0;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.life < 0) return;
    this.life += dt;
    const DUR = 0.55;
    if (this.life >= DUR) {
      this.life = -1;
      this.points.visible = false;
      return;
    }
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < BURST_N; i++) {
      this.vels[i * 3 + 1] -= 12 * dt; // gravity
      pos.setXYZ(
        i,
        pos.getX(i) + this.vels[i * 3] * dt,
        Math.max(0.05, pos.getY(i) + this.vels[i * 3 + 1] * dt),
        pos.getZ(i) + this.vels[i * 3 + 2] * dt,
      );
    }
    pos.needsUpdate = true;
    this.mat.opacity = 1 - this.life / DUR;
  }
}

/**
 * F-Q body-bump dust: a low, short puff of a dozen motes at the contact point
 * that drift outward and settle. Solid, ground-hugging and brief — it marks
 * WHERE two bodies met without ever masking the ball or the shape.
 */
const DUST_N = 12;
class Dust {
  readonly points: THREE.Points;
  private vels = new Float32Array(DUST_N * 3);
  private life = -1;
  private mat: THREE.PointsMaterial;
  private static readonly DUR = 0.5;

  constructor(blending: THREE.Blending, color: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST_N * 3), 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.22, color, transparent: true, opacity: 0, depthWrite: false, blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  fire(x: number, z: number, nx: number, nz: number, strength: number): void {
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const k = 0.6 + Math.min(1, strength / 4) * 0.6;
    for (let i = 0; i < DUST_N; i++) {
      pos.setXYZ(i, x, 0.12, z);
      // Fan out along the contact LINE (perpendicular to the normal), a bit each way.
      const a = (i / DUST_N) * Math.PI * 2;
      const out = (0.8 + Math.random() * 1.2) * k;
      const px = -nz * Math.cos(a) + nx * Math.sin(a) * 0.35;
      const pz = nx * Math.cos(a) + nz * Math.sin(a) * 0.35;
      this.vels[i * 3] = px * out;
      this.vels[i * 3 + 1] = (0.9 + Math.random() * 1.1) * k;
      this.vels[i * 3 + 2] = pz * out;
    }
    pos.needsUpdate = true;
    this.life = 0;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.life < 0) return;
    this.life += dt;
    if (this.life >= Dust.DUR) {
      this.life = -1;
      this.points.visible = false;
      return;
    }
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < DUST_N; i++) {
      this.vels[i * 3 + 1] -= 5 * dt;
      this.vels[i * 3] *= 1 - 2.5 * dt;
      this.vels[i * 3 + 2] *= 1 - 2.5 * dt;
      pos.setXYZ(
        i,
        pos.getX(i) + this.vels[i * 3] * dt,
        Math.max(0.06, pos.getY(i) + this.vels[i * 3 + 1] * dt),
        pos.getZ(i) + this.vels[i * 3 + 2] * dt,
      );
    }
    pos.needsUpdate = true;
    const k = this.life / Dust.DUR;
    this.mat.opacity = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * 0.75;
  }
}

class Floater {
  readonly sprite: THREE.Sprite;
  private tex: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private life = -1;

  constructor() {
    this.canvas.width = 192;
    this.canvas.height = 64;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0 }),
    );
    this.sprite.scale.set(4.6, 1.55, 1);
    this.sprite.visible = false;
  }

  fire(x: number, z: number, text: string, color: string): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 192, 64);
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.fillStyle = color;
    ctx.strokeText(text, 96, 42);
    ctx.fillText(text, 96, 42);
    this.tex.needsUpdate = true;
    this.sprite.position.set(x, 2.2, z);
    this.life = 0;
    this.sprite.visible = true;
  }

  update(dt: number): void {
    if (this.life < 0) return;
    this.life += dt;
    const DUR = 1.3;
    if (this.life >= DUR) {
      this.life = -1;
      this.sprite.visible = false;
      return;
    }
    this.sprite.position.y += dt * 1.6;
    (this.sprite.material as THREE.SpriteMaterial).opacity =
      this.life < 0.15 ? this.life / 0.15 : 1 - (this.life - 0.15) / (DUR - 0.15);
  }
}

export interface FxHooks {
  /** A goal happened (side) — banner, net shake, sound... */
  onGoal: (side: 0 | 1) => void;
  /** A shot was struck — camera pulse, sound. */
  onShot: () => void;
  /** Any fx event, for optional sound hooks. */
  onEvent?: (type: FxEvent['type']) => void;
}

export type FxQuality = 'low' | 'medium' | 'high';

export class FxSystem {
  readonly root = new THREE.Group();
  private bursts: Burst[];
  private floaters = [new Floater(), new Floater(), new Floater()];
  private pyros: Pyro[];
  private shells: Firework[];
  private dusts: Dust[];
  private nextDust = 0;
  private nextBurst = 0;
  private nextFloater = 0;
  private seen = new Set<string>();
  /** The shells' neutral star colour for THIS lighting (see the preset field). */
  private sparkNeutral: number;
  hooks: FxHooks | null = null;
  /**
   * low = feedback without particles (the phone escape hatch); medium = the
   * full goal celebration; high = the extra confetti bursts on top.
   *
   * F7 built the fireworks and then gated them behind `high` — but the default
   * is `medium` and the only control lives at the bottom of the left panel,
   * which world-mode hides outright. The headline of the goal moment was
   * therefore off for every player who never went looking for a quality
   * switch. The shells cost three `THREE.Points` draw calls and 210 particles
   * for about a second and a half, two or three times a match; the crowd next
   * to them is 369 instanced bodies every frame. That is not what a phone
   * chokes on, so a goal now celebrates at the default and `low` stays the
   * honest way out.
   */
  quality: FxQuality = 'medium';

  constructor(style: StylePreset = stylePreset()) {
    // F7: blending is a STYLE choice, not a constant. Additive particles glow
    // beautifully against the old night diorama and all but vanish against a
    // bright daylight pitch — which is what F0 quietly did to every goal
    // celebration. Daylight arms get solid confetti instead.
    const blending = style.fxBlending === 'additive'
      ? THREE.AdditiveBlending
      : THREE.NormalBlending;
    this.bursts = Array.from({ length: 5 }, () => new Burst(blending));
    this.pyros = Array.from({ length: PYRO_JETS * 2 }, () => new Pyro(blending));
    this.sparkNeutral = style.fxSparkNeutral;
    this.shells = Array.from({ length: 3 }, () => new Firework(blending, style.fxSparkSize));
    // F-Q: bump dust in the pitch's own worn-earth colour — solid by day; at
    // night the additive blending turns the same motes into a faint glow.
    const dustColor = new THREE.Color(style.grass.wearColor).lerp(new THREE.Color(0xffffff), 0.45).getHex();
    this.dusts = Array.from({ length: 4 }, () => new Dust(blending, dustColor));
    for (const d of this.dusts) this.root.add(d.points);
    for (const b of this.bursts) this.root.add(b.points);
    for (const f of this.floaters) this.root.add(f.sprite);
    for (const j of this.pyros) this.root.add(j.sprite);
    for (const sh of this.shells) this.root.add(sh.points);
  }

  /** Re-arm all effects (called when a replay jumps/scrubs or a match attaches). */
  reset(): void {
    this.seen.clear();
  }

  process(state: RenderState, teamColors: [number, number]): void {
    for (const fx of state.fx) {
      const key = `${fx.type}:${fx.t.toFixed(2)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 400) this.seen.clear(); // unbounded-growth guard

      const particles = this.quality !== 'low';
      switch (fx.type) {
        case 'shot': {
          const label = fx.xg !== undefined ? `xG ${fx.xg.toFixed(2)}` : 'shot';
          this.floater().fire(state.ball.x, state.ball.z, label, '#fde047');
          this.hooks?.onShot();
          break;
        }
        case 'save': {
          // Burst at the saving side's keeper.
          const gk = state.players.find((p) => p.side === fx.side && p.role === 'GK');
          if (gk && particles) this.burst().fire(gk.x, 1.4, gk.z, 0x7dd3fc);
          break;
        }
        case 'interception': {
          if (particles) this.burst().fire(state.ball.x, 0.6, state.ball.z, teamColors[fx.side]);
          break;
        }
        case 'corner': {
          this.floater().fire(state.ball.x, state.ball.z, '⚑ corner', '#facc15');
          break;
        }
        case 'goal': {
          if (particles) this.burst().fire(state.ball.x, 1.0, state.ball.z, teamColors[fx.side]);
          if (this.quality === 'high') {
            // Confetti: two extra offset bursts in both kit colors.
            this.burst().fire(state.ball.x - 1.6, 1.6, state.ball.z + 1.2, teamColors[fx.side]);
            this.burst().fire(state.ball.x + 1.6, 1.9, state.ball.z - 1.2, 0xffffff);
          }
          // F7 pyro. Anchored on the GOAL, not the ball: the ball ends up
          // inside the net where the mesh hides it, and the goal line is
          // where the eye already is. Play is stopped, so nothing is masked.
          if (particles) this.firePyro(Math.sign(state.ball.x) || 1);
          // The shells go up whenever particles do — see `quality` above for
          // why this is not the thing that costs a phone its frame rate.
          if (particles) this.fireShells(teamColors, fx.side);
          this.hooks?.onGoal(fx.side);
          break;
        }
      }
      this.hooks?.onEvent?.(fx.type);
    }
  }

  update(dt: number): void {
    for (const b of this.bursts) b.update(dt);
    for (const f of this.floaters) f.update(dt);
    for (const j of this.pyros) j.update(dt);
    for (const sh of this.shells) sh.update(dt);
    for (const d of this.dusts) d.update(dt);
  }

  /**
   * F-Q: two bodies met at speed (render-detected, `contactCues.ts`). Dust at
   * the contact point, scaled by the closing speed. Not gated on `low`: the
   * puff is a dozen points and IS the collision the user could not see.
   */
  bump(x: number, z: number, nx: number, nz: number, closing: number): void {
    this.dusts[this.nextDust++ % this.dusts.length].fire(x, z, nx, nz, closing);
  }

  /**
   * Flame jets at the end the ball just crossed. They stand just INSIDE the
   * goal line, flanking the posts and out by the corners — which is where a
   * real ground puts its pyro, and, less romantically, the only place every
   * camera can actually see them: behind the line they were hidden variously
   * by the net, the adboards and the goal-end crowd. Play is stopped when
   * these fire, so nothing on the pitch is masked.
   */
  private firePyro(endSign: number): void {
    const x = endSign * (HALF_L - 0.8);
    const inner = GOAL_WIDTH / 2 + 2.2;
    const outer = HALF_W - 1.5;
    const zs = [-outer, -inner, inner, outer];
    for (let i = 0; i < PYRO_JETS; i++) this.pyros[i].fire(x, zs[i]);
  }

  /** Three staggered shells over the main stand, in both kits plus white. */
  private fireShells(teamColors: [number, number], side: 0 | 1): void {
    const z = -HALF_W - 12;
    // The middle shell is the NEUTRAL one — white against a night sky, a hot
    // hue by day, because white over a pale grey roof is not a firework.
    const colors = [teamColors[side], this.sparkNeutral, teamColors[side]];
    for (let i = 0; i < this.shells.length; i++) {
      const x = (i - 1) * (HALF_L * 0.55);
      this.shells[i].fire(x, z, 17 + i * 2.5, colors[i], i * 0.32);
    }
  }

  private burst(): Burst {
    return this.bursts[this.nextBurst++ % this.bursts.length];
  }
  private floater(): Floater {
    return this.floaters[this.nextFloater++ % this.floaters.length];
  }
}
