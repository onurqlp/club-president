import type { FxQuality } from './FxSystem';

/**
 * Render-quality ladder (Track F, F-Q 2026-09-15) — DATA, keyed on the same
 * Low / Med / High buttons that already drive the FX budget, so one control
 * sets both.
 *
 * Why this exists: the user's phone verdict was 「很糊」. The blur had four
 * separate sources, none of them the models themselves:
 *
 * - The pitch was ONE canvas at 16 px/m stretched across a 73 × 50 m plane.
 *   In the follow camera the screen shows ~50–75 px per metre of grass, so
 *   every blade of "grain" was magnified 3–5× into a soft blob, and every
 *   line edge with it.
 * - The pixel ratio was capped at 2 while the user's phone is DPR 3: the
 *   canvas was rendered at 2× and then stretched 1.5× by the compositor.
 * - The sun's shadow map covered the WHOLE pitch (124 × 93 m in 2048 px,
 *   ~16 texels/m) whatever the camera looked at — contact shadows were
 *   smears, so bodies never sat on the grass.
 * - Nothing on the pitch had a specular response: no environment, so the
 *   ball and the goal frame were matte blobs.
 *
 * Each row below is one lever; the renderer reads them and nothing else does.
 */
export interface RenderQualitySpec {
  /** Cap on `devicePixelRatio`. 3 = native on a modern phone. */
  pixelRatio: number;
  /** Sun shadow map edge (px). Square. */
  shadowMap: number;
  /**
   * Pitch canvas resolution in pixels per metre. 40 keeps the canvas under
   * the 4096 texture limit on the 73 m plane (2920 × 2024) and gives the
   * paint ~2.5× the texels it had.
   */
  pitchPx: number;
  /** Tiled turf relief (a bump map at blade scale) on the grass material. */
  turfDetail: boolean;
}

export const RENDER_QUALITY: Record<FxQuality, RenderQualitySpec> = {
  low: { pixelRatio: 1, shadowMap: 1024, pitchPx: 20, turfDetail: false },
  medium: { pixelRatio: 2, shadowMap: 2048, pitchPx: 40, turfDetail: true },
  high: { pixelRatio: 3, shadowMap: 2048, pitchPx: 40, turfDetail: true },
};

/** The renderer's actual pixel ratio for a quality on this device. */
export function pixelRatioFor(q: FxQuality, devicePixelRatio: number): number {
  return Math.min(devicePixelRatio, RENDER_QUALITY[q].pixelRatio);
}
