/**
 * Track F / F0 — the style-direction showcase, as DATA.
 *
 * F0's question is "what should this game look like", and it is answered by
 * the user's eyes, not a probe. So the three candidate directions live here as
 * plain preset objects that `createScene`, `createPitch`, `PlayerModel` and the
 * renderer read. Nothing here touches the sim; every value is a colour, a
 * light, a material flag or a canvas-painting parameter.
 *
 * The arms (F0 row, trimmed on the user's call 2026-07-25 — the
 * broadcast-realism arm was dropped rather than built: it needs gLTF rigs and
 * skeletal animation, which contradicts ART_DIRECTION's procedural-first rule,
 * and the user's reference image is stylised, not realist):
 *
 * - `current`    the baseline, byte-for-byte today's look. The control.
 * - `coherence`  same palette, one material language: ACES tone mapping and a
 *                managed exposure, unified atmosphere, crisper turf grain.
 *                Answers "how much of the gap is just incoherence?"
 * - `toy`        the toy/board-game direction: toon ramp shading, flat vivid
 *                palette, groomed-and-WORN turf, softer paint, warmer key.
 *
 * Lighting is ORTHOGONAL to the arm (user 2026-07-25: "白天也做一版给我挑").
 * `night` reproduces the committed floodlit diorama; `day` is the open
 * question against ART_DIRECTION's "atmosphere darker than the surface" rule.
 */

export type StyleId = 'current' | 'coherence' | 'toy';
export type Lighting = 'night' | 'day';

export interface GrassPalette {
  /** Apron (outside the touchlines). */
  base: string;
  /** The two mowing stripes. */
  stripeA: string;
  stripeB: string;
  stripes: number;
  /** Cross-mow overlay strength (0 = none). */
  crossAlpha: number;
  /** Turf speckle: blob count, opacity, and blob radius range in METRES.
   *
   * Count and radius must move in OPPOSITE directions, and the radius has to
   * stay genuinely small. F5 measured it: metre-scale blobs read as CLOUDS —
   * mould on the grass — not as turf, and no amount of lowering the alpha
   * fixes that because the defect is the spatial frequency, not the contrast.
   * Grain belongs at boot-stud scale (a few cm to ~30cm) so it mips away with
   * distance and only shows as texture underfoot. */
  grainCount: number;
  grainAlpha: number;
  grainRadius: [number, number];
  /** Worn/bare patches — goalmouths, centre circle, wing channels. 0 = none. */
  wear: number;
  wearColor: string;
}

export interface StylePreset {
  id: StyleId;
  lighting: Lighting;
  /** Renderer. `none` is three's default (what the game shipped with). */
  toneMapping: 'none' | 'aces' | 'neutral';
  exposure: number;
  /** Atmosphere. */
  background: number;
  fog: { color: number; near: number; far: number } | null;
  hemi: { sky: number; ground: number; intensity: number };
  sun: { color: number; intensity: number; pos: [number, number, number] };
  /** Extra flat fill; 0 = none. Toon shading needs a floor or it goes muddy. */
  ambient: { color: number; intensity: number } | null;
  pedestal: number;
  /** Pitch surface. */
  grass: GrassPalette;
  lineAlpha: number;
  /** Paint width in metres. */
  lineWidth: number;
  /** Adboards + terraces + floodlight towers. */
  boards: [number, number, number];
  boardStripe: number;
  terrace: [number, number];
  floodlights: boolean;
  /** Terrace crowd shirt colours. The last element any preset didn't own. */
  crowd: readonly number[];
  /**
   * Particle blending. `additive` glows against a dark diorama; against a
   * bright daylight pitch it all but vanishes, which is what F0 quietly did
   * to every goal celebration. Daylight arms use solid `normal` confetti.
   */
  fxBlending: 'additive' | 'normal';
  /**
   * The firework shells' NEUTRAL star colour, and how big a star is in metres.
   *
   * F7 hard-coded the middle shell white and the star at 1.7 m, which is right
   * against a night sky and wrong in every way against a daylight one: the
   * shells burst above the main stand, so by day their backdrop is a pale grey
   * roof under a pale blue sky and white stars read as dust. Same lesson as
   * `fxBlending` one field up — an FX constant that looks fixed is usually a
   * palette entry that has only ever been seen under one light.
   */
  fxSparkNeutral: number;
  fxSparkSize: number;
  /** Bodies: toon ramp materials instead of PBR standard. */
  toon: boolean;
  /** Fake contact-shadow opacity multiplier (1 = as shipped). */
  contactShadow: number;
  /**
   * F-Q (2026-09-15): image-based lighting strength. A procedural sky/grass
   * environment (code, not an asset) gives the ball, the goal frame and the
   * boards a specular response — without it every PBR surface was a matte
   * blob. 0 = no environment, which is exactly what shipped before F-Q.
   */
  environment: number;
  /**
   * F-Q: tiled blade-scale turf relief on the grass material (bump scale).
   * 0 = flat paint. Toon bodies ignore it; only the pitch surface reads it.
   */
  turfBump: number;
}

