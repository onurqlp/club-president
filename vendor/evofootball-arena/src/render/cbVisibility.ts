/**
 * ⭐⭐ CB — THE FRONTEND VISIBILITY RUNG (contract CB-CARRY-BEAT-CONTRACT.md §2 M-CB.3, the
 * user's own clause 让人看到; docs/world-model/CB-FRONTEND-VISIBILITY-RUNG.md).
 *
 * This module turns the CB-armed match's OWN state into the small set of quantities the two
 * viewers draw. It is the single owner of that derivation so the 2D and 3D views can never
 * show two different stories, and it is PURE: no pixi, no three, no `Match`, no timers of its
 * own — it is handed a frame and returns what to draw for it.
 *
 * ⭐⭐ THE RULE THIS MODULE EXISTS TO KEEP (contract §-1: the rendering must SHOW what happened,
 * never decorate it):
 *
 *   * THE KNOCK'S PATH IS THE BALL'S OWN PAST POSITIONS. Every point in the trail is a
 *     position the ball ACTUALLY OCCUPIED on a frame the viewer sampled. Nothing is predicted,
 *     interpolated toward an aim point, or extrapolated: if the defender wins the race, the
 *     trail simply stops where the ball stopped.
 *   * THE BEATEN RING'S DURATION IS HIS OWN RECOVERY CLOCK. The mark exists exactly as long as
 *     the engine's own `tackleCooldown` on that body, and it fades in lockstep with it. There
 *     is NO duration constant here — the only thing this module remembers is the value the
 *     engine wrote at the miss (the rising edge), which is what turns "seconds left" into
 *     "how much of HIS recovery is left".
 *   * THE COLOUR SPLIT IS REAL STATE, not a flourish: while `stunTimer` still runs he is being
 *     carried through by his own momentum (the brake leg of the physics-derived interval);
 *     after it he is turning and closing. Two legs, two colours, one real boundary.
 *
 * READ-ONLY: this module holds no reference to any sim object and writes nothing anywhere.
 * Its inputs are numbers already published on the render state.
 *
 * COST (the user plays on a phone): all state is allocated ONCE — the trail is a fixed
 * `Float64Array`, the output marks are a fixed pool of records reused every frame, and the
 * rising-edge memory is one `Map` keyed by gid. A frame does bounded arithmetic over ≤ 12
 * bodies and appends at most one trail point. No per-frame allocation.
 */

/** The carry-beat feed a CB-armed match publishes each frame (see `RenderStateAdapter`). */
export interface CbFeed {
  /** `Match.cbLedger.touchPasts` — the monotone count of aimed knocks that have fired. */
  readonly knocks: number;
  /**
   * `Match.dribbleTouch` — the body whose feet the ball just left and the sim time at which
   * the engine stops calling the loose ball his knock. Null when no touch is live.
   */
  readonly touch: { readonly gid: number; readonly until: number } | null;
}

/** The per-body slice this module reads — `RenderPlayer` satisfies it structurally. */
export interface CbBodyFrame {
  readonly gid: number;
  readonly x: number;
  readonly z: number;
  /** Seconds still to run on his own post-challenge recovery (`Player.tackleCooldown`). */
  readonly cbRecover?: number;
  /** Seconds still to run on the braking leg of it (`Player.stunTimer`). */
  readonly cbCarryThrough?: number;
}

/** One body to mark: where he is, and how far through his own recovery he is. */
export interface CbBeatenMark {
  gid: number;
  x: number;
  z: number;
  /** Seconds left, verbatim from his `tackleCooldown`. */
  remain: number;
  /** `remain` ÷ the value the engine wrote at the miss — 1 at the miss, 0 when he is back. */
  frac: number;
  /** His `stunTimer` is still running: his own momentum is still carrying him past. */
  carryThrough: boolean;
}

