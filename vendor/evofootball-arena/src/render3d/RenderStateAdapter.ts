import { formationSpot } from '../ai/formations';
import type { CbFeed } from '../render/cbVisibility';
import type { Match } from '../sim/Match';
import type { ActionType, MatchPhase, Role, Side, TeamMode } from '../sim/types';

/**
 * RenderStateAdapter — the ONLY bridge between the authoritative 2D sim and
 * the 3D viewer. Pure functions, no three.js imports, fully testable.
 *
 * Coordinate mapping:  sim x -> world x,  sim y -> world z,  height -> world y.
 * Yaw convention: 0 faces world +z (sim +y); yaw = atan2(heading.x, heading.y),
 * so a model built facing +z turns to match the player's sim heading.
 */

export interface RenderPlayer {
  gid: number;
  side: Side;
  role: Role;
  /** Surname of the slot's CURRENT occupant (Phase 61) — carried per frame
   * so a substitution updates the nameplate. Absent in old replays: the
   * renderer then keeps the theme's (kickoff) name. */
  name?: string;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  action: ActionType;
  stamina: number;
  /** The occupant's evolved strength (Phase 76) — drives the body build.
   * Carried per frame (like `name`) so substitutions swap the body too.
   * Absent in old replays: the renderer falls back to a neutral build. */
  str?: number;
  /** A tackle lunge is playing (Phase 27) — display only. Optional: the
   * shootout theater and pre-Phase-27 replays never set it. */
  tackling?: boolean;
  /** Recovering after being dispossessed / a whiffed lunge (Phase 27). */
  stunned?: boolean;
  /** A keeper dive is playing (Phase 27.4) — display only. */
  saving?: boolean;
  /** A header jump is playing (Phase 28) — display only. */
  header?: boolean;
  /**
   * ⭐ CB (M-CB.3): seconds still to run on his OWN post-challenge recovery, verbatim from
   * `Player.tackleCooldown` — set only in a CB-armed match, and only for a body who did NOT
   * come away with the ball (see `buildRenderState`). In the armed world the miss branch
   * writes the physics-derived interval here, so this number IS his recovery clock.
   */
  cbRecover?: number;
  /**
   * ⭐ CB (M-CB.3): the braking (carry-through) leg of that interval still to run, verbatim
   * from `Player.stunTimer` — while it runs, his own momentum is still taking him past.
   */
  cbCarryThrough?: number;
}

export interface RenderBall {
  x: number;
  z: number;
  /** Real ball height (m) from the sim (Phase 28). Absent in old replays. */
  y?: number;
  vx: number;
  vz: number;
  speed: number;
  /** Sidespin (Phase 74, from the sim's Magnus field) — the path's turn
   * rate in rad/s. Drives the visible ball rotation on curled balls.
   * Absent in pre-curve replays. */
  spin?: number;
  ownerGid: number | null;
  /** Most recent physical touch, distinct from stable ownership (M3). */
  lastTouchGid?: number | null;
  /** A shot is currently in flight (drives trail emphasis + camera pulse). */
  isShot: boolean;
  /** A pass is currently in flight. */
  isPass: boolean;
  /** The keeper is holding the ball in their hands (Phase 27.2). */
  heldByGk?: boolean;
}

/** A recent notable event, for visual/audio feedback (deduped by `t`). */
export interface FxEvent {
  type: 'goal' | 'save' | 'shot' | 'interception' | 'corner' | 'foul' | 'card' | 'woodwork';
  side: Side;
  t: number;
  /** Attached for shots so the viewer can show chance quality. */
  xg?: number;
  /** Cards only (Phase 75): a sending-off, from the feed's own words. */
  red?: boolean;
  /** Fouls only (Phase 77): this whistle is an offside call — the sim
   * pushes offside as a `foul` whose text starts with "Offside". */
  offside?: boolean;
}

export interface OverlayState {
  /** Ball position -> intended receiver, while a pass is in flight. */
  passLine: { x1: number; z1: number; x2: number; z2: number } | null;
  /** Ball position -> short projection of shot velocity, while a shot flies. */
  shotLine: { x1: number; z1: number; x2: number; z2: number } | null;
  /** Marker -> marked opponent, both teams. */
  markLines: Array<{ x1: number; z1: number; x2: number; z2: number }>;
  /** Players currently assigned to press, with their positions. */
  chasers: Array<{ gid: number; x: number; z: number }>;
  /** Formation target (x/z) per player, plus the player's position (px/pz). */
  formation: Array<{ gid: number; side: Side; x: number; z: number; px: number; pz: number }>;
}

