import * as THREE from 'three';
import type {
  ObserverGaze, PerceptionSnapshot, PerceptionTruth,
} from '../ai/perceptionSnapshot';

/**
 * The read-only payload the sandbox draws: the honest truth of a tick, the
 * selected observer's private PerceptionSnapshot of that same tick, and the
 * synthetic awareness it was perceived at. Everything here is a copy — the
 * sandbox never touches sim/ai state, and no AI ever reads this back.
 */
export interface PerceptionView {
  readonly truth: PerceptionTruth;
  readonly snapshot: PerceptionSnapshot;
  readonly awareness: number;
  /** A scheduled visual scan fired on the tick this view was built. */
  readonly scanPulse: boolean;
  /** Hypothetical gaze from chooseAttentionGaze at the carrier (sub-toggle). */
  readonly whatIfGaze: ObserverGaze | null;
}

/** Sim x → world x, sim y → world z (RenderStateAdapter contract). */
const CONE_Y = 0.05;
const RING_Y = 0.06;
const GHOST_Y = 0.14;
const LINE_Y = 0.16;
const BALL_Y = 0.3;
const CONE_SEG = 48;
const MAX_GHOSTS = 24; // 2 teams × squad, comfortable headroom
const MAX_WARNINGS = 12;

/**
 * B2 exception thresholds — taken from `scripts/probes/perception-divergence-census.ts`
 * so the overlay draws only what the data says is signal. At awareness 0.8 the
 * mean ghost error is 0.45m (≈0.7% of pitch length) and ~9 of ~10 ghosts per
 * tick sit essentially on truth: drawing them all is ink without signal.
 */
const ERR_M = 1; // believed vs true position gap worth seeing (8.6% of ghosts)
const STALE_TICKS = 15; // a fact this old is a memory, not an observation
const NEAR_RADIUS = 12; // the census' "a body the player should care about"
/** The rear blind sector is unbounded in reality; drawn only to the near zone. */
const BLIND_RANGE = 14;

/** Awareness-derived vision geometry — mirrors perceptionSnapshot.visible(). */
function coneRange(awareness: number): number {
  return 18 + awareness * 22;
}
function coneHalfAngle(awareness: number): number {
  return Math.acos(Math.max(-1, -0.2 - awareness * 0.5));
}
/** The complement: what the body CANNOT see, centred behind the player. */
function blindHalfAngle(awareness: number): number {
  return Math.PI - coneHalfAngle(awareness);
}
/** Scan/retention cadence — mirrors perceiveSnapshot() for the readout. */
function scanInterval(awareness: number): number {
  return Math.round(15 - awareness * 9);
}
function retention(awareness: number): number {
  return Math.round(15 + awareness * 45);
}

/** One filled facing-cone plus its outline; positions rewritten each frame. */
class Cone {
  readonly mesh: THREE.Mesh;
  readonly outline: THREE.Line;
  private meshPos: THREE.BufferAttribute;
  private outPos: THREE.BufferAttribute;

