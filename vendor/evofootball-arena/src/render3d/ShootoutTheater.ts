import { HALF_L, PENALTY_SPOT_DIST } from '../sim/constants';
import type { ShootoutKick } from '../sim/cup';
import { TEAM_SIZE } from '../sim/types';
import type { RenderPlayer, RenderState } from './RenderStateAdapter';

/**
 * ShootoutTheater (Phase 24) — stages an already-decided penalty shootout as
 * a kick-by-kick 3D presentation. Pure RenderState synthesizer: no three.js,
 * no sim access, no randomness — the outcome was computed by the same seeded
 * `resolveShootout` the League records, and this class only choreographs the
 * recorded kick script (walk-up, strike, dive, celebration; the deciding
 * kick in slow motion). Wall-clock driven and skippable; it never mutates
 * sim state, so watched-vs-skipped equivalence is untouched.
 */

type SegmentKind = 'intro' | 'walk' | 'set' | 'strike' | 'outcome' | 'finale';

interface Segment {
  kind: SegmentKind;
  dur: number;
  /** Index into `kicks` for per-kick segments. */
  kick: number;
}

/** Theater states use this time base so fx keys never collide with match events. */
const T_BASE = 100000;
/** How long an fx event stays in the outgoing state (FxSystem dedupes by t). */
const FX_WINDOW = 0.3;
/** Ball flight within a strike segment: launch → arrival (fractions of dur). */
const LAUNCH_F = 0.22;
const ARRIVE_F = 0.62;

export class ShootoutTheater {
  private readonly kicks: ShootoutKick[];
  private readonly score: [number, number];
  private readonly template: RenderPlayer[];
  private readonly segments: Segment[];
  private readonly total: number;
  /** +1: staged at the +x goal, -1: the -x goal (the winner's attacking end). */
  private readonly sign: 1 | -1;
  private readonly winner: 0 | 1;
  /** Fixed waiting spot (sim coords) per gid. */
  private readonly waitSpot = new Map<number, { x: number; y: number }>();

  private elapsed = 0;
  private emittedFeed = 0; // kicks whose outcome has started (feed cursor)
  private feedCursor = 0; //  ...of which GameApp has taken
  private goalFired = false; // the finale's banner/net-shake fx fires once
  private fx: Array<{ type: 'save' | 'goal'; side: 0 | 1; t: number }> = [];

  constructor(kicks: ShootoutKick[], players: RenderPlayer[], score: [number, number]) {
    if (kicks.length === 0) throw new Error('empty shootout script');
    this.kicks = kicks;
    this.score = score;
    this.template = players.map((p) => ({ ...p }));
    const last = kicks[kicks.length - 1];
    this.winner = last.h > last.a ? 0 : 1;
    this.sign = this.winner === 0 ? 1 : -1;

    this.segments = [{ kind: 'intro', dur: 2.2, kick: -1 }];
    kicks.forEach((_, i) => {
      const deciding = i === kicks.length - 1;
      this.segments.push(
        { kind: 'walk', dur: 1.6, kick: i },
        { kind: 'set', dur: 0.5, kick: i },
        { kind: 'strike', dur: deciding ? 2.0 : 0.9, kick: i }, // deciding kick: slow motion
        { kind: 'outcome', dur: deciding ? 3.0 : 1.4, kick: i },
      );
    });
    this.segments.push({ kind: 'finale', dur: 3.4, kick: kicks.length - 1 });
    this.total = this.segments.reduce((a, s) => a + s.dur, 0);

    // Waiting lines: both teams cluster just outside the box arc (so the
    // behind-goal camera keeps the whole cast in frame and every walk-up is
    // a plausible ~13 m); the spare keeper waits beside the staged goal.
    for (const p of this.template) {
      if (p.role === 'GK') {
        this.waitSpot.set(p.gid, { x: this.sign * (HALF_L - 1.2), y: p.side === 0 ? 5.5 : -5.5 });
      } else {
        const rank = p.gid % TEAM_SIZE; // 1..TEAM_SIZE-1 within the team
        this.waitSpot.set(p.gid, {
          x: this.sign * (HALF_L - 19.5 - rank * 1.1),
          y: p.side === 0 ? -7 - rank * 1.4 : 7 + rank * 1.4,
        });
      }
    }
  }

