import type { PlayerAttributes } from '../evolution/playerGenome';
import type { V2 } from '../utils/vec';
import { Player } from './Player';
import { BALL_FRICTION_K, BALL_RADIUS, CONTROL_RADIUS, DT } from './constants';
import {
  controlledTouchSpacing,
  virtualFootAnchor,
  virtualFootForTouch,
  type VirtualFootSide,
  type VirtualGaitState,
} from './controlCoupling';
import { directBallAccess } from './physical';
import type { Role, Side } from './types';

export interface FixedMovementIntent {
  readonly desiredVel: Readonly<V2>;
  readonly faceTarget: Readonly<V2> | null;
}

export interface GroundBallState {
  readonly pos: Readonly<V2>;
  readonly vel: Readonly<V2>;
  readonly radius?: number;
}

export interface PlayerPhysicsSnapshot {
  readonly side: Side;
  readonly index: number;
  readonly role: Role;
  readonly name: string;
  readonly attrs: PlayerAttributes;
  readonly pos: V2;
  readonly vel: V2;
  readonly heading: V2;
  readonly desiredVel: V2;
  readonly faceTarget: V2 | null;
  /** ⭐ BF T0: `physicsStep` reads it, so the complete shadow carries it (0 = shut). */
  readonly facingDepth: number;
  readonly stamina: number;
  readonly staminaSpent: number;
  readonly distance: number;
  readonly baseSpeed: number;
  readonly accel: number;
  readonly staminaDrainMul: number;
  readonly kickCooldown: number;
  readonly tackleCooldown: number;
  readonly touchTimer: number;
  readonly stunTimer: number;
  readonly gkHoldTimer: number;
  readonly tackleAnimTimer: number;
  readonly saveAnimTimer: number;
  readonly headerAnimTimer: number;
  readonly firstTouchWindow: number;
  readonly decisionTimer: number;
}

export type TouchRecoveryStatus =
  | 'planned'
  | 'recovering'
  | 'contacted'
  | 'missed'
  | 'invalidatedIntent';

export interface TouchRecoveryPlan {
  readonly id: number;
  readonly controllerGid: number;
  readonly committedTick: number;
  readonly playerAtCommit: PlayerPhysicsSnapshot;
  readonly ballBefore: GroundBallState;
  readonly ballAfterSingleImpulse: GroundBallState;
  readonly singleImpulse: V2;
  readonly fixedContactTick: number;
  readonly fixedContactPoint: Readonly<V2>;
  readonly fixedContactCenter: Readonly<V2>;
  readonly fixedContactBodyDir: Readonly<V2>;
  readonly fixedFootSide: VirtualFootSide;
  readonly movementIntentAtCommit: FixedMovementIntent;
  readonly predictedPlayerAtContact: PlayerPhysicsSnapshot;
  readonly status: 'planned';
}

export interface PlanFixedRendezvousInput {
  readonly id: number;
  readonly committedTick?: number;
  readonly player: Player;
  readonly ball: GroundBallState;
  readonly movementIntent: FixedMovementIntent;
  /** Decision-neutral direction supplied by the synthetic scenario. */
  readonly touchDirection: Readonly<V2>;
  readonly gait: VirtualGaitState;
  readonly maxImpulse?: number;
  readonly candidateWindows?: number;
}

export interface RecoveryInvariantLedger {
  readonly initialBallImpulses: number;
  readonly controllerBallCorrectionsAfterCommit: number;
  readonly contactTargetChanges: number;
  readonly contactTickChanges: number;
  readonly retimes: number;
  readonly directPlayerPositionWrites: number;
  readonly directPlayerVelocityWrites: number;
  readonly directHeadingWrites: number;
  readonly topSpeedOverrides: number;
  readonly accelOverrides: number;
  readonly m3Calls: number;
  readonly contestEpisodesCreated: number;
  readonly giveBallCalls: number;
  readonly possessionWrites: number;
  readonly controlSequenceWrites: number;
  readonly possessionLocusReads: number;
  readonly rngDraws: number;
  readonly recoveryDesiredVelWrites: number;
  readonly externalBallPerturbations: number;
}

export interface ExecuteRecoveryOptions {
  readonly recoveryEnabled?: boolean;
  readonly stunAtTick?: number;
  readonly stunDuration?: number;
  readonly intentChangeAtTick?: number;
  readonly ballPerturbation?: {
    readonly tick: number;
    readonly impulse: Readonly<V2>;
  };
}
export interface TouchRecoveryResult {
  readonly status: Exclude<TouchRecoveryStatus, 'planned' | 'recovering'>;
  readonly actualPlayerAtContact: PlayerPhysicsSnapshot;
  readonly actualBallAtContact: GroundBallState;
  readonly accessGranted: boolean;
  readonly footError: number;
  readonly playerPath: readonly Readonly<V2>[];
  readonly ballPath: readonly Readonly<V2>[];
  readonly ledger: RecoveryInvariantLedger;
}