  constructor(color: number, opacity: number) {
    const geo = new THREE.BufferGeometry();
    this.meshPos = new THREE.BufferAttribute(new Float32Array((CONE_SEG + 2) * 3), 3);
    geo.setAttribute('position', this.meshPos);
    const idx: number[] = [];
    for (let i = 0; i < CONE_SEG; i++) idx.push(0, i + 1, i + 2);
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    const outGeo = new THREE.BufferGeometry();
    // center → rim(0..SEG) → back to center
    this.outPos = new THREE.BufferAttribute(new Float32Array((CONE_SEG + 3) * 3), 3);
    outGeo.setAttribute('position', this.outPos);
    this.outline = new THREE.Line(outGeo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: Math.min(1, opacity + 0.55),
    }));
    this.outline.frustumCulled = false;
    this.outline.visible = false;
  }

  hide(): void {
    this.mesh.visible = false;
    this.outline.visible = false;
  }

  /** Aim from (ox,oz) along the world-plane unit dir (dx,dz). */
  setPose(ox: number, oz: number, dx: number, dz: number, range: number, half: number): void {
    this.meshPos.setXYZ(0, ox, CONE_Y, oz);
    this.outPos.setXYZ(0, ox, CONE_Y, oz);
    for (let i = 0; i <= CONE_SEG; i++) {
      const a = -half + (2 * half * i) / CONE_SEG;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rx = dx * c - dz * s;
      const rz = dx * s + dz * c;
      const px = ox + range * rx;
      const pz = oz + range * rz;
      this.meshPos.setXYZ(i + 1, px, CONE_Y, pz);
      this.outPos.setXYZ(i + 1, px, CONE_Y, pz);
    }
    this.outPos.setXYZ(CONE_SEG + 2, ox, CONE_Y, oz);
    this.meshPos.needsUpdate = true;
    this.outPos.needsUpdate = true;
    this.mesh.visible = true;
    this.outline.visible = true;
  }
}

/**
 * B2 perception sandbox (read-only) — EXCEPTION-BASED. B1 drew the whole world
 * model and the user's first look was clutter: the census says ~90% of ghosts
 * sit within a metre of truth, so drawing them says nothing. This version draws
 * only where belief and truth DIVERGE:
 *
 *   · the ~106° REAR BLIND wedge (what the body cannot see) instead of the
 *     253° cone (what it can — nearly everything);
 *   · ghosts only when the belief error exceeds 1m or the fact is older than
 *     15 ticks, each with its tie line to truth;
 *   · a loud warning marker for a body that is absent from memory yet within
 *     12m — 0.27 per tick, and the real drama;
 *   · the ball only when lost, stale or misplaced;
 *   · a prominent awareness 0.2 ↔ 0.8 toggle, because the contrast is the
 *     legible thing (at 0.2: ~5 missing bodies, 28% of ticks with no ball).
 *
 * Owns its own THREE.Group and a small DOM readout. It never reads or writes
 * Match/players/ball/RNG/brains, and no AI ever consumes what it renders.
 */
export class PerceptionSandbox3D {
  readonly root = new THREE.Group();

  /** Set by the host so the awareness chip can flip the sandbox's UI flag. */
  onToggleAwareness: (() => void) | null = null;

  private blindWedge = new Cone(0xf43f5e, 0.09);
  private gazeCone = new Cone(0xf59e0b, 0.09);
  private nearRing: THREE.Mesh;
  private pulseRing: THREE.Mesh;
  private pulseMat: THREE.MeshBasicMaterial;
  private pulseT = 0;
  private lastTick = -1;
  private time = 0;

  private ghosts: THREE.Mesh[] = [];
  private warnings: THREE.Mesh[] = [];
  private beliefLines: THREE.LineSegments;
  private beliefPos: THREE.BufferAttribute;
  private ballGhost: THREE.Mesh;
  private ballGhostMat: THREE.MeshBasicMaterial;
  private ballLine: THREE.Line;

  private readout: HTMLDivElement;
  private body: HTMLDivElement;
  private chip: HTMLButtonElement;

