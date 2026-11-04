import * as THREE from 'three';
import type { Role } from '../sim/types';
import type { AnimName } from './AnimationSystem';
import type { StylePreset } from './stylePresets';

/**
 * Procedural low-poly footballer: torso/head/arms/legs/feet built from shared
 * geometries; team kit via primary/secondary materials (goalkeepers wear the
 * inverted kit, like the 2D view). A billboard sprite above the head shows
 * role + name, plus the current action when the labels overlay is on.
 *
 * Joint hierarchy (all pivots chosen so AnimationSystem can pose it):
 *   root (pitch position, yaw, hop)
 *     scaleRoot (F1 scale honesty — the whole body, uniformly)
 *       body (whole-body pivot at the feet — dives tilt EVERYTHING)
 *         lean (hip pivot, forward/side lean)  -> torso, head, armL, armR
 *         legL, legR (hip pivots)              -> thigh+sock+foot
 *       blob (fake contact shadow — anatomy, so it scales)
 *     selectRing (flat ring on the grass)
 *     label (sprite billboard)
 */

/* ---------------- scale honesty (Track F, step F1) ---------------- */

/*
 * The body model was drawn WIDER than the footprint the sim gives it. The
 * overlap solver keeps player CENTRES `PLAYER_MIN_DIST` (1.05 m) apart, but
 * the widest body this file can build spans 1.63 m across the arms — so two
 * bodies at minimum separation intersect by half a torso during close
 * marking, and every player reads bloated against a 63 × 40.6 m pitch.
 *
 * F1 is ONE uniform shrink, applied to every procedural human body on the
 * pitch — players here, plus the referee, linesmen and touchline coaches,
 * which are the same box-person skeleton in their own files. They share the
 * constant because they share a world: shrinking players alone would leave
 * the officials towering over them.
 *
 * What does NOT move (the user's rule): name labels, selection rings and
 * halos keep full size — they are information, not anatomy. Nor does any sim
 * constant: this is render-only, so the fingerprint cannot move.
 *
 * The value is DERIVED, not chosen: 1.05 / 1.63134 = 0.6436, rounded DOWN to
 * the nearest 0.01 so the anchor holds for every role at the tallest identity
 * `bodyFor` can hash. `armSpan`/`maxArmSpan` below are pure and the render3d
 * contract test pins both directions — 0.64 fits, 0.65 does not.
 */
export const HUMAN_MODEL_SCALE = 0.64;

/*
 * F2 (Track F, 2026-07-25) — toy anatomy. F-DIRECTION's largest named gap to
 * the reference was the silhouette: a wide slab torso with spindly stick
 * limbs. The fix is CHUNK, not size — limbs thicken by ~35% while shoulders
 * tuck IN, which is what a toy figure's arms actually do and what keeps the
 * F1 anchor intact: the widest body still spans 1.6165 m, so 0.64 remains the
 * largest 0.01 step that fits and the whole model neither grew nor shrank.
 * Limb LENGTHS are untouched on purpose — every elbow/knee pivot and every
 * AnimationSystem pose is written against them.
 */

/** Shoulder offset from the spine, × the role's torso width. */
const SHOULDER_X = 0.50;
/** Keeper shoulders sit a touch wider still. */
const GK_SHOULDER_OUT = 0.03;
/** Half-width of the upper arm (sleeve box is twice this). */
export const SLEEVE_HALF_W = 0.15;
/** Half-width of the forearm; keeper gloves fatten it. */
export const FOREARM_HALF_W = 0.13;
const GK_FOREARM_SCALE = 1.25;
/** Head radius. The torso top sits at 1.095, so the head centre tracks it. */
const HEAD_R = 0.34;

/**
 * Torso box, before the per-role build and per-player bulk multipliers.
 * F2 NARROWED it 0.86 → 0.72: with the thickened arms tucked to SHOULDER_X
 * 0.50, a 0.86 chest swallowed the sleeves whole and the shoulders read as
 * one wide red slab. A narrow chest under thick arms is the toy silhouette.
 * Exported so the contract test measures the real box, not a copied literal.
 */
export const TORSO_BASE = { w: 0.72, h: 0.86, d: 0.54 } as const;
/** Shoulder line — the torso top, and what the head beds into. */
const TORSO_TOP = 1.095;
/** `bodyFor`'s bulk ceiling — 0.88 + strength × 0.28 at strength 1. */
export const MAX_BULK = 1.16;

/** `bodyFor`'s identity-height band — the anchor is derived at the top of it. */
const MIN_BODY_HEIGHT = 0.94;
export const MAX_BODY_HEIGHT = 1.06;

