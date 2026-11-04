import { Container, Graphics } from 'pixi.js';
import {
  BOX_DEPTH, BOX_WIDTH, CENTER_CIRCLE_R, GOAL_DEPTH, GOAL_WIDTH, PITCH_LENGTH, PITCH_WIDTH,
} from '../sim/constants';
import { MARGIN, SCALE, toPxX, toPxY } from './transform';

const GRASS_A = 0x2d7a3e;
const GRASS_B = 0x338746;
const LINE = 0xf1f5f9;

/** Static pitch: striped grass, lines, boxes, goals. Drawn once. */
export class PitchRenderer {
  readonly container = new Container();

  constructor() {
    const g = new Graphics();

    // Mowing stripes.
    const stripes = 10;
    const stripeW = (PITCH_LENGTH * SCALE) / stripes;
    for (let i = 0; i < stripes; i++) {
      g.rect(MARGIN + i * stripeW, MARGIN, stripeW, PITCH_WIDTH * SCALE).fill(i % 2 === 0 ? GRASS_A : GRASS_B);
    }

    const lw = 2;
    const stroke = { width: lw, color: LINE, alpha: 0.85 };

    // Touchlines + halfway line.
    g.rect(MARGIN, MARGIN, PITCH_LENGTH * SCALE, PITCH_WIDTH * SCALE).stroke(stroke);
    g.moveTo(toPxX(0), toPxY(-PITCH_WIDTH / 2)).lineTo(toPxX(0), toPxY(PITCH_WIDTH / 2)).stroke(stroke);

    // Center circle + spot.
    g.circle(toPxX(0), toPxY(0), CENTER_CIRCLE_R * SCALE).stroke(stroke);
    g.circle(toPxX(0), toPxY(0), 3).fill({ color: LINE, alpha: 0.85 });

    // Penalty boxes.
    const boxPxW = BOX_WIDTH * SCALE;
    const boxPxD = BOX_DEPTH * SCALE;
    g.rect(toPxX(-PITCH_LENGTH / 2), toPxY(-BOX_WIDTH / 2), boxPxD, boxPxW).stroke(stroke);
    g.rect(toPxX(PITCH_LENGTH / 2) - boxPxD, toPxY(-BOX_WIDTH / 2), boxPxD, boxPxW).stroke(stroke);

    // Goals (drawn behind the goal line).
    const goalPxW = GOAL_WIDTH * SCALE;
    const goalPxD = GOAL_DEPTH * SCALE;
    g.rect(toPxX(-PITCH_LENGTH / 2) - goalPxD, toPxY(-GOAL_WIDTH / 2), goalPxD, goalPxW)
      .fill({ color: 0x0f172a, alpha: 0.6 })
      .stroke(stroke);
    g.rect(toPxX(PITCH_LENGTH / 2), toPxY(-GOAL_WIDTH / 2), goalPxD, goalPxW)
      .fill({ color: 0x0f172a, alpha: 0.6 })
      .stroke(stroke);

    this.container.addChild(g);
  }
}