/** The live knock: where the ball left the feet, and every position it has held since. */
export interface CbKnockMark {
  /** The knocker's gid (`Match.dribbleTouch.gid`). */
  gid: number;
  /** The release point — the ball's own position on the first frame after it left the feet. */
  x0: number;
  z0: number;
  /**
   * The ball's own past positions, oldest first, as a flat x/z pair list. `Float64Array`
   * deliberately: these are the engine's own coordinates, and a trail that claims to BE the
   * ball's path may not round it (the GPU buffer downcasts at the draw, which is the renderer's
   * business, not this claim's).
   */
  path: Float64Array;
  /** How many pairs of `path` are live. */
  points: number;
  /** The race is still on (nobody has the ball and the engine still calls it his knock). */
  live: boolean;
  /** 1 while live, decaying to 0 across the linger once the race has resolved. */
  alpha: number;
}

/** What to draw this frame. Both fields are POOLED — copy anything you keep. */
export interface CbVisible {
  knock: CbKnockMark | null;
  /** The bodies to ring; only the first `beatenCount` entries are live. */
  readonly beaten: readonly CbBeatenMark[];
  beatenCount: number;
}

/* ---------------- presentation constants (declared in the stage doc's table) ---------------- */

/**
 * How many of the ball's own positions the trail can hold. A knock's race lasts at most the
 * engine's own regather window (~1.6 s of marker), so 96 points covers it at 60 fps with the
 * sampling step below; the buffer is a ring, and an over-long episode drops its oldest points.
 */
export const CB_TRAIL_MAX_POINTS = 96;
/**
 * The minimum distance (m) the ball must have travelled before another point is recorded. A
 * SAMPLING choice, not a shape claim: it keeps a stationary ball from filling the buffer with
 * one repeated point. The path it produces is still made only of positions the ball held.
 */
export const CB_TRAIL_MIN_STEP_M = 0.2;
/**
 * How long (s of sim time) the resolved knock's trail lingers before it disappears. PURELY
 * presentation — it decides how long the EYE gets to see a path the ball has already finished
 * travelling, and it never extends or invents any part of that path.
 */
export const CB_KNOCK_LINGER_S = 0.9;

/* ------------------------------------------------------------------ */

const MAX_BODIES = 32;

export class CbVisibility {
  private readonly path = new Float64Array(CB_TRAIL_MAX_POINTS * 2);
  private points = 0;
  private knock: CbKnockMark;
  private open = false;
  /** Sim time at which the race resolved (−1 while it is still on). */
  private resolvedT = -1;
  private lastKnocks = -1;
  /** The recovery value the engine wrote at the miss, per gid — the rising edge, remembered. */
  private readonly peak = new Map<number, number>();
  private readonly marks: CbBeatenMark[] = [];
  private readonly out: CbVisible;

  constructor() {
    this.knock = { gid: -1, x0: 0, z0: 0, path: this.path, points: 0, live: false, alpha: 0 };
    for (let i = 0; i < MAX_BODIES; i++) {
      this.marks.push({ gid: -1, x: 0, z: 0, remain: 0, frac: 0, carryThrough: false });
    }
    this.out = { knock: null, beaten: this.marks, beatenCount: 0 };
  }

  /** Forget everything — a new match, or a view that just came back on screen. */
  reset(): void {
    this.points = 0;
    this.open = false;
    this.resolvedT = -1;
    this.lastKnocks = -1;
    this.peak.clear();
    this.out.knock = null;
    this.out.beatenCount = 0;
  }

  /**
   * Fold one frame in and return what to draw. `feed` null (an unarmed match, or a replay
   * snapshot recorded before this rung) ⇒ nothing is drawn and nothing is remembered.
   */
  update(
    t: number, ballX: number, ballZ: number, ballOwned: boolean,
    feed: CbFeed | null, bodies: readonly CbBodyFrame[],
  ): CbVisible {
    if (feed === null) {
      if (this.lastKnocks !== -1 || this.out.beatenCount !== 0) this.reset();
      return this.out;
    }
    this.updateKnock(t, ballX, ballZ, ballOwned, feed);
    this.updateBeaten(bodies);
    return this.out;
  }

