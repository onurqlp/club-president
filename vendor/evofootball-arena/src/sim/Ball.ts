import { v2 } from '../utils/vec';
import { BALL_RADIUS } from './constants';
import type { Player } from './Player';
import type { BallPhysicalMode } from './physical';

/**
 * The ball is either free (integrated by Match physics with friction and wall
 * bounces) or owned — glued slightly ahead of its owner while they dribble.
 * Since Phase 28 it also has a height: lofted kicks fly parabolic arcs
 * (z up, gravity, bounces) while ground balls keep z = vz = 0 exactly.
 */
export class Ball {
  pos = v2();
  vel = v2();
  /** IFAB-sized physical radius; M0 does not feed it into line/goal/capture laws. */
  get radius(): number {
    return BALL_RADIUS;
  }
  /** Height above the pitch (m). 0 for ground balls. */
  z = 0;
  /** Vertical velocity (m/s, + up). 0 for ground balls. */
  vz = 0;
  /**
   * Sidespin (Phase 37, Magnus): the velocity direction rotates at this
   * rate (rad/s, + = counterclockwise) while the ball is free — a constant
   * rate is a circular arc, which gives every projection (ballLanding,
   * interceptBall) an exact closed form. Set only by curled kicks
   * (`curlKick` in mechanics); zeroed by every plain kick and capture.
   */
  spin = 0;
  owner: Player | null = null;
  lastTouch: Player | null = null;

  /** In the air right now (grounded balls take the exact pre-Phase-28 path). */
  get airborne(): boolean {
    return this.z > 0 || this.vz !== 0;
  }

  /** Pure physical classification; match-law possessionPhase stays separate. */
  get physicalMode(): BallPhysicalMode {
    if (this.owner !== null) return 'controlled';
    return this.airborne ? 'freeAirborne' : 'freeGround';
  }

  reset(): void {
    this.pos = v2();
    this.vel = v2();
    this.z = 0;
    this.vz = 0;
    this.spin = 0;
    this.owner = null;
    this.lastTouch = null;
  }
}