export interface RenderState {
  t: number;
  phase: MatchPhase;
  minute: number;
  /** Scoreboard clock with stoppage (`45+2`) — absent in old replays/theater. */
  clock?: string;
  score: [number, number];
  /** Side celebrating during goalPause, else -1. */
  celebratingSide: Side | -1;
  /** The scorer's gid during goalPause (celebrates harder), else null. */
  celebratingGid: number | null;
  players: RenderPlayer[];
  ball: RenderBall;
  overlays: OverlayState | null;
  /** Events from the last ~0.5s of sim time — viewers dedupe by `t`. */
  fx: FxEvent[];
  /**
   * Running penalty-shootout score while the shootout theater plays
   * (Phase 24). Never set by the live-sim adapter or replays.
   */
  shootout?: { h: number; a: number };
  /**
   * The BROADCAST layer's inputs (Phase 68, N4) — light, always built,
   * independent of the debug overlays. Absent in old replays: the
   * presentation degrades gracefully (no block outline, no press waves).
   */
  possession?: Side | -1;
  modes?: [TeamMode, TeamMode];
  /** Assigned pressers (both sides) — the press-wave emitters. */
  press?: Array<{ side: Side; x: number; z: number }>;
  /**
   * ⭐ CB (M-CB.3): the carry-beat feed, present ONLY while a CB door is armed (and therefore
   * absent from every production frame and every pre-rung replay). Two engine quantities and
   * nothing else — see `src/render/cbVisibility.ts` for what the viewers make of them.
   */
  cb?: CbFeed;
}

/** Static per-match info the 3D scene needs once (kits, names, roles). */
export interface RenderTheme {
  teams: Array<{
    primary: number;
    secondary: number;
    short: string;
    name: string;
    /** The named coach (Phase 66, N3) — drives the touchline figure.
     * Missing (ad-hoc teams, old replays) = no dugout presence. */
    coach?: string;
    /** His tinkerBias gene (66.1) — the touchline figure's temperament:
     * the tinkerer gesticulates, the stoic folds his arms. Display only. */
    tinker?: number;
  }>;
  players: Array<{ gid: number; side: Side; role: Role; name: string }>;
}

export function buildRenderTheme(match: Match): RenderTheme {
  return {
    teams: match.teams.map((t) => ({
      primary: t.info.colors.primary,
      secondary: t.info.colors.secondary,
      short: t.info.short,
      name: t.info.name,
      coach: t.info.coachName,
      tinker: t.info.genome.tinkerBias ?? 0.5,
    })),
    players: match.allPlayers.map((p) => ({ gid: p.gid, side: p.side, role: p.role, name: p.name })),
  };
}

export function buildRenderState(match: Match, includeOverlays: boolean): RenderState {
  let celebratingSide: Side | -1 = -1;
  if (match.phase === 'goalPause') {
    for (let i = match.events.length - 1; i >= 0; i--) {
      const ev = match.events[i];
      if (ev.type === 'goal') {
        celebratingSide = ev.side as Side;
        break;
      }
    }
  }

  const players: RenderPlayer[] = match.allPlayers.map((p) => ({
    gid: p.gid,
    side: p.side,
    role: p.role,
    name: p.name,
    x: p.pos.x,
    z: p.pos.y,
    yaw: Math.atan2(p.heading.x, p.heading.y),
    speed: Math.hypot(p.vel.x, p.vel.y),
    action: p.action.type,
    stamina: p.stamina,
    str: p.attrs.strength,
    tackling: p.tackleAnimTimer > 0,
    stunned: p.stunTimer > 0,
    saving: p.saveAnimTimer > 0,
    header: p.headerAnimTimer > 0,
  }));

  // ⭐ CB (M-CB.3) — THE ONE CB FORK IN THE RENDER BRIDGE. False in every production match, so
  // the loop below never runs, no field is added and no object shape moves; the two reads it
  // then performs are of state the players already publish.
  //
  // ⚠ WHO GETS THE MARK: a body inside his own `tackleCooldown` who is NOT the ball's last
  // toucher. A WON challenge makes its winner the last toucher (`ball.lastTouch = tackler`, the
  // engine's own line), so the winner is excluded and what is left is the man who challenged
  // and did not come away with it — which is what "beaten" means on screen. The renderer adds
  // no knowledge of its own: both halves are read off the match.
  if (match.cbCommitPhysics || match.cbTouchPast || match.cbChoiceSeat) {
    for (let i = 0; i < players.length; i++) {
      const p = match.allPlayers[i];
      if (p.tackleCooldown > 0 && match.ball.lastTouch !== p) {
        players[i].cbRecover = p.tackleCooldown;
        players[i].cbCarryThrough = p.stunTimer;
      }
    }
  }

  const ball: RenderBall = {
    x: match.ball.pos.x,
    z: match.ball.pos.y,
    y: match.ball.z,
    vx: match.ball.vel.x,
    vz: match.ball.vel.y,
    speed: Math.hypot(match.ball.vel.x, match.ball.vel.y),
    spin: match.ball.spin,
    ownerGid: match.ball.owner ? match.ball.owner.gid : null,
    lastTouchGid: match.ball.lastTouch ? match.ball.lastTouch.gid : null,
    isShot: match.pendingShot !== null,
    isPass: match.pendingPass !== null,
    // gkDistributing too (Phase 97 — the LAST raw-timer consumer): the
    // shape-wait re-arms the hold in 0.25s quanta, and in the timer==0 gaps
    // (measured 21.6% of distribution frames, `hold-jitter.ts`) a raw-timer
    // read flickered heldByGk off — BallModel's heldY sawtoothed 4×/s, the
    // reported 持球上下颤动. Every SIM consumer was patched in 31.9; the
    // render adapter was the one left behind.
    heldByGk:
      match.ball.owner !== null &&
      (match.ball.owner.gkHoldTimer > 0 ||
        (match.ball.owner.role === 'GK' && match.ball.owner.gkDistributing)),
  };

  const state: RenderState = {
    t: match.simTime,
    phase: match.phase,
    minute: match.minute(),
    clock: match.clockText(),
    score: [match.score[0], match.score[1]],
    celebratingSide,
    celebratingGid: match.phase === 'goalPause' ? match.lastScorerGid : null,
    players,
    ball,
    overlays: includeOverlays ? buildOverlays(match) : null,
    fx: buildFx(match),
    possession: match.possessionSide,
    modes: [match.teams[0].mode, match.teams[1].mode],
    press: match.teams.flatMap((team) =>
      [...team.chasers].map((idx) => {
        const p = team.players[idx];
        return { side: team.side, x: p.pos.x, z: p.pos.y };
      }),
    ),
  };
  // The touch-past door is what makes a knock POSSIBLE, so it is what the feed keys off; an
  // unarmed match never reaches this line and its state object is the shipped one, field for
  // field (no empty-object spread, no allocation).
  if (match.cbTouchPast) state.cb = cbFeedOf(match);
  return state;
}

