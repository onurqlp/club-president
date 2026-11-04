import * as THREE from 'three';
import {
  BOX_DEPTH, BOX_WIDTH, CENTER_CIRCLE_R, FIELD_SCALE, GOAL_WIDTH, HALF_L, HALF_W,
} from '../sim/constants';
import { RENDER_QUALITY, type RenderQualitySpec } from './renderQuality';
import { stylePreset, type StylePreset } from './stylePresets';

/**
 * The playing surface: one plane with a procedurally painted canvas texture —
 * mowing stripes and every line in a single draw call. Corner flags are real
 * geometry. (Goals live in GoalModel; they must be 3D.)
 *
 * Palette, turf grain, wear and paint softness all come from the F0 style
 * preset; the default preset repaints today's surface exactly.
 *
 * F-Q (2026-09-15): the paint resolution and the blade-scale relief come from
 * the render-quality ladder, and both can be re-applied at runtime when the
 * user flips Low / Med / High — hence the handle instead of a bare group.
 */
export interface Pitch {
  group: THREE.Group;
  /** Repaint at another quality: pitch resolution + turf relief on/off. */
  setQuality(spec: RenderQualitySpec): void;
  /** Turf relief currently applied (tooling). */
  readonly hasBump: boolean;
}

/** Grass margin outside the touchlines (m). */
const APRON = 5;
/** One turf-relief tile covers this many metres; 256 px per tile ≈ 6 mm per texel. */
const TURF_TILE_M = 1.5;

export function createPitch(
  maxAnisotropy: number, style: StylePreset = stylePreset(), quality: RenderQualitySpec = RENDER_QUALITY.medium,
): Pitch {
  const group = new THREE.Group();

  const apron = APRON;
  const w = (HALF_L + apron) * 2;
  const h = (HALF_W + apron) * 2;
  const aniso = Math.min(8, maxAnisotropy);

  const groundMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, h), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  let paintedPx = -1;
  const setQuality = (spec: RenderQualitySpec): void => {
    if (spec.pitchPx !== paintedPx) {
      paintedPx = spec.pitchPx;
      groundMat.map?.dispose();
      const texture = paintPitchTexture(apron, style, spec.pitchPx);
      texture.anisotropy = aniso;
      texture.colorSpace = THREE.SRGBColorSpace;
      groundMat.map = texture;
    }
    const wantBump = spec.turfDetail && style.turfBump > 0;
    if (wantBump && !groundMat.bumpMap) {
      const bump = turfDetailTexture();
      bump.anisotropy = aniso;
      bump.wrapS = THREE.RepeatWrapping;
      bump.wrapT = THREE.RepeatWrapping;
      bump.repeat.set(w / TURF_TILE_M, h / TURF_TILE_M);
      groundMat.bumpMap = bump;
      groundMat.bumpScale = style.turfBump;
    } else if (!wantBump && groundMat.bumpMap) {
      groundMat.bumpMap.dispose();
      groundMat.bumpMap = null;
    }
    groundMat.needsUpdate = true;
  };
  setQuality(quality);

  // Adboards: low procedural boards along the far side and behind the goals —
  // grounds the diorama without heavy assets. Widths + positions scale with
  // FIELD_SCALE (2026-07-20 density相变): the fixed 24m board at ±30 spilled
  // past the shrunk pitch/stands (the green top-stripe "beams" poking out).
  const s = FIELD_SCALE;
  const boardGeo = new THREE.BoxGeometry(24 * s, 0.9, 0.25);
  const boardMats = style.boards.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }),
  );
  const boards: Array<{ x: number; z: number; rot: number }> = [
    { x: -30 * s, z: -HALF_W - 3.4 * s, rot: 0 },
    { x: 0, z: -HALF_W - 3.4 * s, rot: 0 },
    { x: 30 * s, z: -HALF_W - 3.4 * s, rot: 0 },
    { x: -HALF_L - 3.6 * s, z: -18 * s, rot: Math.PI / 2 },
    { x: -HALF_L - 3.6 * s, z: 18 * s, rot: Math.PI / 2 },
    { x: HALF_L + 3.6 * s, z: -18 * s, rot: Math.PI / 2 },
    { x: HALF_L + 3.6 * s, z: 18 * s, rot: Math.PI / 2 },
  ];
  boards.forEach((b, i) => {
    const mesh = new THREE.Mesh(boardGeo, boardMats[i % boardMats.length]);
    mesh.position.set(b.x, 0.45, b.z);
    mesh.rotation.y = b.rot;
    mesh.castShadow = true;
    group.add(mesh);
    // Accent stripe along the top edge.
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(24 * s, 0.08, 0.27),
      new THREE.MeshStandardMaterial({ color: style.boardStripe, roughness: 0.6 }),
    );
    stripe.position.set(b.x, 0.92, b.z);
    stripe.rotation.y = b.rot;
    group.add(stripe);
  });

  // Corner flags — taller and brighter so restarts read from tactical range.
  const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.0, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.6 });
  const flagGeo = new THREE.ConeGeometry(0.32, 0.55, 4);
  const flagMat = new THREE.MeshStandardMaterial({
    color: 0xfacc15, emissive: 0x4a3b02, roughness: 0.6,
  });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(sx * HALF_L, 1.0, sz * HALF_W);
      pole.castShadow = true;
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.rotation.z = Math.PI / 2;
      flag.position.set(sx * HALF_L - sx * 0.27, 1.78, sz * HALF_W);
      group.add(pole, flag);
    }
  }

  addTerraces(group, style);
  addRoof(group, style);
  // A lit floodlight at noon is exactly the incoherence Track F exists to kill.
  if (style.floodlights) addFloodlights(group);

  return { group, setQuality, get hasBump() { return groundMat.bumpMap !== null; } };
}

