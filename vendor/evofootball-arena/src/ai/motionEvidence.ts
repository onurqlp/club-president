import type { PerceptionSnapshot } from './perceptionSnapshot';
import { DT } from '../sim/constants';
import type { V2 } from '../utils/vec';

export interface ObservedMotionSample {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly observedTick: number;
  readonly observationAgeTicks: number;
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
  readonly bodyDir: Readonly<V2>;
}

export interface ObservedMotionHistory {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly samples: readonly ObservedMotionSample[];
}

export interface ObservedTemporalMotionEvidence {
  readonly observerGid: number;
  readonly actorGid: number;
  readonly referenceGid: number;
  readonly referenceEpoch: number;
  readonly firstTick: number;
  readonly middleTick: number;
  readonly lastTick: number;
  readonly firstIntervalSeconds: number;
  readonly secondIntervalSeconds: number;
  readonly firstDisplacement: Readonly<V2>;
  readonly secondDisplacement: Readonly<V2>;
  readonly firstAverageVelocity: Readonly<V2>;
  readonly secondAverageVelocity: Readonly<V2>;
  readonly firstSpeed: number;
  readonly middleSpeed: number;
  readonly lastSpeed: number;
  readonly firstSpeedDelta: number;
  readonly secondSpeedDelta: number;
  readonly firstVelocityTurn: number | null;
  readonly secondVelocityTurn: number | null;
  readonly firstBodyTurn: number | null;
  readonly secondBodyTurn: number | null;
  readonly displacementPersistence: number | null;
}

const validId = (value: number): boolean => Number.isInteger(value) && value >= 0;
const validTick = (value: number): boolean => Number.isInteger(value) && value >= 0;
const finiteVector = (value: Readonly<V2>): boolean =>
  Number.isFinite(value.x) && Number.isFinite(value.y);
const copyVector = (value: Readonly<V2>): V2 => ({ x: value.x, y: value.y });

const copySample = (sample: ObservedMotionSample): ObservedMotionSample => ({
  ...sample,
  pos: copyVector(sample.pos),
  vel: copyVector(sample.vel),
  bodyDir: copyVector(sample.bodyDir),
});

const copyHistory = (history: ObservedMotionHistory): ObservedMotionHistory => ({
  ...history,
  samples: history.samples.map(copySample),
});

const validSample = (sample: ObservedMotionSample): boolean =>
  validId(sample.observerGid)
  && validId(sample.actorGid)
  && sample.observerGid !== sample.actorGid
  && validTick(sample.observedTick)
  && validTick(sample.observationAgeTicks)
  && finiteVector(sample.pos)
  && finiteVector(sample.vel)
  && finiteVector(sample.bodyDir);

export function appendObservedMotionSample(
  snapshot: PerceptionSnapshot,
  actorGid: number,
  referenceGid: number,
  referenceEpoch: number,
  previous: ObservedMotionHistory | null,
): ObservedMotionHistory | null {
  if (
    !validId(snapshot.observerGid)
    || !validId(actorGid)
    || snapshot.observerGid === actorGid
    || !validId(referenceGid)
    || !validTick(referenceEpoch)
    || !validTick(snapshot.tick)
  ) return null;
  const actor = snapshot.players.find((player) => player.gid === actorGid);
  if (
    !actor
    || !validTick(actor.observedTick)
    || !validTick(actor.ageTicks)
    || actor.observedTick + actor.ageTicks !== snapshot.tick
    || !finiteVector(actor.pos)
    || !finiteVector(actor.vel)
    || !finiteVector(actor.bodyDir)
  ) return null;
  if (previous && (
    previous.observerGid !== snapshot.observerGid
    || previous.actorGid !== actorGid
    || previous.referenceGid !== referenceGid
    || previous.referenceEpoch !== referenceEpoch
    || previous.samples.length > 3
    || previous.samples.some((sample, index) => (
      !validSample(sample)
      || (index > 0 && sample.observedTick <= previous.samples[index - 1].observedTick)
    ))
  )) return null;

  const last = previous?.samples.at(-1) ?? null;
  if (last && actor.observedTick < last.observedTick) return null;
  if (last && actor.observedTick === last.observedTick) return copyHistory(previous!);

  const sample: ObservedMotionSample = {
    observerGid: snapshot.observerGid,
    actorGid,
    observedTick: actor.observedTick,
    observationAgeTicks: actor.ageTicks,
    pos: copyVector(actor.pos),
    vel: copyVector(actor.vel),
    bodyDir: copyVector(actor.bodyDir),
  };
  const samples = [...(previous?.samples ?? []), sample].slice(-3);
  return {
    observerGid: snapshot.observerGid,
    actorGid,
    referenceGid,
    referenceEpoch,
    samples,
  };
}