/**
 * Lateral silhouette width across the arms, in metres. The arms are always
 * the model's widest horizontal dimension — torso (0.86 × torsoW × bulk, bulk
 * ≤ 1.16) and stance (feet at ±0.35) both sit inside them — so this is the
 * honest quantity to hold against `PLAYER_MIN_DIST`. Pure: no THREE objects,
 * so the contract test can call it in node.
 */
export function armSpan(role: Role, height = 1, scale = HUMAN_MODEL_SCALE): number {
  const isGK = role === 'GK';
  const shoulder = SHOULDER_X * BUILD[role].torsoW + (isGK ? GK_SHOULDER_OUT : 0);
  const halfLimb = Math.max(SLEEVE_HALF_W, FOREARM_HALF_W * (isGK ? GK_FOREARM_SCALE : 1));
  return 2 * (shoulder + halfLimb) * height * scale;
}

/** The widest body the game can build: broadest role × tallest identity. */
export function maxArmSpan(scale = HUMAN_MODEL_SCALE): number {
  return Math.max(
    ...(Object.keys(BUILD) as Role[]).map((role) => armSpan(role, MAX_BODY_HEIGHT, scale)),
  );
}

/*
 * RB (round body, 2026-08-19) — the user's directive: 「我觉得球员现在方形身体
 * 一有点违和,也不符合实际模型,应该变成身体变圆(类似于现实)」. Every anatomy
 * box became a BODY OF REVOLUTION: no vertical edge survives anywhere on the
 * man. The primitive is `barrel()` — a lathed rounded rectangle: circular in
 * cross-section, straight-sided through the middle, rounded off at both ends.
 * A full capsule (corner radius = half-width) was tried first and read as a
 * BALL: the chest lost its shoulder line and the short upper arm turned into
 * a bead. Keeping the corner radius BELOW the half-width restores the
 * shoulder/hip lines while the silhouette stays round from every angle.
 *
 * THE INVARIANTS THIS SLICE KEEPS, by construction (nothing else may move):
 *  - Every part occupies the SAME bounding box as the box it replaces (a
 *    capsule's total height = length + 2·radius; the radii ARE the old box
 *    half-widths, so `armSpan`/`maxArmSpan` and the F1 anchor 0.64 are
 *    numerically untouched, and the F2 toy proportions read the same).
 *  - Non-circular cross-sections are baked into the GEOMETRY (`.scale(1,1,k)`
 *    at build time), never onto the mesh — `mesh.scale` still carries role
 *    build × per-player bulk exactly as before.
 *  - Every pivot and every translate-to-pivot offset is byte-identical, so
 *    the elbow group (y=-0.34) and knee group (y=-0.55) still hold and
 *    AnimationSystem's poses are unchanged.
 * Segment counts are deliberately low (corners 3, radial 8–12): this game has
 * a live perf budget and the silhouette, not the shading, is what reads.
 */

/*
 * RB-2 (2026-08-19): the referee, linesmen and touchline coaches were still
 * the box-person skeleton in their own files and read as a DIFFERENT SPECIES
 * next to a round player. The primitives below are therefore EXPORTED and
 * reused verbatim by `RefereeModel.ts` / `LinesmanModel.ts` / `CoachModel.ts`
 * — one lathe, one segment budget, one corner rule for every procedural human
 * on the pitch. Nothing here changed for the player; only the visibility did.
 */

/** Radial faces around a limb / around the torso. */
export const LIMB_RADIAL_SEG = 8;
export const TORSO_RADIAL_SEG = 12;
/** Quads per rounded end — 3 is where the corner stops faceting visibly. */
export const CORNER_SEG = 3;
/** Limb end rounding, × the limb's half-width. Below 1 = still a limb, not a bead. */
const LIMB_CORNER = 0.7;

/**
 * A lathed rounded rectangle: a solid of revolution `2·halfW` wide, `2·halfH`
 * tall, its ends rounded off at radius `corner` — the shape every box on this
 * model became (RB). Centred on the origin, exactly filling the box it
 * replaces, so no pivot or offset in this file had to move.
 */
