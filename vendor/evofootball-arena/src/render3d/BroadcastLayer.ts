import * as THREE from 'three';
import { HALF_W } from '../sim/constants';
import type { RenderState, RenderTheme } from './RenderStateAdapter';

/**
 * The ANALYST layer (Phase 68 → redesigned in 72 after the user's read on
 * real tactical feeds): tactical graphics live ONLY in the tacfeed camera,
 * and each element appears only while the thing it describes is actually
 * HAPPENING — the real-broadcast lesson that annotation answers a question
 * at a moment, while an always-on overlay is wallpaper.
 *
 *   defensive LINES (base) — one line per team through its second-deepest
 *     outfielder: line height IS the tactical identity (high line vs bus),
 *     and it's the object every fan already knows.
 *   block HULL — only while the defending side's block is SET (Defend or
 *     Press mode): the polygon means "the block has formed".
 *   press CONVERGENCE — lines from the assigned chasers to the ball, only
 *     while their side hunts in Press mode: the pack is ON (replaces the
 *     old water-ripple rings nobody could read).
 *   offside FLASH — the defending line brightens amber while a pass is in
 *     flight TOWARD it from beyond: the moment the line matters.
 *
 * Everything pre-allocated; per-frame work is position writes. Old replays
 * carry no possession/modes/press fields — the layer simply stays dark.
 */

const Y = 0.05; // under the debug overlays (0.08), over the grass

export class BroadcastLayer {
  readonly root = new THREE.Group();
  private readonly defLines: [THREE.Line, THREE.Line];
  private readonly defLineMats: [THREE.LineBasicMaterial, THREE.LineBasicMaterial];
  private readonly fill: THREE.Mesh;
  private readonly fillPos: THREE.BufferAttribute;
  private readonly fillMat: THREE.MeshBasicMaterial;
  private readonly edge: THREE.LineLoop;
  private readonly edgePos: THREE.BufferAttribute;
  private readonly edgeMat: THREE.LineBasicMaterial;
  private readonly press: THREE.LineSegments;
  private readonly pressPos: THREE.BufferAttribute;
  private readonly pressMat: THREE.LineBasicMaterial;
  private teamColors: [number, number] = [0x60a5fa, 0xf59e0b];
  /** Debug/tests: which elements drew this frame. */
  linesVisible = false;
  blockVisible = false;
  pressVisible = false;
  offsideFlash = false;

  constructor() {
    const mkLine = (): [THREE.Line, THREE.LineBasicMaterial] => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      return [line, mat];
    };
    const [l0, m0] = mkLine();
    const [l1, m1] = mkLine();
    this.defLines = [l0, l1];
    this.defLineMats = [m0, m1];