/**
 * Firework stars by light (see `StylePreset.fxSparkNeutral`). Night keeps F7's
 * tuned white-on-navy at 1.7 m — additive blending blooms it, so small works.
 * Day gets a hot magenta at 2.6 m: the shells burst over the main stand, so
 * their daylight backdrop is a pale grey roof under a pale blue sky, where
 * white has no contrast to spend and `normal` blending grants no bloom to make
 * a small star carry. Named rather than repeated so the five presets that
 * choose between them cannot drift apart.
 */
const SPARK_NIGHT = { neutral: 0xffffff, size: 1.7 } as const;
const SPARK_DAY = { neutral: 0xff2f7a, size: 2.6 } as const;

/** Today's look, exactly — every literal lifted from the shipped files. */
const CURRENT_NIGHT: StylePreset = {
  id: 'current',
  lighting: 'night',
  toneMapping: 'none',
  exposure: 1,
  background: 0x0b1220,
  fog: { color: 0x0b1220, near: 160, far: 320 },
  hemi: { sky: 0xbdd4ff, ground: 0x1c2b1e, intensity: 1.05 },
  sun: { color: 0xfff2df, intensity: 2.2, pos: [-40, 70, 30] },
  ambient: null,
  pedestal: 0x111a2c,
  grass: {
    base: '#1f5c2e',
    stripeA: '#2d7a3e',
    stripeB: '#37904b',
    stripes: 14,
    crossAlpha: 0.025,
    grainCount: 260,
    grainAlpha: 1,
    grainRadius: [0.35, 2.55],
    wear: 0,
    wearColor: '#8a6a3a',
  },
  lineAlpha: 0.96,
  lineWidth: 0.24,
  boards: [0x16223a, 0x1d3a5f, 0x24304a],
  boardStripe: 0x4ade80,
  terrace: [0x131c30, 0x1a2742],
  crowd: [0x33415e, 0x475c85, 0x8294b5, 0x4ade80, 0xf59e0b, 0xe2e8f0, 0x60a5fa, 0x1d3a5f],
  floodlights: true,
  fxBlending: 'additive',
  fxSparkNeutral: SPARK_NIGHT.neutral,
  fxSparkSize: SPARK_NIGHT.size,
  toon: false,
  contactShadow: 1,
  // F-Q: OFF on the banked baseline — its frame is the one the pick was made against.
  environment: 0,
  turfBump: 0,
};

/**
 * Relight the CURRENT palette for daylight without restyling anything: warm
 * high key, pale sky, fog pushed back, floodlights off (a lit lamp at noon is
 * the exact incoherence this track exists to kill).
 */