export function barrel(halfW: number, halfH: number, corner: number, radial: number): THREE.LatheGeometry {
  const rc = Math.min(corner, halfW, halfH);
  const rFlat = halfW - rc; // where the straight side starts
  const yFlat = halfH - rc;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -halfH)];
  for (let i = 0; i <= CORNER_SEG; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / CORNER_SEG);
    pts.push(new THREE.Vector2(rFlat + rc * Math.cos(a), -yFlat + rc * Math.sin(a)));
  }
  for (let i = 1; i <= CORNER_SEG; i++) {
    const a = (Math.PI / 2) * (i / CORNER_SEG);
    pts.push(new THREE.Vector2(rFlat + rc * Math.cos(a), yFlat + rc * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(0, halfH));
  return new THREE.LatheGeometry(pts, radial);
}

/**
 * A limb of the given BOX footprint: total height `h`, width `2r`, depth
 * `2r·zk` — so it drops into the old box's place exactly. The end rounding is
 * `LIMB_CORNER × r`: below the half-width, so it stays a limb, not a bead.
 * (RB-2: hoisted out of `sharedGeo()` unchanged so the officials share it.)
 */
export function limb(r: number, h: number, zk = 1): THREE.LatheGeometry {
  const g = barrel(r, h / 2, r * LIMB_CORNER, LIMB_RADIAL_SEG);
  if (zk !== 1) g.scale(1, 1, zk);
  return g;
}

/**
 * A shoe/boot of the given BOX footprint (`w × h × d`): a capsule laid along
 * **+z** so toe and heel round off, then widened on x back to `w` — a foot is
 * wider than it is tall. Fills the box exactly (capsule height = `d`, radius
 * `h/2`). (RB-2: hoisted so the referee's and the coach's shoes share it.)
 */
export function shoe(w: number, h: number, d: number): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(h / 2, d - h, CORNER_SEG, LIMB_RADIAL_SEG)
    .rotateX(Math.PI / 2)
    .scale(w / h, 1, 1) as THREE.CapsuleGeometry;
}

/* Shared geometries — created once, reused by all 10 players. */
let GEO: {
  torso: THREE.LatheGeometry;
  head: THREE.SphereGeometry;
  hair: THREE.SphereGeometry;
  sleeve: THREE.LatheGeometry;
  forearm: THREE.LatheGeometry;
  thigh: THREE.LatheGeometry;
  sock: THREE.LatheGeometry;
  sockBand: THREE.CylinderGeometry;
  foot: THREE.CapsuleGeometry;
  hips: THREE.LatheGeometry;
  eye: THREE.CircleGeometry;
  ring: THREE.RingGeometry;
  number: THREE.PlaneGeometry;
} | null = null;