  get done(): boolean {
    return this.elapsed >= this.total;
  }

  /** True during the closing celebration — the director cuts to a wide shot. */
  get finale(): boolean {
    return this.current()?.kind === 'finale';
  }

  /** Jump straight to the end (skip button / view switches). */
  skip(): void {
    this.elapsed = this.total;
    this.emittedFeed = this.kicks.length;
  }

  /** Kicks whose outcome has landed since the last call — for feed lines. */
  takeEvents(): ShootoutKick[] {
    const out = this.kicks.slice(this.feedCursor, this.emittedFeed);
    this.feedCursor = this.emittedFeed;
    return out;
  }

  /** For dev tooling (`__evo.theater()`). */
  info(): { kick: number; total: number; pens: [number, number]; done: boolean } {
    const seg = this.current();
    return {
      kick: seg?.kick ?? this.kicks.length - 1,
      total: this.kicks.length,
      pens: [this.pens().h, this.pens().a],
      done: this.done,
    };
  }

  private current(): Segment | null {
    let t = this.elapsed;
    for (const s of this.segments) {
      if (t < s.dur) return s;
      t -= s.dur;
    }
    return null;
  }

  /** Running pens score shown on the bug: post-kick once the outcome lands. */
  private pens(): { h: number; a: number } {
    const upto = this.emittedFeed - 1;
    if (upto < 0) return { h: 0, a: 0 };
    return { h: this.kicks[upto].h, a: this.kicks[upto].a };
  }