const CURRENT_DAY: StylePreset = {
  ...CURRENT_NIGHT,
  lighting: 'day',
  background: 0x9fc6e8,
  fog: { color: 0xbdd8ee, near: 200, far: 420 },
  hemi: { sky: 0xdcefff, ground: 0x4a6b3c, intensity: 1.55 },
  sun: { color: 0xfff6e6, intensity: 2.5, pos: [-40, 80, 30] },
  pedestal: 0x2c3d52,
  floodlights: false,
  fxBlending: 'normal',
  fxSparkNeutral: SPARK_DAY.neutral,
  fxSparkSize: SPARK_DAY.size,
};

/**
 * Arm (c): the same palette and the same models, given ONE material language.
 * ACES tone mapping with a managed exposure is the single biggest cheap win —
 * the game currently ships with three's default NoToneMapping, so every bright
 * kit clips and every shadow crushes. Grain is doubled so turf reads as turf.
 */
const COHERENCE_NIGHT: StylePreset = {
  ...CURRENT_NIGHT,
  id: 'coherence',
  toneMapping: 'aces',
  exposure: 1.18,
  hemi: { sky: 0xc4d8ff, ground: 0x22331f, intensity: 1.15 },
  sun: { color: 0xfff4e2, intensity: 2.9, pos: [-40, 70, 30] },
  ambient: { color: 0x2a3a52, intensity: 0.25 },
  grass: {
    ...CURRENT_NIGHT.grass,
    base: '#1c5429',
    stripeA: '#2f7d40',
    stripeB: '#3a9550',
    crossAlpha: 0.03,
    // Finer and denser than shipped: turf grain, not soap bubbles.
    grainCount: 2400,
    grainAlpha: 0.8,
    grainRadius: [0.08, 0.34],
  },
  // One palette family for all the chrome, instead of three unrelated blues.
  boards: [0x18243c, 0x1e3050, 0x233a5c],
  terrace: [0x141e33, 0x1b2a46],
  contactShadow: 0.85,
  environment: 0.3,
  turfBump: 0.02,
};

const COHERENCE_DAY: StylePreset = {
  ...COHERENCE_NIGHT,
  lighting: 'day',
  background: 0x9fc6e8,
  fog: { color: 0xc6dcf0, near: 200, far: 420 },
  hemi: { sky: 0xe4f2ff, ground: 0x50703e, intensity: 1.7 },
  sun: { color: 0xfff8ec, intensity: 3.1, pos: [-40, 80, 30] },
  ambient: { color: 0xbcd4ea, intensity: 0.35 },
  exposure: 1.05,
  pedestal: 0x33465c,
  boards: [0x30425e, 0x3a5070, 0x44597a],
  terrace: [0x33405c, 0x3f4d6b],
  floodlights: false,
  fxBlending: 'normal',
  fxSparkNeutral: SPARK_DAY.neutral,
  fxSparkSize: SPARK_DAY.size,
  environment: 0.45,
};

/**
 * Arm (a): the toy/board-game world the commander recommended and the user's
 * reference image points at. Toon ramp shading, a flat vivid palette that owes
 * nothing to PBR, and turf that has actually been PLAYED on — the goalmouth
 * scuffs and wing-channel wear are what separates a real pitch from a green
 * rectangle. Paint is softened: a groomed pitch's lines are chalk, not vector.
 */