/**
 * F-Q: blade-scale turf relief, one 256 px tile repeated every `TURF_TILE_M`
 * metres as a bump map. Mid-grey base, then thousands of short strokes in
 * random directions at slightly lighter/darker greys: under the key light
 * the grass gets a fine, directionless nap that mips to nothing at tactical
 * range and reads as TURF underfoot in the follow camera — which is where
 * the 16 px/m paint used to fall apart. Deterministic (LCG), a few ms once.
 */
function turfDetailTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, S, S);
  let lcg = 987654321;
  const rand = () => ((lcg = (lcg * 48271) % 2147483647) / 2147483647);
  ctx.lineCap = 'round';
  for (let i = 0; i < 2600; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const len = 3 + rand() * 7;
    const a = rand() * Math.PI * 2;
    const tone = 128 + (rand() - 0.5) * 110;
    ctx.strokeStyle = `rgb(${tone},${tone},${tone})`;
    ctx.lineWidth = 1 + rand() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
    // Wrap the stroke so the tile has no seam: repeat it shifted by ±S on
    // whichever edges it crosses.
    for (const [ox, oy] of [[-S, 0], [S, 0], [0, -S], [0, S]] as const) {
      if ((ox < 0 && x < 12) || (ox > 0 && x > S - 12) || (oy < 0 && y < 12) || (oy > 0 && y > S - 12)) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
        ctx.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** One terrace step: `y` is the seat level ON TOP of the slab (the slab
 * mesh centers itself 0.55 below). Shared by the slab geometry here and
 * the animated CrowdSystem (Phase 66.1) so the crowd always sits exactly
 * on its steps. */
export interface TerraceSlab {
  w: number;
  x: number;
  y: number;
  z: number;
  rot: number;
}

/**
 * The terrace step layout — F6 closes the BOWL so day and night both read as
 * "inside a ground" instead of a pitch floating in a void. Pure data, shared
 * with `CrowdSystem` so every new step gets seated automatically.
 *
 * Every height here is bounded by a CAMERA, not by taste. The cameras look
 * from the +z side and from behind the goals, and Phase 28.3 already burned
 * this once — three-step goal-end stands put the behindGoal camera INSIDE the
 * geometry and the whole goalmouth vanished behind a black slab. So:
 *
 * - FAR (−z) side: nothing looks from there, so it carries the height (5 rows
 *   plus a roof). This is what fills the sky in broadcast and follow.
 * - Corners: filled, because the gap between the far stand and the goal ends
 *   was the void you could see straight through at frame edges.
 * - GOAL ends: still ONE low bank. behindGoal sits at ±43.5 m, only 5 m up,
 *   and its sight line to the goalmouth is already down to ~3.9 m by x = 40.
 * - NEAR (+z) side: one bank, and pushed to HALF_W + 6 rather than the usual
 *   1.8 m apron. The binding case is follow-cam on near-touchline play, where
 *   the sight line is just 2.8 m up at z = 23.7 — a bank there would block it.
 *   At z = 26.3 the same line has climbed to 4.6 m and clears with room.
 *
 * `terraceClearsCameras` in the render3d test pins all of that.
 */
export function terraceSlabs(): TerraceSlab[] {
  const out: TerraceSlab[] = [];
  const mk = (w: number, x: number, z: number, rot: number, steps: number) => {
    for (let step = 0; step < steps; step++) {
      // Rows RECEDE as they rise (user report "观众应该阶梯向上"): the
      // offset marches AWAY from the pitch with height — the first cut
      // marched it toward the pitch, an inside-out grandstand whose back
      // row was the lowest. The anchor is the FRONT row, at the boards.
      const off = 1.6 + step * 2.4;
      out.push({
        w,
        x: x - Math.sin(rot) * off,
        y: 1.1 + step * 1.1,
        z: z - Math.cos(rot) * off,
        rot,
      });
    }
  };
  mk(HALF_L * 2 + 6, 0, -HALF_W - 1.8, 0, FAR_ROWS); // main stand, carries the height
  // Corners: the void used to show straight through here at frame edges.
  //
  // A 45° section reaches w/2 · √½ toward the pitch along BOTH axes, so its
  // centre has to stand at least that far out or its inner tip lands on the
  // playing surface. Two cuts got this wrong before the camera test caught
  // it — the second one still poked to (27, −16), inside the pitch, and
  // blocked the follow camera whenever play went into that corner.
  const inset = (CORNER_W / 2) * Math.SQRT1_2;
  const cx = HALF_L + inset + 0.9;
  const cz = HALF_W + inset + 0.9;
  mk(CORNER_W, cx, -cz, -Math.PI / 4, 3);
  mk(CORNER_W, -cx, -cz, Math.PI / 4, 3);
  // Behind each goal: ONE low bank only (Phase 28.3) — see the note above.
  // Held at +4.0 rather than +2.2: at 2.2 the behindGoal sight line to the
  // goalmouth grazed the top of the crowd's heads at 2.15 m, so the bottom of
  // every goal shot had spectators poking into it. Pre-existing; the camera
  // test found it. It sits behind the adboards either way.
  mk(HALF_W * 2 - 4, -HALF_L - 4.0, 0, Math.PI / 2, 1);
  mk(HALF_W * 2 - 4, HALF_L + 4.0, 0, -Math.PI / 2, 1);
  // Near touchline: one bank, held back to clear the follow camera.
  mk(HALF_L * 2 + 6, 0, HALF_W + NEAR_STAND_GAP, Math.PI, 1);
  return out;
}

/** Width of each 45° corner section (m). */
export const CORNER_W = 13;
/** Rows in the main stand. The far side is the only one nothing looks from. */
export const FAR_ROWS = 5;
/** How far the near bank sits back from the touchline (m) — camera-bound. */
export const NEAR_STAND_GAP = 6;
/** Underside of the main stand's roof (m). Above every sight line. */
export const ROOF_Y = 8.2;

/**
 * Low-poly terrace silhouettes on the shared slab layout. The SEATED crowd
 * itself moved to `CrowdSystem` (Phase 66.1, user ask "观众席也得有动作"):
 * it animates per frame, so it belongs to the renderer's update loop, not
 * the static pitch group.
 */
function addTerraces(group: THREE.Group, style: StylePreset): void {
  const mat = new THREE.MeshStandardMaterial({ color: style.terrace[0], roughness: 0.95 });
  const seatMat = new THREE.MeshStandardMaterial({ color: style.terrace[1], roughness: 0.9 });
  terraceSlabs().forEach((s, i) => {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(s.w, 1.1, 2.4), i % 2 === 0 ? mat : seatMat);
    slab.position.set(s.x, s.y - 0.55, s.z);
    slab.rotation.y = s.rot;
    slab.receiveShadow = true;
    group.add(slab);
  });
}

/**
 * A canopy over the main stand plus a back wall behind its top row (F6). This
 * is the single thing that turns "a pitch with some seats" into "a ground":
 * from the broadcast and follow cameras the roof line cuts the sky, so there
 * is a ceiling to the world instead of open blue above the crowd.
 *
 * It sits at ROOF_Y, which is above every camera's sight line into the pitch —
 * and no camera lives on the −z side at all, so it can never occlude play.
 */
function addRoof(group: THREE.Group, style: StylePreset): void {
  const backRow = 1.6 + (FAR_ROWS - 1) * 2.4;
  const zFront = -HALF_W - 1.8;
  const zBack = zFront - backRow - 1.6;
  const w = HALF_L * 2 + 8;

  const roofMat = new THREE.MeshStandardMaterial({ color: style.terrace[0], roughness: 0.9 });
  const depth = Math.abs(zBack - zFront) + 3;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, depth), roofMat);
  canopy.position.set(0, ROOF_Y, (zFront + zBack) / 2 - 0.6);
  canopy.castShadow = true;
  group.add(canopy);

  // Fascia: a bright band on the roof's pitch-facing edge, so the ceiling
  // reads as a built edge rather than a floating slab.
  const fascia = new THREE.Mesh(
    new THREE.BoxGeometry(w, 0.7, 0.3),
    new THREE.MeshStandardMaterial({ color: style.boardStripe, roughness: 0.6 }),
  );
  fascia.position.set(0, ROOF_Y - 0.35, (zFront + zBack) / 2 + depth / 2 - 0.75);
  group.add(fascia);

  // Back wall, closing the gap between the top row and the roof.
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(w, ROOF_Y - 1.4, 0.4),
    new THREE.MeshStandardMaterial({ color: style.terrace[1], roughness: 0.95 }),
  );
  wall.position.set(0, (ROOF_Y - 1.4) / 2 + 1.4, zBack - 1.2);
  group.add(wall);

  // Two pillars so the canopy has visible support at the frame edges.
  const pillarMat = new THREE.MeshStandardMaterial({ color: style.terrace[1], roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, ROOF_Y, 0.5), pillarMat);
    pillar.position.set(sx * (w / 2 - 0.6), ROOF_Y / 2, zFront + 0.4);
    group.add(pillar);
  }
}