const signedTurn = (from: Readonly<V2>, to: Readonly<V2>): number | null => {
  const fromLength = Math.hypot(from.x, from.y);
  const toLength = Math.hypot(to.x, to.y);
  if (fromLength < 1e-8 || toLength < 1e-8) return null;
  return Math.atan2(
    from.x * to.y - from.y * to.x,
    from.x * to.x + from.y * to.y,
  );
};

const persistence = (first: Readonly<V2>, second: Readonly<V2>): number | null => {
  const firstLength = Math.hypot(first.x, first.y);
  const secondLength = Math.hypot(second.x, second.y);
  if (firstLength < 1e-8 || secondLength < 1e-8) return null;
  const value = (first.x * second.x + first.y * second.y) / (firstLength * secondLength);
  return Math.max(-1, Math.min(1, value));
};

export function evaluateTemporalMotionEvidence(
  history: ObservedMotionHistory,
): ObservedTemporalMotionEvidence | null {
  if (
    !validId(history.observerGid)
    || !validId(history.actorGid)
    || history.observerGid === history.actorGid
    || !validId(history.referenceGid)
    || !validTick(history.referenceEpoch)
    || history.samples.length !== 3
    || history.samples.some((sample, index) => (
      !validSample(sample)
      || sample.observerGid !== history.observerGid
      || sample.actorGid !== history.actorGid
      || (index > 0 && sample.observedTick <= history.samples[index - 1].observedTick)
    ))
  ) return null;
  const [first, middle, last] = history.samples;
  const firstTicks = middle.observedTick - first.observedTick;
  const secondTicks = last.observedTick - middle.observedTick;
  if (firstTicks <= 0 || secondTicks <= 0) return null;
  const firstIntervalSeconds = firstTicks * DT;
  const secondIntervalSeconds = secondTicks * DT;
  const firstDisplacement = {
    x: middle.pos.x - first.pos.x,
    y: middle.pos.y - first.pos.y,
  };
  const secondDisplacement = {
    x: last.pos.x - middle.pos.x,
    y: last.pos.y - middle.pos.y,
  };
  const firstSpeed = Math.hypot(first.vel.x, first.vel.y);
  const middleSpeed = Math.hypot(middle.vel.x, middle.vel.y);
  const lastSpeed = Math.hypot(last.vel.x, last.vel.y);
  return {
    observerGid: history.observerGid,
    actorGid: history.actorGid,
    referenceGid: history.referenceGid,
    referenceEpoch: history.referenceEpoch,
    firstTick: first.observedTick,
    middleTick: middle.observedTick,
    lastTick: last.observedTick,
    firstIntervalSeconds,
    secondIntervalSeconds,
    firstDisplacement,
    secondDisplacement,
    firstAverageVelocity: {
      x: firstDisplacement.x / firstIntervalSeconds,
      y: firstDisplacement.y / firstIntervalSeconds,
    },
    secondAverageVelocity: {
      x: secondDisplacement.x / secondIntervalSeconds,
      y: secondDisplacement.y / secondIntervalSeconds,
    },
    firstSpeed,
    middleSpeed,
    lastSpeed,
    firstSpeedDelta: middleSpeed - firstSpeed,
    secondSpeedDelta: lastSpeed - middleSpeed,
    firstVelocityTurn: signedTurn(first.vel, middle.vel),
    secondVelocityTurn: signedTurn(middle.vel, last.vel),
    firstBodyTurn: signedTurn(first.bodyDir, middle.bodyDir),
    secondBodyTurn: signedTurn(middle.bodyDir, last.bodyDir),
    displacementPersistence: persistence(firstDisplacement, secondDisplacement),
  };
}
