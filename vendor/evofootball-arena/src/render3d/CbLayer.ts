import * as THREE from 'three';
import type { CbVisible } from '../render/cbVisibility';

/**
 * ⭐⭐ CB — THE VISIBILITY LAYER IN 3D (contract §2 M-CB.3, ruling #269.4).
 *
 * Draws the two things the carry-beat arc owes the eye, and nothing else:
 *
 *   1. **THE KNOCK AND THE RACE** — a tapered ribbon along the ball's OWN past positions from
 *      the moment it left the carrier's feet, with a ground ring at the release point. The
 *      ribbon is a ribbon and not a `THREE.Line` for the reason `BallModel` records: WebGL
 *      caps `linewidth` at 1, and a one-pixel hair is invisible on a phone.
 *   2. **THE BEATEN DEFENDER** — a ground ring under a body inside his own recovery interval,
 *      fading in lockstep with HIS clock and coloured by which leg of it is running.
 *
 * ⭐ NOTHING HERE IS TIMED BY THIS FILE. Every duration on screen comes from
 * `CbVisibility`, which reads it off the match; the constants below are colours, radii,
 * widths and heights — appearance only, each declared in the stage doc's presentation table.
 *
 * COST: all geometry is allocated ONCE (one ribbon buffer, one ring, a pool of rings sized to
 * the pitch). A frame writes positions and opacities into buffers it already owns; nothing is
 * created, and with the entry off `update` is never called with a state at all.
 */

/* ---------------- presentation constants (stage doc §PRESENTATION) ---------------- */

/** Height above the grass — over `Overlays3D`'s 0.08 so the two never z-fight. */
const Y = 0.09;
/** The knock's ribbon and its release ring: amber, the "the ball is loose and it is a race" cue. */
const KNOCK_COLOR = 0xfacc15;
/** A body still being carried past by his own momentum (his brake leg is running). */
const CARRY_THROUGH_COLOR = 0xfb923c;
/** A body turning and closing — the rest of his recovery. */
const BEATEN_COLOR = 0xef4444;
/** Ribbon half-width, metres. */
const TRAIL_HALF_W = 0.13;
/** Peak ribbon opacity (at the head of the trail). */
const TRAIL_OPACITY = 0.6;
/** The release ring's inner/outer radius, metres. */
const ORIGIN_R0 = 0.38;
const ORIGIN_R1 = 0.62;
/** The beaten ring's inner/outer radius, metres. */
const RING_R0 = 0.85;
const RING_R1 = 1.1;
/** Peak beaten-ring opacity (at the instant of the miss). */
const RING_OPACITY = 0.85;
/** How many bodies can carry a ring at once — the whole pitch, so nothing is ever dropped. */
const RING_POOL = 12;
/** Ribbon capacity in samples; matches `CB_TRAIL_MAX_POINTS`. */
const TRAIL_N = 96;

export class CbLayer {
  readonly root = new THREE.Group();

  private ribbon: THREE.Mesh;
  private ribbonPos: THREE.BufferAttribute;
  private ribbonMat: THREE.MeshBasicMaterial;
  private origin: THREE.Mesh;
  private originMat: THREE.MeshBasicMaterial;
  private rings: THREE.Mesh[] = [];
  private ringMats: THREE.MeshBasicMaterial[] = [];

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.ribbonPos = new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3);
    geo.setAttribute('position', this.ribbonPos);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.ribbonMat = new THREE.MeshBasicMaterial({
      color: KNOCK_COLOR, transparent: true, opacity: TRAIL_OPACITY,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.ribbon = new THREE.Mesh(geo, this.ribbonMat);
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 7;
    this.ribbon.visible = false;

    this.originMat = new THREE.MeshBasicMaterial({
      color: KNOCK_COLOR, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.origin = new THREE.Mesh(new THREE.RingGeometry(ORIGIN_R0, ORIGIN_R1, 24), this.originMat);
    this.origin.rotation.x = -Math.PI / 2;
    this.origin.position.y = Y;
    this.origin.visible = false;

    const ringGeo = new THREE.RingGeometry(RING_R0, RING_R1, 28);
    for (let i = 0; i < RING_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: BEATEN_COLOR, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = Y;
      ring.visible = false;
      this.ringMats.push(mat);
      this.rings.push(ring);
      this.root.add(ring);
    }

    this.root.add(this.ribbon, this.origin);
  }

  /** Everything off — an unarmed match, a replay without the feed, or a detached view. */
  clear(): void {
    this.ribbon.visible = false;
    this.origin.visible = false;
    for (const r of this.rings) r.visible = false;
  }

  update(vis: CbVisible | null): void {
    if (vis === null) {
      this.clear();
      return;
    }
    this.updateKnock(vis);
    this.updateRings(vis);
  }

  private updateKnock(vis: CbVisible): void {
    const k = vis.knock;
    if (k === null || k.points < 2) {
      this.ribbon.visible = false;
      this.origin.visible = k !== null;
      if (k !== null) {
        this.origin.position.set(k.x0, Y, k.z0);
        this.originMat.opacity = RING_OPACITY * k.alpha;
      }
      return;
    }
    // The release ring sits on the ball's own first recorded position of this knock.
    this.origin.position.set(k.x0, Y, k.z0);
    this.originMat.opacity = RING_OPACITY * k.alpha;
    this.origin.visible = true;

    // Two verts per real sample, offset perpendicular to the direction the ball was actually
    // travelling between consecutive samples, widening toward the head. Every centre point is
    // a position the ball held; the offset is the ribbon's thickness and nothing more.
    const n = Math.min(k.points, TRAIL_N);
    const first = k.points - n;
    for (let i = 0; i < n; i++) {
      const j = (first + i) * 2;
      const x = k.path[j];
      const z = k.path[j + 1];
      const jn = (first + Math.min(i + 1, n - 1)) * 2;
      const jp = (first + Math.max(i - 1, 0)) * 2;
      let dx = k.path[jn] - k.path[jp];
      let dz = k.path[jn + 1] - k.path[jp + 1];
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      const w = TRAIL_HALF_W * (0.35 + 0.65 * (i / Math.max(1, n - 1)));
      this.ribbonPos.setXYZ(i * 2, x - dz * w, Y, z + dx * w);
      this.ribbonPos.setXYZ(i * 2 + 1, x + dz * w, Y, z - dx * w);
    }
    this.ribbon.geometry.setDrawRange(0, (n - 1) * 6);
    this.ribbonPos.needsUpdate = true;
    this.ribbonMat.opacity = TRAIL_OPACITY * k.alpha;
    this.ribbon.visible = true;
  }

  private updateRings(vis: CbVisible): void {
    const n = Math.min(vis.beatenCount, RING_POOL);
    for (let i = 0; i < n; i++) {
      const m = vis.beaten[i];
      const ring = this.rings[i];
      ring.position.set(m.x, Y, m.z);
      ring.visible = true;
      // ⭐ THE FADE IS HIS OWN CLOCK: `frac` is what is left of the interval the engine wrote
      // at the miss. Full at the miss, gone the tick he can challenge again.
      this.ringMats[i].opacity = RING_OPACITY * m.frac;
      this.ringMats[i].color.setHex(m.carryThrough ? CARRY_THROUGH_COLOR : BEATEN_COLOR);
    }
    for (let i = n; i < RING_POOL; i++) this.rings[i].visible = false;
  }
}
// No `dispose()`: the layer's root lives in the scene, and `ThreeMatchRenderer.dispose`
// already walks the scene disposing every geometry and material it finds — a second owner
// would be a second thing to keep in step.