function sharedGeo(): NonNullable<typeof GEO> {
  if (GEO) return GEO;
  const translate = <G extends THREE.BufferGeometry>(g: G, y: number): G => {
    g.translate(0, y, 0);
    return g;
  };
  GEO = {
    // RB: the chest is a barrel, not a slab. Half-width = the old TORSO_BASE.w
    // half (the F1 span inputs must not move); the 0.75 z-squash reproduces the
    // 0.54 depth; the 0.20 corner keeps a readable shoulder line and hem.
    torso: barrel(TORSO_BASE.w / 2, TORSO_BASE.h / 2, 0.20, TORSO_RADIAL_SEG)
      .scale(1, 1, TORSO_BASE.d / TORSO_BASE.w),
    // F2: a bigger head is the toy read — ~1:4 head-to-height, not 1:7.
    head: new THREE.SphereGeometry(HEAD_R, 12, 10),
    // Hair cap (Phase 76): the top half-sphere, slightly proud of the head.
    // F2 raised the hairline from 0.52π to 0.46π — at the bigger head the old
    // cap reached below the equator and swallowed the new eyes — and doubled
    // the segments, because the same facet count on a wider sphere zigzagged.
    hair: new THREE.SphereGeometry(HEAD_R * 1.09, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    // F2: eyes. Two flat discs on the face — the cheapest thing that turns a
    // sphere into someone. Parented to the head so they ride every pose.
    eye: new THREE.CircleGeometry(HEAD_R * 0.17, 8),
    // Limbs pivot at their top: translate geometry downward by half height.
    // Short sleeves: shirt-colored upper arm, skin (or GK glove) forearm.
    // Since Phase 73 the forearm hangs from an ELBOW group (y=-0.34 in the
    // arm) and sock/band/foot from a KNEE group (y=-0.55 in the leg), so
    // their geometry is translated relative to those pivots.
    // RB: all four limb segments are round barrels now. Half-widths = the old
    // box half-widths (SLEEVE_HALF_W / FOREARM_HALF_W are the F1 span inputs
    // and must not move); total heights and pivot offsets are unchanged, so a
    // segment's rounded end always sits inside the next joint's.
    sleeve: translate(limb(SLEEVE_HALF_W, 0.36), -0.18),
    forearm: translate(limb(FOREARM_HALF_W, 0.44), -0.22),
    thigh: translate(limb(0.17, 0.55), -0.27),
    sock: translate(limb(0.15, 0.42, 0.32 / 0.30), -0.21),
    // Sock-top trim: a short cylinder hugging the round calf (was a flat box).
    sockBand: translate(
      new THREE.CylinderGeometry(0.16, 0.16, 0.1, LIMB_RADIAL_SEG).scale(1, 1, 0.34 / 0.32),
      -0.03,
    ),
    // Boot: chunkier and SHORTER — the old 0.52 depth read as a clown shoe.
    // Centre moves to -0.44 so the sole still lands at -0.53, on the grass.
    // RB: a capsule laid along +z (toe and heel round off), then widened on x
    // back to the old 0.32 — a boot is wider than it is tall.
    foot: translate(shoe(0.32, 0.18, 0.46), -0.44),
    // RB: the pelvis is a wide, strongly rounded barrel on the old
    // 0.68 × 0.34 × 0.5 box — the hip line the shorts hang from.
    hips: barrel(0.34, 0.17, 0.15, TORSO_RADIAL_SEG).scale(1, 1, 0.5 / 0.68),
    ring: new THREE.RingGeometry(0.75, 0.98, 24),
    number: new THREE.PlaneGeometry(0.52, 0.58),
  };
  return GEO;
}

/* ---------------- material language (Track F, F0 arm (a)) ---------------- */

/*
 * One switch decides whether bodies are PBR (`MeshStandardMaterial`, as
 * shipped) or toon-ramped (`MeshToonMaterial` against a 4-step gradient — flat
 * lit areas with hard terminator lines, the toy/board-game language). It is a
 * module-level flag rather than a parameter because the kit factory is called
 * from six places; the renderer sets it from its style preset BEFORE building
 * any body, and `resetSharedPlayerResources` clears the caches with it.
 */
let TOON = false;
let CONTACT_SHADOW = 1;
let RAMP: THREE.DataTexture | null = null;

/**
 * Apply an F0 style preset to the body language. Call BEFORE constructing any
 * PlayerModel — switching the material language drops the shared caches, so
 * bodies built earlier would keep the old one.
 */
export function setBodyStyle(style: Pick<StylePreset, 'toon' | 'contactShadow'>): void {
  CONTACT_SHADOW = style.contactShadow;
  if (style.toon === TOON) return;
  TOON = style.toon;
  resetSharedPlayerResources();
}

/** 4-step toon ramp: shadow · mid · light · hot, as a 1×4 luminance texture. */
function ramp(): THREE.DataTexture {
  if (RAMP) return RAMP;
  const steps = new Uint8Array([70, 140, 205, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  RAMP = tex;
  return tex;
}

/** A lit body material in whichever language the current style asked for.
 *  Shared with the referee/linesman/coach models so one arm restyles them all. */
export function bodyMat(color: number, roughness: number): THREE.Material {
  return TOON
    ? new THREE.MeshToonMaterial({ color, gradientMap: ramp() })
    : new THREE.MeshStandardMaterial({ color, roughness });
}

/* Shared skin/boot/glove materials — lazy like GEO so a full renderer
   dispose (whose scene traverse disposes them) can reset the cache. */
let MATS: {
  skin: THREE.Material;
  dark: THREE.Material;
  glove: THREE.Material;
} | null = null;

function sharedMats(): NonNullable<typeof MATS> {
  if (MATS) return MATS;
  MATS = {
    skin: bodyMat(0xe0b089, 0.8),
    dark: bodyMat(0x14171e, 0.65),
    glove: bodyMat(0xf1f5f9, 0.85),
  };
  return MATS;
}

/* Per-tone skin + per-color hair materials (Phase 76) — small shared caches,
   reset together with GEO/MATS on a full renderer dispose. */
const TONE_MATS = new Map<number, THREE.Material>();
function toneMat(color: number, roughness = 0.8): THREE.Material {
  let m = TONE_MATS.get(color);
  if (!m) {
    m = bodyMat(color, roughness);
    TONE_MATS.set(color, m);
  }
  return m;
}

/**
 * Forget the shared geometry/material caches. Call after a full renderer
 * dispose() — its scene traverse has already disposed the GPU resources —
 * so the next 3D init builds fresh ones instead of reusing disposed objects.
 */
export function resetSharedPlayerResources(): void {
  GEO = null;
  MATS = null;
  TONE_MATS.clear();
}

/* ---------------- the individual body (Phase 76) ---------------- */

/** Skin tones + hair colors — small palettes indexed by the name hash. */
const SKIN_TONES = [0xf1c27d, 0xe0b089, 0xc68642, 0x9c6b3f, 0x6b4423, 0x4a2f1b];
const HAIR_COLORS = [0x17171a, 0x2c2118, 0x4a3220, 0x6e4a26, 0x8a8d93, 0xb0651f];

/** Deterministic 0..1 from a name (FNV-1a) — stable across sessions. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export interface BodySpec {
  /** Whole-body scale, 0.94 – 1.06 (identity — from the name). */
  height: number;
  /** Torso/hip width multiplier, 0.88 – 1.16 (ability — from strength). */
  bulk: number;
  tone: number;
  /** 0 = cap, 1 = buzz (flattened), 2 = bald (hidden). */
  hair: 0 | 1 | 2;
  hairColor: number;
}

/**
 * The body a player EARNS (Phase 76, user direction "和球员本身绑定再加上
 * 和能力绑定"): identity (height, skin, hair) hashes off the NAME so it
 * survives saves/replays and swaps correctly on substitution; build follows
 * the evolved STRENGTH attribute — the gym shows. Pure, unit-pinned.
 */
export function bodyFor(name: string, strength: number): BodySpec {
  const h1 = hash01(name);
  const h2 = hash01(`${name}#skin`);
  const h3 = hash01(`#hair${name}`);
  return {
    height: MIN_BODY_HEIGHT + h1 * (MAX_BODY_HEIGHT - MIN_BODY_HEIGHT),
    bulk: 0.88 + Math.max(0, Math.min(1, strength)) * (MAX_BULK - 0.88),
    tone: SKIN_TONES[Math.min(SKIN_TONES.length - 1, Math.floor(h2 * SKIN_TONES.length))],
    hair: h3 < 0.14 ? 2 : h3 < 0.62 ? 0 : 1,
    hairColor: HAIR_COLORS[Math.min(HAIR_COLORS.length - 1, Math.floor(((h3 * 7919) % 1) * HAIR_COLORS.length))],
  };
}

/** Squad numbers by role — instantly readable football shorthand. */
const ROLE_NUMBER: Record<Role, number> = { GK: 1, DF: 4, MF: 8, WG: 7, ST: 9 };

/** Subtle silhouette variation so roles read at a glance (visual only). */
const BUILD: Record<Role, { torsoW: number; torsoD: number; head: number; leanBias: number }> = {
  GK: { torsoW: 1.14, torsoD: 1.12, head: 1.06, leanBias: 0 },
  DF: { torsoW: 1.07, torsoD: 1.05, head: 1.0, leanBias: 0 },
  MF: { torsoW: 1.0, torsoD: 1.0, head: 1.0, leanBias: 0 },
  WG: { torsoW: 0.9, torsoD: 0.94, head: 0.97, leanBias: 0.02 },
  ST: { torsoW: 0.98, torsoD: 1.0, head: 1.0, leanBias: 0.07 },
};

export interface KitMaterials {
  shirt: THREE.Material;
  shorts: THREE.Material;
  sock: THREE.Material;
  /** Back-number digit color, picked for contrast against the shirt. */
  numberColor: string;
}

export function makeKit(primary: number, secondary: number): KitMaterials {
  // Digits must survive on any shirt: white on dark kits, near-black on pale.
  const lum = 0.299 * ((primary >> 16) & 0xff) + 0.587 * ((primary >> 8) & 0xff) + 0.114 * (primary & 0xff);
  return {
    shirt: bodyMat(primary, 0.7),
    shorts: bodyMat(secondary, 0.75),
    sock: bodyMat(primary, 0.8),
    numberColor: lum > 150 ? '#14171e' : '#f5f7fa',
  };
}

export function disposeKit(kit: KitMaterials): void {
  kit.shirt.dispose();
  kit.shorts.dispose();
  kit.sock.dispose();
}

const HIP_Y = 1.06;

export class PlayerModel {
  readonly root = new THREE.Group();
  /** F1 scale honesty: the ONE uniform shrink, carried by its own group so
   * every body transform underneath it — including the run bob and the dive
   * lift that AnimationSystem writes to `body.position.y` — scales with the
   * model, while the root's label/ring/halo/blob children keep full size. */
  readonly scaleRoot = new THREE.Group();
  /** Whole-body group (lean + legs), pivot at the feet: the keeper dive
   * tilts THIS, so the legs leave the ground with the torso — tilting only
   * `lean` folded the keeper at the hips while his legs stood planted (the
   * "只有上半身动" report). Label/ring/blob stay outside it, upright. */
  readonly body = new THREE.Group();
  readonly lean = new THREE.Group();
  readonly legL: THREE.Group;
  readonly legR: THREE.Group;
  readonly armL: THREE.Group;
  readonly armR: THREE.Group;
  /** Second joints (Phase 73): shins flex during the swing phase, forearms
   * carry at ~90° on the run — the single-segment limbs were the biggest
   * silhouette gap vs. a real runner. */
  readonly kneeL: THREE.Group;
  readonly kneeR: THREE.Group;
  readonly elbowL: THREE.Group;
  readonly elbowR: THREE.Group;
  private selectRing: THREE.Mesh;
  private selectHalo!: THREE.Mesh;
  private blob!: THREE.Mesh;
  private label: THREE.Sprite;
  private labelCanvas = document.createElement('canvas');
  private labelTex: THREE.CanvasTexture;
  private labelDrawn = '';
  private numberTex!: THREE.CanvasTexture;
  private numberMat!: THREE.MeshBasicMaterial;

  /* Animation state owned by AnimationSystem. */
  phase = 0;
  animTime = 0;
  kickT = -1;
  kickPower = 1;
  headerT = -1;
  /** Smoothed swing amplitude / arm factor (31.9): players hovering on the
   * jog↔sprint speed threshold flipped limb amplitude INSTANTLY every few
   * frames — the "跑动眼花" strobe. These ease toward the anim's targets. */
  swingAmpCur = 0.05;
  armFCur = 0.7;
  /** Dive side frozen at dive start (29.1) — recomputing it per frame made
   * the pose mirror-flip as the ball crossed the keeper (the "twitch"). */
  diveSide = 1;
  /** One-shot dive clock: drives the launch → full-stretch → landed arc. */
  diveT = -1;
  /** Facing frozen at dive start (34.1) — the sim heading keeps tracking
   * the ball, and applying it raw ROTATED the horizontal body mid-save. */
  yawLock = 0;
  /** Ground position frozen at dive start (Phase B, user report: keeper's
   * feet drifted BACKWARD after landing). The save is a probability roll —
   * the sim keeper keeps steering back to his spot while the dive pose plays,
   * dragging the horizontal body with it. Plant the root where he dove. */
  diveX = 0;
  diveZ = 0;
  /** Recovery blend: 1 → still facing the lock, eases to the live heading. */
  yawEase = 0;
  /** One-shot trap clock (Phase 73): reaches for an arriving ball, gives. */
  receiveT = -1;
  /** F-Q body bump (render-only): seconds into the brace/recoil, -1 = none;
   * the contact direction in the body's frame — lateral slot (+1 = local +x,
   * the `armR` side) and forward component (+1 = hit from the front). */
  bumpT = -1;
  bumpLat: 1 | -1 = 1;
  bumpFwd = 0;
  /** 0..1 from the closing speed — a nudge and a collision do not recoil alike. */
  bumpStrength = 0.5;
  /** Which leg meets the arriving ball: +1 = the local-+x slot (legR). */
  receiveSlot: 1 | -1 = 1;
  /** Kicking leg, frozen at kick start (Phase 73): the ball-side foot. */
  kickSlot: 1 | -1 = 1;
  /** Previous frame's yaw + smoothed bank — turns tip the torso (Phase 73). */
  yawPrev: number | null = null;
  bankCur = 0;
  prevAnim: AnimName = 'idle';

  readonly gid: number;
  private name: string;
  private role: Role;
  private labelColor: string;
  /* Body-binding refs (Phase 76). */
  private torso!: THREE.Mesh;
  private hips!: THREE.Mesh;
  private head!: THREE.Mesh;
  private hair!: THREE.Mesh;
  private skinMeshes: THREE.Mesh[] = [];
  private build!: { torsoW: number; torsoD: number };
  private bodyKey = '';

  constructor(gid: number, role: Role, name: string, kit: KitMaterials, labelColor: string) {
    this.gid = gid;
    this.role = role;
    this.name = name;
    this.labelColor = labelColor;
    const g = sharedGeo();

    // Upper body pivots at the hips. Builds differ subtly by role: keepers
    // are broad, wingers slim, strikers carry a slight forward hunch.
    const build = BUILD[role];
    this.build = { torsoW: build.torsoW, torsoD: build.torsoD };
    const isGK = role === 'GK';
    this.lean.position.y = HIP_Y;
    const torso = new THREE.Mesh(g.torso, kit.shirt);
    torso.position.y = TORSO_TOP - TORSO_BASE.h / 2; // hem rises, shoulders hold
    torso.scale.set(build.torsoW, 1, build.torsoD);
    torso.rotation.x = build.leanBias;
    torso.castShadow = true;
    this.torso = torso;
    const head = new THREE.Mesh(g.head, sharedMats().skin);
    // Beds 0.115 INTO the shoulder line. A 0.34 head perched at 1.36 read as
    // a ball balanced on a fridge — a toy figure has no visible neck at all.
    head.position.y = 1.32;
    head.scale.setScalar(build.head);
    head.castShadow = true;
    this.head = head;
    this.skinMeshes.push(head);
    // Hair cap (Phase 76) — restyled per occupant by setBody.
    this.hair = new THREE.Mesh(g.hair, toneMat(HAIR_COLORS[0], 0.9));
    this.hair.position.y = 0.02;
    head.add(this.hair);
    // F2: two dark discs on the face (+z is forward). Unlit so they stay
    // legible in shadow, depth-offset so they never z-fight the sphere.
    const eyeMat = new THREE.MeshBasicMaterial({
      color: 0x17171a, polygonOffset: true, polygonOffsetFactor: -2,
    });
    for (const ex of [-1, 1]) {
      const eye = new THREE.Mesh(g.eye, eyeMat);
      eye.position.set(ex * HEAD_R * 0.34, -HEAD_R * 0.06, HEAD_R * 0.95);
      head.add(eye);
    }
    const hips = new THREE.Mesh(g.hips, kit.shorts);
    hips.position.y = 0.06;
    hips.scale.set(build.torsoW, 1, build.torsoD);
    this.hips = hips;

    // Back number: a small canvas plane on the shirt (kit-secondary digits).
    const numberTex = numberTexture(ROLE_NUMBER[role], kit.numberColor);
    this.numberTex = numberTex;
    this.numberMat = new THREE.MeshBasicMaterial({
      map: numberTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    });
    const backNumber = new THREE.Mesh(g.number, this.numberMat);
    // Derived from the real box: a literal -0.253 was a hand-fit to the old
    // 0.5 depth and F2's deeper torso swallowed the digits whole.
    backNumber.position.set(0, 0.66, -(TORSO_BASE.d / 2) * build.torsoD - 0.012);
    backNumber.rotation.y = Math.PI;
    this.lean.add(backNumber);

    const armX = SHOULDER_X * build.torsoW + (isGK ? GK_SHOULDER_OUT : 0);
    const aL = this.makeArm(g, kit, -armX, isGK);
    const aR = this.makeArm(g, kit, armX, isGK);
    this.armL = aL.arm;
    this.armR = aR.arm;
    this.elbowL = aL.elbow;
    this.elbowR = aR.elbow;
    this.lean.add(torso, head, hips, this.armL, this.armR);

    // Legs pivot at the hips too (siblings of the lean group so the upper
    // body can lean without dragging the legs).
    const lL = this.makeLeg(g, kit, -0.23);
    const lR = this.makeLeg(g, kit, 0.23);
    this.legL = lL.leg;
    this.legR = lR.leg;
    this.kneeL = lL.knee;
    this.kneeR = lR.knee;

    // Selection highlight: bright inner ring + soft outer halo (pulsing).
    this.selectRing = new THREE.Mesh(
      g.ring,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
    );
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.position.y = 0.06;
    this.selectRing.visible = false;
    this.selectHalo = new THREE.Mesh(
      new THREE.RingGeometry(1.05, 1.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    );
    this.selectHalo.rotation.x = -Math.PI / 2;
    this.selectHalo.position.y = 0.05;
    this.selectHalo.visible = false;

    // Grounding blob so players read as standing on the grass.
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(isGK ? 0.64 : 0.58, 14),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.34 * CONTACT_SHADOW, depthWrite: false,
      }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    this.blob = blob;

    // Label billboard.
    this.labelCanvas.width = 256;
    this.labelCanvas.height = 96;
    this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.labelTex, transparent: true, depthWrite: false }),
    );
    // The plate's SIZE is information and never scales, but its HEIGHT is an
    // anchor to the head — it rides the F1 shrink so it keeps hugging it.
    this.label.position.y = 3.15 * HUMAN_MODEL_SCALE;
    this.label.scale.set(3.4, 1.28, 1);
    this.drawLabel('');

    this.body.add(this.lean, this.legL, this.legR);
    // The grounding blob is the body's own contact shadow, so it shrinks WITH
    // it — a shadow wider than the man is a drawing error, not a marker. The
    // ring/halo/label are markers and stay full size.
    this.scaleRoot.scale.setScalar(HUMAN_MODEL_SCALE);
    this.scaleRoot.add(this.body, this.blob);
    this.root.add(this.scaleRoot, this.selectRing, this.selectHalo, this.label);
    // Raycast target for click-to-select.
    this.root.traverse((o) => (o.userData.gid = gid));
  }

  private makeArm(
    g: NonNullable<typeof GEO>, kit: KitMaterials, x: number, isGK: boolean,
  ): { arm: THREE.Group; elbow: THREE.Group } {
    const arm = new THREE.Group();
    arm.position.set(x, 1.0, 0);
    const sleeve = new THREE.Mesh(g.sleeve, kit.shirt);
    // Keepers wear long sleeves + big pale gloves; outfielders show skin.
    const m = sharedMats();
    const forearm = new THREE.Mesh(g.forearm, isGK ? m.glove : m.skin);
    if (isGK) forearm.scale.set(GK_FOREARM_SCALE, 1, GK_FOREARM_SCALE);
    else this.skinMeshes.push(forearm); // retoned per occupant (Phase 76)
    sleeve.castShadow = true;
    forearm.castShadow = true;
    // Elbow joint (Phase 73): the forearm hangs from its own pivot so it
    // can carry bent while the shoulder swings.
    const elbow = new THREE.Group();
    elbow.position.y = -0.34;
    elbow.add(forearm);
    arm.add(sleeve, elbow);
    return { arm, elbow };
  }

  private makeLeg(
    g: NonNullable<typeof GEO>, kit: KitMaterials, x: number,
  ): { leg: THREE.Group; knee: THREE.Group } {
    const leg = new THREE.Group();
    leg.position.set(x, HIP_Y, 0);
    const thigh = new THREE.Mesh(g.thigh, kit.shorts);
    const sock = new THREE.Mesh(g.sock, kit.sock);
    const band = new THREE.Mesh(g.sockBand, kit.shorts); // contrast sock-top trim
    const foot = new THREE.Mesh(g.foot, sharedMats().dark);
    foot.position.z = 0.1; // toes forward (+z = facing direction)
    thigh.castShadow = true;
    sock.castShadow = true;
    // Knee joint (Phase 73): shin+foot flex during the swing phase — the
    // scissor-straight leg was the loudest "not a runner" tell.
    const knee = new THREE.Group();
    knee.position.y = -0.55;
    knee.add(sock, band, foot);
    leg.add(thigh, knee);
    return { leg, knee };
  }

  setPose(x: number, z: number, yaw: number): void {
    this.root.position.x = x;
    this.root.position.z = z;
    this.root.rotation.y = yaw;
  }

  setSelected(sel: boolean): void {
    this.selectRing.visible = sel;
    this.selectHalo.visible = sel;
    if (sel) {
      // The blob is stationary relative to root; pulse the halo instead.
      this.animTimePulse += 0.05;
      const s = 1 + Math.sin(this.animTimePulse * 2) * 0.08;
      this.selectHalo.scale.set(s, s, 1);
    }
  }

  private animTimePulse = 0;

  /** Hide/show the billboard (label decluttering). */
  setLabelVisible(v: boolean): void {
    this.label.visible = v;
  }

  /** Update the billboard: role letter + surname, optional action line. */
  setLabel(action: string, showAction: boolean): void {
    const key = showAction ? action : '';
    if (key === this.labelDrawn) return;
    this.drawLabel(key);
  }

  /** A substitution changed this slot's man (Phase 61) — redraw the plate. */
  setName(name: string): void {
    if (name === this.name) return;
    this.name = name;
    this.drawLabel(this.labelDrawn);
  }

  /**
   * Bind the body to the slot's CURRENT occupant (Phase 76): identity
   * (height/skin/hair) from the name, build from the evolved strength.
   * Called per frame — early-outs on the (name, strength) key.
   */
  setBody(name: string | undefined, strength: number): void {
    const n = name ?? this.name; // old replays: the kickoff-sheet name
    const key = `${n}:${strength.toFixed(2)}`;
    if (key === this.bodyKey) return;
    this.bodyKey = key;
    const b = bodyFor(n, strength);
    this.body.scale.setScalar(b.height);
    this.torso.scale.set(this.build.torsoW * b.bulk, 1, this.build.torsoD * b.bulk);
    this.hips.scale.set(this.build.torsoW * b.bulk, 1, this.build.torsoD * b.bulk);
    const skin = toneMat(b.tone);
    for (const mesh of this.skinMeshes) mesh.material = skin;
    this.hair.visible = b.hair !== 2;
    this.hair.material = toneMat(b.hairColor, 0.9);
    this.hair.scale.set(1, b.hair === 1 ? 0.55 : 1, 1);
  }

  private drawLabel(action: string): void {
    this.labelDrawn = action;
    const ctx = this.labelCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 256, 96);
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px monospace';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.fillStyle = this.labelColor;
    const line1 = `${this.role[0]}·${this.name}`;
    ctx.strokeText(line1, 128, action ? 38 : 58);
    ctx.fillText(line1, 128, action ? 38 : 58);
    if (action) {
      ctx.font = '28px monospace';
      ctx.fillStyle = '#f1f5f9';
      ctx.strokeText(action, 128, 76);
      ctx.fillText(action, 128, 76);
    }
    this.labelTex.needsUpdate = true;
  }

  dispose(): void {
    this.labelTex.dispose();
    this.numberTex.dispose();
    this.numberMat.dispose();
    (this.label.material as THREE.SpriteMaterial).dispose();
    (this.selectRing.material as THREE.Material).dispose();
    // Per-instance (not shared) geometry+materials — these leaked on every
    // match attach until they were added here.
    this.selectHalo.geometry.dispose();
    (this.selectHalo.material as THREE.Material).dispose();
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
  }
}

/** Back-number canvas: one small texture per player, drawn once. */
function numberTexture(n: number, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.font = 'bold 46px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(String(n), 32, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