const TOY_DAY: StylePreset = {
  id: 'toy',
  lighting: 'day',
  toneMapping: 'neutral',
  exposure: 1.12,
  background: 0x8ec5e6,
  fog: { color: 0xb9dcef, near: 220, far: 460 },
  hemi: { sky: 0xeaf6ff, ground: 0x63884a, intensity: 1.5 },
  sun: { color: 0xfff3d6, intensity: 2.4, pos: [-34, 66, 26] },
  ambient: { color: 0xd8ecff, intensity: 0.55 },
  pedestal: 0x6a5138,
  grass: {
    base: '#3f8a3f',
    stripeA: '#4fa04a',
    stripeB: '#5cb356',
    stripes: 10,
    crossAlpha: 0.05,
    grainCount: 3600,
    grainAlpha: 0.75,
    grainRadius: [0.06, 0.26],
    wear: 0.85,
    wearColor: '#a8814a',
  },
  lineAlpha: 0.8,
  lineWidth: 0.3,
  boards: [0xe8e2d2, 0xd8cfb8, 0xc9bfa4],
  boardStripe: 0x2f6f3a,
  terrace: [0x76839a, 0x8794ab],
  crowd: [
    0xe94f4f, 0xf2a33c, 0xf6d55c, 0x5cb85c, 0x3aa6d8, 0x4a63c8, 0x9b59b6, 0xef8fb5,
    0xf5f2e8, 0x3f4a5a, 0xe2725b, 0x2fb8a0,
  ],
  floodlights: false,
  fxBlending: 'normal',
  fxSparkNeutral: SPARK_DAY.neutral,
  fxSparkSize: SPARK_DAY.size,
  toon: true,
  contactShadow: 1.15,
  // F-Q: a pale sky over green — enough for the ball to catch a highlight,
  // not enough to turn the toy world glossy.
  environment: 0.4,
  turfBump: 0.018,
};

/** The same toy world at night — floodlit, saturated, warmer key. */
const TOY_NIGHT: StylePreset = {
  ...TOY_DAY,
  lighting: 'night',
  toneMapping: 'neutral',
  exposure: 1.2,
  background: 0x101a2e,
  fog: { color: 0x142138, near: 170, far: 340 },
  hemi: { sky: 0xa9c6ef, ground: 0x2c4230, intensity: 1.15 },
  sun: { color: 0xffeec9, intensity: 2.6, pos: [-34, 72, 26] },
  ambient: { color: 0x33465f, intensity: 0.4 },
  pedestal: 0x3a2f22,
  grass: {
    ...TOY_DAY.grass,
    base: '#2e6b32',
    stripeA: '#3b813c',
    stripeB: '#479046',
    wearColor: '#8a6a3d',
  },
  boards: [0xdcd6c6, 0xccc3ac, 0xbdb398],
  terrace: [0x2b3346, 0x353d52],
  fxBlending: 'additive',
  // Back to white-on-navy: this arm inherits TOY_DAY, so without these two the
  // night sky would get the daylight magenta it was never chosen for.
  fxSparkNeutral: SPARK_NIGHT.neutral,
  fxSparkSize: SPARK_NIGHT.size,
  crowd: [
    0xa63a3a, 0xb0762c, 0xb39a43, 0x438743, 0x2b7a9e, 0x374a93, 0x724285, 0xaf6a86,
    0xb4b1a8, 0x2f3743, 0xa85444, 0x24897a,
  ],
  floodlights: true,
  // Floodlit night: a darker dome, so reflections stay faint.
  environment: 0.25,
};

const PRESETS: Record<StyleId, Record<Lighting, StylePreset>> = {
  current: { night: CURRENT_NIGHT, day: CURRENT_DAY },
  coherence: { night: COHERENCE_NIGHT, day: COHERENCE_DAY },
  toy: { night: TOY_NIGHT, day: TOY_DAY },
};

export const STYLE_IDS: readonly StyleId[] = ['current', 'coherence', 'toy'];
export const LIGHTINGS: readonly Lighting[] = ['night', 'day'];

/**
 * The shipped direction, PICKED BY THE USER at F0 (2026-07-25): the
 * toy/board-game world, in daylight. Lighting stays switchable in-game (their
 * call: "两个都要,做成可切换"), so `night` is a live preset, not a leftover.
 * `current` is kept forever as the banked baseline the pick was made against.
 */
export const DEFAULT_STYLE: StyleId = 'toy';
export const DEFAULT_LIGHTING: Lighting = 'day';

export function stylePreset(id: StyleId = DEFAULT_STYLE, lighting: Lighting = DEFAULT_LIGHTING): StylePreset {
  return PRESETS[id][lighting];
}

export function isStyleId(v: unknown): v is StyleId {
  return typeof v === 'string' && (STYLE_IDS as readonly string[]).includes(v);
}

export function isLighting(v: unknown): v is Lighting {
  return v === 'night' || v === 'day';
}