  private updateKnock(
    t: number, ballX: number, ballZ: number, ballOwned: boolean, feed: CbFeed,
  ): void {
    // ⭐ THE KNOCK MOMENT, off the engine's own monotone counter: `cbLedger.touchPasts` only
    // ever rises inside `performTouchPast`, so a rise between two frames IS a knock having
    // fired. The counter carries no position, which is exactly why the release point is taken
    // as the ball's OWN position on this frame rather than reconstructed (§DOUBTS 1).
    if (feed.knocks > this.lastKnocks && this.lastKnocks >= 0) {
      this.points = 0;
      this.open = true;
      this.resolvedT = -1;
      this.knock.gid = feed.touch === null ? -1 : feed.touch.gid;
      this.knock.x0 = ballX;
      this.knock.z0 = ballZ;
    }
    this.lastKnocks = feed.knocks;

    if (!this.open) {
      this.out.knock = null;
      return;
    }
    if (this.resolvedT < 0) {
      this.record(ballX, ballZ);
      // THE RACE IS OVER when somebody has the ball, or when the engine itself stops calling
      // this loose ball his knock (`dribbleTouch` expired or was replaced). Both are the
      // engine's own state; the viewer invents no end.
      const stillHis = feed.touch !== null && feed.touch.gid === this.knock.gid && t <= feed.touch.until;
      if (ballOwned || !stillHis) this.resolvedT = t;
    }
    const age = this.resolvedT < 0 ? 0 : t - this.resolvedT;
    if (age > CB_KNOCK_LINGER_S) {
      this.open = false;
      this.out.knock = null;
      return;
    }
    this.knock.points = this.points;
    this.knock.live = this.resolvedT < 0;
    this.knock.alpha = this.resolvedT < 0 ? 1 : Math.max(0, 1 - age / CB_KNOCK_LINGER_S);
    this.out.knock = this.knock;
  }

  /** Append the ball's current position if it has moved far enough to be a new sample. */
  private record(x: number, z: number): void {
    if (this.points > 0) {
      const px = this.path[(this.points - 1) * 2];
      const pz = this.path[(this.points - 1) * 2 + 1];
      if (Math.hypot(x - px, z - pz) < CB_TRAIL_MIN_STEP_M) return;
    }
    if (this.points === CB_TRAIL_MAX_POINTS) {
      this.path.copyWithin(0, 2);
      this.points--;
    }
    this.path[this.points * 2] = x;
    this.path[this.points * 2 + 1] = z;
    this.points++;
  }

  private updateBeaten(bodies: readonly CbBodyFrame[]): void {
    let n = 0;
    for (const b of bodies) {
      const remain = b.cbRecover ?? 0;
      if (remain <= 0) {
        // He is back in the duel: the memory of what he paid goes with him.
        if (this.peak.size > 0) this.peak.delete(b.gid);
        continue;
      }
      // ⭐ THE RISING EDGE IS THE PRICE HE PAID. Inside one recovery the timer only counts
      // down, so the largest value seen since it started IS the interval the engine wrote at
      // the miss — read out of his state, never a styling constant.
      const prev = this.peak.get(b.gid) ?? 0;
      const peak = remain > prev ? remain : prev;
      if (peak !== prev) this.peak.set(b.gid, peak);
      if (n === MAX_BODIES) break;
      const m = this.marks[n++];
      m.gid = b.gid;
      m.x = b.x;
      m.z = b.z;
      m.remain = remain;
      m.frac = peak > 0 ? Math.min(1, remain / peak) : 0;
      m.carryThrough = (b.cbCarryThrough ?? 0) > 0;
    }
    this.out.beatenCount = n;
  }
}