const cloneV2 = (value: Readonly<V2>): V2 => ({ x: value.x, y: value.y });

const unitOrX = (value: Readonly<V2>): V2 => {
  const length = Math.hypot(value.x, value.y);
  return length > 1e-9 ? { x: value.x / length, y: value.y / length } : { x: 1, y: 0 };
};

export function snapshotPlayerPhysics(player: Player): PlayerPhysicsSnapshot {
  return {
    side: player.side,
    index: player.index,
    role: player.role,
    name: player.name,
    attrs: { ...player.attrs },
    pos: cloneV2(player.pos),
    vel: cloneV2(player.vel),
    heading: cloneV2(player.heading),
    desiredVel: cloneV2(player.desiredVel),
    faceTarget: player.faceTarget === null ? null : cloneV2(player.faceTarget),
    facingDepth: player.facingDepth,
    stamina: player.stamina,
    staminaSpent: player.staminaSpent,
    distance: player.distance,
    baseSpeed: player.baseSpeed,
    accel: player.accel,
    staminaDrainMul: player.staminaDrainMul,
    kickCooldown: player.kickCooldown,
    tackleCooldown: player.tackleCooldown,
    touchTimer: player.touchTimer,
    stunTimer: player.stunTimer,
    gkHoldTimer: player.gkHoldTimer,
    tackleAnimTimer: player.tackleAnimTimer,
    saveAnimTimer: player.saveAnimTimer,
    headerAnimTimer: player.headerAnimTimer,
    firstTouchWindow: player.firstTouchWindow,
    decisionTimer: player.decisionTimer,
  };
}

/** Complete shadow of every field read or written by Player.physicsStep(). */
export function shadowPlayerFromSnapshot(snapshot: PlayerPhysicsSnapshot): Player {
  const player = new Player(
    snapshot.side,
    snapshot.index,
    snapshot.role,
    snapshot.name,
    { ...snapshot.attrs },
  );
  player.pos = cloneV2(snapshot.pos);
  player.vel = cloneV2(snapshot.vel);
  player.heading = cloneV2(snapshot.heading);
  player.desiredVel = cloneV2(snapshot.desiredVel);
  player.faceTarget = snapshot.faceTarget === null ? null : cloneV2(snapshot.faceTarget);
  player.facingDepth = snapshot.facingDepth;
  player.stamina = snapshot.stamina;
  player.staminaSpent = snapshot.staminaSpent;
  player.distance = snapshot.distance;
  player.baseSpeed = snapshot.baseSpeed;
  player.accel = snapshot.accel;
  player.staminaDrainMul = snapshot.staminaDrainMul;
  player.kickCooldown = snapshot.kickCooldown;
  player.tackleCooldown = snapshot.tackleCooldown;
  player.touchTimer = snapshot.touchTimer;
  player.stunTimer = snapshot.stunTimer;
  player.gkHoldTimer = snapshot.gkHoldTimer;
  player.tackleAnimTimer = snapshot.tackleAnimTimer;
  player.saveAnimTimer = snapshot.saveAnimTimer;
  player.headerAnimTimer = snapshot.headerAnimTimer;
  player.firstTouchWindow = snapshot.firstTouchWindow;
  player.decisionTimer = snapshot.decisionTimer;
  return player;
}

export function clonePlayerForPhysics(player: Player): Player {
  return shadowPlayerFromSnapshot(snapshotPlayerPhysics(player));
}

const setIntent = (player: Player, intent: FixedMovementIntent): void => {
  player.desiredVel.x = intent.desiredVel.x;
  player.desiredVel.y = intent.desiredVel.y;
  player.faceTarget = intent.faceTarget === null ? null : cloneV2(intent.faceTarget);
};

/**
 * Time-to-go controller. It only writes desiredVel; Player.physicsStep owns
 * all clamps, acceleration, stun damping, position, heading and stamina.
 */
export function recoveryDesiredVelocity(
  player: Player,
  fixedContactCenter: Readonly<V2>,
  remainingTicks: number,
  dt = DT,
): V2 {
  const remainingTime = Math.max(dt, Math.max(1, remainingTicks) * dt);
  const averageX = (fixedContactCenter.x - player.pos.x) / remainingTime;
  const averageY = (fixedContactCenter.y - player.pos.y) / remainingTime;
  return {
    x: averageX * 2 - player.vel.x,
    y: averageY * 2 - player.vel.y,
  };
}

