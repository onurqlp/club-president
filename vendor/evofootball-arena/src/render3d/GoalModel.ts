import * as THREE from 'three';
import { GOAL_DEPTH, GOAL_HEIGHT, GOAL_WIDTH, HALF_L } from '../sim/constants';

// The drawn crossbar IS the sim's over-the-bar boundary (Phase 28).
const CROSSBAR_H = GOAL_HEIGHT;
// Chunkier than a real post (0.06 m): at broadcast/gantry distances a thin
// cylinder collapses to a sub-pixel line and the goal loses its 3D frame.
const POST_R = 0.13;

/**
 * A real 3D goal: two posts, crossbar, angled back stanchions and a net made
 * of transparent grid-textured planes (back, top, both sides). The net lives
 * in its own subgroup so it can shake when a goal goes in (visual only).
 */
export class Goal3D {
  readonly group: THREE.Group;
  private net: THREE.Group;
  private back: THREE.Mesh;
  private backBase: Float32Array;
  private readonly dir: 1 | -1;
  private shakeT = -1;
  private bulgeT = -1;
  private bulgeX = 0; // impact point in the back panel's local plane coords
  private bulgeY = 0;

  /**
   * @param dir +1 = goal on the +x end, -1 = goal on the -x end.
   * @param anisotropy renderer max anisotropy — keeps the net mesh readable
   *   at grazing angles and on small (phone) canvases.
   */
  constructor(dir: 1 | -1, anisotropy = 1) {
    const { group, net, back } = buildGoal(dir, anisotropy);
    this.group = group;
    this.net = net;
    this.back = back;
    this.dir = dir;
    const pos = back.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.backBase = Float32Array.from(pos.array as Float32Array);
  }

  /** Ripple the net for ~0.7s. */
  shake(): void {
    this.shakeT = 0;
  }

  /**
   * Punch the back net outward at the ball's impact point (Phase 74) — the
   * iconic goal read. worldZ = across the mouth, worldY = ball height.
   */
  bulge(worldZ: number, worldY: number): void {
    // The panel is rotated y=+90°, so plane local x = -(world z); local y
    // is measured from the panel center at CROSSBAR_H/2.
    const halfW = GOAL_WIDTH / 2;
    this.bulgeX = Math.max(-halfW + 0.2, Math.min(halfW - 0.2, -worldZ));
    this.bulgeY = Math.max(-CROSSBAR_H / 2 + 0.1, Math.min(CROSSBAR_H / 2 - 0.1, worldY - CROSSBAR_H / 2));
    this.bulgeT = 0;
  }

  get isShaking(): boolean {
    return this.shakeT >= 0;
  }

  get isBulging(): boolean {
    return this.bulgeT >= 0;
  }

  update(dt: number): void {
    if (this.bulgeT >= 0) {
      this.bulgeT += dt;
      const DUR = 0.9;
      const pos = this.back.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (this.bulgeT >= DUR) {
        this.bulgeT = -1;
        (pos.array as Float32Array).set(this.backBase);
        pos.needsUpdate = true;
      } else {
        // Instant punch, then a couple of decaying recoil swings; the
        // displacement falls off as a gaussian around the impact point and
        // pushes along the panel normal (local +z = world dir·x = outward).
        const t = this.bulgeT;
        const swing = Math.exp(-t * 4.2) * Math.cos(t * 11) * 0.62;
        for (let i = 0; i < pos.count; i++) {
          const bx = this.backBase[i * 3];
          const by = this.backBase[i * 3 + 1];
          const dx = bx - this.bulgeX;
          const dy = by - this.bulgeY;
          const g = Math.exp(-(dx * dx + dy * dy) / (2 * 1.1 * 1.1));
          pos.setXYZ(i, bx, by, this.backBase[i * 3 + 2] + this.dir * swing * g);
        }
        pos.needsUpdate = true;
      }
    }

    if (this.shakeT < 0) return;
    this.shakeT += dt;
    const DUR = 0.7;
    if (this.shakeT >= DUR) {
      this.shakeT = -1;
      this.net.position.set(0, 0, 0);
      this.net.rotation.z = 0;
      return;
    }
    const decay = 1 - this.shakeT / DUR;
    this.net.position.x = Math.sin(this.shakeT * 46) * 0.16 * decay;
    this.net.position.z = Math.cos(this.shakeT * 38) * 0.1 * decay;
    this.net.rotation.z = Math.sin(this.shakeT * 30) * 0.02 * decay;
  }
}

