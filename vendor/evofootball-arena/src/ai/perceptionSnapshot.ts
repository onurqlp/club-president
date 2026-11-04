import type { Match } from '../sim/Match';
import type { Side } from '../sim/types';
import type { V2 } from '../utils/vec';

export interface PerceptionTruthPlayer {
  readonly gid: number;
  readonly side: Side;
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
  readonly bodyDir: Readonly<V2>;
  readonly sentOff: boolean;
}

export interface PerceptionTruth {
  readonly tick: number;
  readonly ball: {
    readonly pos: Readonly<V2>;
    readonly vel: Readonly<V2>;
    readonly ownerGid: number | null;
  };
  readonly players: readonly PerceptionTruthPlayer[];
}

export interface ObservedPlayer {
  readonly gid: number;
  readonly side: Side;
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
  readonly bodyDir: Readonly<V2>;
  readonly observedTick: number;
  readonly ageTicks: number;
}

export interface ObservedBall {
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
  readonly ownerGid: number | null;
  readonly observedTick: number;
  readonly ageTicks: number;
}

export interface PerceptionSnapshot {
  readonly tick: number;
  readonly observerGid: number;
  readonly awareness: number;
  readonly ball: ObservedBall | null;
  readonly players: readonly ObservedPlayer[];
}

/** Observer-owned attention pose. It changes only the visual cone, never body truth. */
export interface ObserverGaze {
  readonly observerGid: number;
  readonly gazeDir: Readonly<V2>;
  readonly establishedTick: number;
}

interface StoredPlayer extends Omit<ObservedPlayer, 'ageTicks'> {}
interface StoredBall extends Omit<ObservedBall, 'ageTicks'> {}

export interface PerceptionMemory {
  nextScanTick: number;
  ball: StoredBall | null;
  readonly players: Map<number, StoredPlayer>;
}

export function createPerceptionMemory(): PerceptionMemory {
  return { nextScanTick: -1, ball: null, players: new Map() };
}

/** Validate, normalise and copy one private gaze choice. */
export function createObserverGaze(
  observerGid: number,
  gazeDir: Readonly<V2>,
  establishedTick: number,
): ObserverGaze | null {
  const length = Math.hypot(gazeDir.x, gazeDir.y);
  if (
    !Number.isInteger(observerGid)
    || observerGid < 0
    || !Number.isInteger(establishedTick)
    || establishedTick < 0
    || !Number.isFinite(gazeDir.x)
    || !Number.isFinite(gazeDir.y)
    || length <= 1e-9
  ) return null;
  return {
    observerGid,
    gazeDir: { x: gazeDir.x / length, y: gazeDir.y / length },
    establishedTick,
  };
}

export function capturePerceptionTruth(match: Match): PerceptionTruth {
  return {
    tick: match.simTick,
    ball: {
      pos: { x: match.ball.pos.x, y: match.ball.pos.y },
      vel: { x: match.ball.vel.x, y: match.ball.vel.y },
      ownerGid: match.ball.owner?.gid ?? null,
    },
    players: match.allPlayers.map((p) => ({
      gid: p.gid,
      side: p.side,
      pos: { x: p.pos.x, y: p.pos.y },
      vel: { x: p.vel.x, y: p.vel.y },
      bodyDir: { x: p.bodyDir.x, y: p.bodyDir.y },
      sentOff: p.sentOff,
    })),
  };
}