const simulateRecoveryPlayer = (
  source: Player,
  fixedContactCenter: Readonly<V2>,
  ticks: number,
  movementIntent: FixedMovementIntent,
): Player => {
  const shadow = clonePlayerForPhysics(source);
  for (let tick = 1; tick <= ticks; tick++) {
    const desired = recoveryDesiredVelocity(shadow, fixedContactCenter, ticks - tick + 1);
    shadow.desiredVel.x = desired.x;
    shadow.desiredVel.y = desired.y;
    shadow.faceTarget = movementIntent.faceTarget === null
      ? null
      : cloneV2(movementIntent.faceTarget);
    shadow.physicsStep(DT);
  }
  return shadow;
};

const ballTravelFactor = (ticks: number): number => {
  const decay = Math.exp(-BALL_FRICTION_K * DT);
  return DT * (1 - decay ** ticks) / (1 - decay);
};

export function advanceGroundBall(ball: { pos: V2; vel: V2 }, dt = DT): void {
  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;
  const decay = Math.exp(-BALL_FRICTION_K * dt);
  ball.vel.x *= decay;
  ball.vel.y *= decay;
}

/**
 * Enumerate at most the next two distance-derived gait windows. Planning may
 * simulate; after commit the selected tick and point never move.
 */
export function planFixedRendezvous(
  input: PlanFixedRendezvousInput,
): TouchRecoveryPlan | null {
  const speed = Math.hypot(input.player.vel.x, input.player.vel.y);
  const direction = unitOrX(input.touchDirection);
  const facingDot = Math.max(-1, Math.min(1,
    input.player.bodyDir.x * direction.x + input.player.bodyDir.y * direction.y,
  ));
  const turnDemand = Math.acos(facingDot) / Math.PI;
  const spacing = controlledTouchSpacing(speed, turnDemand, 0);
  const phase = Math.max(0, Math.min(0.999999, input.gait.phase));
  const windows = Math.max(1, Math.min(2, Math.trunc(input.candidateWindows ?? 2)));
  const maxImpulse = Math.max(0, input.maxImpulse ?? (4 + speed * 0.9));
  const ballBefore: GroundBallState = {
    pos: cloneV2(input.ball.pos),
    vel: cloneV2(input.ball.vel),
    radius: input.ball.radius ?? BALL_RADIUS,
  };

  for (let window = 0; window < windows; window++) {
    const travel = spacing * (1 - phase + window);
    const nominalSeconds = travel / Math.max(speed, 1.5);
    const minSeconds = 0.22 * (window + 1);
    const maxSeconds = 0.58 * (window + 1);
    const seconds = Math.max(minSeconds, Math.min(maxSeconds, nominalSeconds));
    const fixedContactTick = Math.max(1, Math.ceil(seconds / DT - 1e-12));
    const fixedContactCenter = {
      x: input.player.pos.x + direction.x * travel,
      y: input.player.pos.y + direction.y * travel,
    };
    const predictedPlayer = simulateRecoveryPlayer(
      input.player,
      fixedContactCenter,
      fixedContactTick,
      input.movementIntent,
    );
    const footSide = virtualFootForTouch(input.gait.touchIndex + window);
    const fixedContactPoint = virtualFootAnchor(
      predictedPlayer.pos,
      predictedPlayer.bodyDir,
      footSide,
    );
    const factor = ballTravelFactor(fixedContactTick);
    const requiredVelocity = {
      x: (fixedContactPoint.x - input.ball.pos.x) / factor,
      y: (fixedContactPoint.y - input.ball.pos.y) / factor,
    };
    const singleImpulse = {
      x: requiredVelocity.x - input.ball.vel.x,
      y: requiredVelocity.y - input.ball.vel.y,
    };
    if (Math.hypot(singleImpulse.x, singleImpulse.y) > maxImpulse) continue;

    return {
      id: input.id,
      controllerGid: input.player.gid,
      committedTick: input.committedTick ?? 0,
      playerAtCommit: snapshotPlayerPhysics(input.player),
      ballBefore,
      ballAfterSingleImpulse: {
        pos: cloneV2(input.ball.pos),
        vel: requiredVelocity,
        radius: input.ball.radius ?? BALL_RADIUS,
      },
      singleImpulse,
      fixedContactTick,
      fixedContactPoint,
      fixedContactCenter,
      fixedContactBodyDir: cloneV2(predictedPlayer.bodyDir),
      fixedFootSide: footSide,
      movementIntentAtCommit: {
        desiredVel: cloneV2(input.movementIntent.desiredVel),
        faceTarget: input.movementIntent.faceTarget === null
          ? null
          : cloneV2(input.movementIntent.faceTarget),
      },
      predictedPlayerAtContact: snapshotPlayerPhysics(predictedPlayer),
      status: 'planned',
    };
  }
  return null;
}