/**
 * ⭐ CB (M-CB.3): the two engine quantities the knock affordance is drawn from.
 *
 * `touchPasts` is `performTouchPast`'s own monotone counter — the ONLY thing in the engine that
 * says an aimed knock has fired, and nothing in the sim ever reads it back. `dribbleTouch` is
 * the engine's existing "this loose ball is still HIS touch" marker, which the touch-past sets
 * exactly as the incumbent push does. Both are read; neither is written.
 */
function cbFeedOf(match: Match): CbFeed {
  const touch = match.dribbleTouch;
  return {
    knocks: match.cbLedger.touchPasts,
    touch: touch === null ? null : { gid: touch.gid, until: touch.until },
  };
}

const FX_WINDOW = 0.5;

function buildFx(match: Match): FxEvent[] {
  const out: FxEvent[] = [];
  for (let i = match.events.length - 1; i >= 0; i--) {
    const ev = match.events[i];
    if (match.simTime - ev.t > FX_WINDOW) break;
    if (
      ev.type === 'goal' || ev.type === 'save' || ev.type === 'shot' ||
      ev.type === 'interception' || ev.type === 'corner' ||
      ev.type === 'foul' || ev.type === 'card' || ev.type === 'woodwork'
    ) {
      // ADVANTAGE fouls never stop play (27.2) — no whistle, in sound or
      // animation (user report, Phase 111 session). The feed line stays.
      if (ev.type === 'foul' && ev.text.endsWith('— advantage')) continue;
      const fx: FxEvent = { type: ev.type, side: ev.side as Side, t: ev.t };
      // The card's color lives only in the feed text — mine it (Phase 75).
      if (ev.type === 'card') fx.red = /SENT OFF|STRAIGHT RED/.test(ev.text);
      // Offside is pushed as a foul; the text is its only marker (Phase 77).
      if (ev.type === 'foul') fx.offside = ev.text.startsWith('Offside');
      if (ev.type === 'shot') {
        for (let j = match.shotLog.length - 1; j >= 0; j--) {
          const s = match.shotLog[j];
          if (Math.abs(s.t - ev.t) < 0.03 && s.side === ev.side) {
            fx.xg = s.xg;
            break;
          }
          if (ev.t - s.t > FX_WINDOW) break;
        }
      }
      out.push(fx);
    }
  }
  return out.reverse();
}

/**
 * The single source of truth for debug-overlay geometry — the 2D DebugOverlay
 * and the 3D Overlays3D both consume this (no duplicated projection math).
 */
