import { HALF_L, HALF_W, PITCH_LENGTH, PITCH_WIDTH } from '../sim/constants';
import type { V2 } from '../utils/vec';

/** Pitch-space (meters, origin center) -> canvas pixels. */
export const SCALE = 10;
export const MARGIN = 30;
export const CANVAS_W = PITCH_LENGTH * SCALE + MARGIN * 2;
export const CANVAS_H = PITCH_WIDTH * SCALE + MARGIN * 2;

export const toPxX = (x: number): number => MARGIN + (x + HALF_L) * SCALE;
export const toPxY = (y: number): number => MARGIN + (y + HALF_W) * SCALE;
export const toPx = (p: V2): { x: number; y: number } => ({ x: toPxX(p.x), y: toPxY(p.y) });