const emptyLedger = (): RecoveryInvariantLedger => ({
  initialBallImpulses: 1,
  controllerBallCorrectionsAfterCommit: 0,
  contactTargetChanges: 0,
  contactTickChanges: 0,
  retimes: 0,
  directPlayerPositionWrites: 0,
  directPlayerVelocityWrites: 0,
  directHeadingWrites: 0,
  topSpeedOverrides: 0,
  accelOverrides: 0,
  m3Calls: 0,
  contestEpisodesCreated: 0,
  giveBallCalls: 0,
  possessionWrites: 0,
  controlSequenceWrites: 0,
  possessionLocusReads: 0,
  rngDraws: 0,
  recoveryDesiredVelWrites: 0,
  externalBallPerturbations: 0,
});

export function executeFixedRendezvous(
  plan: TouchRecoveryPlan,
  options: ExecuteRecoveryOptions = {},
): TouchRecoveryResult {
  const player = shadowPlayerFromSnapshot(plan.playerAtCommit);
  const ball = {
    pos: cloneV2(plan.ballAfterSingleImpulse.pos),
    vel: cloneV2(plan.ballAfterSingleImpulse.vel),
  };
  const playerPath: V2[] = [cloneV2(player.pos)];
  const ballPath: V2[] = [cloneV2(ball.pos)];
  const ledger = { ...emptyLedger() };
  const recoveryEnabled = options.recoveryEnabled ?? true;

  for (let tick = 1; tick <= plan.fixedContactTick; tick++) {
    if (options.intentChangeAtTick === tick) {
      return {
        status: 'invalidatedIntent',
        actualPlayerAtContact: snapshotPlayerPhysics(player),
        actualBallAtContact: { pos: cloneV2(ball.pos), vel: cloneV2(ball.vel), radius: BALL_RADIUS },
        accessGranted: false,
        footError: Infinity,
        playerPath,
        ballPath,
        ledger,
      };
    }
    if (options.stunAtTick === tick) {
      player.stunTimer = Math.max(player.stunTimer, options.stunDuration ?? 1);
    }
    if (recoveryEnabled) {
      const desired = recoveryDesiredVelocity(
        player,
        plan.fixedContactCenter,
        plan.fixedContactTick - tick + 1,
      );
      player.desiredVel.x = desired.x;
      player.desiredVel.y = desired.y;
      ledger.recoveryDesiredVelWrites++;
      player.faceTarget = plan.movementIntentAtCommit.faceTarget === null
        ? null
        : cloneV2(plan.movementIntentAtCommit.faceTarget);
    } else {
      setIntent(player, plan.movementIntentAtCommit);
    }
    player.physicsStep(DT);

    if (options.ballPerturbation?.tick === tick) {
      ball.vel.x += options.ballPerturbation.impulse.x;
      ball.vel.y += options.ballPerturbation.impulse.y;
      ledger.externalBallPerturbations++;
    }
    advanceGroundBall(ball);
    playerPath.push(cloneV2(player.pos));
    ballPath.push(cloneV2(ball.pos));
  }

  const access = directBallAccess(
    player,
    { pos: ball.pos, radius: plan.ballAfterSingleImpulse.radius ?? BALL_RADIUS },
    [player],
    CONTROL_RADIUS,
  );
  const foot = virtualFootAnchor(player.pos, player.bodyDir, plan.fixedFootSide);
  const footError = Math.hypot(ball.pos.x - foot.x, ball.pos.y - foot.y);
  // Lab-only planned-foot completion: stricter than M2, never a live reach expansion.
  const contacted = access.canDirectlyContact && footError <= BALL_RADIUS * 2;

  return {
    status: contacted ? 'contacted' : 'missed',
    actualPlayerAtContact: snapshotPlayerPhysics(player),
    actualBallAtContact: {
      pos: cloneV2(ball.pos),
      vel: cloneV2(ball.vel),
      radius: plan.ballAfterSingleImpulse.radius ?? BALL_RADIUS,
    },
    accessGranted: access.canDirectlyContact,
    footError,
    playerPath,
    ballPath,
    ledger,
  };
}
