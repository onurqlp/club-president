import type { ActionType } from '../sim/types';

/** Short human labels for player actions — shared by the 2D and 3D views. */
export const ACTION_SHORT: Record<ActionType, string> = {
  MoveToFormationSpot: 'form',
  MoveToPoint: 'point',
  TrackRelativePoint: 'relative',
  ChaseBall: 'chase',
  ReceivePass: 'recv',
  MakeRun: 'run!',
  MarkOpponent: 'mark',
  InterceptPass: 'cut',
  SupportBallCarrier: 'support',
  Dribble: 'dribble',
  Pass: 'pass',
  LoftedPass: 'switch!',
  ThroughBall: 'through!',
  Cross: 'cross!',
  ThrowOut: 'throw',
  HoldUp: 'hold-up',
  ShieldHold: 'shielding',
  Shoot: 'shoot!',
  ClearBall: 'clear',
  GoalkeeperSave: 'SAVE',
  GoalkeeperPosition: 'gk',
  GoalkeeperRush: 'RUSH!',
  HoldPosition: 'hold',
};