/** Four corner floodlight towers with softly glowing heads. */
function addFloodlights(group: THREE.Group): void {
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.8 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xf5f7fa, emissive: 0xbdd4ff, emissiveIntensity: 0.9, roughness: 0.4,
  });
  const mastGeo = new THREE.CylinderGeometry(0.22, 0.34, 17, 6);
  const headGeo = new THREE.BoxGeometry(3.4, 1.5, 0.5);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (HALF_L + 8);
      const z = sz * (HALF_W + 7);
      const mast = new THREE.Mesh(mastGeo, mastMat);
      mast.position.set(x, 8.5, z);
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.set(x, 17.4, z);
      head.lookAt(0, 0, 0);
      group.add(mast, head);
    }
  }
}

/**
 * Worn turf, painted as soft blotches over the mowing. The zones are where a
 * real pitch actually goes bare: both goalmouths, the centre circle, and the
 * two wing channels. `strength` scales blotch count and opacity together.
 */
function paintWear(
  ctx: CanvasRenderingContext2D,
  strength: number,
  color: string,
  rand: () => number,
  X: (x: number) => number,
  Z: (z: number) => number,
  PX: number,
): void {
  const zones: Array<{ x: number; z: number; rx: number; rz: number; w: number }> = [
    { x: -HALF_L + BOX_DEPTH * 0.35, z: 0, rx: BOX_DEPTH * 0.5, rz: GOAL_WIDTH * 1.1, w: 1 },
    { x: HALF_L - BOX_DEPTH * 0.35, z: 0, rx: BOX_DEPTH * 0.5, rz: GOAL_WIDTH * 1.1, w: 1 },
    { x: 0, z: 0, rx: CENTER_CIRCLE_R * 1.1, rz: CENTER_CIRCLE_R * 0.9, w: 0.65 },
    { x: 0, z: -HALF_W * 0.78, rx: HALF_L * 0.62, rz: HALF_W * 0.16, w: 0.5 },
    { x: 0, z: HALF_W * 0.78, rx: HALF_L * 0.62, rz: HALF_W * 0.16, w: 0.5 },
  ];
  const rgb = [
    parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16),
  ];
  for (const zone of zones) {
    const blotches = Math.round(90 * strength * zone.w);
    for (let i = 0; i < blotches; i++) {
      // Bias toward the zone centre so edges fade instead of ending hard.
      const t = rand() ** 0.7;
      const a = rand() * Math.PI * 2;
      const px = X(zone.x + Math.cos(a) * zone.rx * t);
      const pz = Z(zone.z + Math.sin(a) * zone.rz * t);
      const r = (0.4 + rand() * 1.5) * PX;
      const alpha = 0.17 * strength * zone.w * (1 - t * 0.75);
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(px, pz, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * `PX` = pixels per metre. Shipped at 16 for months; F-Q raised the default to
 * 40 (see `renderQuality.ts`) — in the follow camera the screen shows 50–75
 * px per metre of grass, so at 16 every mark was magnified into a blur.
 */
function paintPitchTexture(apron: number, style: StylePreset, PX = 16): THREE.CanvasTexture {
  const g = style.grass;
  const cw = Math.round((HALF_L + apron) * 2 * PX);
  const ch = Math.round((HALF_W + apron) * 2 * PX);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;

  const X = (x: number) => (x + HALF_L + apron) * PX;
  const Z = (z: number) => (z + HALF_W + apron) * PX;

  // Grass base: darker apron, then dual-direction mowing inside the lines —
  // broad lengthwise stripes with a faint crosshatch for a groomed look.
  ctx.fillStyle = g.base;
  ctx.fillRect(0, 0, cw, ch);
  const stripeW = (HALF_L * 2 * PX) / g.stripes;
  for (let i = 0; i < g.stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? g.stripeA : g.stripeB;
    ctx.fillRect(X(-HALF_L) + i * stripeW, Z(-HALF_W), stripeW, HALF_W * 2 * PX);
  }
  const cross = 8;
  const crossH = (HALF_W * 2 * PX) / cross;
  ctx.fillStyle = `rgba(255,255,255,${g.crossAlpha})`;
  for (let i = 0; i < cross; i += 2) {
    ctx.fillRect(X(-HALF_L), Z(-HALF_W) + i * crossH, HALF_L * 2 * PX, crossH);
  }

  // Grain: deterministic speckle so the surface reads as turf, not plastic.
  // (LCG — purely cosmetic, stable across reloads.)
  let lcg = 1234567;
  const rand = () => ((lcg = (lcg * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < g.grainCount; i++) {
    const px = X(-HALF_L) + rand() * HALF_L * 2 * PX;
    const pz = Z(-HALF_W) + rand() * HALF_W * 2 * PX;
    const [rMin, rMax] = g.grainRadius;
    const r = (rMin + rand() * (rMax - rMin)) * PX;
    const dark = 0.06 * g.grainAlpha;
    const light = 0.045 * g.grainAlpha;
    const [rgb, alpha] = rand() < 0.5 ? ['16,52,26', dark] : ['214,255,214', light];
    // F-Q: soft-edged. At 16 px/m these blobs were soft only because the
    // texture was being magnified; painted crisp at 40 px/m they read as
    // polka dots, and the F5 verdict (grain must mip to a nap, not shapes)
    // was about their look, not their pixel count.
    if (PX > 24 && r > 1.5) {
      const grad = ctx.createRadialGradient(px, pz, 0, px, pz, r);
      grad.addColorStop(0, `rgba(${rgb},${alpha})`);
      grad.addColorStop(0.55, `rgba(${rgb},${alpha * 0.7})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
    }
    ctx.beginPath();
    ctx.arc(px, pz, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Wear (F0's toy arm; 0 elsewhere): a pitch that has been PLAYED on. Bare
  // goalmouths, a scuffed centre circle and worn wing channels — the thing
  // that separates a real surface from a green rectangle. Deterministic.
  if (g.wear > 0) paintWear(ctx, g.wear, g.wearColor, rand, X, Z, PX);

  ctx.strokeStyle = `rgba(247,250,253,${style.lineAlpha})`;
  ctx.lineWidth = style.lineWidth * PX;
  ctx.lineCap = 'round';

  // Touchlines + halfway line.
  ctx.strokeRect(X(-HALF_L), Z(-HALF_W), HALF_L * 2 * PX, HALF_W * 2 * PX);
  ctx.beginPath();
  ctx.moveTo(X(0), Z(-HALF_W));
  ctx.lineTo(X(0), Z(HALF_W));
  ctx.stroke();

  // Center circle + spot.
  ctx.beginPath();
  ctx.arc(X(0), Z(0), CENTER_CIRCLE_R * PX, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(241,245,249,0.92)';
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 0.25 * PX, 0, Math.PI * 2);
  ctx.fill();

  // Corner arcs — where the Evo Cup's corners are actually taken.
  const cornerR = 1.2 * PX;
  const corners: Array<[number, number, number]> = [
    [X(-HALF_L), Z(-HALF_W), 0],
    [X(HALF_L), Z(-HALF_W), Math.PI / 2],
    [X(HALF_L), Z(HALF_W), Math.PI],
    [X(-HALF_L), Z(HALF_W), -Math.PI / 2],
  ];
  for (const [cx, cy, start] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, cornerR, start, start + Math.PI / 2);
    ctx.stroke();
  }

  // Penalty boxes, goal boxes, penalty spots and the arc ("D").
  for (const side of [-1, 1]) {
    const edge = side * HALF_L;
    ctx.strokeRect(
      Math.min(X(edge), X(edge - side * BOX_DEPTH)),
      Z(-BOX_WIDTH / 2),
      BOX_DEPTH * PX,
      BOX_WIDTH * PX,
    );
    const gbDepth = BOX_DEPTH * 0.45;
    const gbWidth = GOAL_WIDTH + 6;
    ctx.strokeRect(
      Math.min(X(edge), X(edge - side * gbDepth)),
      Z(-gbWidth / 2),
      gbDepth * PX,
      gbWidth * PX,
    );
    const spotX = X(edge - side * BOX_DEPTH * 0.72);
    ctx.fillStyle = 'rgba(241,245,249,0.92)';
    ctx.beginPath();
    ctx.arc(spotX, Z(0), 0.22 * PX, 0, Math.PI * 2);
    ctx.fill();
    // The D: an arc outside the box, centered on the penalty spot.
    ctx.beginPath();
    const dR = 6.2 * PX;
    const boxEdgeX = X(edge - side * BOX_DEPTH);
    const half = Math.acos(Math.min(1, Math.abs(boxEdgeX - spotX) / dR));
    const facing = side > 0 ? Math.PI : 0; // arc opens away from the goal
    ctx.arc(spotX, Z(0), dR, facing - half, facing + half);
    ctx.stroke();
  }

  return new THREE.CanvasTexture(canvas);
}