function buildGoal(
  dir: 1 | -1, anisotropy: number,
): { group: THREE.Group; net: THREE.Group; back: THREE.Mesh } {
  const group = new THREE.Group();
  const net = new THREE.Group();
  group.add(net);
  // A touch of emissive keeps the frame readable against the dark apron the
  // behind-goal cameras look into (failure mode 13's neighborhood).
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc, roughness: 0.22, metalness: 0.25,
    emissive: 0x8b96a8, emissiveIntensity: 0.35,
  });
  const postGeo = new THREE.CylinderGeometry(POST_R, POST_R, CROSSBAR_H, 10);

  const halfW = GOAL_WIDTH / 2;
  const lineX = dir * HALF_L;
  const backX = dir * (HALF_L + GOAL_DEPTH);

  for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, frameMat);
    post.position.set(lineX, CROSSBAR_H / 2, sz * halfW);
    post.castShadow = true;
    group.add(post);

    // Back stanchion: slopes from the crossbar down to the back of the net.
    const len = Math.hypot(GOAL_DEPTH, CROSSBAR_H);
    const stanchion = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 8), frameMat);
    stanchion.position.set((lineX + backX) / 2, CROSSBAR_H / 2, sz * halfW);
    stanchion.rotation.z = -dir * Math.atan2(GOAL_DEPTH, CROSSBAR_H);
    group.add(stanchion);
  }

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, GOAL_WIDTH + POST_R * 2, 10), frameMat);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(lineX, CROSSBAR_H, 0);
  bar.castShadow = true;
  group.add(bar);

  // Net planes with a repeating grid texture. Each panel gets its own
  // texture clone with the repeat derived from ITS dimensions, so the mesh
  // is a square ~0.28 m weave on every face — one shared repeat stretched
  // the roof's cells to 0.24×1.75 m and the goal read as a flat grate from
  // the behind-goal gantry instead of a proper box net.
  const NET_CELL = 0.28;
  const baseTex = netTexture(anisotropy);
  const addNet = (
    w: number, h: number, opacity: number, setup: (m: THREE.Mesh) => void, segsW = 1, segsH = 1,
  ): THREE.Mesh => {
    const tex = baseTex.clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, Math.round(w / NET_CELL)), Math.max(1, Math.round(h / NET_CELL)));
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, segsW, segsH), mat);
    setup(mesh);
    net.add(mesh);
    return mesh;
  };
  // Per-panel opacity: at grazing angles a panel's lines stack up per pixel
  // and it glows; face-on they thin out. The roof is seen at a grazing angle
  // from every elevated camera, so it gets the LOW opacity — otherwise it
  // outshines the box and the whole goal reads as a flat grate.
  // Back wall — subdivided so the goal-impact bulge (Phase 74) can deform it.
  const back = addNet(GOAL_WIDTH, CROSSBAR_H, 0.9, (m) => {
    m.position.set(backX, CROSSBAR_H / 2, 0);
    m.rotation.y = Math.PI / 2;
  }, 18, 9);
  // Roof: lies flat from the crossbar back to the net's top rear edge.
  // PlaneGeometry(depth, width) + rotation.x=-90° maps local x -> world x
  // (goal depth) and local y -> world z (goal width). NOTE Three.js applies
  // euler X last — the previous y-then-x rotation combo stood this panel
  // upright as a 7 m-tall tower above the bar.
  addNet(GOAL_DEPTH, GOAL_WIDTH, 0.42, (m) => {
    m.position.set((lineX + backX) / 2, CROSSBAR_H - 0.02, 0);
    m.rotation.x = -Math.PI / 2;
  });
  // Side walls.
  for (const sz of [-1, 1]) {
    addNet(GOAL_DEPTH, CROSSBAR_H, 0.68, (m) => {
      m.position.set((lineX + backX) / 2, CROSSBAR_H / 2, sz * halfW);
    });
  }

  return { group, net, back };
}

function netTexture(anisotropy: number): THREE.CanvasTexture {
  // 64px cell + 3px lines: the mesh survives mip filtering, so the net still
  // reads as a woven grid on small (phone) canvases and at grazing angles —
  // the old 32px/2px version filtered away to a faint haze when downscaled.
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(244,248,252,0.95)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, S - 4, S - 4);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = anisotropy;
  return tex;
}