  advance(dt: number): RenderState {
    this.elapsed = Math.min(this.elapsed + dt, this.total);

    // Locate the current segment and its local time.
    let t = this.elapsed;
    let seg: Segment = this.segments[this.segments.length - 1];
    for (const s of this.segments) {
      if (t < s.dur || s === this.segments[this.segments.length - 1]) {
        seg = s;
        break;
      }
      t -= s.dur;
    }
    const f = Math.min(t / seg.dur, 1); // segment progress 0..1

    const kick = seg.kick >= 0 ? this.kicks[seg.kick] : null;
    const spot = { x: this.sign * (HALF_L - PENALTY_SPOT_DIST), y: 0 };
    const goalX = this.sign * HALF_L;

    // Outcome landing: advance the feed/pens cursor + fire one-shot fx.
    if (kick && (seg.kind === 'outcome' || seg.kind === 'finale') && this.emittedFeed <= seg.kick) {
      this.emittedFeed = seg.kick + 1;
      if (!kick.scored) {
        this.fx.push({ type: 'save', side: (1 - kick.side) as 0 | 1, t: T_BASE + this.elapsed });
      }
    }
    if (seg.kind === 'finale' && !this.goalFired) {
      // The winning moment: banner + net shake + confetti, exactly once.
      this.goalFired = true;
      this.fx.push({ type: 'goal', side: this.winner, t: T_BASE + this.elapsed });
    }

    // ---- choreograph the 10 players + ball ----
    const kickerGid = kick ? kick.side * TEAM_SIZE + kick.kicker : -1;
    const keeperGid = kick ? (1 - kick.side) * TEAM_SIZE : -1; // defending keeper
    const standX = spot.x - this.sign * 1.3;

    const ball = { x: spot.x, z: spot.y, vx: 0, vz: 0, speed: 0, ownerGid: null as number | null, isShot: false, isPass: false };
    let celebratingSide: 0 | 1 | -1 = -1;
    let celebratingGid: number | null = null;

    // Ball target for this kick: scored → corner; saved → within the keeper's reach.
    const cornerZ = kick ? (seg.kick % 2 === 0 ? 1 : -1) * (kick.scored ? 2.45 : 0.85) : 0;
    const ballEnd = kick
      ? kick.scored
        ? { x: goalX + this.sign * 0.7, y: cornerZ }
        : { x: goalX - this.sign * 0.9, y: cornerZ }
      : spot;

    if (seg.kind === 'strike' && kick) {
      if (f < LAUNCH_F) {
        ball.ownerGid = kickerGid;
      } else {
        const ff = Math.min((f - LAUNCH_F) / (ARRIVE_F - LAUNCH_F), 1);
        ball.x = spot.x + (ballEnd.x - spot.x) * ff;
        ball.z = spot.y + (ballEnd.y - spot.y) * ff;
        ball.isShot = ff < 1;
        const flight = (ARRIVE_F - LAUNCH_F) * seg.dur;
        ball.vx = (ballEnd.x - spot.x) / flight;
        ball.vz = (ballEnd.y - spot.y) / flight;
        ball.speed = Math.hypot(ball.vx, ball.vz);
        if (ff >= 1 && !kick.scored) {
          // Parried: the ball sits where the keeper pushed it.
          ball.x = ballEnd.x - this.sign * 1.5;
          ball.z = cornerZ * 2.2;
          ball.vx = 0;
          ball.vz = 0;
          ball.speed = 0;
        }
      }
    } else if ((seg.kind === 'outcome' || seg.kind === 'finale') && kick) {
      ball.x = kick.scored ? ballEnd.x : ballEnd.x - this.sign * 1.5;
      ball.z = kick.scored ? ballEnd.y : cornerZ * 2.2;
    } else if (seg.kind === 'walk' || seg.kind === 'set') {
      ball.ownerGid = seg.kind === 'set' ? kickerGid : null;
    }

    if (seg.kind === 'outcome' && kick) {
      celebratingSide = kick.scored ? kick.side : ((1 - kick.side) as 0 | 1);
      celebratingGid = kick.scored ? kickerGid : null;
    } else if (seg.kind === 'finale') {
      celebratingSide = this.winner;
      celebratingGid = kick && kick.scored && kick.side === this.winner ? kickerGid : null;
    }

    const players: RenderPlayer[] = this.template.map((p) => {
      const wait = this.waitSpot.get(p.gid)!;
      let x = wait.x;
      let y = wait.y;
      let action: RenderPlayer['action'] = 'HoldPosition';
      let speed = 0;
      let face = { x: spot.x - x, y: spot.y - y }; // everyone watches the spot

      if (p.gid === keeperGid) {
        // Defending keeper: on the line, facing the kicker; dives on the strike.
        x = goalX - this.sign * 0.4;
        y = 0;
        face = { x: -this.sign, y: 0 };
        action = seg.kind === 'strike' && f >= LAUNCH_F ? 'GoalkeeperSave' : 'GoalkeeperPosition';
      } else if (p.gid === kickerGid) {
        if (seg.kind === 'walk') {
          // Approach from the waiting line to the spot.
          x = wait.x + (standX - wait.x) * f;
          y = wait.y + (spot.y - wait.y) * f;
          face = { x: standX - wait.x, y: spot.y - wait.y };
          action = 'MoveToFormationSpot';
          speed = Math.hypot(standX - wait.x, spot.y - wait.y) / seg.dur;
        } else {
          x = standX;
          y = spot.y;
          face = { x: this.sign, y: 0 };
          if (seg.kind === 'strike') action = f < LAUNCH_F + 0.18 ? 'Shoot' : 'HoldPosition';
        }
      }

      return {
        gid: p.gid,
        side: p.side,
        role: p.role,
        x,
        z: y,
        yaw: Math.atan2(face.x, face.y),
        speed,
        action,
        stamina: p.stamina,
      };
    });

    // Keep only fresh fx in the outgoing state (FxSystem dedupes repeats).
    this.fx = this.fx.filter((e) => T_BASE + this.elapsed - e.t < FX_WINDOW);

    return {
      t: T_BASE + this.elapsed,
      phase: 'fulltime',
      minute: 90,
      score: this.score,
      celebratingSide,
      celebratingGid,
      players,
      ball,
      overlays: null,
      fx: this.fx.map((e) => ({ type: e.type, side: e.side, t: e.t })),
      shootout: this.pens(),
    };
  }
}