/** Full-truth snapshot for offline oracle probes; never a live perception path. */
export function oraclePerceptionSnapshot(
  truth: PerceptionTruth,
  observerGid: number,
): PerceptionSnapshot {
  if (!truth.players.some((player) => player.gid === observerGid && !player.sentOff)) {
    throw new Error(`Unknown perception observer gid ${observerGid}`);
  }
  return {
    tick: truth.tick,
    observerGid,
    awareness: 1,
    ball: {
      pos: { x: truth.ball.pos.x, y: truth.ball.pos.y },
      vel: { x: truth.ball.vel.x, y: truth.ball.vel.y },
      ownerGid: truth.ball.ownerGid,
      observedTick: truth.tick,
      ageTicks: 0,
    },
    players: truth.players.filter((player) => !player.sentOff).map((player) => ({
      gid: player.gid,
      side: player.side,
      pos: { x: player.pos.x, y: player.pos.y },
      vel: { x: player.vel.x, y: player.vel.y },
      bodyDir: { x: player.bodyDir.x, y: player.bodyDir.y },
      observedTick: truth.tick,
      ageTicks: 0,
    })),
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * ⭐ THE INCUMBENT RETENTION HORIZON, named here at its own use site by OBM-T0
 * (#227). PURE CODE MOTION: `Math.round(15 + awareness * 45)` is the very
 * expression the three perception paths below have always used for "how long a
 * reading is still worth keeping" (0.25–1.0 s of memory at 60 Hz). Given a name so
 * the off-ball eyes seat can normalise its STALENESS feature by the engine's own
 * answer to that question instead of by a fresh literal (the #202 form). The
 * argument is clamped exactly as every call site already clamped it, so the number
 * this returns is bit-for-bit the one the inline expression produced.
 */
export function perceptionRetentionTicks(awarenessInput: number): number {
  return Math.round(15 + clamp01(awarenessInput) * 45);
}

/** Stable functional noise: no RNG state and no call-order dependence. */
function keyedNoise(seed: number, observerGid: number, entityGid: number, tick: number, channel: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (observerGid + 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (entityGid + 0xc2b2ae35), 0x27d4eb2d);
  h = Math.imul(h ^ tick, 0x165667b1);
  h = Math.imul(h ^ channel, 0x9e3779b1);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * Visible, and HOW FAR — one distance for both questions.
 *
 * Returns the observer-to-entity distance when the body is perceivable and NaN
 * when it is not; the observer's own body returns 0. E3R's perf lever
 * (ruling #12.4 (d)) reuses this number in `writeObservation` instead of
 * recomputing `Math.hypot` for the same pair: the same call, so the same value
 * to the last bit — `Math.hypot` and `Math.sqrt(x*x+y*y)` differ in the final
 * ULP for ~38% of inputs, so the honest number is computed ONCE, never
 * approximated.
 */
function visibleDistance(
  observer: PerceptionTruthPlayer,
  entity: PerceptionTruthPlayer,
  awareness: number,
  viewDir: Readonly<V2>,
): number {
  if (entity.gid === observer.gid) return 0;
  const dx = entity.pos.x - observer.pos.x;
  const dy = entity.pos.y - observer.pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= 4) return d; // near-field bodies are felt/heard even outside the cone
  const range = 18 + awareness * 22;
  if (d > range) return Number.NaN;
  const facing = d > 1e-9 ? (viewDir.x * dx + viewDir.y * dy) / d : 1;
  return facing >= -0.2 - awareness * 0.5 ? d : Number.NaN;
}

/** The same record with its fields writable — internal to this module only. */
interface MutableStoredPlayer {
  gid: number;
  side: Side;
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  bodyDir: { x: number; y: number };
  observedTick: number;
}

/**
 * EDS E3R (ruling #12.4 (d)): write one observation into an EXISTING record.
 *
 * The arithmetic is `observePlayer`'s, unchanged line for line — same keyed
 * error channels, same amplitudes, same body-turn rotation. The only
 * difference is that a body already in memory is overwritten in place instead
 * of allocating a fresh record plus three vectors per observed body per scan.
 * A squad-wide scan at brain cadence allocated ~40 objects per call; this
 * allocates none. Cheaper because it allocates less, never because it
 * perceives less — and `materialisePerceptionSnapshot` now copies the vectors
 * out, so no snapshot can alias a record that will later be rewritten.
 */
function writeObservation(
  into: MutableStoredPlayer,
  seed: number,
  observer: PerceptionTruthPlayer,
  entity: PerceptionTruthPlayer,
  awareness: number,
  tick: number,
  knownDistance = Number.NaN,
): void {
  into.gid = entity.gid;
  into.side = entity.side;
  into.observedTick = tick;
  if (entity.gid === observer.gid) {
    into.pos.x = entity.pos.x;
    into.pos.y = entity.pos.y;
    into.vel.x = entity.vel.x;
    into.vel.y = entity.vel.y;
    into.bodyDir.x = entity.bodyDir.x;
    into.bodyDir.y = entity.bodyDir.y;
    return;
  }
  const d = Number.isNaN(knownDistance)
    ? Math.hypot(entity.pos.x - observer.pos.x, entity.pos.y - observer.pos.y)
    : knownDistance;
  const error = 1 - awareness;
  const posAmp = (0.2 + d * 0.025) * error;
  const speed = Math.hypot(entity.vel.x, entity.vel.y);
  const velAmp = (0.45 + speed * 0.08) * error;
  const turn = keyedNoise(seed, observer.gid, entity.gid, tick, 4) * 0.35 * error;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  into.pos.x = entity.pos.x + keyedNoise(seed, observer.gid, entity.gid, tick, 0) * posAmp;
  into.pos.y = entity.pos.y + keyedNoise(seed, observer.gid, entity.gid, tick, 1) * posAmp;
  into.vel.x = entity.vel.x + keyedNoise(seed, observer.gid, entity.gid, tick, 2) * velAmp;
  into.vel.y = entity.vel.y + keyedNoise(seed, observer.gid, entity.gid, tick, 3) * velAmp;
  into.bodyDir.x = entity.bodyDir.x * c - entity.bodyDir.y * s;
  into.bodyDir.y = entity.bodyDir.x * s + entity.bodyDir.y * c;
}

function observePlayer(
  seed: number,
  observer: PerceptionTruthPlayer,
  entity: PerceptionTruthPlayer,
  awareness: number,
  tick: number,
  knownDistance = Number.NaN,
): StoredPlayer {
  const record: MutableStoredPlayer = {
    gid: entity.gid,
    side: entity.side,
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    bodyDir: { x: 0, y: 0 },
    observedTick: tick,
  };
  writeObservation(record, seed, observer, entity, awareness, tick, knownDistance);
  return record;
}

/** Overwrite in place when the body is already remembered; allocate only once. */
function rememberPlayer(
  memory: PerceptionMemory,
  seed: number,
  observer: PerceptionTruthPlayer,
  entity: PerceptionTruthPlayer,
  awareness: number,
  tick: number,
  knownDistance = Number.NaN,
): void {
  const existing = memory.players.get(entity.gid) as MutableStoredPlayer | undefined;
  if (existing === undefined) {
    memory.players.set(
      entity.gid, observePlayer(seed, observer, entity, awareness, tick, knownDistance),
    );
    return;
  }
  writeObservation(existing, seed, observer, entity, awareness, tick, knownDistance);
}

/**
 * Build one pass-facing snapshot. The memory mutates only when its deterministic
 * scan clock fires; between scans callers receive the last-known facts with age.
 */
/**
 * EDS E2b-1R — the O(1) ball percept (commander ruling #10.3).
 *
 * The only thing the sim itself reads from a percept is the ball: the
 * defender's interception entry needs where it is and where it is going.
 * Building a whole snapshot for that meant scanning every body, writing
 * proprioception, pruning retention and allocating an `ObservedPlayer[]` whose
 * output was then discarded — measured at 33% of a step against a 25% budget.
 *
 * This is the SAME ball branch `perceiveSnapshot` runs, with the per-body loop
 * and the array build removed: same scan cadence, same visibility rule, same
 * keyed error channels, same retention, same carrier proprioception. It is
 * cheaper because it computes less, never because it perceives less — and
 * `X6`/the contract test pin it against the full path so that stays true.
 *
 * The observer's own `memory.players` entry is deliberately NOT written: no
 * consumer of this path reads bodies, and the ball percept does not depend on
 * it. A memory driven by this path therefore carries a ball only.
 */
export function observeBall(
  memory: PerceptionMemory,
  observer: PerceptionTruthPlayer,
  ball: PerceptionTruth['ball'],
  tick: number,
  awarenessInput: number,
  seed: number,
  gazeDir: Readonly<V2> | null = null,
): ObservedBall | null {
  const awareness = clamp01(awarenessInput);
  const viewDir = gazeDir ?? observer.bodyDir;
  const intervalTicks = Math.round(15 - awareness * 9);
  const retentionTicks = perceptionRetentionTicks(awareness);
  const scan = memory.nextScanTick < 0 || tick >= memory.nextScanTick;
  const ownsBall = ball.ownerGid === observer.gid;

  if (scan) {
    memory.nextScanTick = tick + intervalTicks;
    const bdx = ball.pos.x - observer.pos.x;
    const bdy = ball.pos.y - observer.pos.y;
    const bd = Math.hypot(bdx, bdy);
    const ballFacing = bd > 1e-9 ? (viewDir.x * bdx + viewDir.y * bdy) / bd : 1;
    if (!ownsBall && (bd <= 4 || (bd <= 18 + awareness * 22 && ballFacing >= -0.2 - awareness * 0.5))) {
      const ballError = (0.12 + bd * 0.015) * (1 - awareness);
      memory.ball = {
        pos: {
          x: ball.pos.x + keyedNoise(seed, observer.gid, -1, tick, 5) * ballError,
          y: ball.pos.y + keyedNoise(seed, observer.gid, -1, tick, 6) * ballError,
        },
        vel: {
          x: ball.vel.x + keyedNoise(seed, observer.gid, -1, tick, 7) * ballError,
          y: ball.vel.y + keyedNoise(seed, observer.gid, -1, tick, 8) * ballError,
        },
        ownerGid: ball.ownerGid,
        observedTick: tick,
      };
    }
  }
  if (ownsBall) {
    memory.ball = {
      pos: { x: ball.pos.x, y: ball.pos.y },
      vel: { x: ball.vel.x, y: ball.vel.y },
      ownerGid: ball.ownerGid,
      observedTick: tick,
    };
  }
  if (memory.ball && tick - memory.ball.observedTick > retentionTicks) memory.ball = null;
  return memory.ball ? { ...memory.ball, ageTicks: tick - memory.ball.observedTick } : null;
}

export function perceiveSnapshot(
  truth: PerceptionTruth,
  observerGid: number,
  awarenessInput: number,
  seed: number,
  memory: PerceptionMemory,
  gaze: ObserverGaze | null = null,
): PerceptionSnapshot {
  advancePerceptionMemory(truth, observerGid, awarenessInput, seed, memory, gaze);
  return materialisePerceptionSnapshot(truth, observerGid, clamp01(awarenessInput), memory);
}

/**
 * EDS E2b-1R: the first half of `perceiveSnapshot` — scan, observe, remember,
 * forget — with no array built. Split out so a consumer that must keep a memory
 * chain alive but will not read it this tick does not pay to materialise one
 * (ruling #10.3). Every honesty rule lives here and is untouched by the split.
 */
export function advancePerceptionMemory(
  truth: PerceptionTruth,
  observerGid: number,
  awarenessInput: number,
  seed: number,
  memory: PerceptionMemory,
  gaze: ObserverGaze | null = null,
): void {
  const awareness = clamp01(awarenessInput);
  const observer = truth.players.find((p) => p.gid === observerGid);
  if (!observer) throw new Error(`Unknown perception observer gid ${observerGid}`);
  if (gaze !== null && (
    gaze.observerGid !== observerGid
    || !Number.isInteger(gaze.establishedTick)
    || gaze.establishedTick < 0
    || gaze.establishedTick > truth.tick
    || !Number.isFinite(gaze.gazeDir.x)
    || !Number.isFinite(gaze.gazeDir.y)
    || Math.abs(Math.hypot(gaze.gazeDir.x, gaze.gazeDir.y) - 1) > 1e-9
  )) throw new Error(`Invalid gaze for observer gid ${observerGid}`);
  const viewDir = gaze?.gazeDir ?? observer.bodyDir;
  const intervalTicks = Math.round(15 - awareness * 9); // 4–10 Hz at 60 Hz sim
  const retentionTicks = perceptionRetentionTicks(awareness); // 0.25–1.0 s memory
  const scan = memory.nextScanTick < 0 || truth.tick >= memory.nextScanTick;
  const ownsBall = truth.ball.ownerGid === observerGid;

  if (scan) {
    memory.nextScanTick = truth.tick + intervalTicks;
    for (const entity of truth.players) {
      if (entity.sentOff) {
        memory.players.delete(entity.gid);
        continue;
      }
      const distance = visibleDistance(observer, entity, awareness, viewDir);
      if (!Number.isNaN(distance)) {
        rememberPlayer(memory, seed, observer, entity, awareness, truth.tick, distance);
      }
    }
    const bdx = truth.ball.pos.x - observer.pos.x;
    const bdy = truth.ball.pos.y - observer.pos.y;
    const bd = Math.hypot(bdx, bdy);
    const ballFacing = bd > 1e-9 ? (viewDir.x * bdx + viewDir.y * bdy) / bd : 1;
    if (!ownsBall && (bd <= 4 || (bd <= 18 + awareness * 22 && ballFacing >= -0.2 - awareness * 0.5))) {
      const ballError = (0.12 + bd * 0.015) * (1 - awareness);
      memory.ball = {
        pos: {
          x: truth.ball.pos.x + keyedNoise(seed, observer.gid, -1, truth.tick, 5) * ballError,
          y: truth.ball.pos.y + keyedNoise(seed, observer.gid, -1, truth.tick, 6) * ballError,
        },
        vel: {
          x: truth.ball.vel.x + keyedNoise(seed, observer.gid, -1, truth.tick, 7) * ballError,
          y: truth.ball.vel.y + keyedNoise(seed, observer.gid, -1, truth.tick, 8) * ballError,
        },
        ownerGid: truth.ball.ownerGid,
        observedTick: truth.tick,
      };
    }
  }

  // Proprioception is continuous too: the observer does not need a visual
  // scan to know their own body position, velocity, or facing.
  rememberPlayer(memory, seed, observer, observer, awareness, truth.tick);

  // Touch/proprioception is continuous: the carrier does not wait for a visual
  // scan to know the authoritative location and motion of the ball at their feet.
  if (ownsBall) {
    memory.ball = {
      pos: { x: truth.ball.pos.x, y: truth.ball.pos.y },
      vel: { x: truth.ball.vel.x, y: truth.ball.vel.y },
      ownerGid: truth.ball.ownerGid,
      observedTick: truth.tick,
    };
  }

  for (const [gid, observation] of memory.players) {
    if (truth.tick - observation.observedTick > retentionTicks) memory.players.delete(gid);
  }
  if (memory.ball && truth.tick - memory.ball.observedTick > retentionTicks) memory.ball = null;

}

/**
 * EDS E3R2 — one recorded scan moment (ruling #13.3, "perception is PULL").
 *
 * The truth a body's eyes were pointed at when its scan clock fired. Storing
 * this and replaying it later is cheaper than observing ten bodies at the time,
 * and it is EXACT rather than approximate: an observation is a pure function of
 * (seed, observer, entity, tick) and the truth at that tick, so the number a
 * replay produces is the number the scan would have produced. Frames are
 * per-observer, not per-tick, because `bodyDir` is `heading` and a restart
 * taker's heading turns inside the decide loop — two observers in one tick can
 * honestly see different facings.
 */
export interface ScanFrame {
  tick: number;
  players: {
    gid: number;
    side: Side;
    pos: { x: number; y: number };
    vel: { x: number; y: number };
    bodyDir: { x: number; y: number };
    sentOff: boolean;
  }[];
}

export function createScanFrame(): ScanFrame {
  return { tick: -1, players: [] };
}

/** Copy the body truth of this scan moment into a reusable frame slot. */
export function recordScanFrame(into: ScanFrame, truth: PerceptionTruth): void {
  into.tick = truth.tick;
  const players = into.players;
  while (players.length < truth.players.length) {
    players.push({
      gid: -1, side: 0, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 },
      bodyDir: { x: 0, y: 0 }, sentOff: false,
    });
  }
  players.length = truth.players.length;
  for (let index = 0; index < truth.players.length; index++) {
    const from = truth.players[index];
    const to = players[index];
    to.gid = from.gid;
    to.side = from.side;
    to.pos.x = from.pos.x;
    to.pos.y = from.pos.y;
    to.vel.x = from.vel.x;
    to.vel.y = from.vel.y;
    to.bodyDir.x = from.bodyDir.x;
    to.bodyDir.y = from.bodyDir.y;
    to.sentOff = from.sentOff;
  }
}

/**
 * EDS E3R2: rebuild this observer's BODY memory from its recorded scan moments,
 * then write proprioception at the current tick — the same two things
 * `advancePerceptionMemory` does, in the same order, with the same code.
 *
 * `frames` must be the observer's own scan frames in chronological order; ones
 * outside retention are ignored here and pruned below, exactly as the eager
 * path prunes them call by call. The ball is NOT touched: it is maintained
 * eagerly by `observeBall`, because the sim reads it every tick it thinks.
 */
export function reconstructBodyMemory(
  memory: PerceptionMemory,
  frames: readonly ScanFrame[],
  currentTruth: PerceptionTruth,
  observerGid: number,
  awarenessInput: number,
  seed: number,
): void {
  const awareness = clamp01(awarenessInput);
  const retentionTicks = perceptionRetentionTicks(awareness);
  const now = currentTruth.tick;
  for (const frame of frames) {
    if (frame.tick < 0 || now - frame.tick > retentionTicks || frame.tick > now) continue;
    const observer = frame.players.find((player) => player.gid === observerGid);
    if (observer === undefined) continue;
    const viewDir = observer.bodyDir;
    for (const entity of frame.players) {
      if (entity.sentOff) {
        memory.players.delete(entity.gid);
        continue;
      }
      const distance = visibleDistance(observer, entity, awareness, viewDir);
      if (!Number.isNaN(distance)) {
        rememberPlayer(memory, seed, observer, entity, awareness, frame.tick, distance);
      }
    }
  }
  // Proprioception is continuous: the observer does not need a visual scan to
  // know their own body. Written last and at the current tick, as the eager
  // path writes it on the call that is happening right now.
  const self = currentTruth.players.find((player) => player.gid === observerGid);
  if (self !== undefined) rememberPlayer(memory, seed, self, self, awareness, now);
  for (const [gid, observation] of memory.players) {
    if (now - observation.observedTick > retentionTicks) memory.players.delete(gid);
  }
}

/**
 * EDS E2b-1R: the second half of `perceiveSnapshot`, split out so a consumer
 * that only needs the memory chain advanced does not pay to build an array it
 * will not read (ruling #10.3 — cost scales with what consumers READ). Pure:
 * it reads the memory, never writes it.
 */
export function materialisePerceptionSnapshot(
  truth: PerceptionTruth,
  observerGid: number,
  awareness: number,
  memory: PerceptionMemory,
  scope: ReadonlySet<number> | null = null,
): PerceptionSnapshot {
  const players: ObservedPlayer[] = [];
  for (const entity of truth.players) {
    // E3R (ruling #12.4 (d)): candidate-scoped materialisation. A consumer that
    // prices a named option set does not need every remembered body in an
    // array — the scope carries the observer, his candidates and the opponents
    // the corridor read scans. Null keeps the full snapshot, which is what
    // every banked probe used, so the default path is untouched.
    if (scope !== null && !scope.has(entity.gid)) continue;
    const observed = memory.players.get(entity.gid);
    if (!observed) continue;
    // The vectors are COPIED, not shared: memory records are now overwritten in
    // place (E3R's allocation-free scan), so a snapshot holding references
    // would silently change under its reader.
    players.push({
      gid: observed.gid,
      side: observed.side,
      pos: { x: observed.pos.x, y: observed.pos.y },
      vel: { x: observed.vel.x, y: observed.vel.y },
      bodyDir: { x: observed.bodyDir.x, y: observed.bodyDir.y },
      observedTick: observed.observedTick,
      ageTicks: truth.tick - observed.observedTick,
    });
  }
  const ball = memory.ball
    ? {
      pos: { x: memory.ball.pos.x, y: memory.ball.pos.y },
      vel: { x: memory.ball.vel.x, y: memory.ball.vel.y },
      ownerGid: memory.ball.ownerGid,
      observedTick: memory.ball.observedTick,
      ageTicks: truth.tick - memory.ball.observedTick,
    }
    : null;
  return { tick: truth.tick, observerGid, awareness: clamp01(awareness), ball, players };
}