    const fillGeo = new THREE.BufferGeometry();
    this.fillPos = new THREE.BufferAttribute(new Float32Array(5 * 3 * 3), 3);
    fillGeo.setAttribute('position', this.fillPos);
    this.fillMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide,
    });
    this.fill = new THREE.Mesh(fillGeo, this.fillMat);
    this.fill.frustumCulled = false;
    this.fill.visible = false;

    const edgeGeo = new THREE.BufferGeometry();
    this.edgePos = new THREE.BufferAttribute(new Float32Array(5 * 3), 3);
    edgeGeo.setAttribute('position', this.edgePos);
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
    this.edge = new THREE.LineLoop(edgeGeo, this.edgeMat);
    this.edge.frustumCulled = false;
    this.edge.visible = false;

    const pressGeo = new THREE.BufferGeometry();
    this.pressPos = new THREE.BufferAttribute(new Float32Array(4 * 2 * 3), 3);
    pressGeo.setAttribute('position', this.pressPos);
    this.pressMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    this.press = new THREE.LineSegments(pressGeo, this.pressMat);
    this.press.frustumCulled = false;
    this.press.visible = false;

    this.root.add(l0, l1, this.fill, this.edge, this.press);
  }

  applyTheme(theme: RenderTheme): void {
    this.teamColors = [theme.teams[0].primary, theme.teams[1].primary];
  }

  update(state: RenderState | null, active: boolean): void {
    const playing = state !== null && active && !state.shootout &&
      state.phase !== 'halftime' && state.phase !== 'fulltime';
    this.linesVisible = false;
    this.blockVisible = false;
    this.pressVisible = false;
    this.offsideFlash = false;
    if (!playing) {
      this.defLines[0].visible = false;
      this.defLines[1].visible = false;
      this.fill.visible = false;
      this.edge.visible = false;
      this.press.visible = false;
      return;
    }

    // ---- defensive lines (base): x of each side's second-deepest outfielder
    // toward its OWN goal. Team 0 defends −x, team 1 defends +x.
    const lineX: [number, number] = [0, 0];
    for (const side of [0, 1] as const) {
      const xs: number[] = [];
      for (const p of state.players) {
        if (p.side === side && p.role !== 'GK') xs.push(p.x);
      }
      xs.sort((a, b) => (side === 0 ? a - b : b - a));
      lineX[side] = xs[1] ?? 0;
      const attr = this.defLines[side].geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, lineX[side], Y, -HALF_W + 1);
      attr.setXYZ(1, lineX[side], Y, HALF_W - 1);
      attr.needsUpdate = true;
      this.defLineMats[side].color.setHex(this.teamColors[side]);
      this.defLineMats[side].opacity = 0.4;
      this.defLines[side].visible = true;
    }
    this.linesVisible = true;

    const possession = state.possession ?? -1;

    // ---- offside flash: a pass in flight toward a line with the ball
    // still in front of it — the moment the line MATTERS. The defending
    // side's line brightens amber.
    if (state.ball.isPass && possession !== -1) {
      const def = (1 - possession) as 0 | 1;
      const toward = def === 0 ? state.ball.vx < -2 : state.ball.vx > 2;
      const ballInFront = def === 0 ? state.ball.x > lineX[def] : state.ball.x < lineX[def];
      if (toward && ballInFront) {
        this.defLineMats[def].color.setHex(0xfbbf24);
        this.defLineMats[def].opacity = 0.85;
        this.offsideFlash = true;
      }
    }

    // ---- the SET block hull: only while the defending side is organised
    // (Defend/Press mode) — the polygon means "the block has formed".
    let hullOn = false;
    if (possession !== -1 && state.modes) {
      const def = (1 - possession) as 0 | 1;
      const mode = state.modes[def];
      if (mode === 'Defend' || mode === 'Press') {
        const pts: Array<{ x: number; z: number }> = [];
        for (const p of state.players) {
          if (p.side === def && p.role !== 'GK') pts.push({ x: p.x, z: p.z });
        }
        const hull = convexHull(pts);
        if (hull.length >= 3) {
          let cx = 0;
          let cz = 0;
          for (const h of hull) {
            cx += h.x;
            cz += h.z;
          }
          cx /= hull.length;
          cz /= hull.length;
          for (let i = 0; i < hull.length; i++) {
            const a = hull[i];
            const b = hull[(i + 1) % hull.length];
            this.fillPos.setXYZ(i * 3, cx, Y, cz);
            this.fillPos.setXYZ(i * 3 + 1, a.x, Y, a.z);
            this.fillPos.setXYZ(i * 3 + 2, b.x, Y, b.z);
            this.edgePos.setXYZ(i, a.x, Y + 0.005, a.z);
          }
          this.fill.geometry.setDrawRange(0, hull.length * 3);
          this.edge.geometry.setDrawRange(0, hull.length);
          this.fillPos.needsUpdate = true;
          this.edgePos.needsUpdate = true;
          this.fillMat.color.setHex(this.teamColors[def]);
          this.edgeMat.color.setHex(this.teamColors[def]);
          hullOn = true;
        }
      }
    }
    this.fill.visible = hullOn;
    this.edge.visible = hullOn;
    this.blockVisible = hullOn;

    // ---- press convergence: chaser → ball, only while the hunt is ON.
    let segs = 0;
    if (possession !== -1 && state.modes && state.press) {
      const def = (1 - possession) as 0 | 1;
      if (state.modes[def] === 'Press') {
        for (const c of state.press) {
          if (c.side !== def || segs >= 4) continue;
          this.pressPos.setXYZ(segs * 2, c.x, Y + 0.01, c.z);
          this.pressPos.setXYZ(segs * 2 + 1, state.ball.x, Y + 0.01, state.ball.z);
          segs++;
        }
        if (segs > 0) this.pressMat.color.setHex(this.teamColors[def]);
      }
    }
    this.press.geometry.setDrawRange(0, segs * 2);
    this.pressPos.needsUpdate = true;
    this.press.visible = segs > 0;
    this.pressVisible = segs > 0;
  }
}

/** Gift-wrap convex hull for ≤5 points — tiny inputs. Winding order. */
function convexHull(pts: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  if (pts.length < 3) return pts.slice();
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x < pts[start].x || (pts[i].x === pts[start].x && pts[i].z < pts[start].z)) start = i;
  }
  const hull: Array<{ x: number; z: number }> = [];
  let cur = start;
  do {
    hull.push(pts[cur]);
    let next = (cur + 1) % pts.length;
    for (let i = 0; i < pts.length; i++) {
      if (i === cur) continue;
      const cross =
        (pts[next].x - pts[cur].x) * (pts[i].z - pts[cur].z) -
        (pts[next].z - pts[cur].z) * (pts[i].x - pts[cur].x);
      if (cross < 0) next = i;
    }
    cur = next;
  } while (cur !== start && hull.length <= pts.length);
  return hull;
}