export function buildOverlays(match: Match): OverlayState {
  let passLine: OverlayState['passLine'] = null;
  if (match.pendingPass) {
    const target = match.allPlayers.find((p) => p.gid === match.pendingPass!.targetGid);
    if (target) {
      passLine = { x1: match.ball.pos.x, z1: match.ball.pos.y, x2: target.pos.x, z2: target.pos.y };
    }
  }

  let shotLine: OverlayState['shotLine'] = null;
  if (match.pendingShot && !match.ball.owner) {
    shotLine = {
      x1: match.ball.pos.x,
      z1: match.ball.pos.y,
      x2: match.ball.pos.x + match.ball.vel.x * 0.45,
      z2: match.ball.pos.y + match.ball.vel.y * 0.45,
    };
  }

  const markLines: OverlayState['markLines'] = [];
  const chasers: OverlayState['chasers'] = [];
  for (const team of match.teams) {
    const opp = match.teams[1 - team.side];
    for (const [ownIdx, oppIdx] of team.marks) {
      const a = team.players[ownIdx];
      const b = opp.players[oppIdx];
      markLines.push({ x1: a.pos.x, z1: a.pos.y, x2: b.pos.x, z2: b.pos.y });
    }
    for (const idx of team.chasers) {
      const p = team.players[idx];
      chasers.push({ gid: p.gid, x: p.pos.x, z: p.pos.y });
    }
  }

  const formation: OverlayState['formation'] = [];
  for (const team of match.teams) {
    const hasBall = match.possessionSide === team.side;
    for (const p of team.players) {
      const spot = formationSpot(p, team, match.ball, hasBall);
      formation.push({ gid: p.gid, side: team.side, x: spot.x, z: spot.y, px: p.pos.x, pz: p.pos.y });
    }
  }

  return { passLine, shotLine, markLines, chasers, formation };
}

/* ---------------- interpolation (replay smoothing) ---------------- */

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest-path angular interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Blend two adjacent snapshots for smooth replay scrubbing. Discrete fields
 * (action, phase, score, possession) snap to the newer state at alpha >= 0.5.
 */
export function interpolateStates(a: RenderState, b: RenderState, alpha: number): RenderState {
  const t = Math.max(0, Math.min(1, alpha));
  const late = t >= 0.5 ? b : a;
  return {
    t: lerp(a.t, b.t, t),
    phase: late.phase,
    minute: late.minute,
    clock: late.clock,
    score: late.score,
    celebratingSide: late.celebratingSide,
    celebratingGid: late.celebratingGid,
    fx: late.fx,
    shootout: late.shootout,
    possession: late.possession,
    modes: late.modes,
    press: late.press,
    players: a.players.map((pa, i) => {
      const pb = b.players[i] ?? pa;
      return {
        gid: pa.gid,
        side: pa.side,
        role: pa.role,
        name: (t >= 0.5 ? pb : pa).name,
        x: lerp(pa.x, pb.x, t),
        z: lerp(pa.z, pb.z, t),
        yaw: lerpAngle(pa.yaw, pb.yaw, t),
        speed: lerp(pa.speed, pb.speed, t),
        action: (t >= 0.5 ? pb : pa).action,
        stamina: lerp(pa.stamina, pb.stamina, t),
        str: (t >= 0.5 ? pb : pa).str,
        // `=== true` also maps pre-Phase-27 replay snapshots (undefined) to false.
        tackling: (t >= 0.5 ? pb : pa).tackling === true,
        stunned: (t >= 0.5 ? pb : pa).stunned === true,
        saving: (t >= 0.5 ? pb : pa).saving === true,
        header: (t >= 0.5 ? pb : pa).header === true,
        // ⭐ CB: countdowns SNAP with the other discrete fields rather than blending — a
        // scrubbed frame must never show a recovery clock that no tick of the match ever
        // held. Absent (production, pre-rung replays) stays absent.
        cbRecover: (t >= 0.5 ? pb : pa).cbRecover,
        cbCarryThrough: (t >= 0.5 ? pb : pa).cbCarryThrough,
      };
    }),
    ball: {
      x: lerp(a.ball.x, b.ball.x, t),
      z: lerp(a.ball.z, b.ball.z, t),
      // `?? 0` maps pre-Phase-28 replay snapshots onto the ground.
      y: lerp(a.ball.y ?? 0, b.ball.y ?? 0, t),
      vx: lerp(a.ball.vx, b.ball.vx, t),
      vz: lerp(a.ball.vz, b.ball.vz, t),
      speed: lerp(a.ball.speed, b.ball.speed, t),
      // `?? 0` maps pre-Phase-74 replay snapshots onto no-spin.
      spin: lerp(a.ball.spin ?? 0, b.ball.spin ?? 0, t),
      ownerGid: late.ball.ownerGid,
      lastTouchGid: late.ball.lastTouchGid ?? null,
      isShot: late.ball.isShot,
      isPass: late.ball.isPass,
      heldByGk: late.ball.heldByGk === true,
    },
    overlays: null,
    cb: late.cb,
  };
}