  constructor(host: HTMLElement) {
    this.root.add(
      this.blindWedge.mesh, this.blindWedge.outline, this.gazeCone.mesh, this.gazeCone.outline,
    );

    // The "should care about" radius the absent-body warning is defined at.
    const nearGeo = new THREE.RingGeometry(NEAR_RADIUS - 0.12, NEAR_RADIUS, 72);
    this.nearRing = new THREE.Mesh(nearGeo, new THREE.MeshBasicMaterial({
      color: 0x38bdf8, transparent: true, opacity: 0.18, side: THREE.DoubleSide,
    }));
    this.nearRing.rotation.x = -Math.PI / 2;
    this.nearRing.position.y = RING_Y;
    this.nearRing.visible = false;
    this.root.add(this.nearRing);

    this.pulseMat = new THREE.MeshBasicMaterial({
      color: 0xbae6fd, transparent: true, opacity: 0, side: THREE.DoubleSide,
    });
    this.pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 40), this.pulseMat);
    this.pulseRing.rotation.x = -Math.PI / 2;
    this.pulseRing.position.y = RING_Y;
    this.pulseRing.visible = false;
    this.root.add(this.pulseRing);

    const ghostGeo = new THREE.RingGeometry(0.42, 0.66, 20);
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
      }));
      g.rotation.x = -Math.PI / 2;
      g.position.y = GHOST_Y;
      g.visible = false;
      this.ghosts.push(g);
      this.root.add(g);
    }

    // Absent-but-near: a loud open ring at the body's TRUE position — the
    // player has no idea it is there.
    const warnGeo = new THREE.RingGeometry(0.95, 1.25, 6);
    for (let i = 0; i < MAX_WARNINGS; i++) {
      const w = new THREE.Mesh(warnGeo, new THREE.MeshBasicMaterial({
        color: 0xf43f5e, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
      }));
      w.rotation.x = -Math.PI / 2;
      w.position.y = GHOST_Y;
      w.visible = false;
      this.warnings.push(w);
      this.root.add(w);
    }

    const lineGeo = new THREE.BufferGeometry();
    this.beliefPos = new THREE.BufferAttribute(new Float32Array(MAX_GHOSTS * 2 * 3), 3);
    lineGeo.setAttribute('position', this.beliefPos);
    this.beliefLines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      color: 0xfbbf24, transparent: true, opacity: 0.8,
    }));
    this.beliefLines.frustumCulled = false;
    this.root.add(this.beliefLines);

    this.ballGhostMat = new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.8 });
    this.ballGhost = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), this.ballGhostMat);
    this.ballGhost.visible = false;
    this.root.add(this.ballGhost);

    const ballLineGeo = new THREE.BufferGeometry();
    ballLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
    this.ballLine = new THREE.Line(ballLineGeo, new THREE.LineBasicMaterial({
      color: 0xfde047, transparent: true, opacity: 0.55,
    }));
    this.ballLine.frustumCulled = false;
    this.ballLine.visible = false;
    this.root.add(this.ballLine);

    this.readout = document.createElement('div');
    this.readout.className = 'perception-readout hidden';
    this.readout.style.cssText = [
      'position:absolute', 'left:12px', 'bottom:12px', 'z-index:6',
      'padding:8px 11px', 'border-radius:8px', 'pointer-events:none',
      'background:rgba(9,14,24,0.72)', 'border:1px solid rgba(56,189,248,0.5)',
      'color:#e2e8f0', 'font:12px/1.5 ui-monospace,Menlo,monospace',
      'letter-spacing:0.02em', 'max-width:300px',
    ].join(';');

    // The awareness contrast is the point of the sandbox, so it gets a real
    // button in the overlay rather than a settings checkbox two screens away.
    this.chip = document.createElement('button');
    this.chip.type = 'button';
    this.chip.style.cssText = [
      'pointer-events:auto', 'cursor:pointer', 'display:block', 'width:100%',
      'margin:6px 0 0', 'padding:5px 8px', 'border-radius:6px',
      'border:1px solid rgba(56,189,248,0.75)', 'background:rgba(56,189,248,0.16)',
      'color:#e0f2fe', 'font:600 12px/1.3 ui-monospace,Menlo,monospace',
      'letter-spacing:0.02em', 'text-align:left',
    ].join(';');
    this.chip.addEventListener('click', () => this.onToggleAwareness?.());

    this.body = document.createElement('div');
    this.readout.append(this.body, this.chip);
    host.appendChild(this.readout);
  }

  /** Remove the DOM readout; scene meshes are freed by the renderer's traverse. */
  dispose(): void {
    this.readout.remove();
  }

  private hideAll(): void {
    this.root.visible = false;
    this.readout.classList.add('hidden');
  }

  update(view: PerceptionView | null, dt: number): void {
    if (!view) {
      this.hideAll();
      this.lastTick = -1;
      this.pulseT = 0;
      return;
    }
    const { truth, snapshot, awareness } = view;
    const observer = truth.players.find((p) => p.gid === snapshot.observerGid);
    if (!observer || observer.sentOff) {
      this.hideAll();
      return;
    }
    this.root.visible = true;
    this.time += dt;
    const ox = observer.pos.x;
    const oz = observer.pos.y;

    // What the body CANNOT see: the rear wedge, bounded to the near zone.
    const bd = observer.bodyDir;
    const blen = Math.hypot(bd.x, bd.y) || 1;
    const bx = bd.x / blen;
    const bz = bd.y / blen;
    this.blindWedge.setPose(ox, oz, -bx, -bz, BLIND_RANGE, blindHalfAngle(awareness));
    this.nearRing.position.set(ox, RING_Y, oz);
    this.nearRing.visible = true;

    // Hypothetical gaze cone (clearly labelled in the readout; never live).
    if (view.whatIfGaze) {
      const g = view.whatIfGaze.gazeDir;
      this.gazeCone.setPose(ox, oz, g.x, g.y, coneRange(awareness), coneHalfAngle(awareness));
    } else {
      this.gazeCone.hide();
    }

    // ---- Exception 1: ghosts that actually diverge (error or staleness) ----
    const ret = retention(awareness);
    const known = new Set<number>();
    const notes: string[] = [];
    let n = 0;
    let matching = 0;
    for (const obs of snapshot.players) {
      known.add(obs.gid);
      if (obs.gid === snapshot.observerGid) continue; // self is exact, no ghost
      const real = truth.players.find((p) => p.gid === obs.gid);
      const err = real ? Math.hypot(obs.pos.x - real.pos.x, obs.pos.y - real.pos.y) : 0;
      const stale = obs.ageTicks > STALE_TICKS;
      if (err <= ERR_M && !stale) {
        matching++; // belief ≈ truth: deliberately not drawn
        continue;
      }
      if (n >= MAX_GHOSTS) continue;
      const g = this.ghosts[n];
      const mat = g.material as THREE.MeshBasicMaterial;
      mat.color.setHex(obs.side === 0 ? 0x60a5fa : 0xf87171);
      mat.opacity = Math.max(0.3, 1 - obs.ageTicks / ret);
      g.position.set(obs.pos.x, GHOST_Y, obs.pos.y);
      g.visible = true;
      this.beliefPos.setXYZ(n * 2, obs.pos.x, LINE_Y, obs.pos.y);
      if (real) this.beliefPos.setXYZ(n * 2 + 1, real.pos.x, LINE_Y, real.pos.y);
      else this.beliefPos.setXYZ(n * 2 + 1, obs.pos.x, LINE_Y, obs.pos.y);
      if (notes.length < 5) {
        notes.push(`#${obs.gid} ${err > ERR_M ? `off ${err.toFixed(1)}m` : 'stale'} ${obs.ageTicks}t`);
      }
      n++;
    }
    for (let i = n; i < MAX_GHOSTS; i++) this.ghosts[i].visible = false;
    this.beliefLines.geometry.setDrawRange(0, n * 2);
    this.beliefPos.needsUpdate = true;
    this.beliefLines.visible = n > 0;

    // ---- Exception 2: bodies absent from memory yet inside the near zone ----
    let w = 0;
    const flash = 0.55 + 0.45 * Math.sin(this.time * 6);
    for (const p of truth.players) {
      if (p.gid === snapshot.observerGid || p.sentOff || known.has(p.gid)) continue;
      const d = Math.hypot(p.pos.x - ox, p.pos.y - oz);
      if (d > NEAR_RADIUS) continue; // far unknowns are normal, not drama
      if (w >= MAX_WARNINGS) break;
      const mk = this.warnings[w];
      (mk.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.5 * flash;
      mk.position.set(p.pos.x, GHOST_Y, p.pos.y);
      mk.rotation.z = this.time * 1.2;
      mk.visible = true;
      w++;
    }
    for (let i = w; i < MAX_WARNINGS; i++) this.warnings[i].visible = false;

    // ---- Exception 3: the ball, only when lost / stale / misplaced ----
    const b = snapshot.ball;
    let ballNote: string;
    if (!b) {
      this.ballGhost.visible = false;
      this.ballLine.visible = false;
      ballNote = '<span style="color:#f43f5e">BALL LOST — no fact in memory</span>';
    } else {
      const err = Math.hypot(b.pos.x - truth.ball.pos.x, b.pos.y - truth.ball.pos.y);
      const stale = b.ageTicks > STALE_TICKS;
      if (err > ERR_M || stale) {
        this.ballGhostMat.opacity = Math.max(0.3, 1 - b.ageTicks / ret);
        this.ballGhost.position.set(b.pos.x, BALL_Y, b.pos.y);
        this.ballGhost.visible = true;
        const bl = this.ballLine.geometry.getAttribute('position') as THREE.BufferAttribute;
        bl.setXYZ(0, b.pos.x, BALL_Y, b.pos.y);
        bl.setXYZ(1, truth.ball.pos.x, BALL_Y, truth.ball.pos.y);
        bl.needsUpdate = true;
        this.ballLine.visible = true;
        ballNote = `<span style="color:#fbbf24">ball ${stale ? 'stale' : 'misplaced'} · off ${err.toFixed(1)}m · ${b.ageTicks}t</span>`;
      } else {
        this.ballGhost.visible = false;
        this.ballLine.visible = false;
        ballNote = `ball ok · ${b.ageTicks}t`;
      }
    }

    // Scan pulse — fire once per new tick that ran a scheduled scan.
    if (snapshot.tick !== this.lastTick) {
      this.lastTick = snapshot.tick;
      if (view.scanPulse) this.pulseT = 1;
    }
    if (this.pulseT > 0) {
      this.pulseT = Math.max(0, this.pulseT - dt * 3);
      const scale = 1 + (1 - this.pulseT) * 5;
      this.pulseRing.position.set(ox, RING_Y, oz);
      this.pulseRing.scale.set(scale, scale, scale);
      this.pulseMat.opacity = this.pulseT * 0.6;
      this.pulseRing.visible = true;
    } else {
      this.pulseRing.visible = false;
    }

    // ---- Readout: only exceptions, plus what was suppressed as agreeing ----
    const blindDeg = Math.round((blindHalfAngle(awareness) * 360) / Math.PI);
    this.body.innerHTML =
      `<b style="color:#38bdf8">Perception sandbox</b> · observer #${snapshot.observerGid}<br>` +
      `scan ~${scanInterval(awareness)}t · memory ${ret}t · ` +
      `<span style="color:#f43f5e">blind ${blindDeg}° rear</span><br>` +
      `<span style="color:#f43f5e">unseen within ${NEAR_RADIUS}m: ${w}</span> · ` +
      `<span style="color:#fbbf24">diverging ghosts: ${n}</span> · agreeing (hidden): ${matching}<br>` +
      ballNote +
      (notes.length ? `<br><span style="color:#94a3b8">${notes.join(' · ')}</span>` : '') +
      (view.whatIfGaze ? '<br><span style="color:#f59e0b">what-if gaze (hypothetical)</span>' : '');
    const low = awareness < 0.5;
    this.chip.textContent = low
      ? `awareness 0.20 (low) — click for 0.80`
      : `awareness 0.80 (high) — click for 0.20`;
    this.chip.style.borderColor = low ? 'rgba(244,63,94,0.75)' : 'rgba(56,189,248,0.75)';
    this.chip.style.background = low ? 'rgba(244,63,94,0.18)' : 'rgba(56,189,248,0.16)';
    this.readout.classList.remove('hidden');
  }
}
