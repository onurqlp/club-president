import { Rng } from '../utils/rng';
import { add, clone, dist, len, norm, scale, sub, v2, type V2 } from '../utils/vec';
import { decidePlayer } from '../ai/PlayerBrain';
import { applyMentality, applyUnderdogShift, mentalityOf } from '../ai/mentality';
import { pickCornerRoutine, updateTeamBrain } from '../ai/TeamBrain';
import { PROFILER as prof } from './profiler';
import { executeAction } from '../ai/actionExecutor';
import { cornerCrashSpots, fkWallSlots, formationSpot, offsideLineLocalX, shapeReady } from '../ai/formations';
import {
  advancePerceptionMemory, createPerceptionMemory, createScanFrame,
  materialisePerceptionSnapshot, observeBall, recordScanFrame, reconstructBodyMemory,
  type ObservedBall, type PerceptionMemory, type PerceptionSnapshot, type PerceptionTruth,
  type ScanFrame,
} from '../ai/perceptionSnapshot';
import type { KnownReachProfile } from '../ai/reachability';
import type {
  ApproachTable, ControlLevels, GoingConditionedTable, MergedChildTable, RoleConditionedTable,
  RoleControlLevels, StationEyeArm, StationEyeTrace,
} from '../ai/stationEye';
import type { WhetherEyeConfig } from '../ai/whetherEye';
import { OBM_POLICY_TTL_TICKS, type ObmPlane } from '../ai/offballEyes';
import { opennessOf } from '../ai/perception';
// DV T2-T0 (docs/world-model/DV-T2-T0-LEARNING-SEAM.md §SEAM): the per-team account book
// and its label ledger. Dormant — `dvLearnedMap` is a hard false in every production path.
import { DeliveryAccountBook, DeliveryLabelLedger } from '../ai/deliveryAccountBook';
// EK T0 §SEAM (docs/world-model/EK-T0-HOLD-BELIEF-SEAM.md): the hold account book and
// its label ledger. Dormant — `ekHoldLearn` / `ekHoldVeto` are hard false everywhere.
import { HoldAccountBook, HoldLabelLedger } from '../ai/holdAccountBook';
// ⭐ L3 T0 §SEAM — the defence account book and its label ledger. Dormant: `l3DefenceLearn` /
// `l3DefenceVeto` are hard false everywhere.
import {
  DefenceAccountBook, LungeLabelLedger, L3_DEFENCE_WINDOW_S, arrivalGroup,
} from '../ai/defenceBook';
// ⭐⭐ PC T0 §SEAM (docs/world-model/PC-T0-LATENCY-SEAM.md): the reaction-latency seat, the
// recognition book and its constants. Dormant — `pcReactionLatency` is hard false everywhere.
import {
  PC_CLASSES, PC_CLASS_RANK, PC_INITIATOR_PAYS, PC_N_COVER, PC_RELEVANCE_M, PcLatencySeat,
  PcRecognitionBook, pcRecognitionKey, type PcClass, type PcRelation,
} from '../ai/pcLatency';
import { rcAnticipationWeightOf, type TacticalGenome } from '../evolution/genome';
// ⭐⭐ RC T0 §SEAM (docs/world-model/RC-T0-PRECUE-SEAM.md): the alignment cue and RC-C0's own
// rank→belief table. PURE and CHANNEL-CLOSED — it is handed EXTERNAL FIELDS as scalars and can
// name nothing in this file. Dormant — `rcAnticipate` is hard false everywhere.
import { alignmentRank, rcBeliefForRank } from '../ai/receiverAnticipationSeat';
import { receptionZoneIndex } from '../ai/deliveryValueSeat';
import { BF_DEPTH } from './bodyFacing';
import {
  createInSnapshotLedger, type InSnapshotField, type InSnapshotLedger, type InSnapshotStore,
} from '../ai/inSnapshotView';
import {
  createInLookLedger, type InLookLedger, type InLookWindows,
} from '../ai/inLookAct';
import { Ball } from './Ball';
import {
  AI_INTERVAL, BALL_AIR_SPIN_DECAY, BALL_BOUNCE, BALL_BOUNCE_SPIN_RETENTION, BALL_FRICTION_K,
  BALL_GROUND_SPIN_DECAY, BOUNCE_DAMP, BOUNCE_MIN_VZ, BOX_DEPTH, BOX_WIDTH,
  CONTACT_BLIND_PEN, CONTROL_MAX_HEIGHT, CONTROL_MAX_SPEED, CONTROL_RADIUS, CORNER_CLEARANCE,
  CONTACT_COMMIT_TIME, CONTACT_CONTROL_DELAY_TICKS, CONTACT_CONTROL_RETENTION_MARGIN,
  CONTACT_RELEASE_INCOMING_SHARE,
  CONTACT_RELEASE_MAX_SPEED, CONTACT_RELEASE_MIN_SPEED, CONTACT_TANGENTIAL_RETENTION,
  DEFLECT_MAX_SPEED, DT,
  GK_CONTROL_MAX_SPEED, GK_HOLD_CLEARANCE, GOAL_HEIGHT, GOAL_WIDTH, GRAVITY, HALF_L, HALF_W,
  HEADER_MIN_HEIGHT,
  KICK_COOLDOWN, MATCH_DURATION, OUT_PLAY_COAST,
  PENALTY_CLEARANCE, PENALTY_SPOT_DIST, PLAYER_MIN_DIST, RESTART_CLEARANCE, RESTART_MIN_SETUP,
  CONTEST_RADIUS, RESTART_TIMEOUT, STOPPAGE_MAX, TEAM_AI_INTERVAL, TOUCH_CONTROL_DIST,
} from './constants';
import * as mech from './mechanics';
import type { FirstTouchTraceEntry } from './mechanics';
import {
  classifyBallControl,
  derivePossessionLocus,
  directBallAccess,
  type BallControlPhase,
  type ControlSequence,
  type ContestContact,
  type ContestEpisode,
  type ContestOrigin,
  type ContestResolution,
  type DirectBallAccess,
  type PossessionLocus,
} from './physical';
import { Player, TURN_RATE } from './Player';
import { clamp } from '../utils/math';
import { matchRating } from './ratings';
import { Team } from './Team';
import {
  ROSTER_SIZE, SUBS_MAX, TEAM_SIZE, emptyPlayerStats,
  type EventType, type GoalChannel, type MatchEvent, type MatchPhase, type MatchResult,
  type PlayerMatchStats,
  type CornerRoutine, type PossessionPhase, type RestartKind, type RestartState, type Side, type TeamInfo,
} from './types';

/**
 * Feed threshold for 🎼 pass-move lines (Phase 33). Measured (20-match
 * probe): 6 ⇒ ~2.1 lines/match, 8 ⇒ ~0.75 — six keeps the line an event
 * without feed spam (failure mode 7); `bestPassChain` records every chain.
 */
const PASS_MOVE_FEED_MIN = 6;

/**
 * EDS E3: arm the whole bundle for an AUDIT run without teaching every Match
 * construction site about it — the §2 equilibrium band runs through `League`
 * and the behavioural contract suite constructs its own matches, and neither
 * has any business knowing about a dormant slice. Unset ⇒ every flag off ⇒ the
 * production path is bit-for-bit the shipped one (pinned by a test, and by X1's
 * fingerprint). Same pattern as `formations.ts`'s EMERGENT_POS switch.
 */
const envArmed = (name: string): boolean =>
  typeof process !== 'undefined' && !!process.env && process.env[name] === '1';
const EDS_BUNDLE_ARMED = envArmed('EDS_BUNDLE');
/** E3R2: at most 11 scan frames can be inside retention; 16 is the safe ring. */
const SCAN_FRAME_RING = 16;
const EDS_TRACE_ARMED = envArmed('EDS_TRACE_CHOICE');

/* ------------------------------------------------------------------ *
 * C6 T1 — THE HONEST OFFSET (docs/world-model/C6-T1-HONEST-OFFSET.md) *
 * ------------------------------------------------------------------ *
 * The law that replaces the rigid `owner.pos + heading·0.85` glue when the
 * dormant `c6Carry` flag is armed (probe-only; OFF in every production path).
 * It reads ONLY the body's own `|v|`, its heading sweep rate `|ω|`, and its own
 * `dribbling` attribute — no opponents, no percepts, no ball-context (invariant
 * I2 / contract §4.2). Constants are candidate B's shape, frozen verbatim at the
 * T1 pre-registration; the dribbling terms are mean-preserving, centered on the
 * founding population mean d̄ = 0.40 so a mean body reproduces candidate B and
 * T0's measured effects transfer as the population-mean expectations.
 */
const C6_D_BAR = 0.4; // founding population mean dribbling (the centering anchor)
const C6_V_REF = 7.0; // TOP_SPEED_REF — the role top-speed reference
const C6_CARRY_BASE = 0.55;
const C6_CARRY_SPEED = 0.15;
const C6_CARRY_TUCK = 0.3;
const C6_CARRY_FLOOR = 0.3;
const C6_CARRY_CAP = 1.4;
const C6_TUCK_KAPPA = 1.0; // dribbling scaling of the tuck (bounded ±30% of B)
const C6_TAU_BASE = 0.18; // candidate B's lag (s)
const C6_TAU_SLOPE = 0.1; // s per unit dribbling
const C6_TAU_MIN = 0.12;
const C6_TAU_MAX = 0.24;
const C6_SIGMA_AMP = 0.06; // wobble amplitude (m), not a driver
const C6_SIGMA_DRB = 0.8; // dribbling clean-up of the wobble
/** The heading ring must hold at least the τ cap (round(0.24/DT) = 14 ticks). */
const C6_HEADING_RING = 16;

/** Candidate B's magnitude law, dribbling-scaled tuck; mean-preserving at d̄. */
const c6CarryLen = (speed: number, omega: number, drb: number): number => {
  const tuckGain = 1 + C6_TUCK_KAPPA * (drb - C6_D_BAR);
  return clamp(
    C6_CARRY_BASE + C6_CARRY_SPEED * (speed / C6_V_REF) - C6_CARRY_TUCK * (omega / TURN_RATE) * tuckGain,
    C6_CARRY_FLOOR,
    C6_CARRY_CAP,
  );
};
/** The technique-priced lag τ (seconds), clamped inside B's measured-alive band. */
const c6TauSeconds = (drb: number): number =>
  clamp(C6_TAU_BASE + C6_TAU_SLOPE * (drb - C6_D_BAR), C6_TAU_MIN, C6_TAU_MAX);
/** τ in ticks (DT = 1/60): d̄ → round(0.18·60) = 11; band [7, 14]. */
const c6TauTicks = (drb: number): number => Math.round(c6TauSeconds(drb) / DT);
/** The wobble σ (m): gated on turn intensity, scaled down by dribbling. */
const c6Sigma = (omega: number, drb: number): number =>
  C6_SIGMA_AMP * (omega / TURN_RATE) * (1 - C6_SIGMA_DRB * drb);

/* ------------- C7 T1 the shot wind-up (docs/world-model/C7-T1-PENDINGKICK.md) ------------- */
// The FROZEN §LAW constants — each a T0 MID bracket derivation (see the doc's
// §LAW table). W is a deterministic function of the body's own |v|, |ω| and
// `dribbling` (mean-centered on t̄); it reads no opponent, no percept, no ball
// context (I2) and carries no rng draw (I1).
const C7_W_BASE = 0.06; // T0 §5 MID W_BASE
const C7_W_MOVE = 0.05; // T0 §5 MID W_MOVE (the dominant, move-on term)
const C7_W_TURN = 0.05; // T0 §5 MID W_TURN
const C7_W_TECH = 0.05; // T0 §5 MID W_TECH (technique buys the set-time back)
const C7_W_FLOOR = 0.05; // T0 §5 MID W_FLOOR (3 ticks; no free instant strikes)
const C7_W_CAP = 0.18; // T0 §5 MID W_CAP (11 ticks; ≪ the 0.33 s median spell)
const C7_V_REF = 7.0; // role top-speed reference
const C7_T_BAR = 0.4068; // measured population-mean dribbling (T0 §5(ii))
/** W in whole ticks (§LAW): clamp the continuous W to [W_FLOOR,W_CAP] seconds,
 *  round to the nearest whole tick (round-half-up), then clamp to [3,11]. */
const c7WindupTicks = (v: number, omega: number, tech: number): number => {
  const raw =
    C7_W_BASE + C7_W_MOVE * (v / C7_V_REF) + C7_W_TURN * (omega / TURN_RATE) - C7_W_TECH * (tech - C7_T_BAR);
  const clamped = raw < C7_W_FLOOR ? C7_W_FLOOR : raw > C7_W_CAP ? C7_W_CAP : raw;
  const ticks = Math.round(clamped * 60); // DT = 1/60
  return ticks < 3 ? 3 : ticks > 11 ? 11 : ticks;
};

/* ------------- BK T0 THE FACING LAW (docs/world-model/BK-T0-FACING-LAW.md) ------------- */
/**
 * BK T0 §LAW — THE STRIKE CONE, in whole ticks and in radians.
 *
 * NOT a new number. `BK_CONE_TICKS` is the C7 §LAW ceiling `C7_W_CAP` under the same
 * `round(W · 60)` tick conversion `c7WindupTicks` itself uses (this file's C7 family
 * above) — i.e. the LARGEST time charge the certified wind-up family knows how to make.
 * `BK_CONE_RAD` is that budget spent at the shipped body turn rate: the widest rotation
 * the world's EXISTING time price can already absorb. Everything is derived from two
 * shipped constants (`C7_W_CAP`, `TURN_RATE`) and the engine's own `DT`; nothing is
 * chosen by taste (#200).
 *
 * Numerically: 11 ticks × (1/60) s × 6.5 rad/s = 1.1916667 rad = 68.2775°, i.e. the
 * `kickMisalignment` value (1 − cos θ)/2 = 0.3149440 — the cone BK-C0 §R4 published.
 */
export const BK_CONE_TICKS = Math.round(C7_W_CAP * 60); // 11 ticks — the C7 cap, in ticks
export const BK_CONE_RAD = BK_CONE_TICKS * DT * TURN_RATE; // 1.1916667 rad = 68.2775°
/**
 * BK T0 §LAW — THE ADDED TICKS: the turn the strike REQUIRES, minus the turn the shipped
 * wind-up ceiling already pays for. `theta` is the exact rotation from the body's current
 * heading to the strike direction; `turnTicks = ceil(theta / (TURN_RATE · DT))` is BK-C0's
 * own `turnTicksWhole` column (the body cannot be aimed until the tick in which the sweep
 * completes, so the ceiling — not a round — is the honest count).
 *
 * The law is `max(0, turnTicks − BK_CONE_TICKS)`: inside the cone the required turn fits
 * inside the budget the world already pays and the release is UNCHANGED; outside it, the
 * timeline absorbs exactly the excess, so the release lands INSIDE the cone (the added
 * ticks alone cover the turn down to the edge; every base wind-up tick is surplus). No
 * clamp is added — the range [0, 18] is structural (θ ≤ π ⇒ turnTicks ≤ 29, the full
 * reversal of record), not a taste bound.
 *
 * A TIME COST, NEVER A BAN: no strike is refused, no chooser option is removed, no rng is
 * drawn (I1) and nothing outside the body's own heading and the arm-time aim is read (I2).
 */
export const bkFacingExtraTicks = (
  heading: V2, aimX: number, aimY: number, fromX: number, fromY: number,
): number => {
  const dx = aimX - fromX;
  const dy = aimY - fromY;
  const dl = Math.sqrt(dx * dx + dy * dy);
  // A degenerate aim (the strike point ON the body) names no direction — the shipped
  // `faceTarget` integrator ignores it by the same `1e-6` test, so the law charges nothing.
  if (!(dl > 1e-6)) return 0;
  const c = (heading.x * dx + heading.y * dy) / dl;
  const theta = Math.acos(c < -1 ? -1 : c > 1 ? 1 : c);
  const turnTicks = Math.ceil(theta / (TURN_RATE * DT));
  return turnTicks > BK_CONE_TICKS ? turnTicks - BK_CONE_TICKS : 0;
};

/* ------------- O2 T0 THE LOOK (docs/world-model/O2-T0-DORMANT-SEAM.md) ------------- */
/**
 * O2 T0 §LAW — the FROZEN LOOK interval, in whole ticks.
 *
 * NOT a new number: it is DERIVED here from the C7 §LAW constant family above
 * (`C7_W_CAP = 0.18 s`, the certified wind-up ceiling, this file's line 141), by
 * the same `round(W · 60)` tick conversion the law itself uses — and it lands on
 * exactly the [3,11] clamp ceiling `c7WindupTicks` already enforces. The LOOK is
 * therefore priced at the TOP of the traced release-wind-up scale: the most
 * expensive moment the certified family knows how to charge for standing still.
 * Contract O2-LOOK-CONTRACT §2 M-O2.1 names that family ("the C7 wind-up scale is
 * the natural neighbour"); no constant is invented for this slice.
 */
export const O2_LOOK_TICKS = Math.round(C7_W_CAP * 60); // 11 ticks = 0.18333 s

/** One keyed uniform in [0, 1) — the E3R2 keyed-noise style (#13.3), a pure
 *  function of (gid, tick, channel); never touches `match.rng`. */
const c6KeyedUnit = (gid: number, tick: number, channel: number): number => {
  let h = 0x6d6e4c31 | 0;
  h = Math.imul(h ^ (gid + 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (tick + 0xc2b2ae35), 0x27d4eb2d);
  h = Math.imul(h ^ (channel + 0x165667b1), 0x9e3779b1);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
};
/** A deterministic 2D unit gaussian keyed on (gid, simTick); Box-Muller from two
 *  keyed uniforms. Zero-mean, so it does not shift the population-mean far-side /
 *  eligibility expectations — only inflates their variance (doc §LAW). */
const c6KeyedGaussian2D = (gid: number, tick: number): { x: number; y: number } => {
  const u1 = Math.min(1 - 1e-12, Math.max(1e-12, c6KeyedUnit(gid, tick, 0)));
  const u2 = c6KeyedUnit(gid, tick, 1);
  const r = Math.sqrt(-2 * Math.log(u1));
  const a = 2 * Math.PI * u2;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
};

/**
 * Per-foul injury chance at neutral fatigue/age (Phase 118). Calibrated by
 * the injury-census probe against the user-ratified budget of ~1-2
 * injuries per club-season: ≈4.5-5 fouls/match ×
 * observed mean multiplier ≈0.6 (fouled carriers run fresher than the
 * average leg) × this ≈ 0.27-0.30 injuries/match ≈ 1.2-1.4 per
 * club-season (census, 12-season worlds 991/424242).
 */
const INJURY_BASE = 0.10;

export interface PendingPass {
  side: Side;
  passerGid: number;
  targetGid: number;
  t: number;
  /**
   * Offside, judged AT KICK TIME (Phase 29): the target was in an offside
   * position when the ball was struck. The flag only becomes an offence if
   * the ball reaches the flagged target (giveBall or a won header) —
   * defenders playing it, or another teammate arriving, plays on.
   */
  offside: boolean;
  /** Where the flagged target stood at the kick — the free-kick spot. */
  offsideSpot: V2 | null;
  /** Third-man release (Phase 34): a fresh receiver bouncing it to a runner. */
  bounce?: boolean;
}

export interface PendingShot {
  side: Side;
  shooterGid: number;
  xg: number;
  t: number;
  resolved: boolean;
  /** Index into Match.shotLog for outcome bookkeeping. */
  logIndex: number;
  /** Passer credited with an assist if this shot scores (else null). */
  assistGid: number | null;
  /**
   * Save-probability multiplier fixed AT SHOT TIME from how far the ball's
   * path passes from the keeper's position when the shot is struck. Computed
   * once (not live) so the keeper's dive toward the line doesn't erase the
   * difficulty — it models reaction time. 1 = straight at the keeper,
   * 0.25 = shaving the edge of reach.
   */
  difficulty: number;
  /**
   * A PLACED ball (Phase 32, direct free kicks): the keeper is set and
   * expecting it — tryKeeperSave floors the difficulty discount instead of
   * treating the far-corner curl like an open-play reaction save.
   */
  placed?: boolean;
  /**
   * ANGLE CLOSED (Phase 103, the sweeper's missing physics): how near the
   * keeper stood to the SHOOTER at the strike (1 at his feet, 0 beyond 7m).
   * Frozen at shot time like `difficulty`. The save model was blind to
   * closing down — a keeper at the striker's toes saved at the same rate
   * as one on his line, so 出击 could never pay and the walk-in pipe had
   * no keeper answer. The xG model stays keeper-blind (phase-85's rule:
   * evolved defending shows up as UNDER-performance, like real xG).
   * Chips and placed balls carry 0 — the chip IS the counter.
   */
  closeIn?: number;
  /**
   * ANGLE COVERED (Phase 119b, the 1v1 honesty lever): how much of the
   * goal's angular window the keeper's POSITION cut at the strike — his
   * depth off the line over the shooter's distance, discounted when he
   * stands off the shooter→goal line (a dragged keeper covers nothing).
   * The onevone-anatomy probe caught evolution routing AROUND closeIn:
   * late-gen shooters strike from 8-10m where closeIn ≈ 0.1, yet a keeper
   * 3m up the cone still covers ~40% of the window — a credit the save
   * model never paid. Frozen at shot time; shares closeIn's ×0.9 slope
   * via max() so the two never double-count.
   */
  coverage?: number;
}

/** One shot for the analytics timeline (xG race chart). */
export interface ShotLogEntry {
  t: number;
  minute: number;
  side: Side;
  xg: number;
  /** Shot-context telemetry (Phase 86): defender pressure at the strike,
   * the composed-1v1 flag, and what SERVED it. Absent on old entries. */
  pressure?: number;
  oneVone?: boolean;
  assist?: 'through' | 'cutback' | 'cross' | 'pass' | 'lofted' | 'none';
  outcome: 'pending' | 'goal' | 'saved' | 'miss';
  /** Bodies on the shot corridor at the strike (Phase 31, `laneBlockers`). */
  blockers: number;
  /** The lofted finish over an advanced keeper (Phase 69) — probes and the
   * feed tell the chip apart from the placed ground strike. */
  chip?: boolean;
  /** What CREATED the chance (Phase 113) — priced at the strike, banked
   * into the club's goal-channel ledger only if this shot scores. */
  channel?: GoalChannel;
}

/**
 * DF T2 §SEAM — the decision surface's usage ledger (pure bookkeeping; see the field's own
 * docblock on `Match.dfSurfaceLedger`). Counts are in the `DF_SURFACE_OPTIONS` order.
 */
export interface DfSurfaceLedger {
  /** defender-passes on which the surface took an option (the denominator of record) */
  elections: number;
  /** defender-passes on which no option was affordable or legal at all */
  idle: number;
  /** defender-passes on which the shipped contain gate's geometry offered the press option */
  pressOffered: number;
  /** of those, the ones the team's OWN defence book declined (decline-only, M-L3.3) */
  pressDeclinedByBook: number;
  /** decision counts per option: [press, hold, jump, take] */
  byOption: number[];
  /** the same, split by team mode: [Defend×4, Press×4] */
  byModeOption: number[];
  /** the same, per BODY (`gid` → per-option counts) — raw, for the instrument to join */
  byGid: Map<number, number[]>;
}

export interface MatchConfig {
  seed: number;
  teamA: TeamInfo;
  teamB: TeamInfo;
  /** Sim-seconds for the whole match (default MATCH_DURATION). Tests use short ones. */
  duration?: number;
  /** Armed rivalry fixture (Phase 40): a touch more press and bite, 🔥 banner. */
  derby?: boolean;
  /** Pure-observational M3 contest ledger; OFF in live/headless play by default. */
  traceContests?: boolean;
  /**
   * EDS E1a first-touch instrument (docs/world-model/EDS-E1A-FIRST-TOUCH-INSTRUMENT.md):
   * log every first-touch adjudication with its own term decomposition. Pure
   * observation, OFF by default — it must not change a single tick.
   */
  traceFirstTouch?: boolean;
  /**
   * EDS E1b flagged touch cost (docs/world-model/EDS-E1B-TOUCH-COST-CURVE.md):
   * C1-B's honest speed-dependent control curve, OFF by default. With the flag
   * off `touchFailChance` is bit-for-bit the shipped one.
   */
  edsTouchCost?: boolean;
  /**
   * C5 T0 (docs/world-model/C5-T0-HOLD-MECHANICS.md): the generalized
   * shield-hold mechanics. OFF by default and with ZERO live callers — the
   * action is reachable only through `forcedHold`, which no production path
   * ever sets. Legacy `HoldUp` keeps its own code path verbatim.
   */
  c5Hold?: boolean;
  /**
   * C5 T0: the ELECTIVE first-touch window. Today the window is granted by
   * pressure alone (the reception path below); armed, a probe may elect it
   * through `forcedTouchFork`. It changes no pricing — an elected window
   * enters exactly the same `oneTouchMul` / `touchFailChance` paths.
   */
  c5TouchFork?: boolean;
  /**
   * C4 T1-FLIGHT (docs/world-model/C4-T1-FLIGHT.md): crosses get a flight-time
   * floor at the apex that clears the outfield header band. The floor is
   * DERIVED — `CROSS_FLIGHT_MIN_S = sqrt(8·HEADER_MIN_HEIGHT/GRAVITY)` — not
   * chosen, and it applies to `performCross` alone. OFF by default.
   */
  c4Flight?: boolean;
  /**
   * C4 T1-FLIGHT §2.4, the REPORTED variant arm (probe-only, never shipped):
   * with `c4Flight` armed, hold the run-lead's flight estimate at the OLD law
   * instead of tracking the new one. Ruling #31.1 made rule-preserving
   * primary; this exists so the alternative is measured rather than argued.
   */
  c4FlightStaleLead?: boolean;
  /**
   * C4 T2-ARRIVAL (docs/world-model/C4-T2-ARRIVAL.md): the open-play analogue
   * of `team.cornerCrash`. A cross clears `ball.owner`, and `PlayerBrain`'s
   * run gate gives every licensed attacking body its `MakeRun` only while a
   * carrier exists — so today the box EMPTIES for the whole flight (Phase
   * 31.9's bug, still live in open play). Armed, `performCross` snapshots the
   * ALREADY-licensed bodies and holds them for exactly `ballLanding(ball).t`.
   * No new licence, no new count, nothing pre-kick. OFF by default.
   */
  c4Arrival?: boolean;
  /**
   * C4 T2-ARRIVAL §2.3, the second rung: with `c4Arrival` armed, the licensed
   * body CLOSEST to the landing attacks the meet point — the same
   * `landing − flightDir·2.5` the intended receiver has had since Phase 63
   * (`actionExecutor.ts:159-166`) and the corner crash since 31.9. Inert
   * without `c4Arrival`, because without the licence there is no run to route.
   */
  c4ArrivalReroute?: boolean;
  /**
   * EDS E2b-1 (docs/world-model/EDS-E2B1-BOTH-SIDES-AB.md): the defender's
   * interception entry reads HIS OWN perceived ball instead of truth, through
   * the shared awareness trunk. Off in every production path. The awareness
   * the trunk runs at travels with it — one number, both sides, per
   * SUBSTRATE-MAP's no-one-sided-reading-attr ruling.
   */
  edsPerceivedDefence?: boolean;
  edsAwareness?: number;
  /**
   * EDS E3 (docs/world-model/EDS-E3-COEVOLUTION-AUDIT.md §2.1): the passer
   * chooses his TARGET through the E2b-1R pricing, from his own snapshot, over
   * executable options only. The last dormant-to-live step of the slice, and
   * the one that carries the §2 equilibrium band. Off in every production path.
   */
  edsPerceivedChoice?: boolean;
  /**
   * EDS E5 (docs/world-model/EDS-E5-VALUE-AXIS.md, ruling #15.3): the chooser's
   * price becomes measured-P × measured-V — the reception probability times the
   * censused value of arriving in that zone. Off in every production path, and
   * with it off `pricePassOption` returns the E3R price bit for bit.
   */
  edsValueAxis?: boolean;
  /**
   * EDS E3R2 (ruling #13.3): the EAGER perception path, kept as the reference
   * implementation the lazy one is pinned against. Perception is PULL by
   * default — a body knows what its scans would have shown, computed at the
   * moment it acts — and this flag runs the old push-time computation instead
   * so the two can be compared field for field. Probe surface only.
   */
  edsEagerPerception?: boolean;
  /**
   * C6 T1 (docs/world-model/C6-T1-HONEST-OFFSET.md): the honest carrying offset.
   * When armed, the OUTFIELD glued ball (`carry = 0.85`, not the GK `0.3` case)
   * follows the §LAW magnitude/lag/noise around the body instead of riding rigid
   * at `heading·0.85`. Reads only the body's own `|v|`, `|ω|` and `dribbling`
   * (I2). **Default OFF, null in every production path (Road B, #47.5 nothing
   * ships)** — a probe arms it on a forked world; the fingerprint is unchanged.
   * The de-glue branch and the GK-hold path are untouched (I5/I6).
   */
  c6Carry?: boolean;
  /**
   * C7 T1 (docs/world-model/C7-T1-PENDINGKICK.md): the shot wind-up. When armed,
   * an open-play/one-touch shot commit does NOT strike synchronously — the body
   * enters `pendingKick` (the release-side mirror of `pendingControl`), holds the
   * still-owned ball at its carry offset and turns toward the aim for W ticks (the
   * §LAW, reading only |v|, |ω| and dribbling — I1/I2), then the strike resolves
   * at readyTick via the EXISTING performShot math evaluated at strike time.
   * **Default OFF, null in every production path (Road B, #56.3 nothing ships)** —
   * a probe arms it on a forked world; the fingerprint is unchanged. Free-kicks,
   * headers, passes, crosses, clearances, keeper distribution are untouched (I9).
   */
  c7Windup?: boolean;
  /**
   * O1 T1 (docs/world-model/O1-T1-PASS-WINDUP.md): the shortPass wind-up — the
   * pass-family half of the certified C7 release seam (cut-1, ruling #178.3).
   * When armed, an open-play shortPass commit (`PlayerBrain.ts` `case 'Pass'`,
   * the `performPass` statement) does NOT release synchronously: the body enters
   * `pendingPassWindup`, holds the still-owned ball and turns toward the mate for W
   * ticks (the C7 §LAW constants verbatim, with tech = `attrs.passing` — the pass
   * family's own attribute on the shared price chain, the one DESIGNED deviation),
   * then the pass resolves at `readyTick` via the EXISTING performPass math
   * evaluated at strike time. The one-touch window is the DESIGNED bypass
   * (`firstTouchWindow > 0` ⇒ immediate release at the existing `oneTouchMul`
   * price, no new charge); restart (`mustKick`) and kickoff passes are excluded;
   * the cutback branch and the other eight pass kinds are untouched.
   * **Default OFF, an explicit boolean — never `EDS_BUNDLE_ARMED`, never
   * env-armed, absent from `a4World` (Road B, #179.2: nothing ships)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  o1PassWindup?: boolean;
  /**
   * ⭐⭐ DX T0 (docs/world-model/DX-T0-WINDUP-AIM-SEAM.md; contract
   * DX-DELIVERY-EXECUTION-CONTRACT.md §2 M-DX.1/M-DX.2; ruling #352 item 3) — THE
   * WIND-UP AIM DOOR: a pass that enters the WIND-UP channel is struck toward THE
   * ELECTED CANDIDATE'S OWN AIM — the exact point the argmax scored — instead of
   * discarding it and re-aiming at the target's body.
   *
   * The ONE change is WHICH POINT the already-shipped kick is struck toward. NOTHING
   * about the flight changes: no speed, no height, no curl, no new physics, no new
   * candidate, no new scoring term, no new gene and no rng draw. The elected
   * displacement rides the wind-up through `dxStrikeAim` → the wind-up record →
   * the SHIPPED `performPass` lead input (the PW T0b deposit idiom, so every banked
   * strike statement and `armPendingPass`'s own signature stay byte-for-byte as
   * certified). A to-feet election carries ZERO displacement, so a world arming this
   * door WITHOUT a delivery-choice door armed is unchanged (M-DX.2, measured).
   * The one-touch bypass (`firstTouchWindow > 0`) is untouched — it already honours
   * the elected aim through its own synchronous statement.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, and NO WORLD ARMS IT: the string is absent from
   * `a4World.ts` entirely (Road B, #352 item 3: nothing ships)**; a probe arms it on
   * a forked world, and the production fingerprint is unchanged.
   */
  dxWindupAim?: boolean;
  /**
   * BK T0 (docs/world-model/BK-T0-FACING-LAW.md; contract BK-BODYBALL-CONTRACT.md §2
   * M-BK.1): THE FACING LAW — the kick's timeline absorbs the body turn the strike
   * direction requires. When armed, an armed wind-up's W is EXTENDED by
   * `bkFacingExtraTicks` (the §LAW above): the excess of the required rotation over the
   * cone the shipped wind-up ceiling can already absorb. The body then turns through
   * that longer window on the SHIPPED `faceTarget` integrator both arms already set, so
   * the release reads a heading that actually got there and the EXISTING orientation
   * prices (`orientationPowerMul` / `orientationNoiseMul`) price the RESIDUAL. No strike
   * is banned, no new price term is created, no rng is drawn.
   *
   * It EXTENDS the wind-up seams and owns no arm site of its own: with `c7Windup` off
   * shots are untouched, with `o1PassWindup` off passes are untouched, and the one-touch
   * bypass (`firstTouchWindow > 0` releases synchronously, `PlayerBrain`'s own gate) is
   * honoured by construction — the law lives INSIDE the arm methods that gate cannot
   * reach. With NEITHER wind-up armed the flag is provably inert, so the constructor
   * REFUSES to build that world rather than let it claim a law it does not have (the
   * PW×PTP precedent, #293.3 (d)).
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, opt-in via `a4World` v9+ (身体诚实的世界, #310; the shipped default world never arms it — Road B)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  bkFacingLaw?: boolean;
  /**
   * BK T1 (docs/world-model/BK-T1-CONTACT-LAW.md; contract BK-BODYBALL-CONTRACT.md §2
   * M-BK.2): THE CONTACT LAW — the ball stops passing THROUGH bodies. Two halves, both
   * derived, neither inventing a constant:
   *
   * 1. **THE BODY STRIKE.** The shipped claim filter drops a body from
   *    `collectGroundContactClaims` while `kickCooldown > 0` or `stunTimer > 0` — BK-C0
   *    measured that gate as 73.4 % of reach crossings and 81.9 % of visual through-body
   *    ticks. When armed, such a body (never `sentOff`, never the ball's own `lastTouch`)
   *    is collected as a `bodyStrike` claim whenever the ball centre is inside his
   *    PHYSICAL SHELL — `coreRadius + ball.radius`, the very `clearance` expression
   *    `accessLineGeometry` already uses to let his core BLOCK someone else's access line.
   *    A shell that already stops an access line now also stops the ball. He gains NO
   *    control: the strike writes no `pendingControl`, runs no first touch, draws no rng —
   *    it is the passive rebound `applyControlContact` already computes (the `CONTACT_*`
   *    family), with the control half removed.
   * 2. **THE Z PARTITION.** Shipped, the ground channel runs at `z <= CONTROL_MAX_HEIGHT`
   *    (1.30) and the aerial channel at `z >= HEADER_MIN_HEIGHT` (1.35), so
   *    z ∈ (1.30, 1.35) is a dead band nobody may touch. When armed the ground/aerial
   *    dispatch boundary is `HEADER_MIN_HEIGHT` on BOTH sides, so the bands PARTITION by
   *    construction. Neither shipped constant is edited (both are load-bearing elsewhere:
   *    `CROSS_FLIGHT_MIN_S` is an expression of `HEADER_MIN_HEIGHT`, and
   *    `CONTROL_MAX_HEIGHT` gates two `actionExecutor` decisions).
   *
   * It owns its own sites and depends on NO other flag, so it composes freely with
   * everything — there is no inert composition and therefore no constructor refusal.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, opt-in via `a4World` v9+ (身体诚实的世界, #310; the shipped default world never arms it — Road B)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  bkContactLaw?: boolean;
  /**
   * ⭐⭐ BF T0 (docs/world-model/BF-T0-FACING-COST-SEAM.md; contract
   * BF-BODY-FACING-CONTRACT.md §2 M-BF.1; rulings #374 item 5 / #375) — THE FACING-COST
   * LAW. Armed, a body's INTENDED velocity is scaled by `facingFactor(cos φ, D)` inside
   * `Player.physicsStep` before the top-speed clamp: full ahead, `BF_OFF_HEADING_FRACTION`
   * = 0.70 once it is 90° or more off its heading, flat near 0°. 「背着跑、侧着跑，跑不出全速」
   *
   * The flag reaches the body as a PER-BODY NUMBER (`Player.facingDepth`, ruling #375
   * item 3) written by this Match onto every body it owns — never a global, never read
   * inside the physics loop.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, named by NO world and NO preset (Road B: the entry rung is a
   * later stage's business, after BF-T1 and the user's gate)**; a probe arms it, and the
   * production fingerprint is unchanged.
   */
  bfFacingCost?: boolean;
  /**
   * ⭐⭐ BQ T0 (docs/world-model/BQ-T0-CUSHION-LAW.md; contract BK-BODYBALL-CONTRACT.md
   * §2-AMENDMENT M-BK.5; ruling #384 items 5–6) — THE CUSHION LAW. Armed, a cushioning
   * contact leaves the ball WITH the body: in `applyControlContact` the ball takes the
   * body's velocity and NOTHING else, so the relative velocity after the touch is ZERO.
   * The shipped outward release along the body→ball normal (its floor, its cap and its
   * incoming share) and the tangential retention are RETIRED on the armed path only — the
   * four constants stay, character for character, for the shipped one.
   * 「缓冲留球：脚碰到球，球跟着人走，三拍之后还在脚边」
   *
   * ⛔ EVERYTHING ELSE STANDS: the three-tick window, the resolver's retention
   * margin, the first-touch roll, the contest inside the window, the body-strike and
   * deflection channels, `vz`/spin damping, `lastTouch`, the commit cooldown, the offside
   * branch. No new constant: zero is the ABSENCE of a push, not a number chosen.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, named by NO world and NO preset (Road B: the entry rung is a
   * later stage's business, after BQ-T1 and the user's gate)**; a probe arms it, and the
   * production fingerprint is unchanged.
   */
  bqCushion?: boolean;
  /**
   * ⭐⭐ LN T0 (docs/world-model/LN-T0-OWN-LANE-PRICE.md; contract
   * LN-OWN-LANE-CONTRACT.md §2 M-LN.1/M-LN.2/M-LN.3, ruling #393 item 5) — THE OWN-LANE
   * PRICE (让传球者看见自己人). Armed, the passer's three pricers read the SHIPPED
   * `laneOpenness` geometry over his OWN outfield bodies minus himself minus the intended
   * target (`src/ai/ownLaneSeat.ts`) and pay `w · (1 − ownLaneOpenness)` for a line one of
   * ours is standing in, where `w` is the born-absent gene `lnOwnLaneWeight`.
   *
   * Read at exactly ONE place in `src/**` — the `lnSeat` construction in
   * `PlayerBrain.decideCarrier` — which serves FOUR sites, all inside that one function:
   * the hoisted `groundCandidate` pricer (`sLn`, between `sGc` and `sRa`), the kick-off
   * play-back scorer's own loop, the EDS perceived chooser's SNAPSHOT SCOPE (the passer's
   * own outfield gids enter it so he perceives his own men through the same eyes), and the
   * perceived chooser's executable-option price (multiplied by `1 − w · (1 −
   * ownLaneOpenness)` before the argmax). The through-ball scorer, the cutback scorer and
   * `TeamBrain` are UNTOUCHED (LN-C3's K = 3). No predicate, no threshold, no ban
   * (#200 / #328): the argmax still decides everywhere.
   *
   * Seat null ⇒ no scope statement runs, no openness is computed and every score is the
   * shipped double; gene absent ⇒ `w = 0` ⇒ the price is exactly `+0` and the world is
   * byte-identical with the path LIVE (the identity pin measures it).
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B, #393 item 5: nothing
   * ships)**; a probe arms it, and the production fingerprint is unchanged.
   */
  lnOwnLanePrice?: boolean;
  /**
   * ⭐⭐ GK T0 (docs/world-model/GK-T0-DIVE-LAW.md; contract GK-KEEPER-BODY-CONTRACT.md
   * §2 M-GK.1/M-GK.2/M-GK.3, ruling #398 item 5) — THE DIVE LAW (身体跟着手走). GK-C0
   * measured the save resolving a mean 1.968465 m from the keeper's BODY (0.675774 of
   * catches beyond 2 m) while the body stays where it stood, and the caught ball then
   * JUMPING a mean 1.711552 m into his feet on 0.985375 of catches. Armed, the engine
   * records the contact point on the KEEPER at the save tick (`Player.saveContact`), the
   * executor steers his BODY to it at his own `topSpeed` for as long as the existing 0.7 s
   * `saveAnimTimer` window runs, and the caught ball WAITS at the hands until the body's
   * carry point reaches it. NO NEW CONSTANT (#384 item 5): the window, the carry length
   * and `topSpeed` are all the engine's own.
   *
   * ⭐⭐ RE-FORMED AT GK-T0b (ruling #399 item 3): the body is steered on EVERY tick while
   * the contact is set — the field IS the keeper scope, no action-type enumeration — and the
   * caught ball waits until the body ARRIVES or the keeper LOSES OWNERSHIP, never until the
   * animation timer expires (the sprite's window and the law's window are different things).
   *
   * Read at exactly FOUR sites in `src/**`: the TWO `saveContact` writes in
   * `mechanics.tryKeeperSave` (one per branch of the save — the catch marks `caught: true`,
   * the parry `caught: false`, steer-only); the ONE steering override in `actionExecutor`,
   * after the switch, carrying the keeper case's own `clampToBox` (raw for
   * `GoalkeeperRush`); and, in this file, the ONE waiting branch in the carry law together
   * with the ONE ownership-loss sweep immediately above the ball step. NOTHING ELSE MOVES:
   * not `saveP`, not `keeperReach`, not `SAVE_STRETCH`, not `giveBall`'s timing, not the
   * parry's ball velocity, not the renderer — the shot's OUTCOME at the save tick is
   * identical between OFF and ON.
   *
   * Flag off ⇒ `saveContact` is never written, stays null for the whole match, and every
   * new statement is a conjunction that dies on this boolean.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B, #398 item 5: nothing
   * ships)**; a probe arms it, and the production fingerprint is unchanged.
   */
  gkDiveBody?: boolean;
  /**
   * ⭐⭐ DS T0 (docs/world-model/DS-T0-OWN-RUN-SEAM.md; contract
   * DS-DESIGNATION-CONTRACT.md §2 M-DS.1/M-DS.2/M-DS.3/M-DS.5, ruling #405 item 3) — THE OWN
   * RUN 「自己的前插」. DS-C0 measured the read of record: EVERY open-play run in this engine
   * is a HAT — `hatClass.shareOfMakeRun.OTHER` = 0 of 964,441 attacking `MakeRun` decisions,
   * every one of the five `MakeRun` pushes hat-guarded, six `why` literals and no seventh. A
   * body cannot choose to run; the coach names 995.819820 runners a match and the player
   * obeys.
   *
   * Armed, `PlayerBrain.decideOffBall`'s in-possession branch pushes ONE more `MakeRun`
   * candidate for a body carrying NO hat (not in `team.runners`, not `team.arriver`, not
   * `team.overlapper`, no live `p.wallRun`), scored
   * `W.runScore · prior · obmRunMul · (tired ? OFFBALL_TIRED_MUL : 1)` where the prior is the
   * COACH'S OWN RANKING (`RUN_ROLE_W[role] + localX/45`) normalised by its own maximum. Its
   * `why` is the SEVENTH literal, `'own run in behind'`, and its executor routing is the
   * `MakeRun` case's EXISTING default branch (`runTarget`) — NO executor edit.
   *
   * NO NEW CONSTANT (#202), NO PREDICATE ON A FOOTBALL QUANTITY (#200): the fork's whole
   * conditional set is this gate, the not-hatted / licence-liveness guards, and the [0,1]
   * clamp on the prior. NO new gene and NO percept pull at T0 — the eyes are the OBM seat's
   * own `obmRunMul`, which is exactly 1 when `obmMovement` is absent, so `s *= 1` is an
   * IEEE-754 identity.
   *
   * Read at exactly ONE site in `src/**` (the gate in `decideOffBall`).
   * Flag off ⇒ the whole block is skipped and no statement of it runs.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B, #405 item 3: nothing
   * ships)**; a probe arms it, and the production fingerprint is unchanged.
   */
  dsOwnRun?: boolean;
  /**
   * ⭐⭐ DS T0 — THE HATS-OFF ARM (contract §2 M-DS.4, ruling #405 item 3(iv)). Armed,
   * `TeamBrain.assignRunners` SKIPS exactly its TWO OPEN-PLAY blocks — the runner scoring
   * that fills `team.runners`, and the open-play arriver pick — so in open play the board is
   * empty and NOBODY carries a 前插 hat. It exists so DS-T1 can be X-SRC-ZERO with three
   * arms: HATS (shipped) · HATS + OWN RUN · OWN RUN ALONE.
   *
   * ⛔ SLICE ONE IS 前插 ONLY. The held corner crash, the live corner and the cross-flight
   * branches (all of which RETURN above the gates), the 套边 overlap block and the wall-pass
   * trigger are UNTOUCHED committed licences with their own laws — DS-T2's business.
   *
   * The bypass is PURELY ADDITIVE (the DF-T4 idiom): not one shipped statement is deleted,
   * reordered or reworded, and with the flag off they run byte for byte.
   * Read at exactly TWO sites in `src/**` (the two gates in `assignRunners`).
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B)**; a probe arms it.
   */
  dsHatsOff?: boolean;
  /**
   * ⭐⭐⭐ DS T0d — 「配合帽子 · 开关」 THE COOPERATION HATS' SWITCH (contract §2 M-DS.8; ruling
   * #412 item 5). Armed, exactly TWO shipped designations stop being issued:
   *   • GATE 1 — `TeamBrain.assignRunners`' 套边 block (the Phase-34 overlap): `team.overlapper`
   *     is never set, so the player-side 'overlapping outside the carrier' run and the passer's
   *     套边 release bonus have nothing to read.
   *   • GATE 2 — `mechanics.performPass`' 2过1 trigger: `passer.wallRun` is never set, so the
   *     'bursting for the one-two return' push and the passer's wall-return bonus have nothing
   *     to read.
   * That unreachability is a MEASURED consequence (pinned as behaviour in
   * `tests/dsCoopHatsOff.test.ts`), NOT an edit: not one read site moves.
   *
   * It is an INSTRUMENT, not a law — it exists so DS-T1d can measure what the last two
   * hand-written cooperation hats produce that the band can see (ruling #412 item 5(v)).
   * Both bypasses are PURELY ADDITIVE (the DF-T4 idiom): no shipped statement is deleted,
   * reordered or reworded, and with the flag off they run byte for byte — which the recorded
   * OFF digests measure.
   * Read at exactly TWO sites in `src/**`: `TeamBrain.assignRunners` and `mechanics.performPass`.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B)**; a probe arms it.
   */
  dsCoopHatsOff?: boolean;
  /**
   * ⭐⭐⭐ IF T0 — 「球在飞时的前插」 THE FLIGHT-RUN SEAM (docs/world-model/
   * IF-T0-FLIGHT-RUN-SEAM.md; contract IF-FLIGHT-RUN-CONTRACT.md §2 M-IF.1–4; ruling #417
   * item 3 as amended by #418 item 5). A SECOND dormant door INSIDE the own-run fork: armed
   * ALONGSIDE `dsOwnRun`, the state guard M-DS.7 admits ONE more PERCEIVED state — the ball
   * this body SEES has no owner (`snapshot.ball.ownerGid === null`) AND the last body he
   * himself perceived with the ball (`ifLastSeenOwnerGid`) resolves on the ROSTER to a
   * same-side mate who is not him. The SAME candidate is pushed at the SAME score with a
   * distinct `why` — 'own run onto the flight', the EIGHTH literal.
   *
   * ⭐⭐⭐ IF T0b — 「看见出脚」 THE RESTRAINT SLICE (docs/world-model/
   * IF-T0-FLIGHT-RUN-SEAM.md §LAW-B; contract §2 M-IF.5 / M-IF.6; ruling #422 items 2–3).
   * The eighth state is NARROWED, under the SAME door, by two more identity tests:
   * **M-IF.5** the game is LIVE (`match.phase === 'playing'` — the whistle every body on the
   * pitch shares; at a dead ball the eighth state is FALSE and the seventh is untouched), and
   * **M-IF.6** he SAW IT LEAVE — the belief is now a RECORD `{ ownerGid, look }` and the state
   * holds ONLY when it was written at his IMMEDIATELY PREVIOUS look
   * (`belief.look === thisLook - 1`, an index equality of the `cands.length - 1` kind — ⛔ NOT
   * a tick bound, ⛔ NOT an age bound), counted by the per-body look counter `ifLook`.
   *
   * ⛔ NO predicate on a football quantity (#200): identity tests on gid and roster only — no
   * distance, no age bound, no velocity, no constant. ⛔ NO truth read: not `match.ball`, not
   * `ball.owner`, not `pendingPass`, not `lastTouch`. ⛔ NO second percept pull: the own-run
   * fork's existing single `perceivedSnapshot(p)` serves both states.
   *
   * The edit is PURELY ADDITIVE (the DF-T4 idiom): not one shipped statement is deleted,
   * reordered or reworded, so with the door shut the seventh-literal path runs byte for byte
   * — which the recorded OFF digests measure. Armed WITHOUT `dsOwnRun` it does nothing (the
   * fork never runs), which is pinned as behaviour in `tests/ifFlightRun.test.ts`.
   * Read at exactly ONE site in `src/**`: `PlayerBrain.decideOffBall`.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B)**; a probe arms it.
   */
  ifFlightRun?: boolean;
  /**
   * DF T0 (docs/world-model/DF-T0-ASSIGNMENT-PERSISTENCE.md; contract
   * DF-DEFENSIVE-BRAIN-CONTRACT.md §2 M-DF.1/M-DF.2, ruling #322 item 2) — ASSIGNMENT
   * PERSISTENCE. Shipped, `assignMarks` runs `team.marks.clear()` and re-greedies the whole
   * scan every TEAM_AI_INTERVAL: the measured mechanism of 乱跑 (DF-C0 §R2 — 16.1267
   * mark-switches per defender-minute, 28.31 % accidental double-marking, 63.29 %
   * assignment coverage, 1.0576 s re-target latency). When armed the assignment LEDGER
   * survives the pass: the greedy fills only the slots nobody holds, and a marker leaves
   * his man only when the new man is closer by MORE than the slack the shipped L3
   * access-time account already grants his current pairing (`markSagMetres` at the stance
   * line's own argument tuple — a DERIVED hysteresis, no taste constant, #200).
   * `assignChasers` and the Phase-31 presser cap are UNTOUCHED (M-DF.2: two compensators
   * never move in one slice). It adds NO state: the ledger is `team.marks` itself, so
   * nothing new enters `League.toJSON`, `cloneSimulationState` or the render adapter.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, opt-in via `a4World` v10+ (会思考的防守, #337 item 5; the shipped default world never arms it — Road B)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  dfAssignPersist?: boolean;
  /**
   * ⭐⭐ DF T2 (docs/world-model/DF-T2-DECISION-SURFACE.md; contract
   * DF-DEFENSIVE-BRAIN-CONTRACT.md §2 M-DF.1/M-DF.2/M-DF.3/M-DF.4; ruling #325 item 5):
   * THE DEFENSIVE DECISION SURFACE. When armed, every free defender prices his options in
   * ONE currency — METRES OF NET ACCESS — at the `assignMarks` seat: press the carrier ·
   * hold my mark · jump the lane · take the man. Every price comes from an EXISTING account
   * (the L3 access-time slack at the stance line's own argument tuple, the defence book's
   * decline-only veto, and the commitment physics the book indexes by arrival group); no new
   * pricing table, no taste constant, no attr and no gene (#200). The fourth doctrine option
   * 「drop to cover」 is NAMED OUT, not faked — it has no action primitive (DF-C0 §R3).
   * IT READS TRUTH, stated not hidden (M-DF.1): private snapshots arm defenders in a later
   * IN slice — IN-T0's gateway is the CARRIER's, not a defender's.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, opt-in via `a4World` v10+ (会思考的防守, #337 item 5; the shipped default world never arms it — Road B)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  dfSurface?: boolean;
  /**
   * ⭐⭐ DF T4 (docs/world-model/DF-T4-CAP-OFF-TRIAL.md; contract
   * DF-DEFENSIVE-BRAIN-CONTRACT.md §2 M-DF.2 — *"the cap-off arm proves the surface alone
   * holds the band"*; ruling #336 item 5): THE CAP-OFF ARM. When armed, `assignChasers`'
   * PHASE-31 CAP CLAUSE IS BYPASSED — the presser count follows that function's own
   * docblock arithmetic ("1 base, +1 in Press mode, +1 for extreme pressIntensity") and the
   * Phase-112 transition window adds its extra body without the `Math.min(…, 3)` ceiling.
   * The bypass is PURELY ADDITIVE: not one shipped statement of the cap is deleted, moved
   * or reworded, and with this door shut every one of them decides exactly as it ships.
   * NOTHING ELSE in `assignChasers` is touched — the gk-holding zero, the Phase-30.5
   * loose-ball duel, the Phase-28.3/29 dead-ball counts and the Phase-32.1 landing chase
   * are NOT the cap and are left alone (the trial retires ONE compensator, M-DF.2).
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, absent from `a4World` (Road B: nothing ships)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  dfCapOff?: boolean;
  /**
   * ⭐⭐ IN T0 (docs/world-model/IN-T0-SNAPSHOT-LAW.md; contract IN-SNAPSHOT-CONTRACT.md
   * §2 M-IN.1/M-IN.3/M-IN.4; ruling #324 item 4): THE SNAPSHOT LAW AT THE CARRIER'S
   * CHOOSER GATEWAY. When armed, the body who owns the ball prices his options against
   * his PRIVATE SNAPSHOT of the other bodies — a body inside his vision field refreshes
   * to truth this decision, a body outside it is read at his LAST-SEEN position and
   * velocity. PHYSICS STAYS TRUTH (M-IN.1): the executor, steering and contact layers
   * and the BALL are untouched, and every chosen body is resolved back to its truth
   * object before it reaches an action, a heading or a `perform*` call.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, absent from `a4World` (Road B: nothing ships)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  inSnapshotLaw?: boolean;
  /**
   * IN T0: WHICH vision field the law reads with — the seam's ONE parameter (#324 item
   * 4: "the field constant is a parameter of the seam (two values: F2 of record, F4
   * declared)"). Both are derived from the engine's own blind algebra by anchored
   * extraction (`src/ai/inSnapshotView.ts`); neither is a taste cone (#200). Inert
   * while `inSnapshotLaw` is off.
   */
  inSnapshotField?: InSnapshotField;
  /**
   * ⭐⭐ IN T1 (docs/world-model/IN-T1-THE-LOOK.md; contract IN-SNAPSHOT-CONTRACT.md §2
   * M-IN.2/M-IN.3/M-IN.4; ruling #327 item 5): THE LOOK — 抬头观察 as a BODY ACT. When
   * armed, EVERY body refreshes his IN-T0 book for the bodies inside the field centred on
   * his HEADING at his own decision (sight is free), and may ELECT to aim his gaze at a
   * body he REMEMBERS but cannot see — paying `ceil(theta / (TURN_RATE · DT))` TICKS of
   * not re-deciding, with the passive half suspended for the window. The election is
   * priced in ONE currency (BODY-TICKS of staleness) at a DERIVED threshold of zero; no
   * pricing table, no attribute, no gene, no magnitude chosen by taste (#200). PHYSICS
   * STAYS TRUTH (M-IN.1): the look writes no heading, no `faceTarget` and no action —
   * the engine has ONE facing, and the contract's §7 REALITY audit fixes the
   * approximation (the head turn is approximated BY ITS TIME COST). The CONSUMER is
   * unchanged: only `decideCarrier`'s IN-T0 gateway prices anything off the book.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * never bundle-defaulted, absent from `a4World` (Road B: nothing ships)**; a probe
   * arms it, and the production fingerprint is unchanged.
   */
  inLookAct?: boolean;
  /**
   * O2 T0 (docs/world-model/O2-T0-DORMANT-SEAM.md): 抬头观察 — THE LOOK. When
   * armed, a body who owns the ball outside a one-touch window may spend a LOOK
   * at the percept-path decision fork: for `O2_LOOK_TICKS` ticks he plants (the
   * C7/O1 plant idiom — carry slowed to walking pace on his own spot), does not
   * act, and one SCAN MOMENT is recorded per tick from his own heading, so the
   * body memory the whether seat reads is reconstructed from fresh moments
   * instead of stale ones. It opens NO new information channel: the same
   * `visibleDistance` cone, the same keyed error, the same `recordScanFrame`
   * recorder the ordinary scan clock uses — only the CADENCE changes, and only
   * while he stands there paying for it (M-O2.2, I1 NO FREE TIME).
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never
   * env-armed, absent from `a4World` and from every preset (Road B, #193.2:
   * nothing ships)**; a probe arms it, and the production fingerprint is
   * unchanged.
   */
  o2Look?: boolean;
  /**
   * PM T0 (PHASE-MODULATION-CONTRACT §2 M-PM.1/M-PM.2, ruling #195.2): arm the
   * dormant DEFENSIVE LANE-CONVERGENCE seam — the CONSUMPTION half of the gene's
   * own opt-in (the evolution half is `MutateOptions.evolveDefLaneConvergence`).
   * With it armed, the two BODY-MOVEMENT station reads (the walk target and the
   * marker's no-target fallback) get `y += (ball.pos.y − y)·k_PM` in live open
   * play out of possession; every assignment / gate / clamp / restart / render
   * read keeps the UNMODULATED station (M-PM.3, #35.3). The gene is BORN ABSENT,
   * so even armed this changes nothing until an instrument or an opted-in
   * evolution run gives it a value.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never
   * env-armed, absent from `a4World` and from every preset (Road B, #195.2:
   * nothing ships)**; a probe arms it, and the production fingerprint is
   * unchanged.
   */
  pmLaneConvergence?: boolean;
  /**
   * MT T0 (MARK-TIGHTNESS-CONTRACT §2 M-MT.1–3, ruling #201.4): arm the dormant
   * MARK-SAG seam — the CONSUMPTION half of the gene's own opt-in (the evolution
   * half is `MutateOptions.evolveMarkSag`). With it armed, a marker with an assigned
   * mark, in live open play and out of possession, stands
   * `markDist + markSag · sagOf(t_ball − t_self)` from his man along the EXISTING
   * stance blend; direction, `laneW`, `markingAggression` and mark ASSIGNMENT are
   * untouched, and there is no decline/release predicate anywhere (#200). The gene is
   * BORN ABSENT, so even armed this changes nothing until an instrument or an
   * opted-in evolution run gives it a value.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B, #201.4: nothing ships)**; a
   * probe arms it, and the production fingerprint is unchanged.
   */
  mtMarkSag?: boolean;
  /**
   * CTB T0 (CHECK-TO-BALL-CONTRACT §2 M-CTB.2, ruling #223): arm the dormant
   * SUPPORT-PLANE seam — the support seat's ahead-bias becomes a signed continuous
   * axis (前后) and its lateral fan a signed continuous width (左右), both centred on
   * today's values. Read at exactly ONE place: the `ctbPlane` argument of
   * `supportSpot`, passed from the single `SupportBallCarrier` executor case. Who
   * supports, pass selection and the carrier's own behaviour are untouched, and
   * there is no predicate anywhere (#200). Both genes are BORN ABSENT, so even armed
   * this changes nothing until an instrument or an opted-in evolution run gives them
   * values.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B, #223: nothing ships)**; a
   * probe arms it, and the production fingerprint is unchanged.
   */
  ctbSupportPlane?: boolean;
  /**
   * OBM T0 (OFFBALL-MOVEMENT-CONTRACT §2, ruling #227): the OFF-BALL EYES SEAT —
   * the off-ball attacker reads four continuous features off his OWN percept
   * snapshot and a gene-weighted policy turns them into a dynamic position on the
   * banked CTB support plane plus a bounded modulation of his `SupportBallCarrier`
   * and licensed `MakeRun` scores (`src/ai/offballEyes.ts`).
   * ⭐ THIS FLAG OPENS THE DYNAMIC HALF ONLY (the OBM-T0 verify catch). The banked
   * `ctbSupport*` genes enter the plane composition as its INTERCEPT **only when
   * `ctbSupportPlane` — their own flag — is also armed**. Armed alone, this seat
   * runs its dynamic policy on a ZERO intercept, whose zero-point is the incumbent
   * `supportSpot` geometry, so it can never spend a gene bank it was not given the
   * key to; armed together with `ctbSupportPlane`, the banked static plane is
   * delivered exactly as banked and this seat adds slopes on top. Read at exactly TWO
   * places: the policy fork in `PlayerBrain.decideOffBall` (the two SCORE sites) and
   * the plane fork in `actionExecutor`'s `SupportBallCarrier` case (the TARGET site).
   * TeamBrain designation, pass selection, the carrier's seats and the defensive
   * trunk are untouched, and there is no predicate anywhere (#200). The policy
   * matrix is BORN ABSENT, so even armed this changes nothing until an instrument or
   * an opted-in evolution run gives it values.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B, #227: nothing ships)**; a
   * probe arms it, and the production fingerprint is unchanged.
   */
  obmMovement?: boolean;
  /**
   * PTP T0 (PASS-TO-PATH-CONTRACT §2 M-PTP.4, ruling #231): arm the dormant
   * PASS-LEAD seam (传球到路). Armed, the ordinary pass loop prices a SUPPORT-mode
   * mate at an AIM POINT projected along his motion over the pass flight — the
   * through-ball family's own lead arithmetic, weighted by the born-absent
   * `passLeadSupport` gene (`src/ai/passLeadSeat.ts`) — and a pass chosen against a
   * led point CARRIES that lead into the strike, which composes it with the incumbent
   * strike-time correction (so the ball lands BEYOND the priced aim, never exactly on
   * it — §HONESTY 5 of the stage doc). Read at exactly ONE place: the seat fork in
   * `PlayerBrain.decideOnBall`'s pass block. The `MakeRun` through-ball loop, the
   * whether seat, the certified table, the OBM/CTB seams and TeamBrain are untouched,
   * and there is no predicate anywhere (#200) — a still mate's led point is his feet
   * by arithmetic. The gene is BORN ABSENT, so even armed this changes nothing until
   * an instrument or an opted-in evolution run gives it a value.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B, #231: nothing ships)**; a
   * probe arms it, and the production fingerprint is unchanged.
   */
  ptpPassLead?: boolean;
  /**
   * DLC T0 (DELIVERY-CHOICE-CONTRACT §2 M-DLC.1–4, rulings #235/#236): arm the dormant
   * DELIVERY CONTEST (出球的选择权). Armed — the flag AND a non-absent `passLeadSupport`
   * gene — the ordinary pass loop prices EVERY support-mode mate TWICE: to feet (the
   * incumbent arithmetic, byte for byte) and led (the banked PTP-T0 projection,
   * `src/ai/deliveryChoiceSeat.ts`), with BOTH entering the same `bestPass` argmax and
   * the winner struck at its OWN aim. There is no threshold, no taste multiplier and no
   * new comparison logic (#200): the argmax IS the choice. Read at exactly ONE place:
   * the seat fork in `PlayerBrain.decideOnBall`'s pass block. The through-ball license
   * path, the lofted switch and its `d > 24` gate, the auto-bender, the whether seat,
   * the OBM/CTB seams and TeamBrain are untouched. ⭐ Its relation to `ptpPassLead` is
   * FROZEN: they are INDEPENDENT doors and no exam arms both; armed together the two
   * candidates coincide by arithmetic and the banked PTP seam's forced aim keeps
   * precedence (the tie goes to the candidate compared first) — gated, not promised.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B, #235: nothing ships)**; a
   * probe arms it, and the production fingerprint is unchanged.
   */
  dlcDeliveryChoice?: boolean;
  /**
   * DLC T0s (docs/world-model/DLC-T0S-DORMANT-SEAM.md; contract M-DLC.1″, slice one-s) —
   * THE GROUND STRIKE PLANE, dormant. Armed, the pass loop prices a SAMPLED GRID of
   * ground strikes per support-mode mate (direction × power, elevation 0, spin 0, K = 9
   * with today's kick as the zero-point member) through the same hoisted pricing and the
   * same argmax, and the winner's own displacement rides the BANKED led-strike statement.
   * ⭐ Its relation to the banked doors is FROZEN: `ptpPassLead` and `dlcDeliveryChoice`
   * keep PRECEDENCE — no grid forms while either seat exists, so armed-both is the banked
   * door armed alone, byte for byte (gated, not promised). Arming = this flag + a
   * NON-ABSENT `passLeadSupport` gene (PRESENCE only: its magnitude retired at #240/#241).
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B: nothing ships)**; a probe arms
   * it, and the production fingerprint is unchanged.
   */
  dlcStrikePlane?: boolean;
  /**
   * DV T0 (docs/world-model/DV-T0-DORMANT-SEAM.md; contract M-DV.1/M-DV.3) — THE
   * RISK-PRICING SEAM, dormant. Armed, the ONE hoisted ground-pass pricer subtracts two
   * MEASURED risk terms from every candidate it prices: the delivery's FLIGHT EXPOSURE
   * (the corridor read made time-aware over the ball's own travel) weighted by
   * `dvExposureWeight`, and the team's own evolved LOSS-COST BELIEF for the candidate's
   * RECEPTION zone weighted by the pricer's own `passBase`. Because it modifies the ONE
   * shared pricer's output, it prices to-feet, led and strike-plane candidates
   * IDENTICALLY — downstream of which delivery seam formed them.
   * ⭐⭐ Per ruling #247 the DV-C0 census's TRUE table is INSTRUMENT-side and is wired
   * into no player: the belief is BORN ABSENT and can only be EARNED (evolved). Arming =
   * this flag + a NON-ABSENT `dvExposureWeight` or `dvLossBelief`; all absent ⇒ no seat
   * ⇒ the shipped statements alone, and all-zero ⇒ `s − (+0)`, IEEE-exact.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B: nothing ships)**; a probe arms
   * it, and the production fingerprint is unchanged.
   */
  dvDeliveryValue?: boolean;
  /**
   * DV T2-T0 (docs/world-model/DV-T2-T0-LEARNING-SEAM.md, contract §2 M-DV2.3): ⭐ THE
   * LEARNING DOOR. Armed, each team keeps its OWN account book of the M-DV2.1 pass-level
   * label (own deliveries by AIM zone × whether that chain's loss was punished by a
   * concession inside the window) and the book's running frequencies become what the DV
   * pricer's `dvLossBelief` read sees — self-dosing from own experience.
   *
   * ⚠ TWO limbs, both required for any effect: this flag learns, `dvDeliveryValue`
   * consumes. Armed ALONE the books fill and NOTHING reads them, so the world is
   * byte-identical (G-BORN). Armed with an EMPTY book the gene stays ABSENT, so the seat
   * is null and the world is again the shipped one (G-EMPTY).
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B: nothing ships).**
   */
  dvLearnedMap?: boolean;
  /**
   * ⭐⭐ BK T3 (docs/world-model/BK-T3-CORRIDOR-HAZARD.md; ruling #333 item 5, the design
   * pick ratified at #331 item 3, serving the USER MANDATE of #328/#330): THE
   * CORRIDOR-HAZARD PRICE. Armed, the FOUR LOFTED delivery choosers (the keeper's punt —
   * which had no lane, corridor or flight term at all — the open-play loft switch, the
   * dink over the top and the keeper's hand throw) subtract a DIRECTIONAL, HEIGHT-AWARE
   * corridor hazard: `flightExposure`'s shipped form restricted to the bodies the flight
   * would actually strike, judged against the contact law's OWN strike surface (the
   * `HEADER_MIN_HEIGHT` edge inside the body's own shell) at the trajectory's own
   * `g·T²/8`-shaped height.
   *
   * ⚠ TWO limbs, both required for any effect: this flag opens the door and the DV seat's
   * BORN-ABSENT `dvExposureWeight` gene is the weight. Gene absent ⇒ no seat ⇒ the shipped
   * statements alone; gene present at ZERO ⇒ the subtraction is exactly `−(+0)` and the
   * world is byte-identical with the path LIVE.
   *
   * ⛔ NO DEFAULT ARC IS RAISED and no launch parameterization is touched (#328 item 3):
   * the price makes height, angle and target choice PAY; the chooser decides.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * opt-in via `a4World` v11 (走廊价格 0.5, #337 item 5; the shipped default world and every preset never arm it — Road B).**
   */
  bkCorridorPrice?: boolean;
  /**
   * ⭐⭐ GC T0 (docs/world-model/GC-T0-DORMANT-SEAM.md; contract
   * GC-GROUND-CORRIDOR-CONTRACT.md §2 M-GC.3; ruling #343 item 4, serving the user's
   * play-test RED of #341 — 弹身体感觉很影响比赛): THE GROUND-CORRIDOR PRICE. Armed, the
   * ONE hoisted `groundCandidate` pricer subtracts `wExposure · groundShellHazard` from
   * every GROUND candidate it prices (to-feet, led, strike-plane, knock) — BK-C2 §P.4's
   * own binary shell discriminator, over ALL non-sent-off bodies on BOTH TEAMS minus the
   * kicker and minus the intended receiver (BK-C1 §4(ii)'s arriving rule).
   *
   * ⚠ TWO limbs, both required for any effect: this flag opens the door and the DV seat's
   * BORN-ABSENT `dvExposureWeight` gene is the weight — the SAME gene the lofted corridor
   * price rides, so one knob prices the whole corridor family. Gene absent ⇒ no seat ⇒ the
   * shipped statements alone; gene present at ZERO ⇒ the subtraction is exactly `−(+0)`
   * and the world is byte-identical with the path LIVE.
   *
   * ⛔ NO LINE IS BANNED (#328 item 3): the price makes striking a body PAY, and the
   * chooser — comparing every candidate at the same argmax — decides.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * ARMED BY NO WORLD AND NO PRESET YET: `a4World` does not name it at any version and no
   * play-test world reaches it (Road B — the entry rung is GC-T1's business, not this
   * stage's).**
   */
  bkGroundCorridor?: boolean;
  /**
   * ⭐⭐⭐ OP T0 (docs/world-model/OP-T0-FRONT-MAN-SEAM.md; contract OP-FRONT-MAN-CONTRACT.md
   * §2 M-OP.1–3; ruling #432 — the user's 「甲吧」 ⇒ 「身前贴着的人要算进去」): THE LICENCE
   * SEES THE MAN IN FRONT. Armed, the ONE `laneOpenness` call inside the hoisted
   * `groundCandidate` pricer resolves to `laneOpennessFront` — a man whose closest point on
   * the lane lies strictly AHEAD of the kicker within 1.5 m is read at `CONTROL_RADIUS`
   * instead of skipped; men level with or behind the kicker stay skipped. NO new constant,
   * no gene, no weight; no other `laneOpenness` caller changes.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B)**; a probe arms it.
   */
  opFrontMan?: boolean;
  /**
   * ⭐⭐⭐ OP T0b (docs/world-model/OP-T0B-FRONT-CHOOSER-SEAM.md; contract OP-FRONT-MAN-CONTRACT.md
   * §2 M-OP.5; ruling #435 — 「身前贴着的人要算进去」 applied to WHO): THE CHOOSER SEES THE MAN IN
   * FRONT. Armed, the snapshot target chooser prices an option whose lane holds an observed,
   * live opponent strictly ahead of the passer within 1.5 m and within `CONTROL_RADIUS` of the
   * line (`frontContactOf`) in the calibration's LAST threat band. NO new constant, no gene,
   * no weight; the read object and every other consumer untouched.
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, named by NO world and NO preset (Road B)**; a probe arms it.
   */
  opFrontChooser?: boolean;
  /**
   * ⭐⭐ RA T0 (docs/world-model/RA-T0-DORMANT-SEAM.md; rulings #358/#359/#360 — the
   * user's fork election 「①′ 接应时间入价」, licensed by DX-C2's DISCRIMINATES): THE
   * RECEIVER-ACCESS PRICE. Armed, the ONE hoisted `groundCandidate` pricer subtracts
   * `raAccessWeight · deficit(E) · passBase` from every GROUND candidate it prices for
   * ANOTHER body — the deficit being the seconds by which the intended receiver's own
   * chase arithmetic (`interceptBall`'s time-to-point form over the chooser's own
   * flight law, DX-C2 §P.A byte for byte, `CONTROL_RADIUS` presence clause included)
   * says he MISSES the elected point. A knock (receiver = the kicker himself) is out of
   * scope by GATE: the knock's reception point is by construction where the carrier's
   * own race resolves (CB-T2's law), so the account has nothing to price there.
   *
   * ⚠ TWO limbs, both required for any effect: this flag opens the door and the
   * BORN-ABSENT `raAccessWeight` gene is the weight. Gene absent ⇒ no seat ⇒ the
   * shipped statements alone; gene present at ZERO ⇒ the subtraction is exactly `−(+0)`
   * and the world is byte-identical with the path LIVE.
   *
   * ⛔ NO BALL IS BANNED (#328 item 3's doctrine): the price makes an unreachable
   * election PAY, and the chooser — comparing every candidate at the same argmax —
   * decides. ⛔ NO receiver-behaviour change of any kind rides here (#360 item 4: the
   * cooperation seat is a held door).
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * ARMED BY NO WORLD AND NO PRESET: `a4World` does not name it at any version (Road B —
   * the entry rung is RA-T1's business, not this stage's).**
   */
  raAccessPrice?: boolean;
  /**
   * ⭐⭐ RC T0 (docs/world-model/RC-T0-PRECUE-SEAM.md; ruling #369 item 6; contracts
   * RC-RECEIVER-COOPERATION-CONTRACT.md §2-AMENDMENT M-RC.3a + PC-PERCEPTION-CONTRACT.md
   * §2-AMENDMENT M-PC.1b) — THE PRE-CUE DOOR (接球人从出球人的身体提前有了准备).
   *
   * Armed, an OWN-side body armed by the `passRelease` detector meets the release as a
   * PRE-CUED stimulus in proportion to how squarely the passer's BODY was facing him: his
   * alignment RANK among the passer's mates (RC-C0 §P.A's cue, computed from `pos` and
   * `heading` alone) buys a MEASURED belief (RC-C0's own rank table), and his hold
   * INTERPOLATES the two certified PC tiers by `w · belief`. His earned book's own route to
   * SIMPLE is untouched and still WINS.
   *
   * ⚠ THREE limbs, all required for any effect: this flag, the BORN-ABSENT
   * `rcAnticipationWeight` gene, and a `pcReactionLatency` world (no latency seat ⇒ no hold ⇒
   * nothing to shorten). Gene absent ⇒ no pre-cue is ever built (G-BORN); gene present at ZERO
   * ⇒ the interpolation returns the CHOICE tier EXACTLY and the world is byte-identical with
   * the path LIVE (G-ZERO).
   *
   * ⛔ NOTHING IS TOLD TO ANYBODY (M-RC.1): the read set is the initiator's `pos`/`heading`
   * and the mates' `pos`/`gid`/`side`/`sentOff` — never `pendingPassWindup`, never
   * `faceTarget`, never `pendingPass`, never a TeamBrain designation, never `info.genome`.
   * ⛔ Relation `own` ONLY, the `passRelease` class ONLY; the initiator still pays nothing
   * (M-PC.4) and every other class, relation and body is byte-identical.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, ARMED BY
   * NO WORLD AND NO PRESET: `a4World` does not name it at any version (Road B — the entry rung
   * is world 13's business, after the user's world-12 verdict, not this stage's).**
   */
  rcAnticipate?: boolean;
  /**
   * ⭐⭐ RC T0b: THE READY door (M-RC.3b; ruling #378 item 6), dormant. A SECOND flag,
   * switchable APART from `rcAnticipate` so RC-T1b can build shut / 3a / 3a+3b arms; the GENE
   * is the SAME `rcAnticipationWeight` (M-RC.4: one gene = how much a receiver trusts a body
   * cue).
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, ARMED BY
   * NO WORLD AND NO PRESET: `a4World` does not name it at any version (Road B — the entry rung
   * is world 13's business, after the user's world-12 verdict, not this stage's).**
   */
  rcReady?: boolean;
  /**
   * DV T2-T0: the two books this match learns into, home first. Supplied by a League so
   * a SEASON owns the book (M-DV2.2's one-season book, reset at the season boundary);
   * omitted ⇒ the match learns into fresh books of its own and they die with it. Read
   * only when `dvLearnedMap` is armed.
   */
  dvLearnedBooks?: readonly [DeliveryAccountBook, DeliveryAccountBook];
  /**
   * ⭐ EK T0: the HOLD LEARNING door (contract §2 M-EK.1/.2). Armed, the team's own hold
   * account book fills from the holds it EXPERIENCES (the seat's licensed takes and the
   * training-ground drill holds). Armed ALONE nothing reads the book, so the world is
   * byte-identical (G-BORN).
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed,
   * absent from `a4World` and from every preset (Road B: nothing ships).**
   */
  ekHoldLearn?: boolean;
  /**
   * ⭐ EK T0: the HOLD CONSUMPTION door (contract §2 M-EK.3) — the ZERO-CONSTANT
   * COMPARATIVE VETO of ruling #261.3(iv). Armed beside a book with cross-band evidence,
   * the seat may DECLINE a hold the certified table licensed; it can never take one the
   * table did not license (R-B strict no-subsidy, #64.1). Same Road B rules as above.
   */
  ekHoldVeto?: boolean;
  /**
   * EK T0: the two hold books this match learns into, home first. Supplied by a League so
   * a SEASON owns the book (M-EK.2's one-season book, reset at the season boundary);
   * omitted ⇒ the match learns into fresh books of its own and they die with it. Read
   * only when `ekHoldLearn` is armed.
   */
  ekHoldBooks?: readonly [HoldAccountBook, HoldAccountBook];
  /**
   * ⭐ L3 T0 (contract CB-L3-DEFENCE-BOOK-CONTRACT.md §2 M-L3.2; docs/world-model/
   * L3-T0-DEFENCE-BOOK-SEAM.md): the DEFENCE LEARNING door. Armed, a team's defence account
   * book fills from the lunges its own bodies MISS — indexed by the lunger's own arrival
   * group, labelled by the ruled carrier-anchored separation over the common window (#279.3).
   * Armed ALONE nothing reads the book, so the world is byte-identical (gBorn).
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, absent
   * from `a4World` and from every preset (Road B: nothing ships).**
   */
  l3DefenceLearn?: boolean;
  /**
   * ⭐ L3 T0: the DEFENCE CONSUMPTION door (contract §2 M-L3.3) — the DECLINE-ONLY veto, the
   * EK-T0 zero-constant idiom ported. Armed beside a book with cross-group evidence, a body
   * may DECLINE a lunge the engine's own gates licensed; it can never throw one they did not
   * (R-B strict no-subsidy, #64.1). Same Road B rules as above.
   */
  l3DefenceVeto?: boolean;
  /**
   * L3 T0: the two defence books this match learns into, home first. Supplied by a League so a
   * SEASON owns the book (M-L3.2's one-season book, reset at the season boundary); omitted ⇒
   * the match learns into fresh books of its own and they die with it. Read only when
   * `l3DefenceLearn` is armed.
   */
  l3DefenceBooks?: readonly [DefenceAccountBook, DefenceAccountBook];
  /**
   * ⭐ CB T0 (contract CB-CARRY-BEAT-CONTRACT.md §2 M-CB.1(a); docs/world-model/
   * CB-T0-DORMANT-LAYER1-SEAM.md): the COMMITMENT-PHYSICS door. Armed, a standing challenge's
   * odds are scaled by the taker's own reachability (the geometry CB-C0 proved absent) and a
   * beaten lunger pays the recovery interval HIS OWN motion model needs instead of the constant
   * pair. OFF ⇒ `tryTackles` is byte-for-byte the shipped duel.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, absent from
   * `a4World` and from every preset (Road B: nothing ships).**
   */
  cbCommitPhysics?: boolean;
  /**
   * ⭐ CB T0 (contract §2 M-CB.1(b)): the TOUCH-PAST door. Armed, `Match.forcedTouchPast` can
   * fire one aimed knock — the ball genuinely leaves the carrier's feet into a loose-ball race
   * anyone can win. With the seam null (every production path) nothing can call it. Same Road B
   * rules as above; the DECISION to use it is CB-T2's, not this stage's.
   */
  cbTouchPast?: boolean;
  /**
   * ⭐⭐ CB T2 (contract §2 M-CB.2, ruling #268.4): THE LAYER-2 CHOICE-SEAT door. Armed — AND
   * only for a team whose `cbCarryProneness` gene is non-absent — the carrier's own candidate
   * table gains TOUCH-PAST candidates beside its pass candidates, priced by the SAME pricer.
   * A chosen knock arms `forcedTouchPast`, so it still needs CB-T0's `cbTouchPast` door to
   * FIRE: this flag buys the CHOICE, that one buys the CAPABILITY (§ARMING re-derives the
   * whole checklist). OFF ⇒ no seat, no candidate, no allocation — the shipped decision.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, absent
   * from `a4World` and from every preset (Road B: nothing ships).**
   */
  cbChoiceSeat?: boolean;
  /**
   * ⭐⭐ PW T0b (contract PW-PASSWEIGHT-CONTRACT.md §2 M-PW.2; design fixed by ruling #292.4;
   * docs/world-model/PW-T0B-WEIGHT-CHOOSER.md): THE RUNG-GRAIN WEIGHT-CHOOSER door. Armed, an
   * open-play short pass is chosen at (mate × rung) grain over the engine's OWN canary ladder
   * `PASS_CANARY_POWERS` — each pair admitted by the SHIPPED affordance oracle AT ITS OWN POWER
   * and priced by the SAME two factors the shipped joining rule uses (threat quintile × base
   * touch-fail survival), with the argmax picking man and weight together. The chosen weight
   * then RIDES the strike — including through the O1 wind-up's `pendingPassWindup` (#291.5
   * correction 4). Under this flag ONLY, the oracle also carries the passer's own
   * `orientationPowerMul` (DIVERGENCE-1, #291.1(c) — self-knowledge, INFO-DOCTRINE §0).
   *
   * OFF ⇒ every pass is struck at the literal 1 it has always been struck at, and
   * `executedPassPower(1)` draws NO rng, so the production world is byte-identical.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, absent from `a4World` and from every preset (Road B: nothing ships).**
   */
  pwWeightChooser?: boolean;
  /**
   * ⭐⭐ PW T0c (#293.3 (a); docs/world-model/PW-T0C-OBJECTIVE-FIDELITY.md): THE
   * OBJECTIVE-FIDELITY INSTRUMENT. The weight chooser's rung ladder, normally the engine's own
   * `PASS_CANARY_POWERS`. A probe may hand in a COLLAPSED ladder — `[1]` — which removes the
   * weight axis and nothing else, so what remains must be the SHIPPED chooser, decision for
   * decision. That equality is this stage's key receipt and its key pin.
   *
   * Read at exactly ONE place (the `pwWeightChooser` block in `PlayerBrain`) and inert unless
   * `pwWeightChooser` is armed. **Absent from `a4World` and from every preset (Road B).**
   */
  pwPowerLadder?: readonly number[];
  /**
   * ⭐⭐ PC T0 (contract PC-PERCEPTION-CONTRACT.md §2 M-PC.1–5; design fixed by ruling #297
   * items 3–5; docs/world-model/PC-T0-LATENCY-SEAM.md): THE REACTION-LATENCY door — 处理时间.
   * Armed, a body who did not initiate a surprise event inside his perceptual relevance keeps
   * his STALE plan for a tier of processing time — SIMPLE (0.20 sim-s / 12 applied ticks) where
   * his own born-absent recognition book covers the cell, CHOICE (0.45 sim-s / 27 applied
   * ticks) where it does not. ONE per-body gate at the executor surface covers the whole
   * per-tick steering set, and the decide loop is AND-gated by the same timer.
   *
   * OFF ⇒ `pcLatency` is `null`, the detector never runs, the executor gate is skipped and the
   * decide-loop conjunct is a constant `true`, so the production world is byte-identical.
   *
   * **Default OFF, an EXPLICIT boolean — never `EDS_BUNDLE_ARMED`, never env-armed, never
   * bundle-defaulted, absent from `a4World` and from every preset (Road B: nothing ships).**
   */
  pcReactionLatency?: boolean;
  /**
   * PC T0: the season's recognition books, handed in by `League.createMatch` when the door is
   * armed. Absent ⇒ the match allocates its own pair, so a standalone armed match still learns
   * (match-local views, M-PC.3) — it simply forgets at the final whistle.
   */
  pcRecognitionBooks?: readonly [PcRecognitionBook, PcRecognitionBook];
  /**
   * PC T0: the coverage threshold this world judges recognition at. Absent ⇒ `PC_N_COVER`, the
   * derived 18. ⭐ #297 item 4 H1's SENSITIVITY CAPABILITY: PC-T1 reports tier-transition
   * curves at N/2 · N · 2N by walking worlds that differ in nothing but this number.
   */
  pcNCover?: number;
  /**
   * EDS E3 instrument: log every perceived pass choice with the legacy choice
   * beside it, the class shares, look-pressure and the power canary. Pure
   * observation — it must not change a single tick.
   */
  traceChoice?: boolean;
  /**
   * A4-P1b (docs/world-model/A4-P1B-ABANDON-CENSUS.md, ruling #133): the
   * interventional fork-and-abandon seam. SIDE-SCOPED (`0` | `1`; absent ⇒
   * OFF). When set to a side `d`, the index-1 rest-defence DESIGNATION POLICY
   * is REMOVED for that side ALONE — BOTH in-possession faces stop binding: the
   * PlayerBrain support-fan exclusion (`restDefence`) and the formations
   * in-possession clamp (`x = min(x, −8 − coverBias·8)`). The out-of-possession
   * sweeper face is UNTOUCHED. STATUE-safe: it removes a policy, freezes no body
   * (the DF keeps his base spot + ordinary support scoring). **Absent/null in
   * every production path (Road B, #133); the fingerprint 57b0bdab…c673 is
   * unchanged** — a probe sets it on a forked world inside the counterfactual
   * branch only. Consumed under an explicit side-equality guard.
   */
  abandonRestDesignation?: 0 | 1;
}

/** One perceived pass choice, logged for the E3 audit. Never read by the sim. */
export interface PassChoiceTraceEntry {
  readonly tick: number;
  readonly passerGid: number;
  /** What the perceived chooser picked, or -1 when it had no executable option. */
  readonly chosenGid: number;
  /** What the legacy lane-score chooser would have picked (R4's divergence). */
  readonly legacyGid: number;
  readonly candidates: number;
  readonly read: number;
  readonly seenUnread: number;
  readonly unseen: number;
  readonly price: number;
  /** E5: the two halves of the price, so the audit can read V separately. */
  readonly reception: number;
  readonly value: number;
  readonly distance: number;
  readonly blindOutpricesRead: boolean;
  readonly blindOutpricesBand: boolean;
  /** Canary: which of the priced powers the bundle's own evaluator prefers. */
  readonly preferredPowerIndex: number;
  readonly powerPrices: readonly number[];
  readonly powerThreatSeconds: readonly number[];
  readonly powerTouchFailPriors: readonly number[];
  /**
   * E5g (ruling #23.3): the whole menu the chooser saw, so a diagnostic can ask
   * why a particular man was or was not taken instead of re-deriving the answer
   * outside the seam. A SIDECAR — written only when `traceChoice` is armed, read
   * by nothing in the sim, and pinned by the world-hash identity that already
   * covers the rest of this trace.
   */
  readonly options: readonly {
    readonly targetGid: number;
    readonly infoClass: 'READ' | 'SEEN-UNREAD' | 'UNSEEN';
    readonly price: number;
    readonly executable: boolean;
    readonly cell: number;
    readonly band: number;
  }[];
}

interface GroundContactClaim {
  readonly player: Player;
  readonly access: DirectBallAccess;
  readonly reachMargin: number;
  /**
   * `bodyStrike` is BK T1's lawful channel and is only ever produced while `bkContactLaw`
   * is armed: an UNINTENTIONAL contact by a body the shipped claim filter drops.
   */
  readonly kind: 'controlAttempt' | 'deflection' | 'bodyStrike';
  readonly relativeSpeed: number;
  readonly incomingDir: V2;
}

interface PendingControlAttempt {
  readonly gid: number;
  readonly readyTick: number;
  readonly relativeSpeed: number;
  readonly incomingDir: V2;
}

interface MutableContestEpisode {
  readonly id: number;
  readonly startedTick: number;
  readonly origin: ContestOrigin;
  readonly initialBallMode: ContestEpisode['initialBallMode'];
  readonly possessionSideAtStart: ContestEpisode['possessionSideAtStart'];
  readonly contenderGids: number[];
  readonly contacts: ContestContact[];
  resolution?: ContestResolution;
}

/**
 * A fully deterministic 6v6 match: same config + seed => same result, whether
 * it's watched frame by frame or run headless. The Match owns all state and a
 * single fixed-timestep `step(DT)`; rendering reads state and never writes.
 */
export class Match {
  readonly rng: Rng;
  readonly duration: number;
  readonly ball = new Ball();
  readonly teams: [Team, Team];
  readonly allPlayers: Player[];
  private readonly allPlayersReversed: Player[];

  phase: MatchPhase = 'kickoff';
  phaseTimer = 0;
  simTime = 0;
  half: 1 | 2 = 1;
  score: [number, number] = [0, 0];
  events: MatchEvent[] = [];
  finished = false;

  /** Which side has effective possession; -1 while the ball is loose. */
  possessionSide: Side | -1 = -1;
  /**
   * S0 first-class possession phase (docs/SUBSTRATE-MAP.md) — a DERIVED, read-only
   * classification recomputed each step (reflects post-step state). Nothing in the
   * decision path reads it yet (bit-identical); it is the anchor for the physical
   * 50-50 contest that will replace the instant owner-flip.
   */
  possessionPhase: PossessionPhase = { kind: 'deadBall' };
  /** Finalized + active M3 ledgers when traceContests is explicitly enabled. */
  readonly contestEpisodes: ContestEpisode[] = [];
  /** E1a: first-touch adjudications, appended to only when traceFirstTouch is on. */
  readonly firstTouchTrace: FirstTouchTraceEntry[] = [];
  readonly traceFirstTouch: boolean;
  /** E1b: the heavy-touch curve, dormant unless a probe world asks for it. */
  readonly edsTouchCost: boolean;
  /** C5 T0: the shield-hold mechanics, dormant unless a probe world asks. */
  readonly c5Hold: boolean;
  /** C5 T0: the elective first-touch window, dormant unless a probe asks. */
  readonly c5TouchFork: boolean;
  /**
   * ⭐ CB T0 §SEAM (a): the COMMITMENT-PHYSICS door, dormant unless a probe world arms it. Read
   * at exactly ONE place — the armed branch of `mechanics.tryTackles`.
   */
  readonly cbCommitPhysics: boolean;
  /**
   * ⭐ CB T0 §SEAM (b): the TOUCH-PAST door, dormant unless a probe world arms it. Read at
   * exactly ONE place — the touch-past fork at the head of `stepBall`'s owned-ball branch,
   * which additionally requires the `forcedTouchPast` seam to name this very carrier.
   */
  readonly cbTouchPast: boolean;
  /**
   * ⭐⭐ CB T2 §SEAM: the CHOICE-SEAT door, dormant unless a probe world arms it. Read at
   * exactly ONE place — `PlayerBrain`'s on-ball decision, where it builds the seat that forms
   * the touch-past candidates. A chosen knock is armed through `armTouchPast` and still has to
   * clear CB-T0's own `cbTouchPast` fork to fire.
   */
  readonly cbChoiceSeat: boolean;
  /**
   * ⭐⭐ PW T0b: the RUNG-GRAIN weight-chooser door, dormant unless a probe world arms it
   * (Road B). Read at exactly ONE place — the `pwWeightChooser` block in `PlayerBrain`, the
   * single site that can put a non-1 weight on a live strike.
   */
  readonly pwWeightChooser: boolean;
  /**
   * ⭐⭐ PW T0c: the chooser's rung ladder when a probe overrides it (the objective-fidelity
   * instrument, above). `null` ⇒ the engine's own `PASS_CANARY_POWERS`, which is every
   * production and every exam world.
   */
  readonly pwPowerLadder: readonly number[] | null;
  /**
   * ⭐⭐ PW T0b §SEAM — THE CHOSEN WEIGHT, DEPOSITED AND CONSUMED (the `forcedTouchPast` idiom).
   * The single chooser block in `PlayerBrain` leaves the weight it picked here for THIS body at
   * THIS tick; `performPass` consumes it (and clears it, so one choice is one strike), and
   * `armPendingPass` captures it into the wind-up record so a wound-up ball strikes at the
   * chosen weight instead of silently reverting to 1 (#291.5 correction 4).
   *
   * Carrying the weight on the match rather than in the call is what keeps the banked O1 / PTP /
   * DLC / DV strike statements — and `armPendingPass`'s own signature — byte-for-byte as
   * certified. **Null in every production path**, so the substitution is unreachable there
   * rather than merely inert.
   */
  pwStrikePower: { gid: number; power: number; tick: number } | null = null;
  /**
   * ⭐⭐ DX T0 §SEAM — THE ELECTED AIM, DEPOSITED AND CAPTURED (the PW T0b deposit idiom,
   * `pwStrikePower`'s own form). The ONE `dxWindupAim` fork in `PlayerBrain.decideOnBall`
   * leaves the winning candidate's OWN displacement here for THIS body at THIS tick, and
   * `armPendingPass` captures it into the wind-up record (and clears it, so one election is
   * at most one strike). `lead` is the SAME displacement the shipped synchronous led-strike
   * statement hands to `performPass` — the chooser's own scored point, expressed as the
   * offset from the target's body that `mechanics.performPass` already knows how to strike.
   *
   * Carrying it on the match rather than in the call is what keeps the banked O1 / PTP / DLC
   * / DV strike statements — and `armPendingPass`'s own signature — byte-for-byte as
   * certified. **Null in every production path** (`dxWindupAim` is OFF everywhere and the
   * fork never runs), so the substitution is unreachable there rather than merely inert.
   */
  dxStrikeAim: { gid: number; lead: V2; tick: number } | null = null;
  /**
   * ⭐ PW T0b §SEAM — the IN-ENGINE chooser ledger (the O2-T0 / CB-T0 precedent: accounting only
   * the seam can observe lives in the engine, not in a probe wrapper). Pure bookkeeping —
   * nothing in the sim ever READS these fields — and every one stays 0 unless `pwWeightChooser`
   * is armed (Road B ⇒ all-zero in production).
   *
   * * `decisions` — chooser invocations that returned a choice.
   * * `pairsAsked` — (mate × rung) oracle calls, the ×3 cost receipt's numerator.
   * * `chosenByRung` — how often each rung of the canary ladder won, in ladder order.
   * * `pairsAdmittedOnlyOffReference` / `matesAdmittedOnlyOffReference` — the ADMISSION
   *   population PW-T0a's `ref` set could not see (#292.2), at the ORACLE'S NULL grain.
   * * `pairsLive` / `matesLive` / `pairsLiveOnlyOffReference` / `matesLiveOnlyOffReference` —
   *   the same population at the CENSUS ladder's grain (race ∧ corridor), pure observation.
   * * `pairsDroppedForOtherRungRefusal` — the refusal-inheritance receipt; structurally 0.
   * * `struckAtChosenPower` — strikes that reached `performPass` carrying a non-default weight.
   * * `windupCarried` — wind-up resolutions that struck at a non-default carried weight.
   */
  readonly pwChooserLedger = {
    decisions: 0,
    pairsAsked: 0,
    chosenByRung: [0, 0, 0],
    pairsAdmittedOnlyOffReference: 0,
    matesAdmittedOnlyOffReference: 0,
    pairsDroppedForOtherRungRefusal: 0,
    pairsLive: 0,
    matesLive: 0,
    pairsLiveOnlyOffReference: 0,
    matesLiveOnlyOffReference: 0,
    struckAtChosenPower: 0,
    windupCarried: 0,
    /* ── PW T0c (#293.3) — the fidelity + choice-accounting counters ──────────────────────
     * * `mateSwitches` — chooser picks that moved the man off the incumbent decision. ⭐ With
     *   the ladder COLLAPSED to {1} this must be 0: objective fidelity, in one integer.
     * * `matesPriced` / `matesNotExecutable` / `referenceAdmissionsWithoutOracleRead` /
     *   `rungsWithoutReferenceNormaliser` — the candidate-set parity accounting.
     * * ⭐⭐ THE CLOSED CHOICE LEDGER (#293.3 (c)): every deposited non-default weight has
     *   exactly one fate, and the three fates are counted, so a SILENT loss cannot exist —
     *   `depositsNonDefault === struckAtChosenPower + windupChoiceVoided + depositsAbandoned`
     *   plus whatever is still in flight when the whistle goes.
     *   - `windupChoiceVoided` — a wind-up carrying a chosen weight was CANCELLED (the pass
     *     never runs; the interrupting channel owns the outcome, so the decision is VOID and
     *     the body re-decides from a new world — see the doc's §CLAUSE (c) justification).
     *   - `depositsAbandoned` — a deposit that no strike and no arm ever consumed, swept at
     *     the next tick boundary rather than left to rot.
     */
    mateSwitches: 0,
    matesPriced: 0,
    matesNotExecutable: 0,
    referenceAdmissionsWithoutOracleRead: 0,
    rungsWithoutReferenceNormaliser: 0,
    depositsNonDefault: 0,
    windupChoiceVoided: 0,
    depositsAbandoned: 0,
  };
  /**
   * ⭐ CB T0 §SEAM — the instrument seam, the `forcedHold` idiom verbatim: the named carrier
   * knocks the ball along `dir` at his next owned tick. **Null in every production path**, and
   * consumed (set back to null) by the fork that fires it, so one arming is one touch. The
   * direction is the INSTRUMENT's in CB-T0; a chooser is CB-T2's (M-CB.2).
   */
  forcedTouchPast: { gid: number; dir: V2 } | null = null;
  /**
   * ⭐ CB T0: the IN-ENGINE carry-beat ledger (the O2-T0 precedent — accounting only the seam
   * can observe lives in the engine, not in a probe wrapper). Pure bookkeeping: nothing in the
   * sim ever READS these fields, and every one of them stays 0 unless a CB door is armed
   * (Road B ⇒ all-zero in production).
   *
   * * `armedChallenges` / `geometricMisses` — standing duels priced by the armed take, and how
   *   many of them the taker's own momentum had already lost before the roll (χ = 0).
   * * `recoveries` / `recoverySeconds` / `carryThroughSeconds` — beaten lunges under the armed
   *   price, the recovery interval they paid, and the braking (carry-through) share of it.
   * * `touchPasts` / `touchPastChallengers` / `touchPastBeaten` / `touchPastCleanBeats` /
   *   `touchPastPushMetres` — aimed knocks, the contesting bodies they were aimed past, how
   *   many of those the geometry beats, the knocks that beat EVERY challenger, and the pushes.
   * * ⭐ `touchPastContested` (#272.4(b), the R-乙 re-key) — the knocks that had at least ONE
   *   contesting body. `touchPasts` counts EVERY aimed knock, including those released with an
   *   empty contest radius, which are structurally incapable of a clean beat; the commensurable
   *   take-on population (the one a published take-on success rate is computed over) is this
   *   one, and `touchPasts − touchPastContested` is the uncontested remainder. PURE ADDITIVE
   *   BOOKKEEPING: written once, never read anywhere in `src/**`.
   */
  readonly cbLedger: {
    armedChallenges: number; geometricMisses: number;
    recoveries: number; recoverySeconds: number; carryThroughSeconds: number;
    touchPasts: number; touchPastChallengers: number; touchPastBeaten: number;
    touchPastCleanBeats: number; touchPastPushMetres: number; touchPastContested: number;
  } = {
    armedChallenges: 0, geometricMisses: 0,
    recoveries: 0, recoverySeconds: 0, carryThroughSeconds: 0,
    touchPasts: 0, touchPastChallengers: 0, touchPastBeaten: 0,
    touchPastCleanBeats: 0, touchPastPushMetres: 0, touchPastContested: 0,
  };
  /**
   * ⭐ CB T2: the CHOICE ledger, kept SEPARATE from CB-T0's `cbLedger` so no banked receipt's
   * object shape moves. Pure bookkeeping — nothing in the sim ever READS these fields, and
   * every one stays 0 unless the choice door is armed (Road B ⇒ all-zero in production).
   *
   * * `seats` / `decisions` — on-ball decisions at which the seat formed, and the candidate
   *   knocks it priced in total (the compass's realized cost).
   * * `chosen` / `chosenBackHalf` — knocks the candidate table actually picked, and how many
   *   of those aimed into the BACK half of the compass (CB-C0's degenerate half, opened by
   *   CB-T0 and, here, USED or not by a chooser).
   * * `armings` / `armingsCleared` — armings written, and armings withdrawn because the very
   *   next decision of the same body no longer wanted the knock (so no aim is ever stale).
   * * `bestKnockScoreSum` / `winnerScoreSum` — ⭐ THE PRICE GAP, summed over the decisions at
   *   which the seat formed: what the ONE table priced the best knock at, against what it
   *   priced the option that actually won. This is the quantity §STRAIN 1 is argued on, and
   *   it is measured in the engine because only the seam can see both numbers.
   */
  readonly cbChoiceLedger: {
    seats: number; candidates: number; chosen: number; chosenBackHalf: number;
    armings: number; armingsCleared: number;
    bestKnockScoreSum: number; winnerScoreSum: number;
  } = {
    seats: 0, candidates: 0, chosen: 0, chosenBackHalf: 0, armings: 0, armingsCleared: 0,
    bestKnockScoreSum: 0, winnerScoreSum: 0,
  };
  /** C4 T1-FLIGHT: the cross flight-time floor, dormant unless armed. */
  readonly c4Flight: boolean;
  /** C4 T1-FLIGHT §2.4: the stale-lead variant arm (probe-only). */
  readonly c4FlightStaleLead: boolean;
  /** C4 T2-ARRIVAL: the open-play cross licence survives the flight. */
  readonly c4Arrival: boolean;
  /** C4 T2-ARRIVAL: and the closest licensed body attacks the meet point. */
  readonly c4ArrivalReroute: boolean;
  /** E2b-1: perceived-state defending, dormant unless a probe world asks. */
  readonly edsPerceivedDefence: boolean;
  readonly edsAwareness: number;
  /** Kept for the perception trunk's deterministic observation noise. */
  private readonly perceptionSeed: number;
  /**
   * E2b-1R: per-player perception at BRAIN CADENCE, scoped to what the sim
   * actually reads — which is the ball and nothing else. Empty and untouched
   * when the flag is off, which is what keeps the production path
   * bit-identical.
   */
  readonly perceptionMemories = new Map<number, PerceptionMemory>();
  readonly perceivedBalls = new Map<number, ObservedBall | null>();
  /** E3: the passer's own chooser. Dormant unless a probe or an audit arms it. */
  readonly edsPerceivedChoice: boolean;
  /** E5: the chooser's price gains its measured value half. Dormant by default. */
  readonly edsValueAxis: boolean;
  /** E3R2: run perception eagerly (the pinned reference), not on demand. */
  readonly edsEagerPerception: boolean;
  /** C6 T1: the honest carrying offset, dormant unless a probe world arms it. */
  readonly c6Carry: boolean;
  /** C7 T1: the shot wind-up, dormant unless a probe world arms it (Road B). */
  readonly c7Windup: boolean;
  /**
   * C7 T1 (docs/world-model/C7-T1-PENDINGKICK.md §SEAM): a shot committed but not
   * yet struck — the release-side mirror of `pendingControl`. `{ gid, readyTick,
   * aim }`: the committed body turns toward `aim` until `stepCount === readyTick`,
   * then the strike resolves via the EXISTING performShot math. NULL in every
   * production path (only `armPendingKick` sets it, only on the ON path).
   */
  pendingKick: { gid: number; readyTick: number; aim: V2 } | null = null;
  /** O1 T1: the shortPass wind-up, dormant unless a probe world arms it (Road B). */
  readonly o1PassWindup: boolean;
  /**
   * ⭐⭐ DX T0: the wind-up aim door — a wound-up pass is struck toward the ELECTED
   * candidate's own aim. Dormant, and NO WORLD ARMS IT (Road B; the entry rung is
   * DX-T1's business, not this seam's).
   */
  readonly dxWindupAim: boolean;
  /** BK T0: the facing law — the wind-up absorbs the required turn. Dormant (Road B). */
  readonly bkFacingLaw: boolean;
  /**
   * BK T0 §SEAM: the IN-ENGINE facing ledger — the arming receipt the stage's smoke walks
   * read. Pure bookkeeping: nothing in the sim ever READS these fields, so they cannot
   * influence a single tick, and every one stays 0 unless `bkFacingLaw` is armed.
   *
   * * `armsSeen` — wind-up arms that reached the law (shot + pass channels).
   * * `armsExtended` — arms whose required turn fell OUTSIDE the cone ⇒ paid time.
   * * `extraTicksTotal` — the total added ticks (the time the world now pays).
   * * `maxExtraTicks` — the largest single charge (structurally ≤ 29 − `BK_CONE_TICKS`).
   */
  bkFacingLedger = { armsSeen: 0, armsExtended: 0, extraTicksTotal: 0, maxExtraTicks: 0 };
  /** BK T1: the contact law — the ball meets the body it used to pass through. Dormant (Road B). */
  readonly bkContactLaw: boolean;
  /**
   * BF T0: the facing-cost law — a body runs fastest where it faces. Dormant (Road B).
   * Read at exactly TWO kinds of place, all in THIS file: the constructor's per-body
   * write right after `this.teams` is built, and the same write after each
   * `becomeSub` (a substitute is a NEW man in the same pitch slot). `Player.physicsStep`
   * never reads the flag — only the number it wrote.
   */
  readonly bfFacingCost: boolean;
  /**
   * BQ T0: the cushion law — the ball takes the body's velocity and nothing else.
   * Dormant (Road B). Read at exactly ONE place in `src/**`: the two velocity assignments
   * inside `applyControlContact`.
   */
  readonly bqCushion: boolean;
  /**
   * LN T0: THE OWN-LANE PRICE — the passer's pricers see his own men, graded. Dormant
   * (Road B). Read at exactly ONE place in `src/**`: the `lnSeat` construction in
   * `PlayerBrain.decideCarrier`, which serves the three read sites and the one scope site.
   */
  readonly lnOwnLanePrice: boolean;
  /**
   * GK T0b: THE DIVE LAW — the keeper's body travels to the contact point for as long as the
   * contact is set, and the caught ball waits at his hands until the body arrives or he loses
   * the ball. Dormant (Road B). Read at exactly FOUR places: `tryKeeperSave`'s TWO
   * `saveContact` writes, the executor's ONE post-switch override, and this file's ONE
   * carry-law waiting branch plus its ONE ownership-loss sweep.
   */
  readonly gkDiveBody: boolean;
  /**
   * ⭐⭐ DS T0: the OWN-RUN door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B). Read at
   * exactly ONE place: the candidate gate in `PlayerBrain.decideOffBall`.
   */
  readonly dsOwnRun: boolean;
  /**
   * ⭐⭐ DS T0: the HATS-OFF door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B). Read at
   * exactly TWO places, both in `TeamBrain.assignRunners`: the open-play runner scoring and
   * the open-play arriver pick.
   */
  readonly dsHatsOff: boolean;
  /**
   * ⭐⭐⭐ DS T0d: the COOPERATION-HATS door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B).
   * Read at exactly TWO places: the 套边 gate in `TeamBrain.assignRunners` and the 2过1 gate in
   * `mechanics.performPass`.
   */
  readonly dsCoopHatsOff: boolean;
  /**
   * ⭐⭐⭐ IF T0: the FLIGHT-RUN door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B).
   * Read at exactly ONE place: the own-run fork in `PlayerBrain.decideOffBall`.
   */
  readonly ifFlightRun: boolean;
  /**
   * ⭐⭐⭐ IF T0 / M-IF.2 — THE LAST-PERCEIVED-OWNER MEMORY, one entry per body
   * (`gid → the gid he last SAW with the ball`). Created EMPTY in the constructor and written
   * ONLY inside the `ifFlightRun` door at the own-run fork, from the snapshot that fork has
   * already pulled, and only when that percept HAS an owner — a mate, an opponent or himself.
   * An opponent seen with the ball therefore CLEARS the mate state; a restart taker seen with
   * it becomes the last owner; a ball never seen leaves the entry absent. It is the body's
   * OWN memory at his OWN decision cadence — ⛔ never the truth's `lastTouch`, ⛔ never
   * another body's memory. Door shut ⇒ never written, never read ⇒ EMPTY over whole matches
   * (pinned as a count in `tests/ifFlightRun.test.ts`).
   *
   * ⭐⭐⭐ IF T0b / M-IF.6 (ruling #422 item 2) — THE VALUE IS NOW A RECORD
   * `{ ownerGid, look }`: WHO he last saw with the ball AND THE INDEX OF THE LOOK that wrote
   * it. The eighth state holds only when that index is his IMMEDIATELY PREVIOUS look
   * (`belief.look === thisLook - 1`) — he SAW THE PASS LEAVE. The write rule is unchanged.
   */
  readonly ifLastSeenOwnerGid: Map<number, { ownerGid: number; look: number }>;
  /**
   * ⭐⭐⭐ IF T0b / M-IF.6 — THE PER-BODY LOOK COUNTER (`gid → how many times the own-run fork
   * has evaluated for him under the flight door`). Created EMPTY in the constructor and
   * incremented ONCE per own-run evaluation, INSIDE the `ifFlightRun` door at the fork site:
   * it is his OWN decision cadence, because a hatted or wall-licensed body does not reach the
   * fork at all — so his looks are exactly the looks the fork made for him. It exists so that
   * "the PREVIOUS look" can be an INDEX EQUALITY (`belief.look === thisLook - 1`) rather than
   * a tick bound or an age bound: ⛔ no constant, ⛔ no football quantity (#200). Door shut ⇒
   * never written, never read ⇒ EMPTY over whole matches (pinned as a count in
   * `tests/ifFlightRun.test.ts`).
   */
  readonly ifLook: Map<number, number>;
  /**
   * DF T0: ASSIGNMENT PERSISTENCE — the mark ledger survives the pass. Dormant (Road B).
   * Read at exactly ONE place: `assignMarks` in `src/ai/TeamBrain.ts`, which owns the
   * survivor pass and the switch price. `assignChasers` never reads it.
   */
  readonly dfAssignPersist: boolean;
  /**
   * ⭐⭐ DF T2: THE DEFENSIVE DECISION SURFACE. Dormant (Road B). Read at exactly ONE place —
   * `assignMarks` in `src/ai/TeamBrain.ts`, which owns the press election, the priced greedy
   * and the usage ledger. `assignChasers` never reads it and the Phase-31 cap is untouched.
   */
  readonly dfSurface: boolean;
  /**
   * ⭐⭐ DF T4: THE CAP-OFF ARM — the Phase-31 presser cap's own clause, BYPASSED. Dormant
   * (Road B). Read at exactly ONE place — `assignChasers` in `src/ai/TeamBrain.ts`, in two
   * purely ADDITIVE flag-gated statements beside the shipped cap lines, which are untouched.
   * `assignMarks` and the decision surface never read it. It adds NO state, so nothing new
   * enters `League.toJSON`, `cloneSimulationState` or the render adapter.
   */
  readonly dfCapOff: boolean;
  /**
   * DF T2 §SEAM — THE USAGE LEDGER: the stage's non-degeneracy receipt. PURE BOOKKEEPING:
   * nothing in the sim ever READS these fields, so they cannot influence a single tick, and
   * every one stays 0/empty unless `dfSurface` is armed. PER-MATCH TRANSIENT STATE (the DF-T0
   * / IN-T0 serialization precedent): `League.toJSON` does not name it, `cloneSimulationState`
   * does not copy it and the render adapter never sees it — so WORKER-SIMMED fixtures play
   * the SHIPPED world by construction.
   *
   * * `byOption` / `byModeOption` — decision counts in the `DF_SURFACE_OPTIONS` order
   *   (press · hold · jump · take); `byModeOption` is [Defend×4, Press×4].
   * * `byGid` — the same counts per BODY, raw: the instrument joins them to attributes, so
   *   no derived statistic and no threshold lives in `src/**`.
   * * `pressOffered` / `pressDeclinedByBook` — the decline-only veto's own receipt.
   * * `idle` — defender-passes on which no option was affordable or legal at all
   *   (the branch also absorbs the NOT-LEGAL exclusions: the Phase-28.4 WG width
   *   discipline and the zonal zone gate; DF-T2 §CORR item 5, ruling #327).
   */
  readonly dfSurfaceLedger: DfSurfaceLedger = {
    elections: 0, idle: 0, pressOffered: 0, pressDeclinedByBook: 0,
    byOption: [0, 0, 0, 0], byModeOption: [0, 0, 0, 0, 0, 0, 0, 0], byGid: new Map(),
  };
  /**
   * ⭐⭐ IN T0: THE SNAPSHOT LAW. Dormant (Road B). Read at exactly ONE place —
   * `decideCarrier` in `src/ai/PlayerBrain.ts`, which owns the gateway rebinding and the
   * resolution back to truth. No other brain, executor or physics site names it.
   */
  readonly inSnapshotLaw: boolean;
  /** IN T0: the vision field of the law. Inert while `inSnapshotLaw` is off. */
  readonly inSnapshotField: InSnapshotField;
  /**
   * ⭐ IN T0 §SEAM — THE PRIVATE BOOKS, per reader. PER-MATCH TRANSIENT STATE, exactly
   * like `perceptionMemories` above (the DF-T0 serialization precedent, #323 item 1):
   * `League.toJSON` does not name it, `cloneSimulationState` does not copy it and the
   * render adapter never sees it — so WORKER-SIMMED fixtures play the SHIPPED world by
   * construction (canon "worker fixtures", home ruling #283.2(iv)). Empty and untouched
   * unless the law is armed, which is what keeps the production path bit-identical.
   */
  readonly inSnapshotStore: InSnapshotStore = new Map();
  /**
   * IN T0 §SEAM: the staleness ledger — the stage's receipts. PURE BOOKKEEPING: nothing
   * in the sim ever READS these fields, so they cannot influence a single tick, and
   * every one stays 0 unless `inSnapshotLaw` is armed.
   */
  readonly inSnapshotLedger: InSnapshotLedger = createInSnapshotLedger();
  /**
   * ⭐⭐ IN T1: THE LOOK. Dormant (Road B). Read at exactly ONE place — the fork at the
   * head of `decidePlayer` in `src/ai/PlayerBrain.ts`, which owns the whole act.
   */
  readonly inLookAct: boolean;
  /**
   * ⭐ IN T1 §SEAM — THE LIVE LOOK WINDOWS, per body (gid → the tick the window closes
   * at). PER-MATCH TRANSIENT STATE, exactly like `inSnapshotStore` above (the DF-T0
   * serialization precedent, #323 item 1): `League.toJSON` does not name it,
   * `cloneSimulationState` does not copy it and the render adapter never sees it — so
   * WORKER-SIMMED fixtures play the SHIPPED world by construction (canon "worker
   * fixtures", home ruling #283.2(iv)). Empty and untouched unless the door is armed.
   * ⚠ SEVERAL BODIES MAY LOOK AT ONCE — unlike the O2 seam's single global window, this
   * is per-body, because ANY body may look (#327 item 5).
   */
  readonly inLookWindows: InLookWindows = new Map();
  /**
   * IN T1 §SEAM: the look ledger — the stage's receipts. PURE BOOKKEEPING: nothing in the
   * sim ever READS these fields, so they cannot influence a single tick, and every one
   * stays 0 unless `inLookAct` is armed.
   */
  readonly inLookLedger: InLookLedger = createInLookLedger();
  /**
   * BK T1 §SEAM: the IN-ENGINE contact ledger — the arming receipt the stage's walks read.
   * Pure bookkeeping: nothing in the sim ever READS these fields, so they cannot influence
   * a single tick, and every one stays 0 unless `bkContactLaw` is armed.
   *
   * * `strikeClaimsCooldown` / `strikeClaimsStunned` — body-strike CLAIMS collected, split by
   *   which half of the shipped gate excluded that body (a body in both is booked cooldown).
   * * `strikesApplied` — claims that actually became the tick's contact (the shipped
   *   one-contact-per-tick order still decides WHICH claim wins; T1 does not touch it).
   * * `strikesAppliedCooldown` / `strikesAppliedStunned` — the same split, applied.
   * * `maxStrikeRelativeSpeed` — the largest relative closing speed a strike resolved at
   *   (unit: m/s), the honest size of the rebound this law introduces.
   * * `partitionGroundTicks` — free-ball ticks the WIDENED partition routed to the ground
   *   channel that the shipped dispatch would have dropped into the dead band
   *   (z ∈ (`CONTROL_MAX_HEIGHT`, `HEADER_MIN_HEIGHT`)).
   */
  bkContactLedger = {
    strikeClaimsCooldown: 0,
    strikeClaimsStunned: 0,
    strikesApplied: 0,
    strikesAppliedCooldown: 0,
    strikesAppliedStunned: 0,
    maxStrikeRelativeSpeed: 0,
    partitionGroundTicks: 0,
  };
  /**
   * O1 T1 (docs/world-model/O1-T1-PASS-WINDUP.md §SEAM): a shortPass committed
   * but not yet struck — a PARALLEL slot beside `pendingKick`, deliberately not a
   * discriminated member of it, so the certified C7 shot path stays byte-identical
   * (the doc states the form choice) and a shot wind-up and a pass wind-up can
   * never evict each other.
   * `{ gid, readyTick, aim, targetGid, targetRosterIdx, offsideExempt }`:
   * the committed body turns toward `aim` (the mate's position AT ARM TIME) until
   * `stepCount === readyTick`, then the pass resolves via the EXISTING performPass
   * math evaluated at strike time, to the mate captured at arm. NULL in every
   * production path (only `armPendingPass` sets it, only on the ON path).
   *
   * `targetRosterIdx` is the arm-time IDENTITY of the mate (#180.3(i)): the pitch
   * slot object is reused by `becomeSub`, so a gid alone cannot tell whether the
   * body standing there at `readyTick` is still the man who was picked. The
   * resolve cancels (INT-MATE) if it is not.
   *
   * ⭐ PW T0b (#291.5 correction 4): `powerChoice` is the ARM-TIME chosen weight, carried
   * through the wind-up so a wound-up ball strikes at the weight its chooser picked instead of
   * silently reverting to 1. It is the literal 1 on every path but an armed
   * `pwWeightChooser` one, so the certified O1 release is unchanged.
   *
   * ⭐⭐ DX T0 (#352 item 3): `aimLead` is the ARM-TIME ELECTED DISPLACEMENT, carried through
   * the wind-up so a wound-up ball is struck toward the point the argmax actually scored
   * instead of silently reverting to the target's body. It is `null` on every path but an
   * armed `dxWindupAim` one whose decision elected a displaced candidate, so the certified O1
   * release is unchanged.
   */
  pendingPassWindup:
    {
      gid: number; readyTick: number; aim: V2;
      targetGid: number; targetRosterIdx: number; offsideExempt: boolean; powerChoice: number;
      aimLead: V2 | null;
    } | null = null;
  /**
   * O1 T2 (#180.3(ii)/(iii)): the IN-ENGINE arm ledger for the shortPass wind-up.
   * Debt (ii) required eviction accounting to live in the engine rather than in a
   * probe wrapper, so the counters that only the seam can observe are exposed
   * here. Pure bookkeeping: nothing in the sim ever READS these fields, so they
   * cannot influence a single tick, and every one of them stays 0 unless
   * `o1PassWindup` is armed (Road B ⇒ all-zero in every production path).
   *
   * * `arms` — wind-ups armed.
   * * `evictions` — a LIVE pass wind-up overwritten in the single slot by a new
   *   arm (the phase-0 map's trap 10 at pass volume). Measured, not assumed.
   * * `struck` — resolves that reached `performPass`.
   * * `cancelledMate` — INT-MATE: the arm-time mate was sent off or had left the
   *   pitch (identity swapped by `becomeSub`) at `readyTick` ⇒ no pass runs.
   * * `cancelledPendingKick` — the pass arm cancelled a live same-gid SHOT
   *   wind-up (the #180.3(iii) precedence: a body has one set of legs, and the
   *   arm that fires LAST owns them).
   * * `cancelledByPendingKick` — a shot arm cancelled a live same-gid PASS
   *   wind-up (the same precedence, the other order).
   */
  readonly o1WindupLedger: {
    arms: number; evictions: number; struck: number; cancelledMate: number;
    cancelledPendingKick: number; cancelledByPendingKick: number;
  } = {
      arms: 0, evictions: 0, struck: 0, cancelledMate: 0,
      cancelledPendingKick: 0, cancelledByPendingKick: 0,
    };
  /** O2 T0: the LOOK, dormant unless a probe world arms it (Road B). */
  readonly o2Look: boolean;
  /**
   * PM T0: the DEFENSIVE LANE-CONVERGENCE seam, dormant unless a probe world arms
   * it (Road B). Read at exactly ONE place — the M-PM.2 phase gate in
   * `actionExecutor`, which passes the M-PM.3 mover fork into `formationSpot`.
   */
  readonly pmLaneConvergence: boolean;
  /**
   * MT T0: the MARK-SAG stance seam, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the M-MT.1 phase gate in `actionExecutor`, which
   * gates the sag term inside the `MarkOpponent` stance block.
   */
  readonly mtMarkSag: boolean;
  /**
   * CTB T0: the SUPPORT-PLANE seam, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the `supportSpot` call in `actionExecutor`'s
   * `SupportBallCarrier` case, which passes it as that function's `ctbPlane` fork.
   */
  readonly ctbSupportPlane: boolean;
  /**
   * OBM T0: the OFF-BALL EYES SEAT, dormant unless a probe world arms it (Road B).
   * Read at exactly TWO places — the policy fork in `PlayerBrain.decideOffBall` and
   * the plane fork in `actionExecutor`'s `SupportBallCarrier` case.
   */
  readonly obmMovement: boolean;
  /**
   * PTP T0: the PASS-LEAD seam, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the seat fork in `PlayerBrain.decideOnBall`'s pass
   * block, which both prices the led aim point and carries it to the strike.
   */
  readonly ptpPassLead: boolean;
  /**
   * DLC T0: the DELIVERY CONTEST, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the contest seat fork in `PlayerBrain.decideOnBall`'s
   * pass block, which forms the led candidate, enters it in the argmax and hands the
   * winner's own aim to the existing strike machinery.
   */
  readonly dlcDeliveryChoice: boolean;
  /**
   * DLC T0s: the GROUND STRIKE PLANE, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the strike-plane seat fork in `PlayerBrain.decideOnBall`'s
   * pass block, which forms the K = 9 sampled ground strikes, enters them in the argmax
   * and hands the winning kick's own displacement to the existing strike machinery.
   */
  readonly dlcStrikePlane: boolean;
  /**
   * DV T0: the RISK-PRICING seam, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the delivery-value seat fork in
   * `PlayerBrain.decideOnBall`'s pass block, whose seat the ONE hoisted ground-pass
   * pricer consults for every candidate it prices, whichever delivery seam formed it.
   */
  readonly dvDeliveryValue: boolean;
  /**
   * DV T2-T0: the LEARNING door, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the ledger fork in this constructor, which is what
   * produces `dvLearn`. Every downstream consumer keys off that nullable seat.
   */
  readonly dvLearnedMap: boolean;
  /**
   * ⭐⭐ BK T3: the CORRIDOR-HAZARD price, dormant unless a probe world arms it (Road B).
   * Read at exactly ONE place — the corridor-seat fork in `PlayerBrain.decideOnBall`,
   * whose nullable seat every lofted chooser keys off.
   */
  readonly bkCorridorPrice: boolean;
  /**
   * ⭐⭐ GC T0: the GROUND-CORRIDOR price, dormant — ARMED BY NO WORLD AND NO PRESET YET
   * (Road B). Read at exactly ONE place — the ground-corridor seat fork in
   * `PlayerBrain.decideOnBall`, whose nullable seat the ONE hoisted ground-pass pricer
   * keys off for every candidate it prices.
   */
  readonly bkGroundCorridor: boolean;
  /**
   * ⭐⭐⭐ OP T0: the FRONT-MAN door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B).
   * Read at exactly ONE place: the licence's lane seat inside `groundCandidate`.
   */
  readonly opFrontMan: boolean;
  /**
   * ⭐⭐⭐ OP T0b: the FRONT-CHOOSER door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B).
   * Read at exactly ONE place: the snapshot chooser's call site in `decideCarrier`.
   */
  readonly opFrontChooser: boolean;
  readonly raAccessPrice: boolean;
  /**
   * ⭐⭐ RC T0: the PRE-CUE door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B). Read at
   * exactly ONE place — the `passRelease` arm loop in `pcLatencyObserve`, which is the ONE
   * site that can hand `PcLatencySeat.arm` a pre-cue.
   */
  readonly rcAnticipate: boolean;
  /**
   * ⭐⭐ RC T0b: the READY door, dormant — ARMED BY NO WORLD AND NO PRESET (Road B). Read at
   * exactly TWO places: the off-ball menu fork in `PlayerBrain` (the ONE candidate), and this
   * file's own heading-memory hook, which does not exist when the door is shut.
   */
  readonly rcReady: boolean;
  /**
   * ⭐⭐ RC T0b §SEAM — THE FLAG-GATED HEADING MEMORY, and the ONLY new state this seam owns.
   *
   * `null` unless the match was constructed with `rcReady`, so the shipped game allocates
   * nothing and every read below returns `null`. Two flat `[x, y]` pairs per gid: `cur` holds
   * the heading each body carried at the END of the previous step, `prev` the one before that.
   * The shift runs at the HEAD of `step()`, so a brain deciding inside step *t* reads
   * `prev` = h[t−2] against the body's live `heading` = h[t−1] — which is EXACTLY RC-C0b's own
   * pair for tick t−1 (it observed at the END of each step). ⛔ No `Player` field is added, so
   * no shipped byte moves.
   */
  private readonly rcReadyPrevH: Float64Array | null;
  private readonly rcReadyCurH: Float64Array | null;
  /**
   * ⭐ DV T2-T0 §SEAM — THE NULLABLE LEARNING SEAT. Non-null ONLY in a `dvLearnedMap`
   * world; `null` in every production path, which is what makes the learning statements
   * unreachable rather than merely inert.
   */
  readonly dvLearn: DeliveryLabelLedger | null;
  /** DV T2-T0: the score this seam has already accounted for (its scoreboard read). */
  private readonly dvLearnSeenScore: [number, number] = [0, 0];
  /**
   * EK T0: the HOLD LEARNING door, dormant unless a probe world arms it (Road B). Read at
   * exactly ONE place — the ledger fork in this constructor, which produces `ekHold`.
   */
  readonly ekHoldLearn: boolean;
  /**
   * EK T0: the HOLD VETO door (M-EK.3), dormant unless a probe world arms it. Read at
   * exactly ONE place — `ekHoldDeclines`, the single consumption site.
   */
  readonly ekHoldVeto: boolean;
  /**
   * ⭐ EK T0 §SEAM — THE NULLABLE HOLD-LEARNING SEAT. Non-null ONLY in an `ekHoldLearn`
   * world; `null` in every production path, which is what makes the learning statements
   * unreachable rather than merely inert.
   */
  readonly ekHold: HoldLabelLedger | null;
  /**
   * L3 T0: the DEFENCE LEARNING door, dormant unless a probe world arms it (Road B). Read at
   * exactly ONE place — the ledger fork in this constructor, which produces `l3Defence`.
   */
  readonly l3DefenceLearn: boolean;
  /**
   * L3 T0: the DEFENCE VETO door (M-L3.3), dormant unless a probe world arms it. Read at
   * exactly ONE place — `l3DefenceDeclines`, the single consumption site.
   */
  readonly l3DefenceVeto: boolean;
  /**
   * ⭐ L3 T0 §SEAM — THE NULLABLE DEFENCE-LEARNING SEAT. Non-null ONLY in an `l3DefenceLearn`
   * world; `null` in every production path, which is what makes the learning statements
   * unreachable rather than merely inert.
   */
  readonly l3Defence: LungeLabelLedger | null;
  /**
   * PC T0: the REACTION-LATENCY door, dormant unless a probe world arms it (Road B). Read at
   * exactly ONE place — the seat fork in this constructor, which produces `pcLatency`.
   */
  readonly pcReactionLatency: boolean;
  /**
   * ⭐⭐ PC T0 §SEAM — THE NULLABLE REACTION-LATENCY SEAT. Non-null ONLY in a
   * `pcReactionLatency` world; `null` in every production path, which is what makes the
   * detector, the executor's hold gate and the decide-loop AND-gate UNREACHABLE rather than
   * merely inert. It owns the two recognition books, the per-body holds and the per-body memory
   * of the stale plan. NO gene, NO genome write, NO serialization — no Lamarck surface at all.
   */
  readonly pcLatency: PcLatencySeat | null;
  /**
   * PC T0 §SEAM — the detector's snapshot of the PREVIOUS tick's public state, from which the
   * seven class predicates are evaluated as state transitions (PC-C0 §FORM, reused verbatim).
   * `null` in every production path (only `pcLatencyObserve` writes it, only on the ON path).
   */
  private pcPrev: {
    ownerGid: number | null; lastKnownOwnerGid: number | null; touchPasts: number;
    dribbleTouchKey: string | null; pendingPassT: number | null; pendingShot: boolean;
    lastTouchGid: number | null; ballVx: number; ballVy: number; phase: MatchPhase;
  } | null = null;
  /**
   * OBM T0 §SEAM: the last policy each off-ball body computed, keyed by gid, with
   * the tick it was computed on. WRITTEN only by the brain's single `obmMovement`
   * fork (i.e. at the body's own `AI_INTERVAL` decision cadence, never per tick) and
   * READ only by `obmPlaneFor` below. Empty in every production path.
   */
  private readonly obmPolicies = new Map<number, { plane: ObmPlane; tick: number }>();
  /**
   * O2 T0 §SEAM: the live LOOK window — `{ gid, untilTick, startTick }`. A single
   * slot, sufficient because only the BALL OWNER may look and there is one ball.
   * NULL in every production path (only `armO2Look` sets it, only on the ON path).
   * While it is live the body re-decide-locks (`PlayerBrain`), plants
   * (`actionExecutor`), and one scan moment per tick is recorded for him.
   */
  o2LookWindow: { gid: number; untilTick: number; startTick: number } | null = null;
  /**
   * O2 T0 §SEAM — the instrument seam, the `forcedHold` idiom verbatim
   * (M-O2.3: "instruments may force it"). While `o2Look` is armed, the named body
   * takes a LOOK at every eligible decision fork until `untilTick`. **Null in
   * every production path** — and with it null the decision is
   * INCUMBENT-EQUIVALENT (`o2LookDecision` never takes), which is what "born
   * equivalent" means for this stage. The gene/attr expression is a later slice.
   */
  forcedLook: { gid: number; untilTick: number } | null = null;
  /**
   * O2 T0: the IN-ENGINE look ledger (the #180.3(ii) precedent — accounting that
   * only the seam can observe lives in the engine, not in a probe wrapper). Pure
   * bookkeeping: nothing in the sim ever READS these fields, and every one of
   * them stays 0 unless `o2Look` is armed (Road B ⇒ all-zero in production).
   *
   * * `looks` — LOOK windows armed.
   * * `scans` — scan moments recorded BY the look (the refresh itself).
   * * `completed` — windows that ran to `untilTick`.
   * * `abortedLoss` — the looker stopped owning the ball inside the window.
   * * `abortedPhase` — play stopped / he was stunned or sent off inside it.
   */
  readonly o2LookLedger: {
    looks: number; scans: number; completed: number;
    abortedLoss: number; abortedPhase: number;
  } = { looks: 0, scans: 0, completed: 0, abortedLoss: 0, abortedPhase: 0 };
  /**
   * C6 T1: per-body heading ring buffer (the lag law's lookback, doc §SEAM).
   * The outfield carrier's heading is recorded here each owned tick — engine
   * bookkeeping written by the seam, NEVER read as game state by the law and
   * never hashed, so the OFF world signature is byte-identical. It is recorded
   * unconditionally (not gated on `c6Carry`) so a world FORKED from an OFF base
   * match carries the pre-fork history the honest offset's lag reads on the ON
   * arm. A fixed-size ring per gid (`C6_HEADING_RING`), keyed by sim tick.
   */
  readonly c6HeadingHist = new Map<number, { tick: number; hx: number; hy: number }[]>();
  readonly traceChoice: boolean;
  /** E3 instrument output; appended to only when `traceChoice` is on. */
  readonly passChoiceTrace: PassChoiceTraceEntry[] = [];
  /**
   * E3: one reusable truth buffer. The choice consumer needs BODIES, not just a
   * ball, so the memory chain it feeds on cannot use `observeBall`'s O(1) path —
   * but it also must not allocate a fresh `PerceptionTruth` per body per brain
   * tick, which is the cost E2b-1's plumbing failed on. The buffer is refilled
   * in place per call, so the percept is the current one and the allocation is
   * paid once per match (ruling #10.3: compute less, never perceive less).
   */
  /**
   * E3R2: each observer's recent scan moments (ruling #13.3). A body's percept
   * depends only on scans inside its retention window, so the sim records the
   * truth of the moment its scan clock fired and replays those frames when the
   * body is actually asked. Fixed-size ring per observer — retention is at most
   * 60 ticks and the scan interval at least 6, so at most 11 frames can ever be
   * in window. Empty unless the choice consumer is armed.
   */
  private readonly scanFrames = new Map<number, { frames: ScanFrame[]; next: number }>();
  private truthBuffer: {
    tick: number;
    ball: { pos: V2; vel: V2; ownerGid: number | null };
    players: { gid: number; side: Side; pos: V2; vel: V2; bodyDir: V2; sentOff: boolean }[];
  } | null = null;
  /**
   * EDS E2a-2 (docs/world-model/EDS-E2A2-OPTION-SPACE-CENSUS.md): substitute
   * the pass TARGET the brain chose, for one tick, and let the live machinery
   * play it. Intervenes on target choice ONLY — power, lead, aim noise,
   * offside and bookkeeping all run unchanged. Null in every production path;
   * a probe arms it for a single tick and clears it. Forcing the gid the brain
   * would have chosen anyway reproduces the match bit-identically, which is
   * the harness gate the counterfactual census rests on.
   */
  forcedPassTarget: number | null = null;
  /**
   * C5 T0's intervention seam, modelled on `forcedPassTarget` above: while
   * `c5Hold` is armed, the named body shield-holds until `untilTick`. **Null in
   * every production path** — this is the ONLY way `ShieldHold` can be reached
   * at T0, which is what "zero live callers" means for this stage.
   */
  forcedHold: { gid: number; untilTick: number } | null = null;
  /**
   * C5 T0: the elective first-touch window's seam. While `c5TouchFork` is
   * armed, this body takes the window on reception whatever the pressure is.
   * Null in every production path.
   */
  forcedTouchFork: number | null = null;
  /**
   * C4 O1's intervention seam (docs/world-model/C4-O1-FLIGHT-FORK.md), same
   * grammar as `forcedPassTarget`: force ONE cross's flight profile at one
   * real moment, so both arms of the fork share the same delivery struck by
   * the same body. `c4Flight` is a match-wide POLICY and could only ever
   * answer "is mandating this good"; this answers "is choosing it good HERE".
   * Null in every production path.
   */
  forcedCrossProfile: 'current' | 'lofted' | null = null;
  /**
   * C4 O2's intervention seam (docs/world-model/C4-O2-SECOND-BODY-FORK.md):
   * force ONE off-ball body's steering target for a window. Applied BEFORE the
   * onside and barred-box clamps, so a forced body gets no privilege the world
   * does not have. Null in every production path. Stage III P1 is held and may
   * adopt, replace or ignore this seam (#35.3 ruled P1 forks the READ) — O2
   * claims nothing about P1's design.
   */
  forcedStation: { gid: number; target: V2; untilTick: number } | null = null;
  /**
   * Stage III P1's intervention seam
   * (docs/world-model/STAGE3-P1-STATION-CENSUS.md §2.1): a station POLICY in
   * BALL-LOCAL attack-frame coordinates, re-evaluated every tick. P0 §1.1
   * established that a station is a RELATION to the ball recomputed at 60 Hz,
   * not a stored point — so forcing a fixed point would price something the
   * eye cannot express. Consumed at the executor's READ (#35.3), before the
   * onside and barred-box clamps, so the forced body is steered like any
   * other. Null in every production path.
   */
  forcedStationPolicy: {
    gid: number;
    offset: { dx: number; dy: number };
    untilTick: number;
  } | null = null;
  /**
   * Stage III P2's DORMANT EYE
   * (docs/world-model/STAGE3-P2-DORMANT-EYE.md §2.1). The chooser that
   * consumes P1R's approach table through each body's own percept. A SECOND,
   * independent seam from `forcedStationPolicy` on purpose, so P1R's harness
   * stays reproducible bit-for-bit. The table is INJECTED by the probe; no
   * table is bundled in `src/**`. Null in every production path, and the
   * `oracleCtx` arm (which reads truth) is probe-only by contract §2.5.
   */
  stationEye: {
    readonly arm: StationEyeArm;
    readonly scope:
      | { readonly kind: 'body'; readonly gid: number }
      | { readonly kind: 'team'; readonly side: Side }
      | { readonly kind: 'both' };
    readonly table: ApproachTable;
    /**
     * Stage III V2-P2 (STAGE3-V2-P2-CONSUMER §2.2/§2.4): the going-conditioned
     * consumer. When present the eye prices each candidate through its
     * (context × PERCEIVED going-bit) cell against the recovered control level
     * in the same going-bit — the ONE amendment the v2 census forces. Absent ⇒
     * the v1 P2 chooser (`table`) runs unchanged. Both are null in production;
     * the table + control are INJECTED by the probe, never bundled in `src/**`.
     */
    readonly v2?: {
      readonly goingTable: GoingConditionedTable;
      readonly control: ControlLevels;
      /**
       * V2-P2R (ruling #75.2): the mid-window abort is an EXPLICIT opt-in. Absent
       * (or false) ⇒ the going-conditioned consumer runs WITHOUT the abort — the
       * old V2-P2 experiment reproduces byte-for-byte, no G_commit captured, no
       * mid-window re-read. `true` ⇒ the D3-DUPLICATE abort arms (P2R probe only).
       */
      readonly abortEnabled?: boolean;
    };
    /**
     * Stage III V3-P2 (STAGE3-V3-P2-ROLE-CONSUMER §3.2/§3.4): the role-conditioned
     * consumer. When present the eye prices each candidate through the body's OWN
     * role column (`Player.role`, immutable own-state) against the control recovered
     * for that same (context × role) — NO going-bit (#77.2(ii)), the ONE amendment
     * the v3 census forces. Absent ⇒ the v1 (`table`) or v2 (`v2`) chooser runs. All
     * null in production; the table + control are INJECTED by the probe, never bundled
     * in `src/**`. The abort machinery is NOT armed here (it stays dormant behind its
     * v2 #75 opt-in).
     */
    readonly v3?: {
      readonly roleTable: RoleConditionedTable;
      readonly control: RoleControlLevels;
      /**
       * Stage III V4-P3p-2 (STAGE3-V4-P3P2-CONSUMER §2.3, ruling #117.3): the
       * P3p-1 MERGED table's bit-split `children` — an OPTIONAL extension of the
       * v3 role table, INJECTED only for the PARTIAL arms. When present AND a
       * matching `v4` bit flag is armed, the eye prices each candidate through
       * the frozen child-or-base fallback order (§2.2) against the SAME v3
       * control (the control is NOT bit-split). Absent (R0/R3v3) ⇒ the plain v3
       * lookup runs unchanged (X-OFF-IDENT). `mergedTableSha` carries the P3p-1
       * artifact SHA for the probe's X-MERGE-SHA assertion. Both null in
       * production; INJECTED by the probe, never bundled in `src/**`.
       */
      readonly children?: MergedChildTable;
      readonly mergedTableSha?: string;
    };
    /**
     * Stage III V4-P3-PARTIAL (STAGE3-V4-P3-PARTIAL §2.3/§3.4, P3p-0): three
     * INDEPENDENT, DEFAULT-OFF opt-in flags gating the dormant seams — the
     * in-support law (§2) and the two S bits (§3). Each is an EXPLICIT
     * `=== true` opt-in on its OWN named flag (ruling #75's lesson: a
     * `!== undefined` gate once fired inside an old experiment, so every new
     * gate is an explicit boolean). Absent everywhere in production and in the
     * v1/v2/v3 arms ⇒ the consumption path is BYTE-IDENTICAL to the v3 eye
     * (X-OFF-IDENT). Built dormant at P3p-0; consumed (merged table) at P3p-2.
     */
    readonly v4?: {
      /** §2: consult the eye ONLY at in-support moments; else holdIncumbent. */
      readonly inSupportLaw?: boolean;
      /** §3.1: compute the wide-occupancy bit (observability only until P3p-2). */
      readonly deliveryBit?: boolean;
      /** §3.2: compute the beyond-line bit (observability only until P3p-2). */
      readonly offsideBit?: boolean;
      /**
       * A4-P2 (ruling #148): the DORMANT home-prior MASTER flag. Absent / not
       * `true` in every production path AND every banked instrument ⇒ the map-grant
       * consumption block below stays byte-identical (X-OFF-IDENT / I-A7). When
       * `=== true` AND the eye consumption is armed, EACH side's home-map bias
       * strength is derived from THAT side's own genome (`homePriorObedience`, born
       * 0 ⇒ inert) at the SAME v3 consumption point — both teams, each from its own
       * agreement. The probe-injected `Match.homeMapGrant` stays available and takes
       * PRECEDENCE for any side it targets (instrument independence, the P1c/P1d
       * idiom). No clamp, no new consumption moment; homes stay the genome-chosen
       * ATTACK_FORMATIONS base spots (banked #144.2).
       */
      readonly homePrior?: boolean;
    };
    /** Probe-owned observability sink; the sim never reads it back. */
    readonly trace?: StationEyeTrace;
  } | null = null;
  /**
   * V2-P2 §2.3 repair 1: per-body LAST-PERCEIVED ball owner (the in-flight FACE
   * ledger). Written only on eye decisions; read to retain the FACE while the
   * perceived ball is in flight. Empty whenever `stationEye` is null.
   */
  readonly stationEyeOwnerLedger = new Map<number, number>();
  /** P2 §2.2: per-body commitment windows. Empty whenever `stationEye` is null. */
  readonly stationEyeState = new Map<number, {
    /** null = the window is committed to the INCUMBENT (a tie, or no basis). */
    offset: { dx: number; dy: number } | null;
    candidateId: string;
    untilTick: number;
    faceAtDecision: 'ours' | 'theirs';
    /**
     * V2-P2R §1.1: the commit-time going-contributor set G_commit — the perceived
     * teammate gids whose W-advanced position lands within R of the chosen region
     * at commit. Written on a DEVIATION, empty for incumbent windows. The abort
     * (§1.2) fires iff a mid-window re-read's G_mid carries a gid NOT in this set.
     * Only ever populated while `stationEye !== null` (dormant in production).
     */
    committedGoingContributors: Set<number>;
  }>();
  /**
   * C5 T2 — THE WHETHER SEAT (docs/world-model/C5-T2-WHETHER-SEAT.md §2.1). The
   * perceived chooser's "keep holding" option, consuming the certified
   * re-census cost table under R-B (#64.1). **Null in every production path,
   * zero live callers** — when null the world is bit-identical to the shipped
   * game (X-FP / X-OFF-IDENT). The table is INJECTED by the probe; no table is
   * bundled in `src/**`. A SECOND, independent seam from `forcedHold`: the
   * census's forced-hold harness stays reproducible bit-for-bit.
   */
  whetherEye: WhetherEyeConfig | null = null;
  /**
   * C5 T2 §2.1: per-body live hold commitments taken by the whether seat. Only
   * ever populated while `whetherEye !== null`; the seat sets an entry when it
   * takes a HOLD-k, and it lapses at `untilTick` or when the body loses the
   * ball / play stops. Empty whenever `whetherEye` is null.
   */
  readonly whetherHoldState = new Map<number, {
    untilTick: number;
    cellAtDecision: string;
    k: number;
  }>();
  private readonly traceContests: boolean;
  private activeContest: MutableContestEpisode | null = null;
  private nextContestId = 1;
  /** Physical contact has happened; stable ownership has not. */
  private pendingControl: PendingControlAttempt | null = null;
  /**
   * Discrete dribble touch in flight (Phase 36): the carrier pushed the
   * ball ahead and is chasing it. The tag keeps his brain on the chase and
   * prices his re-collect gently (it's HIS touch, not a blind reception);
   * any other capture, kick or dead ball clears it.
   */
  dribbleTouch: { gid: number; until: number } | null = null;
  /**
   * B1c-0 representation only. No live system creates or consumes a control
   * sequence yet; null therefore preserves the complete B0 match path.
   */
  controlSequence: ControlSequence | null = null;
  /**
   * Pure macro projection for future explicitly-classified consumers. In B1c-0
   * the sequence is always null, so this is exactly the authoritative ball.
   */
  get possessionLocus(): PossessionLocus {
    const sequence = this.controlSequence;
    const controller = sequence === null ? null : this.allPlayers[sequence.controllerGid] ?? null;
    return derivePossessionLocus({
      ballPos: this.ball.pos,
      controlSequence: sequence,
      controllerPos: controller?.pos ?? null,
    });
  }
  /**
   * B0 observational control phase derived from existing authoritative state.
   * No live decision or physics path reads it.
   */
  get ballControlPhase(): BallControlPhase {
    const owner = this.ball.owner;
    return classifyBallControl({
      live: this.phase === 'playing',
      ownerGid: owner?.gid ?? null,
      ownerIsKeeper: owner?.role === 'GK',
      keeperHolding:
        owner !== null && owner.role === 'GK' && (owner.gkHoldTimer > 0 || owner.gkDistributing),
      knockedByGid: this.dribbleTouch?.gid ?? null,
      knockExpiresAt: this.dribbleTouch?.until ?? null,
    });
  }
  /** Live dead-ball restart (kick-in/corner/goal kick); null in open play. */
  restart: RestartState | null = null;
  /** A ball over the goal line, coasting clear before its corner/goal-kick is
   * placed (Phase 41.1). Goal detection is frozen while this is set, so a wide
   * ball drifting behind the line can't phantom-goal. Transient — lives only
   * ~OUT_PLAY_COAST s of open play, and setupKickoff clears any stragglers. */
  private pendingOut: { kind: RestartKind; side: Side; spot: V2; until: number } | null = null;
  /** Gid whose next carrier decision must be a kick (restart first touch). */
  restartKickGid: number | null = null;
  /** Gid whose next carrier decision is the kickoff — played BACKWARD (27.3). */
  kickoffKickGid: number | null = null;
  /** What kind of restart that kick is — penalties force a shot. */
  restartKickKind: RestartKind | null = null;
  /**
   * Free-kick WALL (Phase 32): picked when a danger-zone FK is awarded —
   * the defending bodies that line up on the ball–goal line at the law
   * clearance. The executor routes them there (their slot IS their
   * steering target, so the clearance clamps never fight them — the wall
   * IS the clearance). The kick STARTS the release timer instead of
   * dissolving it: released instantly, the wallers walked back toward
   * their marks — straight into the climb's header band — and free-headed
   * the kick they had just walled. `until` null = holding; set = released
   * at that sim time. A new restart clears it outright.
   */
  fkWall: { gids: number[]; pos: V2; side: Side; until: number | null } | null = null;
  /** The corner routine the restart handed to the kick (Phase 31). */
  restartKickRoutine: CornerRoutine | null = null;
  pendingPass: PendingPass | null = null;
  /** Consecutive completed passes in the current move, per side (Phase 33). */
  private passChain: [number, number] = [0, 0];
  pendingShot: PendingShot | null = null;
  shotLog: ShotLogEntry[] = [];
  /** Gid of the most recent goalscorer — passive, for celebration visuals only. */
  lastScorerGid: number | null = null;
  /** Per-player counters (goals/assists/shots/saves/recoveries). ROSTER-
   * indexed since Phase 61 (home 0..ROSTER_SIZE-1, then away): a substitute's
   * numbers land on HIS row. Write through `stat(gid)`. Passive. */
  playerStats: PlayerMatchStats[] = [];
  /** Rounds out per roster row (Phase 118) — home 0..8, then away; 0 = fit.
   * Banked by League.applyResult into `f.injuries` (the suspension seam). */
  readonly injuriesOut: number[] = Array<number>(ROSTER_SIZE * 2).fill(0);
  /** Roster surnames (record resolution — the MOTM line may name a sub). */
  private readonly rosterNames: string[];
  lastCompletedPass: { passerGid: number; receiverGid: number; t: number } | null = null;
  /** The most recent cutback kick (Phase 31) — goals within 5s credit it. */
  lastCutback: { side: Side; t: number } | null = null;
  /** Telemetry (Phase 86): the most recent pass launch's kind — shot-context
   * anatomy reads it; zero RNG, zero behavior. */
  lastPassKind: { kind: 'pass' | 'through' | 'cross' | 'lofted'; t: number } | null = null;
  /* ---- Goal-channel telemetry (Phase 113) — the launch-anatomy probe's
   * band-entry classifier moved in-engine so every GOAL carries a channel
   * tag. All four fields are written from state the step already computed
   * and read ONLY by the shot log: zero RNG, zero behavior. ---- */
  /** The current owner's possession start (team-local x) — the carry clock. */
  carryStart: { gid: number; t: number; x: number } | null = null;
  /** The owner already counted for the final-15m band this possession. */
  private bandInside = false;
  /** The live attack's fresh BREAKAWAY band entry (nobody goal-side but the
   * keeper) and what launched it. A turnover or kickoff kills it. */
  attackEntry: { side: Side; kind: GoalChannel; t: number } | null = null;
  /** The most recent SET-PIECE first touch (corner/free kick/penalty only). */
  lastRestartKick: { kind: RestartKind; side: Side; t: number } | null = null;

  private kickoffSide: Side = 0;
  private stepCount = 0;
  /** Deterministic discrete simulation clock for pure observational layers. */
  get simTick(): number { return this.stepCount; }
  /** One "stoppage time" feed line per half (Phase 27.4). */
  private stoppageAnnounced = false;
  /** Sim time when the second half kicked off — first-half stoppage must not
   * leak into the second half's display clock (Phase 28.1). */
  private secondHalfStart = 0;

  /** Armed rivalry fixture (Phase 40): press + bite up a touch, 🔥 banner. */
  readonly derby: boolean;

  /**
   * A4-P1b (ruling #133): the side (`0`|`1`) whose index-1 rest-defence
   * DESIGNATION POLICY is abandoned, or `null` when the policy is intact.
   * MUTABLE on purpose (the `forcedStation` idiom): a probe sets it on a
   * cloned/forked world inside the counterfactual branch; `null` in every
   * production path, so both gated faces behave bit-for-bit as HEAD. */
  abandonRestDesignation: 0 | 1 | null = null;

  /**
   * A4-P1c (ruling #137): the DORMANT back-home-region GRANT (the M1′ soft-bias
   * instrument form). `null` when no body is granted a back home prior — the case
   * in EVERY production path, so the eye consumption point is bit-for-bit HEAD.
   * When set (ONLY on a cloned/forked world inside the counterfactual branch, the
   * `forcedStationPolicy` idiom), it adds a distance-decayed SOFT bias toward the
   * back home region to the granted body's per-candidate station value at the
   * established v3 consumption point (no clamp; body- and side-scoped; the eye's
   * native score units). `strength` is a pre-registered DOSE (a gene when shipped
   * — I-A3). MUTABLE on purpose; a probe assigns it, never a constructor path.
   *
   * A4 SLICE 2, S2-P1 (A4-SLICE2-PERBODY-CONTRACT §2 M-S2.3, ruling #158): the
   * seam GENERALIZES to a per-body OBEDIENCE VECTOR (the second union member,
   * discriminated by the presence of `obedienceByIndex`). `null` remains the
   * default in EVERY production path, and the single-body P1c member is
   * UNTOUCHED (its branch is byte-for-byte what it was). When the VECTOR member
   * is set (ONLY on a cloned/forked world inside an instrument branch), each
   * side-`side` OUTFIELD body reads HIS OWN obedience `obedienceByIndex[p.index]`
   * ∈ [0,1], mapped through the SHIPPED-FORM `homePriorStrength` onto the
   * certified [0, HOME_MAP_STRENGTH_MAX] span and applied to HIS OWN
   * ATTACK_FORMATIONS home via the SAME `homeMapBias` closure the shipped
   * `eye.v4.homePrior` branch builds — so a UNIFORM vector at obedience 0.5 is
   * exactly the slice-1 certified PRIOR content on that side (asserted in
   * `tests/a4S2VectorGrant.test.ts`). An absent / non-finite / ≤ 0 entry ⇒ no
   * bias for that body (inert). VECTORS ARE MEASUREMENT FORKS, NEVER SHIPPED
   * CONTENT (contract §3 BIRTH NEUTRALITY): no role-derived birth default exists
   * anywhere in `src/**`; the vectors live only inside probe instruments. */
  homeRegionGrant:
    | { readonly side: 0 | 1; readonly bodyIndex: number; readonly strength: number }
    | { readonly side: 0 | 1; readonly obedienceByIndex: readonly number[] }
    | null = null;

  /**
   * A4-P1d (ruling #143): the DORMANT HOME-MAP GRANT (the WHOLE-DISTRIBUTION form
   * of the M1′ soft-bias instrument). `null` when no team is granted its home map
   * — the case in EVERY production path, so the eye consumption point is
   * bit-for-bit HEAD (both this flag and `homeRegionGrant` null ⇒ byte-identical
   * to the pre-P1c world). When set (ONLY on a cloned/forked world inside the
   * counterfactual branch, the `forcedStationPolicy` idiom), EVERY side-`side`
   * OUTFIELD body gets his OWN coarse 2D home bias — centred on HIS formation
   * base spot (ATTACK_FORMATIONS, the world's own per-body variable), extents
   * pre-registered from pitch constants on both axes, no clamp — added to his
   * per-candidate station value at the established v3 consumption point. Per-body
   * homes are DERIVED deterministically in the consumption path (NO per-body
   * table stored here). `strength` is a pre-registered DOSE, uniform across
   * bodies (a gene when shipped — I-A3). MUTABLE on purpose; a probe assigns it,
   * never a constructor path. The P1c single-body `homeRegionGrant` is banked
   * untouched; if BOTH are set the single-body grant takes precedence for its one
   * body (independence). */
  homeMapGrant: { readonly side: 0 | 1; readonly strength: number } | null = null;

  constructor(cfg: MatchConfig) {
    this.rng = new Rng(cfg.seed);
    this.duration = cfg.duration ?? MATCH_DURATION;
    this.derby = cfg.derby ?? false;
    this.traceContests = cfg.traceContests ?? false;
    this.traceFirstTouch = cfg.traceFirstTouch ?? false;
    this.edsTouchCost = cfg.edsTouchCost ?? EDS_BUNDLE_ARMED;
    this.c5Hold = cfg.c5Hold ?? EDS_BUNDLE_ARMED;
    this.c5TouchFork = cfg.c5TouchFork ?? EDS_BUNDLE_ARMED;
    this.c4Flight = cfg.c4Flight ?? EDS_BUNDLE_ARMED;
    this.c4FlightStaleLead = cfg.c4FlightStaleLead ?? false;
    this.c4Arrival = cfg.c4Arrival ?? EDS_BUNDLE_ARMED;
    this.c4ArrivalReroute = cfg.c4ArrivalReroute ?? EDS_BUNDLE_ARMED;
    this.edsPerceivedDefence = cfg.edsPerceivedDefence ?? EDS_BUNDLE_ARMED;
    this.edsPerceivedChoice = cfg.edsPerceivedChoice ?? EDS_BUNDLE_ARMED;
    this.edsValueAxis = cfg.edsValueAxis ?? EDS_BUNDLE_ARMED;
    this.edsEagerPerception = cfg.edsEagerPerception ?? false;
    // C6 T1: Road B — never env-armed, never default-ON; a probe arms it explicitly.
    this.c6Carry = cfg.c6Carry ?? false;
    // C7 T1: Road B — never env-armed, never default-ON; a probe arms it explicitly.
    this.c7Windup = cfg.c7Windup ?? false;
    // O1 T1: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED (the phase-0 trap 12: a seam gated on c7Windup would arm
    // itself in the a4 world); a probe arms it explicitly.
    this.o1PassWindup = cfg.o1PassWindup ?? false;
    this.dxWindupAim = cfg.dxWindupAim ?? false;
    // BK T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-BK.1: the facing law gets its OWN door
    // and nothing else may turn it on); a probe arms it.
    this.bkFacingLaw = cfg.bkFacingLaw ?? false;
    // BK T1: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-BK.2: the contact law gets its OWN door
    // and nothing else may turn it on); a probe arms it. It owns its own sites and depends
    // on no other flag, so — unlike `bkFacingLaw` — there is no inert composition to refuse.
    this.bkContactLaw = cfg.bkContactLaw ?? false;
    // BF T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-BF.3: the facing-cost law gets its OWN
    // door and nothing else may turn it on); a probe arms it. It owns its one seam inside
    // `Player.physicsStep` and depends on no other flag, so there is no inert composition
    // to refuse — and it moves neither the turn rate nor any facing-decision site.
    this.bfFacingCost = cfg.bfFacingCost ?? false;
    // BQ T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-BK.5: the cushion law gets its OWN door
    // and nothing else may turn it on); a probe arms it. It owns its one seam inside
    // `applyControlContact` and depends on no other flag, so there is no inert composition
    // to refuse — and it moves neither the window, nor the margin, nor the roll.
    this.bqCushion = cfg.bqCushion ?? false;
    // LN T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-LN.3: the own-lane price gets its OWN door
    // and nothing else may turn it on); a probe arms it. It owns its one seat construction in
    // `PlayerBrain.decideCarrier` and depends on no other flag, so there is no inert
    // composition to refuse — and with the gene born absent it moves no double at all.
    this.lnOwnLanePrice = cfg.lnOwnLanePrice ?? false;
    // GK T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-GK.1: the dive law gets its OWN door and
    // nothing else may turn it on); a probe arms it. It owns three sites — the contact
    // point, the body override and the ball's wait — and depends on no other flag, so
    // there is no inert composition to refuse; it moves no roll and no save outcome.
    this.gkDiveBody = cfg.gkDiveBody ?? false;
    // DS T0: Road B — TWO explicit booleans, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (#405
    // item 3(v): the own run and the hats-off arm get their OWN doors and nothing else may
    // turn them on); a probe arms them.
    this.dsOwnRun = cfg.dsOwnRun ?? false;
    this.dsHatsOff = cfg.dsHatsOff ?? false;
    // DS T0d: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (#412 item
    // 5(i)); a probe arms it. It owns its two gates and depends on no other flag.
    this.dsCoopHatsOff = cfg.dsCoopHatsOff ?? false;
    // IF T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (M-IF.4,
    // ruling #417 item 3(i)); a probe arms it. It owns its one site inside the own-run fork
    // and is CONTAINED by `dsOwnRun`: armed alone it does nothing. Its per-body memory is
    // created EMPTY here and stays empty unless that site writes it.
    this.ifFlightRun = cfg.ifFlightRun ?? false;
    this.ifLastSeenOwnerGid = new Map();
    // IF T0b / M-IF.6: the per-body LOOK COUNTER, created EMPTY here too and touched only
    // inside the flight door at the own-run fork (#422 item 2).
    this.ifLook = new Map();
    // DF T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-DF.1: the persistence seam gets its OWN
    // door and nothing else may turn it on); a probe arms it. It owns its one site inside
    // `assignMarks` and depends on no other flag, so there is no inert composition to
    // refuse — and it never touches `assignChasers` or the Phase-31 cap (M-DF.2).
    this.dfAssignPersist = cfg.dfAssignPersist ?? false;
    // DF T2: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-DF.1: the surface gets its OWN door and
    // nothing else may turn it on); a probe arms it. It owns its one site inside
    // `assignMarks` and depends on no other flag, so there is no inert composition to
    // refuse — and it never touches `assignChasers` or the Phase-31 cap (M-DF.2).
    this.dfSurface = cfg.dfSurface ?? false;
    // DF T4: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-DF.2: the cap's retirement gets its OWN
    // door and nothing else may turn it on); a probe arms it. It owns its two purely
    // ADDITIVE statements inside `assignChasers` and depends on no other flag, so there is
    // no inert composition to refuse — and it never touches `assignMarks`, the decision
    // surface or any other of that function's non-cap rules.
    this.dfCapOff = cfg.dfCapOff ?? false;
    // IN T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-IN.4 flag hygiene: the snapshot seam
    // gets its OWN door and nothing else may turn it on); a probe arms it. It owns its
    // sites inside `decideCarrier` and depends on no other flag, so there is no inert
    // composition to refuse — and it never touches the executor, the steering layer,
    // the contact layer or the ball (M-IN.1: physics stays truth).
    this.inSnapshotLaw = cfg.inSnapshotLaw ?? false;
    // The field is the seam's ONE parameter; F2 squareAcross is the field OF RECORD
    // (IN-C0 §R2's engine-own midpoint) and F4 contactHalfPrice is the DECLARED
    // sensitivity arm. Inert while the law is off.
    this.inSnapshotField = cfg.inSnapshotField ?? 'F2squareAcross';
    // IN T1: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (M-IN.4 flag hygiene: the look gets its
    // OWN door and nothing else may turn it on); a probe arms it. It owns its ONE fork at
    // the head of `decidePlayer` and depends on no other flag — armed WITHOUT
    // `inSnapshotLaw` it still costs the body his time and writes a book nobody prices,
    // which is a legal (and stated) composition, not a refusal.
    this.inLookAct = cfg.inLookAct ?? false;
    // O2 T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (contract §3 FLAG HYGIENE + #193.2:
    // it gets its OWN opt-in and nothing else may turn it on); a probe arms it.
    this.o2Look = cfg.o2Look ?? false;
    // PM T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#195.2: the gene gets its OWN
    // opt-in and nothing else may turn it on); a probe arms it.
    this.pmLaneConvergence = cfg.pmLaneConvergence ?? false;
    // MT T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#201.4: the gene gets its OWN opt-in
    // and nothing else may turn it on); a probe arms it.
    this.mtMarkSag = cfg.mtMarkSag ?? false;
    // CTB T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#223: the genes get their OWN opt-in
    // and nothing else may turn them on); a probe arms it.
    this.ctbSupportPlane = cfg.ctbSupportPlane ?? false;
    // OBM T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#227: the policy matrix gets its OWN
    // opt-in and nothing else may turn it on); a probe arms it.
    this.obmMovement = cfg.obmMovement ?? false;
    // PTP T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#231: the lead gene gets its OWN
    // opt-in and nothing else may turn it on); a probe arms it.
    this.ptpPassLead = cfg.ptpPassLead ?? false;
    // DLC T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#235: the contest gets its OWN door and
    // nothing else may turn it on); a probe arms it.
    this.dlcDeliveryChoice = cfg.dlcDeliveryChoice ?? false;
    // DLC T0s: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#241: the strike plane gets its OWN door
    // and nothing else may turn it on); a probe arms it.
    this.dlcStrikePlane = cfg.dlcStrikePlane ?? false;
    // DV T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#249: the risk pricing gets its OWN door
    // and nothing else may turn it on); a probe arms it.
    this.dvDeliveryValue = cfg.dvDeliveryValue ?? false;
    // DV T2-T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#256.4: the learning seam gets its OWN
    // door and nothing else may turn it on); a probe arms it.
    this.dvLearnedMap = cfg.dvLearnedMap ?? false;
    // BK T3: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#333 item 5: the corridor price gets its
    // OWN door and nothing else may turn it on); a probe arms it.
    this.bkCorridorPrice = cfg.bkCorridorPrice ?? false;
    // GC T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset
    // (#343 item 4: the ground-corridor price gets its OWN door and nothing else may turn
    // it on); a probe arms it.
    this.bkGroundCorridor = cfg.bkGroundCorridor ?? false;
    // OP T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (M-OP.3,
    // ruling #432 item 3(i)); a probe arms it.
    this.opFrontMan = cfg.opFrontMan ?? false;
    // OP T0b: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (M-OP.5,
    // ruling #435 item 4(i)); a probe arms it.
    this.opFrontChooser = cfg.opFrontChooser ?? false;
    this.raAccessPrice = cfg.raAccessPrice ?? false;
    // RC T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (#369
    // item 6: the pre-cue gets its OWN door and nothing else may turn it on); a probe arms it.
    this.rcAnticipate = cfg.rcAnticipate ?? false;
    // RC T0b: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted, and named by NO world and NO preset (#378
    // item 6: the READY limb gets its OWN door and nothing else may turn it on); a probe arms
    // it. The memory exists ONLY behind the open door.
    this.rcReady = cfg.rcReady ?? false;
    // EK T0: Road B — TWO explicit booleans, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#261.4: the hold-belief seam gets its OWN
    // doors and nothing else may turn them on); a probe arms them.
    this.ekHoldLearn = cfg.ekHoldLearn ?? false;
    this.ekHoldVeto = cfg.ekHoldVeto ?? false;
    // L3 T0: Road B — TWO explicit booleans, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#279.4: the defence-book seam gets its OWN
    // doors and nothing else may turn them on); a probe arms them.
    this.l3DefenceLearn = cfg.l3DefenceLearn ?? false;
    this.l3DefenceVeto = cfg.l3DefenceVeto ?? false;
    // CB T0: Road B — TWO explicit booleans, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#266.5: the layer-1 carry-beat physics gets its
    // OWN doors and nothing else may turn them on); a probe arms them.
    this.cbCommitPhysics = cfg.cbCommitPhysics ?? false;
    this.cbTouchPast = cfg.cbTouchPast ?? false;
    this.cbChoiceSeat = cfg.cbChoiceSeat ?? false;
    // PW T0b: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#292.4: the weight chooser gets its OWN door and
    // nothing else may turn it on); a probe arms it.
    this.pwWeightChooser = cfg.pwWeightChooser ?? false;
    // PC T0: Road B — an EXPLICIT boolean, never env-armed, never default-ON, never
    // EDS_BUNDLE_ARMED, never bundle-defaulted (#297 item 7: the latency law gets its OWN door
    // and nothing else may turn it on); a probe arms it.
    this.pcReactionLatency = cfg.pcReactionLatency ?? false;
    // PW T0c: the fidelity instrument's ladder — absent ⇒ the engine's own canary ladder.
    this.pwPowerLadder = cfg.pwPowerLadder ?? null;
    // ⭐⭐ PW T0c (#293.3 (d)) — THE PTP × PW COMPOSITION DOOR, SHUT AND LOUD. A `ptpPassLead`
    // lead is priced (and its pass aimed) at weight 1; a PW-chosen ball leaves the boot at a
    // different pace, so the lead would be silently wrong. NOTHING in this repo arms both — the
    // composition has ZERO receipt coverage — so rather than let a future world compose them by
    // accident, the engine REFUSES to build the world. Lifting this is a slice: price the lead
    // at the chosen rung, then delete the throw with its own receipts (M-PW.4's own form).
    if (this.pwWeightChooser && this.ptpPassLead) {
      throw new Error(
        'PW×PTP is an UNSUPPORTED COMPOSITION (ruling #293.3 (d)): `ptpPassLead` prices and aims '
        + 'its lead at weight 1, while `pwWeightChooser` strikes at a chosen weight, so the lead '
        + 'would ride a ball it was never priced for. No receipt covers this composition; arming '
        + 'both requires the lead-at-rung pricing slice first.',
      );
    }
    // ⭐⭐ BK T0 — THE INERT-LAW DOOR, SHUT AND LOUD (the #293.3 (d) precedent, other cause).
    // The facing law owns NO arm site: it extends `armPendingKick` / `armPendingPass`, which
    // are only ever reached when their own wind-up flag is armed. With NEITHER armed the flag
    // changes nothing at all, so a world could carry `bkFacingLaw: true` and be byte-identical
    // to a world without it — a claim with no mechanism behind it. Rather than let that world
    // exist, the engine REFUSES to build it. A PARTIAL composition (exactly one channel armed)
    // is legal and honest: the law prices the channel that exists, and the stage doc names the
    // family left unpriced in that world.
    if (this.bkFacingLaw && !this.c7Windup && !this.o1PassWindup) {
      throw new Error(
        'BK `bkFacingLaw` is INERT WITHOUT A WIND-UP CHANNEL (BK-T0 §LAW, contract M-BK.1): '
        + 'the facing law EXTENDS `armPendingKick` (`c7Windup`) and `armPendingPass` '
        + '(`o1PassWindup`) and owns no arm site of its own, so with neither armed it cannot '
        + 'change a single tick. Arm at least one wind-up channel, or drop the flag.',
      );
    }
    this.traceChoice = cfg.traceChoice ?? EDS_TRACE_ARMED;
    // A4-P1b (#133): Road B — never env-armed, never default-ON; absent ⇒ null
    // (the policy intact for both sides), so the fingerprint stands.
    this.abandonRestDesignation = cfg.abandonRestDesignation ?? null;
    this.edsAwareness = cfg.edsAwareness ?? 0.8;
    this.perceptionSeed = cfg.seed;
    this.teams = [new Team(0, cfg.teamA), new Team(1, cfg.teamB)];
    // ⭐⭐ BF T0 — THE PER-BODY DEPTH (ruling #375 item 3): the ONLY way the facing-cost
    // law reaches a body. Shut, every body carries 0 and `physicsStep`'s branch is never
    // taken (byte-identity by construction, pinned by G-OFF). The bench carries no bodies
    // — a substitute IS this same pitch-slot object (`becomeSub`), and the two
    // substitution paths re-write the depth onto him as he enters.
    this.setFacingDepth();
    // The underdog shift (Phase 64): with both clubs' Elo on the team
    // sheet, the outgunned coach bends toward the bus by his gene. Read
    // ONCE at kickoff; the score/clock mentality layers on top each brain
    // tick. 150 Elo = a full class apart — OUR ladder is compressed
    // (K=28, reborn clubs reset to 1500, 14-match seasons), and the first
    // cut at /300 left in-league kickoff factors averaging 0.11-0.19:
    // a sensor whose dynamic range never met its signal (probed).
    if (cfg.teamA.elo !== undefined && cfg.teamB.elo !== undefined) {
      const gap = cfg.teamB.elo - cfg.teamA.elo;
      for (const team of this.teams) {
        const factor = Math.min(1, Math.max(0, (team.side === 0 ? gap : -gap) / 150));
        const s = factor * (team.info.genome.underdogShift ?? 0);
        team.baseGenome = applyUnderdogShift(team.info.genome, s);
        team.effGenome = team.baseGenome;
        // The pragmatist's kickoff call gets NARRATED (Phase 66, N3): the
        // shift existed since 64 but was invisible in the feed. One line,
        // only when the bend is a real bus (s·0.3 ≈ +0.12 compactness), so
        // routine small leans stay quiet (failure mode 7).
        if (s >= 0.4) {
          const oppName = (team.side === 0 ? cfg.teamB : cfg.teamA).name;
          const coach = team.info.coachName;
          this.pushEvent('info', team.side, coach
            ? `🚌 ${coach} parks the bus against ${oppName}`
            : `🚌 ${team.info.name} park the bus against ${oppName}`);
        }
      }
    }
    // ⭐⭐ DV T2-T0 §SEAM — THE ONE `dvLearnedMap` FORK IN `src/**`. It produces the
    // nullable ledger seat every downstream statement keys off, and it is the whole of
    // this seam's arming: no gene, no probe write, no world state. `null` in every
    // production path.
    //
    // ⚠ THE GENOME VIEWS ARE DE-ALIASED HERE, DELIBERATELY (§DEV 1). `baseGenome` and
    // `effGenome` are the franchise's OWN object until something replaces them, and the
    // learned belief must NOT reach it: `crossoverGenomes` copies a present `dvLossBelief`
    // from parent A even with the `evolveDeliveryValue` opt-in shut, so writing the
    // franchise genome would open the Lamarck channel the contract names as a LATER slice
    // (§4). Learning therefore writes MATCH-LOCAL views only, and dies with the match —
    // the BOOK is what carries across matches, and only a League that armed the door
    // holds one.
    this.dvLearn = this.dvLearnedMap
      ? new DeliveryLabelLedger(
        cfg.dvLearnedBooks ?? [new DeliveryAccountBook(), new DeliveryAccountBook()],
        (side) => this.dvLearnWriteBelief(side),
      )
      : null;
    if (this.dvLearn !== null) {
      for (const team of this.teams) {
        team.baseGenome = { ...team.baseGenome };
        team.effGenome = team.baseGenome;
      }
      // A book carried in from an earlier match of the same season already knows
      // something: the belief it serves is live from the first tick.
      this.dvLearnWriteBelief(0);
      this.dvLearnWriteBelief(1);
    }
    // ⭐⭐ EK T0 §SEAM — THE ONE `ekHoldLearn` FORK IN `src/**`. It produces the nullable
    // ledger seat every downstream statement keys off, and it is the whole of this seam's
    // learning arm: NO gene, NO genome write, NO world state (so there is no Lamarck
    // surface at all — the DV catch inherited as a prohibition, G-NOLAMARCK). `null` in
    // every production path.
    this.ekHold = this.ekHoldLearn
      ? new HoldLabelLedger(cfg.ekHoldBooks ?? [new HoldAccountBook(), new HoldAccountBook()])
      : null;
    // ⭐⭐ L3 T0 §SEAM — THE ONE `l3DefenceLearn` FORK IN `src/**`. It produces the nullable
    // ledger seat every downstream statement keys off, and it is the whole of this seam's
    // learning arm: NO gene, NO genome write, NO serialization (so there is no Lamarck surface
    // at all — G-NOLAMARCK). `null` in every production path.
    this.l3Defence = this.l3DefenceLearn
      ? new LungeLabelLedger(cfg.l3DefenceBooks
        ?? [new DefenceAccountBook(), new DefenceAccountBook()])
      : null;
    // ⭐⭐ PC T0 §SEAM — THE ONE `pcReactionLatency` FORK IN `src/**`. It produces the nullable
    // seat every downstream statement keys off (the detector, the executor's hold gate, the
    // decide-loop AND-gate), and it is the whole of this seam's arming: NO gene, NO genome
    // write, NO serialization (so there is no Lamarck surface at all). `null` in every
    // production path.
    this.pcLatency = this.pcReactionLatency
      ? new PcLatencySeat(
        cfg.pcRecognitionBooks ?? [new PcRecognitionBook(), new PcRecognitionBook()],
        cfg.pcNCover ?? PC_N_COVER,
      )
      : null;
    this.allPlayers = [...this.teams[0].players, ...this.teams[1].players];
    this.allPlayersReversed = [...this.allPlayers].reverse();
    // ⭐⭐ RC T0b §SEAM — the heading memory is BORN ONLY BEHIND THE OPEN DOOR: shut, both
    // slots are `null`, nothing is allocated and `rcReadyPrevHeading` answers `null` forever.
    this.rcReadyPrevH = this.rcReady ? new Float64Array(this.allPlayers.length * 2) : null;
    this.rcReadyCurH = this.rcReady ? new Float64Array(this.allPlayers.length * 2) : null;
    // Roster-indexed stats (Phase 61): bench rows exist from kickoff and
    // stay empty unless their man comes on. Starters are appearances.
    this.playerStats = Array.from({ length: ROSTER_SIZE * 2 }, () => emptyPlayerStats());
    for (const p of this.allPlayers) this.stat(p.gid).apps = 1;
    this.rosterNames = Array.from({ length: ROSTER_SIZE * 2 }, (_, ri) => {
      const side = ri < ROSTER_SIZE ? 0 : 1;
      const info = side === 0 ? cfg.teamA : cfg.teamB;
      return info.playerNames[ri % ROSTER_SIZE] ?? '?';
    });
    // Stagger decision ticks deterministically (symmetric across the teams)
    // so all 12 players don't think in the same frame.
    this.allPlayers.forEach((p) => (p.decisionTimer = ((p.index % TEAM_SIZE) + 1) * (AI_INTERVAL / TEAM_SIZE)));
    this.setupKickoff(0);
    if (this.derby) this.pushEvent('info', -1, '🔥 Derby! Old rivals meet again');
  }

  /**
   * Display minute: sim time scaled onto a 90' clock, held at 45/90 during
   * stoppage (Phase 28.1 — the first half used to tick into "46', 47'" while
   * its added time played out, which read as the second half starting early).
   * The second half's clock restarts from 45' regardless of how much
   * stoppage the first half ran.
   */
  minute(): number {
    if (this.half === 1) {
      return Math.min(45, Math.floor((this.simTime / this.duration) * 90));
    }
    const secondHalf = Math.floor(((this.simTime - this.secondHalfStart) / this.duration) * 90);
    return Math.min(90, 45 + Math.max(0, secondHalf));
  }

  /** Added display-minutes in the current half (0 outside stoppage). */
  addedMinutes(): number {
    const over =
      this.half === 1
        ? this.simTime - this.duration / 2
        : this.simTime - this.secondHalfStart - this.duration / 2;
    if (over <= 0) return 0;
    return Math.max(1, Math.ceil((over / this.duration) * 90));
  }

  /** Scoreboard clock: `37`, `45+2`, `90+1`. */
  clockText(): string {
    const added = this.addedMinutes();
    return added > 0 ? `${this.minute()}+${added}` : `${this.minute()}`;
  }

  pushEvent(type: EventType, side: Side | -1, text: string): void {
    this.events.push({ t: this.simTime, minute: this.minute(), type, side, text });
  }

  /** The stats row for the CURRENT occupant of a pitch slot (Phase 61):
   * gid → whoever's rosterIdx holds the slot right now. */
  stat(gid: number): PlayerMatchStats {
    const p = this.allPlayers[gid];
    return this.playerStats[p.side * ROSTER_SIZE + p.rosterIdx];
  }

  /**
   * A passing move ends (Phase 33): turnover, dead ball, shot or clear.
   * Long chains earn ONE feed line (failure mode 7 — the threshold keeps
   * them rare) and the match best feeds the season's longest-chain record.
   */
  endPassMove(side: Side): void {
    const n = this.passChain[side];
    if (n === 0) return;
    this.passChain[side] = 0;
    const team = this.teams[side];
    if (n > team.stats.bestPassChain) team.stats.bestPassChain = n;
    if (n >= PASS_MOVE_FEED_MIN) {
      this.pushEvent('info', side, `🎼 ${n}-pass move by ${team.info.name}!`);
    }
  }

  /**
   * ⭐⭐ DV T2-T0 §SEAM — THE WRITE PATH (M-DV2.3). The truth-dosing instrument's own
   * write, with the SOURCE swapped from the census artifact to the team's OWN book: the
   * three running frequencies are written into `dvLossBelief` on the match-local gene
   * views, which is what the DV pricer's seat reads.
   *
   * ⭐ AN EMPTY BOOK WRITES NOTHING, so the gene stays ABSENT and the seat stays null —
   * the born-absent semantics carried through arming (G-EMPTY). The exposure weight is
   * NOT touched: it has no truth table and is not learned (contract §M-DV2.4).
   */
  private dvLearnWriteBelief(side: number): void {
    const ledger = this.dvLearn;
    if (ledger === null) return;
    const belief = ledger.books[side]?.beliefVector() ?? null;
    if (belief === null) return;
    const team = this.teams[side];
    for (const g of [team.baseGenome, team.effGenome] as TacticalGenome[]) {
      g.dvLossBelief = [...belief];
    }
  }

  /**
   * ⭐ DV T2-T0 §SEAM — THE OBSERVATION TICK, run at the head of every step so it reads
   * exactly the state the previous step left (which is the point T2-C0's own walker
   * observes, and the reason the clock stamps agree: `simTime` only moves inside the
   * body below).
   *
   * ⚠ EVERYTHING IT READS IS PUBLIC: the phase, who has the ball, the scoreboard and the
   * clock. No percept snapshot, no opponent internals, no artifact.
   */
  private dvLearnObserve(): void {
    const ledger = this.dvLearn;
    if (ledger === null) return;
    // THE PUBLIC SCOREBOARD, in chronological order — a conceded goal is a goal for the
    // other side, which is the only thing either team needs to read off it.
    for (const s of [0, 1] as const) {
      while (this.dvLearnSeenScore[s] < this.score[s]) {
        this.dvLearnSeenScore[s]++;
        ledger.observeConcession(1 - s, this.simTime);
      }
    }
    // THE CHAIN (T2-C0's inherited semantics): a maximal interval of same-team control
    // while the ball is in play, SUSPENDED while it is loose, ended by the opponent
    // establishing control (a LOSS) or by the ball going dead (no loss).
    if (this.phase !== 'playing') ledger.observeDeadBall();
    else {
      const owner = this.ball.owner;
      if (owner !== null) ledger.observeOwner(owner.side, this.simTime);
    }
    // THE WINDOW SWEEP: labels whose window has run out close now, and only now.
    ledger.expire(this.simTime);
  }

  /**
   * ⭐ EK T0 §SEAM — THE HOLD OBSERVATION TICK, run at the head of every step so it reads
   * exactly the state the previous step left — which is where EK-C0's own walker stands
   * (its `segmentTick` runs immediately after `m.step`), and the reason the clock stamps
   * agree: `simTime` only moves inside the body below.
   *
   * ⚠ EVERYTHING IT READS IS PUBLIC: the phase, who has the ball and the clock. No percept
   * snapshot, no opponent internals, no artifact, no scoreboard even.
   */
  private ekHoldObserve(): void {
    const ledger = this.ekHold;
    if (ledger === null) return;
    // THE CHAIN (EK-C0's inherited loss semantics, thence DV-C0): a maximal interval of
    // same-team control while the ball is in play, SUSPENDED while it is loose, ended by
    // the opponent establishing control (a LOSS) or by the ball going dead (no loss).
    if (this.phase !== 'playing') ledger.observeDeadBall();
    else {
      const owner = this.ball.owner;
      if (owner !== null) ledger.observeOwner(owner.side, this.simTime);
    }
    // ⭐ THE TRAINING-GROUND DRILL HOLD (#261.3(iii)): a `forcedHold` commitment is a hold
    // the team really EXPERIENCES, and the commitment is PUBLIC STATE — so it is captured
    // HERE, at the head of the very tick the hold starts, one tick after the decision the
    // seat priced (the brain only re-decides every `AI_INTERVAL`, so capturing it on the
    // C5 hold branch would carry a band up to a decision interval stale). The conditions
    // mirror that branch's own public ones: the C5 door, not a keeper, not sent off, not
    // the restart taker. `forcedHold` is null in every production path.
    const forced = this.forcedHold;
    if (this.c5Hold && forced !== null && this.simTick < forced.untilTick) {
      const body = this.allPlayers.find((p) => p.gid === forced.gid);
      if (body !== undefined && body.role !== 'GK' && !body.sentOff
        && this.restartKickGid !== forced.gid) {
        ledger.noteDrillHold(body.side, forced.gid, forced.untilTick, this.simTick, this.simTime);
      }
    }
    // THE WINDOW SWEEP: labels whose window has run out close now, and only now.
    ledger.expire(this.simTime);
  }

  /**
   * ⭐⭐ EK T0 §SEAM — THE ONE CONSUMPTION SITE (M-EK.3, the #261.3(iv) form). Asked by
   * the whether seat ONLY where the certified table has ALREADY licensed a hold: it can
   * decline that hold, never create one (R-B strict no-subsidy, #64.1).
   *
   * ZERO-CONSTANT: the whole comparison lives in the team's own book (`declinesHold`),
   * and both doors plus a speaking book are required, so an unarmed, unlearned or
   * one-banded world can never reach a `true` (G-EMPTY).
   */
  ekHoldDeclines(side: number, band: number): boolean {
    const ledger = this.ekHold;
    if (!this.ekHoldVeto || ledger === null) return false;
    const book = ledger.books[side];
    if (book === undefined || !book.declinesHold(band)) return false;
    ledger.vetoes++;
    return true;
  }

  /**
   * ⭐ L3 T0 §SEAM — THE DEFENCE OBSERVATION TICK, run at the head of every step so it reads
   * exactly the state the previous step left (the EK/DV sharpening: `simTime` only moves
   * inside the body below, so the stamps agree with the label's own t0).
   *
   * ⚠ EVERYTHING IT READS IS PUBLIC: where two named bodies are standing, and the clock. It
   * closes any label whose COMMON window has run out, on the separation those two bodies show
   * now; a pair it cannot read is CENSORED (out of the denominator, counted — never a zero).
   */
  private l3DefenceObserve(): void {
    const ledger = this.l3Defence;
    if (ledger === null) return;
    // A copy, because closing/censoring mutates the ledger's own open list while we walk it.
    for (const p of [...ledger.open]) {
      if (this.simTime < p.tMiss + L3_DEFENCE_WINDOW_S) continue;
      const taker = this.allPlayers.find((b) => b.gid === p.takerGid);
      const carrier = this.allPlayers.find((b) => b.gid === p.carrierGid);
      if (taker === undefined || carrier === undefined) { ledger.censor(p.key); continue; }
      // ⭐ CARRIER-ANCHORED (#266.2(i)): the anchor is the man he dived at, never the ball.
      ledger.observeSeparation(p.key, dist(taker.pos, carrier.pos), this.simTime);
    }
  }

  /**
   * ⭐⭐ PC T0 §SEAM — THE DETECTOR (M-PC.1). The SEVEN class predicates, reused VERBATIM from
   * PC-C0 §FORM (the census is the source of truth for what counts as each class), evaluated
   * as STATE TRANSITIONS over public engine state against `pcPrev`. It runs at the head of
   * every step, so it reads exactly the state the previous step left.
   *
   * WHO PAYS (#297 item 5): every AFFECTED body — inside `PC_RELEVANCE_M` of the ball at the
   * event tick — EXCEPT the initiator. That single exclusion is what leaves the FIVE initiator
   * paths untouched without this seam ever naming them: `knockAndGo` (mechanics.ts
   * `performTouchPast`), `captureSettle` and `gkFeetOverride` (both in `giveBall`),
   * `oneTouchWindow` and `substitutionArrival` all write their timers for a body who INITIATED
   * his own event, and an initiator is never in his own surprise set. ⭐ H6 is the one
   * exception, and it is a ruling, not an oversight: the SPILLER pays (`PC_INITIATOR_PAYS`).
   *
   * ⭐ H4 (#297 item 4) — THE PRE-PROCESSING CHANNEL, kept as-is: a body inside his
   * `firstTouchWindow` decided BEFORE the ball came (抬头观察 / 提前知道). He is SKIPPED, so the
   * one-touch window keeps making a pressed receiver fast and this law never fights it. The
   * composition is doctrine-correct: pre-processed = fast, surprised = slow.
   *
   * ⭐ H5: the ordinary-push author is simply the `dribblePush` initiator ⇒ excluded ⇒ he keeps
   * today's cadence exactly. Nothing here grants him anything.
   * ⭐ H3: the hold is a property of the BODY. `TeamBrain` is untouched; a mid-hold reassignment
   * rewrites his action on paper and his executor keeps the stale target regardless.
   *
   * Dormant: the seat is null in every production path, so this method is unreachable there.
   */
  /**
   * ⭐⭐ RC T0b §SEAM — THE HEADING MEMORY'S ONE WRITE, and the whole of this seam's state.
   *
   * Runs at the HEAD of `step()` (the house observe-hook idiom, beside dv/ek/l3/pc), BEFORE
   * `stepCount++` and before any brain runs, so it sees the state the PREVIOUS step left:
   * `cur` is loaded with h[t−1] and whatever `cur` held (h[t−2]) is shifted into `prev`. A
   * brain deciding later in step *t* therefore reads the PAIR (h[t−2], h[t−1]) — RC-C0b's own
   * consecutive-heading pair for tick t−1, since the census read state at the END of each
   * step. On the first two steps `prev` is still the zero vector, whose length is 0, so the
   * angular speed is not finite and the cell is NONE — the census's own degenerate rule.
   *
   * ⛔ NOT a `Player` field: the store belongs to the match and exists only when the door is
   * open, so no shipped byte moves.
   *
   * Dormant: `rcReady` is false in every production path, so this method is unreachable there.
   */
  private rcReadyObserve(): void {
    const prev = this.rcReadyPrevH;
    const cur = this.rcReadyCurH;
    if (prev === null || cur === null) return;
    for (const p of this.allPlayers) {
      const i = p.gid * 2;
      prev[i] = cur[i];
      prev[i + 1] = cur[i + 1];
      cur[i] = p.heading.x;
      cur[i + 1] = p.heading.y;
    }
  }

  /**
   * ⭐ RC T0b §SEAM — the READ half of the memory: the heading this body carried at the end of
   * the step BEFORE last, or `null` when the door is shut (the shipped answer, always).
   */
  rcReadyPrevHeading(gid: number): { x: number; y: number } | null {
    const prev = this.rcReadyPrevH;
    if (prev === null) return null;
    return { x: prev[gid * 2], y: prev[gid * 2 + 1] };
  }

  private pcLatencyObserve(): void {
    const seat = this.pcLatency;
    if (seat === null) return;
    const players = this.allPlayers;
    const ownerGid = this.ball.owner?.gid ?? null;
    const lastTouchGid = this.ball.lastTouch?.gid ?? null;
    const touchPasts = this.cbLedger.touchPasts;
    const dribbleTouchGid = this.dribbleTouch?.gid ?? null;
    const dribbleTouchKey = this.dribbleTouch === null ? null
      : `${this.dribbleTouch.gid}:${this.dribbleTouch.until}`;
    const pendingPassT = this.pendingPass?.t ?? null;
    const pendingShot = this.pendingShot !== null;
    const prev = this.pcPrev;
    const fired: { klass: PcClass; initiatorGid: number | null }[] = [];
    // ⭐ THE PRE-EXAM AMENDMENT (b) (#298 item 4): "a restart voids the surprise's context —
    // closes the clock-skew class". Any step that is NOT live-play-to-live-play is a dead-ball
    // transition (into a stoppage, through one, or back out of it at the restart) and it WIPES
    // every live hold. This is the exact complement of the firing condition below, so the two
    // halves of the phase rule are read from one place and cannot drift apart.
    if (prev !== null && !(prev.phase === 'playing' && this.phase === 'playing')
      && seat.liveHolds > 0) {
      seat.clearHoldsAtDeadBall(this.stepCount);
    }
    if (prev !== null && prev.phase === 'playing' && this.phase === 'playing') {
      if (touchPasts > prev.touchPasts) {
        fired.push({ klass: 'knockRelease', initiatorGid: lastTouchGid });
      } else if (dribbleTouchKey !== null && dribbleTouchKey !== prev.dribbleTouchKey) {
        fired.push({ klass: 'dribblePush', initiatorGid: lastTouchGid });
      }
      if (pendingPassT !== null && pendingPassT !== prev.pendingPassT) {
        fired.push({ klass: 'passRelease', initiatorGid: this.pendingPass?.passerGid ?? lastTouchGid });
      }
      if (pendingShot && !prev.pendingShot) {
        fired.push({ klass: 'shotRelease', initiatorGid: lastTouchGid });
      }
      if (ownerGid !== null && ownerGid !== prev.ownerGid) {
        const prevSide = prev.lastKnownOwnerGid === null
          ? null : players[prev.lastKnownOwnerGid].side;
        if (prevSide !== null && players[ownerGid].side !== prevSide) {
          fired.push({ klass: 'turnover', initiatorGid: ownerGid });
        }
      }
      if (ownerGid === null && prev.ownerGid === null && lastTouchGid !== prev.lastTouchGid
        && lastTouchGid !== null) {
        const a = Math.hypot(prev.ballVx, prev.ballVy);
        const b = Math.hypot(this.ball.vel.x, this.ball.vel.y);
        const cosT = a > 1e-6 && b > 1e-6
          ? (prev.ballVx * this.ball.vel.x + prev.ballVy * this.ball.vel.y) / (a * b) : 1;
        if (Math.acos(Math.max(-1, Math.min(1, cosT))) > 0.2) {
          fired.push({ klass: 'deflection', initiatorGid: lastTouchGid });
        }
      }
      if (prev.ownerGid !== null && ownerGid === null && pendingPassT === prev.pendingPassT
        && !pendingShot && dribbleTouchGid === null) {
        fired.push({ klass: 'looseBallSpill', initiatorGid: prev.ownerGid });
      }
    }

    if (fired.length > 0) {
      // ⭐ THE PRIORITY PASS (#297 item 5, turnover first-class): a body surprised by several
      // classes on one tick pays for exactly ONE of them — the earliest in `PC_CLASSES`. The
      // winner is chosen per BODY, so two simultaneous events can hold two different bodies at
      // two different tiers, which is what "the hold is a property of the body" means.
      // ⭐ RC T0: the winner record additionally carries the EVENT's `initiatorGid` — the
      // passer, on a `passRelease` — because the pre-cue's cue is read off HIS body. Additive:
      // every other field, and the whole priority pass below, is untouched.
      const winner = new Map<number, {
        klass: PcClass; pressed: boolean; rel: PcRelation; initiatorGid: number | null;
      }>();
      for (const ev of fired) {
        seat.ledger.firings[ev.klass]++;
        const initiator = ev.initiatorGid === null ? null : players[ev.initiatorGid];
        // The PRESSED bit of the EVENT — PC-C0's own split, verbatim: an opponent of the
        // initiator inside the engine's own `TOUCH_CONTROL_DIST` of the ball at the event tick.
        let nearestOpp = Infinity;
        if (initiator !== null) {
          for (const o of this.teams[1 - initiator.side].players) {
            if (o.sentOff) continue;
            const d = Math.hypot(o.pos.x - this.ball.pos.x, o.pos.y - this.ball.pos.y);
            if (d < nearestOpp) nearestOpp = d;
          }
        }
        const pressed = nearestOpp <= TOUCH_CONTROL_DIST;
        const initiatorPays = PC_INITIATOR_PAYS[ev.klass];
        for (const p of players) {
          if (p.sentOff) continue;
          if (initiator !== null && p.gid === initiator.gid && !initiatorPays) continue;
          const d = Math.hypot(p.pos.x - this.ball.pos.x, p.pos.y - this.ball.pos.y);
          if (d > PC_RELEVANCE_M) continue;
          // ⭐ H4 — the PRE-PROCESSING channel: he decided before the ball came.
          // ⭐ THE PRE-EXAM AMENDMENT (c) (#298 item 4): this filter now sits AFTER the
          // relevance radius, on PC-C0's own census grain (sentOff → initiator → distance),
          // so `preProcessedSkips` counts the bodies who WOULD OTHERWISE HAVE BEEN ARMED
          // instead of every pre-processed body anywhere on the pitch. The ARMED SET IS
          // UNCHANGED by the reorder — both filters are bare `continue`s over the same body.
          if (p.firstTouchWindow > 0) { seat.ledger.preProcessedSkips++; continue; }
          const rel: PcRelation = initiator === null
            ? 'opp' : (p.side === initiator.side ? 'own' : 'opp');
          const cur = winner.get(p.gid);
          if (cur === undefined || PC_CLASS_RANK[ev.klass] < PC_CLASS_RANK[cur.klass]) {
            winner.set(p.gid, { klass: ev.klass, pressed, rel, initiatorGid: ev.initiatorGid });
          }
        }
      }
      // ⭐ RC T0 §SEAM — the mate population is a property of the EVENT's initiator, so it is
      // built ONCE per initiator and shared by every body he surprised (the arming order and
      // the armed set are unchanged by the cache; it is memoisation, not a rule).
      const rcMates = new Map<number, { gid: number; x: number; y: number }[]>();
      // ⭐ gid-ORDERED, so the arming order is a deterministic function of the event stream.
      for (const gid of [...winner.keys()].sort((a, b) => a - b)) {
        const w = winner.get(gid) as {
          klass: PcClass; pressed: boolean; rel: PcRelation; initiatorGid: number | null;
        };
        const p = players[gid];
        const key = pcRecognitionKey(w.klass, w.pressed, w.rel);
        const side = p.side as 0 | 1;
        // ⭐⭐ RC T0 §SEAM — THE ONE PRE-CUE READ (M-RC.3a / M-PC.1b), and the WHOLE of this
        // seam's live read set: the initiator's `pos` + `heading` (external body state), each
        // mate's `pos` / `gid` / `side` / `sentOff` (external), the arming body's `gid`, and
        // the team's own anticipation gene. ⛔ NOT `pendingPassWindup`, NOT `faceTarget`, NOT
        // `pendingPass`, NOT a TeamBrain designation, NOT `info.genome` — the seat could not
        // read them if it wanted to (its import list is closed), and this call site does not
        // hand them over. The pin suite pins THIS argument list as the read set (#367 item
        // 3(iv); RC-C0 §CORRECTIONS item 4).
        // ⚠ DECLARED DRIFT: the detector runs at the HEAD of the step, so the passer's heading
        // is read at the END of the release tick — his `faceTarget` was released at the strike
        // and his body may have integrated ≤ 1 tick (≤ TURN_RATE·DT rad) past the last
        // pre-release tick RC-C0 measured. Stated in the stage doc §4, not hidden.
        let preCue: { belief: number; weight: number } | null = null;
        if (this.rcAnticipate && w.klass === 'passRelease' && w.rel === 'own'
          && w.initiatorGid !== null) {
          const initiator = players[w.initiatorGid] as Player | undefined;
          const weight = rcAnticipationWeightOf(this.teams[side].effGenome);
          if (initiator !== undefined && weight !== null) {
            let mates = rcMates.get(w.initiatorGid);
            if (mates === undefined) {
              mates = [];
              for (const q of players) {
                if (q.gid === initiator.gid || q.side !== initiator.side || q.sentOff) continue;
                mates.push({ gid: q.gid, x: q.pos.x, y: q.pos.y });
              }
              rcMates.set(w.initiatorGid, mates);
            }
            const rank = alignmentRank(
              initiator.pos.x, initiator.pos.y, initiator.heading.x, initiator.heading.y,
              mates, p.gid,
            );
            preCue = { belief: rcBeliefForRank(rank), weight };
          }
        }
        // TIER FIRST, THEN THE EXPOSURE (M-PC.3): the surprise he is paying for now must not
        // make itself recognised.
        seat.arm(gid, p.rosterIdx, side, w.klass, key, this.stepCount, preCue);
        seat.noteExposure(p.rosterIdx, side, key);
      }
    }

    this.pcPrev = {
      ownerGid,
      lastKnownOwnerGid: ownerGid ?? prev?.lastKnownOwnerGid ?? null,
      touchPasts,
      dribbleTouchKey,
      pendingPassT,
      pendingShot,
      lastTouchGid,
      ballVx: this.ball.vel.x,
      ballVy: this.ball.vel.y,
      phase: this.phase,
    };
  }

  /**
   * ⭐ L3 T0 §SEAM — THE ONE INDEX READ (M-L3.1). The lunger's OWN arrival speed at his own
   * decision tick, placed on the ruled g2 grain; `-1` when there is no seat at all, which is
   * every production path. Read ONCE per lunge decision and shared by the veto and the label,
   * so the two consumers can never disagree about which group an event came from (#256.2).
   */
  l3DefenceGroup(taker: Player): number {
    if (this.l3Defence === null) return -1;
    return arrivalGroup(len(taker.vel));
  }

  /**
   * ⭐⭐ L3 T0 §SEAM — THE ONE CONSUMPTION SITE (M-L3.3). Asked at the lunge gate ONLY where
   * the engine's own gates have ALREADY licensed the challenge: it can decline that lunge,
   * never throw one they refused (R-B strict no-subsidy, #64.1) — DECLINE-ONLY.
   *
   * ZERO-CONSTANT: the whole comparison lives in the team's own book (`declinesLunge`), and
   * both doors plus a speaking, cross-group book are required, so an unarmed, unlearned or
   * one-grouped world can never reach a `true` (gZero).
   */
  l3DefenceDeclines(side: number, group: number): boolean {
    const ledger = this.l3Defence;
    if (!this.l3DefenceVeto || ledger === null) return false;
    const book = ledger.books[side];
    if (book === undefined || !book.declinesLunge(group)) return false;
    ledger.vetoes++;
    return true;
  }

  /**
   * L3 T0 §SEAM — THE FIRED METER (a read, never a book cell): every lunge the engine actually
   * threw, by group.
   *
   * ⚠ #280.2(ii): it is NOT a decline-only proof. The frozen count proxy ("an armed arm may
   * never fire more lunges than the learn-only arm") is FALSIFIED of record — a declined lunge
   * changes the future (the body keeps his legs, his cooldown and his position), so the armed
   * world can contain MORE lunge opportunities later while every individual decision was
   * decline-only. DECLINE-ONLY IS PROVEN STRUCTURALLY: by POSITION (the one veto site sits in
   * series strictly between the untouched jockey gate and the line that commits the body, and
   * its consequent is a bare early `return`) and by the DOSE-DIRECTION test (doctored books in
   * both directions never make a lunge more likely) — never by arm counts.
   */
  l3DefenceNoteFired(group: number): void {
    if (this.l3Defence === null) return;
    this.l3Defence.noteFired(group);
  }

  /**
   * ⭐ L3 T0 §SEAM — THE LABEL CAPTURE (M-L3.1). Called from the duel's own MISS branch with
   * the body that lunged and the CARRIER he dived at; the carrier-anchored separation at t0 is
   * read HERE (the ledger owns no geometry). A won lunge and a withheld challenge reach this
   * method never — only a miss carries a label.
   */
  l3DefenceNoteMiss(taker: Player, carrier: Player, group: number): void {
    const ledger = this.l3Defence;
    if (ledger === null) return;
    ledger.noteMiss(
      taker.side, group, this.simTime, taker.gid, carrier.gid, dist(taker.pos, carrier.pos),
    );
  }

  step(dt: number): void {
    if (this.finished) return;
    if (this.dvLearn !== null) this.dvLearnObserve();
    if (this.ekHold !== null) this.ekHoldObserve();
    if (this.l3Defence !== null) this.l3DefenceObserve();
    // ⭐⭐ PC T0 §SEAM — THE DETECTOR, the house observe-hook idiom (dv/ek/l3 above). It runs
    // BEFORE `stepCount++`, so it sees the state the PREVIOUS step left and arms holds that
    // bite from the very next executor call — the census's own k = 1 grain. Dormant: the seat
    // is null in every production path.
    if (this.pcLatency !== null) this.pcLatencyObserve();
    // ⭐⭐ RC T0b §SEAM — THE HEADING MEMORY'S SHIFT, the same observe-hook position and for
    // the same reason: it must see the state the PREVIOUS step left, before any brain decides.
    // Dormant: the door is shut in every production path.
    if (this.rcReady) this.rcReadyObserve();
    this.stepCount++;
    // ⭐ PW T0c (#293.3 (c)) — THE STALE-DEPOSIT SWEEP. A chosen weight is deposited and consumed
    // inside ONE tick (the strike, or the wind-up's arm-time capture). Anything still sitting
    // here at a tick boundary was consumed by nobody: it is COUNTED as abandoned and cleared,
    // so "the chooser chose but nothing struck" is a number instead of a silence. Dormant: the
    // slot is null in every production path.
    if (this.pwWeightChooser && this.pwStrikePower !== null) {
      if (this.pwStrikePower.power !== 1) this.pwChooserLedger.depositsAbandoned++;
      this.pwStrikePower = null;
    }
    this.possessionPhase = { kind: 'deadBall' }; // S0 default; the playing path overwrites it below
    // Hard safety net: even a wedged state machine terminates deterministically.
    if (this.stepCount * dt > this.duration * 4) {
      this.endMatch();
      return;
    }

    if (this.phase === 'kickoff' || this.phase === 'goalPause' || this.phase === 'halftime') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        if (this.phase === 'kickoff') this.phase = 'playing';
        else if (this.phase === 'goalPause') this.setupKickoff(this.kickoffSide);
        else {
          this.half = 2;
          this.secondHalfStart = this.simTime;
          this.setupKickoff(1);
        }
      }
      this.possessionPhase = this.computePossessionPhase(); // covers the kickoff→playing flip tick
      return;
    }
    if (this.phase === 'fulltime') return;

    // ---- playing or restart (a restart is live: clock runs, players move) ----
    this.simTime += dt;

    // C7 T1 §SEAM: a shot wind-up that has reached readyTick strikes here, at the
    // head of the tick (before brains/physics), the release-side analogue of the
    // synchronous commit-line strike. No-op unless c7Windup is armed (Road B).
    if (this.pendingKick !== null) this.resolvePendingKick();

    // O1 T1 §SEAM: a shortPass wind-up that has reached readyTick releases here, at
    // the same head-of-tick site as the C7 strike. No-op unless o1PassWindup is
    // armed (Road B ⇒ pendingPassWindup is null in every production path).
    if (this.pendingPassWindup !== null) this.resolvePendingPassWindup();

    // O2 T0 §SEAM: the LOOK window advances here — one recorded scan moment per
    // look tick, and the window's own expiry/abort — at the same head-of-tick site
    // as the two wind-up resolves, BEFORE any brain runs, so a body whose window
    // ended this tick decides freely on the refreshed percept. No-op unless
    // `o2Look` is armed (Road B ⇒ `o2LookWindow` is null in every production path).
    if (this.o2LookWindow !== null) this.stepO2Look();

    const _tBrain = prof.mark();
    for (const team of this.teams) {
      team.brainTimer -= dt;
      team.modeTime += dt;
      if (team.brainTimer <= 0) {
        // Game-state mentality (Phase 35): the gene view every brain and
        // mechanic reads is recomputed here — pure fn of score + clock +
        // (Phase 66) the coach's tinkerBias, which scales how HARD he
        // responds. Read from the RAW genome: personality isn't bent by
        // the underdog shift.
        const diff = this.score[team.side] - this.score[1 - team.side];
        team.mentality = mentalityOf(diff, this.minute(), team.info.genome.tinkerBias ?? 0.5);
        team.effGenome = applyMentality(team.baseGenome, team.mentality);
        // The visible switches earn ONE feed line each (failure mode 7) —
        // the COACH's calls since Phase 66 (N3). A stoic (tinker→0) never
        // crosses 0.8 at all: his silence is the personality showing.
        const coach = team.info.coachName;
        if (team.mentality.urgency > 0.8 && !team.surgeAnnounced) {
          team.surgeAnnounced = true;
          this.pushEvent('info', team.side, coach
            ? `⚡ ${coach} throws everyone forward!`
            : `⚡ ${team.info.name} throw everyone forward!`);
        }
        if (team.mentality.holding > 0.8 && !team.shutdownAnnounced) {
          team.shutdownAnnounced = true;
          this.pushEvent('info', team.side, coach
            ? `🧊 ${coach} shuts up shop`
            : `🧊 ${team.info.name} shut up shop`);
        }
        updateTeamBrain(team, this);
        team.brainTimer = TEAM_AI_INTERVAL;
      }
    }

    // FAIRNESS: within a frame, later-iterated players act on fresher state
    // (they see earlier kicks and reactions). Measured effect: the team
    // iterated second converted ~10pp more of its shots. Alternating the
    // iteration direction every step cancels the asymmetry, deterministically.
    prof.add('teamBrain', _tBrain);
    const _tDecide = prof.mark();
    const order = this.stepCount % 2 === 0 ? this.allPlayers : this.allPlayersReversed;
    for (const p of order) {
      if (p.sentOff) continue;
      // ⭐⭐ PC T0 (M-PC.2) — THE DECIDE-LOOP AND-GATE. A latency timer holds the DECISION layer
      // as well as the steering: a surprised body does not reach his next slot until he has
      // finished processing. `decisionTimer` is NOT re-armed while he is held, so he decides on
      // the first tick after expiry — the hold ADDS to the world's own cadence rather than
      // replacing it (the #297 item 5 ADDITIVITY binding). Dormant: with the seat null this
      // conjunct is a constant `true` and the loop is byte-identical.
      const pcHeld = p.decisionTimer <= 0 && this.pcLatency !== null
        && this.pcLatency.holdFor(p.gid, this.stepCount) !== null;
      if (pcHeld) (this.pcLatency as PcLatencySeat).ledger.decisionsHeld++;
      if (p.decisionTimer <= 0 && !pcHeld) {
        // E2b-1: this body's percept is refreshed exactly when it thinks, so
        // perception costs one build per decision rather than one per tick.
        // E3: EITHER consumer needs the chain alive — the defender's ball read
        // or the passer's choice. Gating this on the defence flag alone made
        // `edsPerceivedChoice` silently inert on its own (no memory ⇒ no
        // snapshot ⇒ the legacy chooser), which the §4 ablation caught.
        // P2: the dormant eye is a third consumer of the same chain — without
        // a memory it would have no snapshot and would abstain on every
        // decision, which is the "treatment never delivered" failure P1 died
        // of. Null in production, so the shipped world is untouched.
        if (this.edsPerceivedDefence || this.edsPerceivedChoice || this.stationEye !== null) {
          this.refreshPerception(p);
        }
        decidePlayer(p, this);
        p.decisionTimer = AI_INTERVAL;
      }
    }
    // C5 T0: hold the forced action BETWEEN decisions. The capture path
    // re-labels a carrier `Dribble` directly (see `giveBall`), and the brain
    // only re-decides every AI_INTERVAL — so without this a forced holder
    // spent part of each interval labelled `Dribble`, and `stepBall`'s push
    // gate (v > 2.5) knocked his own ball away. That inverted the whole
    // pressure curve: an UNPRESSED holder was free to accelerate past the
    // gate, so survival ROSE with pressure. Structural, not a tuned speed:
    // the executor and the push gate now always read the same action.
    // Both operands are dormant in production (`forcedHold` is never set).
    if (this.c5Hold && this.forcedHold !== null && this.simTick < this.forcedHold.untilTick) {
      const held = this.allPlayers.find((p) => p.gid === this.forcedHold!.gid);
      if (held !== undefined && this.ball.owner === held && held.role !== 'GK') {
        if (held.action.type !== 'ShieldHold') {
          held.action = { type: 'ShieldHold', scores: held.action.scores };
        }
      }
    }
    // C5 T2: hold a WHETHER-committed body BETWEEN decisions, exactly as the
    // forced-hold maintenance above (the same push-gate reason). The commitment
    // lapses at `untilTick`, or if the body loses the ball or play stops. Both
    // operands are dormant in production (`whetherEye` is never set), so the map
    // is always empty and this block never runs in the shipped game.
    if (this.whetherEye !== null && this.whetherHoldState.size > 0) {
      for (const [gid, commitment] of this.whetherHoldState) {
        if (this.simTick >= commitment.untilTick) { this.whetherHoldState.delete(gid); continue; }
        const held = this.allPlayers.find((p) => p.gid === gid);
        if (held === undefined || this.ball.owner !== held || held.role === 'GK'
          || this.phase !== 'playing') {
          this.whetherHoldState.delete(gid);
          continue;
        }
        if (held.action.type !== 'ShieldHold') {
          held.action = { type: 'ShieldHold', scores: held.action.scores };
        }
      }
    }

    prof.add('decide', _tDecide);
    const _tExec = prof.mark();
    for (const p of order) {
      if (!p.sentOff) executeAction(p, this, dt);
    }
    prof.add('execute', _tExec);
    const _tPhys = prof.mark();
    for (const p of order) {
      if (!p.sentOff) p.physicsStep(dt);
    }
    this.resolveOverlaps();
    this.clampPlayersToPitch();
    prof.add('physics', _tPhys);
    const _tBall = prof.mark();
    // Kick protection (Phase 31.9): the clearance circle must survive the
    // hand-off — the restart clears ~0.2–0.5s before the taker's kick, and
    // in that gap defenders rushed the taker, so the launch (its first
    // ~2-3m fly at leg height, inside the deflect window) got blocked at
    // the boot. Corners were the loudest victim: probed deliveries left at
    // 19 m/s and were crawling at 8 m/s within metres of the flag. Real
    // law: opponents keep their distance until the ball is IN PLAY.
    if (this.fkWall && this.fkWall.until !== null && this.simTime > this.fkWall.until) {
      this.fkWall = null; // the ball has cleared the wall — break for the marks
    }
    if (this.restartKickGid !== null && this.restartKickKind !== null && this.restartKickKind !== 'penalty') {
      const taker = this.allPlayers[this.restartKickGid];
      const kickClear = this.restartKickKind === 'corner' || this.restartKickKind === 'freeKick' ? CORNER_CLEARANCE : RESTART_CLEARANCE;
      for (const o of this.teams[1 - taker.side].players) {
        if (o.sentOff) continue;
        if (this.fkWall?.gids.includes(o.gid)) continue; // the wall IS the clearance (Phase 32)
        const d = dist(o.pos, this.ball.pos);
        if (d < kickClear) {
          const dir = d < 1e-6 ? v2(-this.teams[taker.side].attackDir, 0) : norm(sub(o.pos, this.ball.pos));
          o.pos = add(this.ball.pos, scale(dir, kickClear));
          o.pos.x = Math.max(-HALF_L + 0.3, Math.min(HALF_L - 0.3, o.pos.x));
          o.pos.y = Math.max(-HALF_W + 0.3, Math.min(HALF_W - 0.3, o.pos.y));
          o.vel.x *= 0.2;
          o.vel.y *= 0.2;
        }
      }
    }
    // ⭐⭐ GK T0b §M-GK.3′ (b) — THE LOSS-OF-OWNERSHIP RELEASE (contract
    // GK-KEEPER-BODY-CONTRACT.md §2 M-GK.3′; ruling #399 item 3(ii)). A `caught` contact is
    // a claim on a ball the keeper OWNS; the moment he stops owning it — he kicks or throws
    // it, an opponent takes it, a dead ball is called, `giveBall` hands it to another body —
    // the claim is void and the hands are forgotten.
    //
    // ⭐ WHY ONE SWEEP AND NOT A CLEAR AT EVERY ASSIGNMENT SITE: `ball.owner` is assigned by
    // TWELVE statements across `Match.ts` (7), `mechanics.ts` (4) and `Ball.ts` (1) — this
    // engine has NO single ownership funnel (`giveBall` is one entry, `kickBall` another, the
    // dead-ball resets a third), so a per-site clear would be twelve new statements in three
    // files, one of them outside the seam's five. ONE sweep, HERE, is exact for what the law
    // needs: it runs after the tick's brains, executors and physics and IMMEDIATELY BEFORE
    // the ball is placed, so the tick on which the keeper loses the ball is already a tick on
    // which the ball is where the ENGINE puts it — struck, loose or dead — never at the hands.
    //
    // ⭐⭐ GK-T0c (ruling #400 item 3): the sweep clears a loss that PERSISTS to the sweep. An
    // intra-step LOSE-AND-REGAIN presents the same owner here, so the third release lives at
    // the GAIN — `giveBall`, the engine's only non-null owner assignment in play.
    //
    // ⛔ ONLY `caught` CONTACTS: a PARRY contact is steer-only and never had an owner, so
    // ownership says nothing about it — it ends with the sprite's window in `physicsStep`.
    //
    // Flag off ⇒ one boolean test, no loop, no assignment.
    if (this.gkDiveBody) {
      for (const t of this.teams) {
        for (const q of t.players) {
          if (q.saveContact !== null && q.saveContact.caught && this.ball.owner !== q) {
            q.saveContact = null;
          }
        }
      }
    }
    if (this.phase === 'restart') this.stepRestart(dt);
    else this.stepBall(dt);
    prof.add('ball', _tBall);
    const _tBook = prof.mark();

    // Possession only accrues in open play — restarts are dead-ball time,
    // so the calibrate "ball-in-play share" stays an honest metric.
    if (this.phase === 'playing' && this.possessionSide !== -1) {
      const holder = this.teams[this.possessionSide];
      holder.stats.possessionTime += dt;
      // Territory clock (Phase 27): the high-water mark only counts as beaten
      // by a real gain (+1.5m); after a retreat it erodes toward the ball so
      // re-won ground counts again. Holding station just ages the possession.
      const lx = holder.localX(this.ball.pos.x);
      if (lx > holder.progressLocalX + 1.5) {
        holder.progressLocalX = lx;
        holder.staleTime = 0;
      } else {
        holder.progressLocalX = Math.max(lx, holder.progressLocalX - 0.35 * dt);
        holder.staleTime += dt;
      }
    }

    this.trackAttackEntry();

    // Stale in-flight bookkeeping expires.
    if (this.pendingPass && this.simTime - this.pendingPass.t > 3.5) this.pendingPass = null;
    if (this.dribbleTouch && this.simTime > this.dribbleTouch.until) this.dribbleTouch = null;
    if (this.pendingShot && this.simTime - this.pendingShot.t > 3.0) {
      this.markShotOutcome('miss');
      this.pendingShot = null;
    }

    // Each half runs its own nominal length + its own stoppage (28.1) —
    // first-half added time no longer eats into the second half.
    if (this.half === 1 && this.simTime >= this.duration / 2) {
      if (this.refBlowsNow(this.duration / 2)) {
        this.endPassMove(0);
        this.endPassMove(1);
        this.phase = 'halftime';
        this.phaseTimer = 1.2;
        this.stoppageAnnounced = false;
        this.pushEvent('halftime', -1, 'Half-time');
        // The break is the classic substitution window (Phase 61); the
        // second-half kickoff will place the entrant into formation.
        this.trySubstitution(0);
        this.trySubstitution(1);
      }
    } else if (this.half === 2 && this.simTime >= this.secondHalfStart + this.duration / 2) {
      if (this.refBlowsNow(this.secondHalfStart + this.duration / 2)) this.endMatch();
    }
    this.possessionPhase = this.computePossessionPhase();
    prof.add('book', _tBook);
    prof.stepDone();
  }

  /** S0: classify the current possession phase — pure fn of live state, no RNG, no writes. */
  private computePossessionPhase(): PossessionPhase {
    if (this.phase !== 'playing') return { kind: 'deadBall' };
    const o = this.ball.owner;
    if (o) return { kind: 'controlled', side: o.side, gid: o.gid };
    const r2 = CONTEST_RADIUS * CONTEST_RADIUS;
    const near: [number, number] = [0, 0];
    let bestSide: Side | -1 = -1;
    let bestD2 = Infinity;
    for (const p of this.allPlayers) {
      if (p.sentOff) continue;
      const dx = p.pos.x - this.ball.pos.x;
      const dy = p.pos.y - this.ball.pos.y;
      const d2 = dx * dx + dy * dy; // squared — avoids a per-tick sqrt on the hot path
      if (d2 < r2) near[p.side]++;
      if (d2 < bestD2) { bestD2 = d2; bestSide = p.side; }
    }
    if (near[0] > 0 && near[1] > 0) return { kind: 'contested', near };
    return { kind: 'loose', likelyFirst: bestSide };
  }

  /**
   * Stoppage time (Phase 27.4): the half doesn't cut off mid-move. The
   * whistle waits for a safe break — no shot or pass in flight, no attack
   * into the final third, and a penalty must always be taken — up to
   * STOPPAGE_MAX seconds past the nominal end.
   */
  private refBlowsNow(nominal: number): boolean {
    // The whistle never blows a set piece AWAY (Phase 35 + the reported
    // danger-band cuts): an awarded penalty, corner, or walled free kick is
    // PLAYED — this is what makes the 90'+ keeper-up corner possible at
    // all. Bounded: restarts timeout, shots resolve in ~2s, and the
    // duration×4 safety net in step() is absolute.
    const setPiece =
      this.phase === 'restart' &&
      (this.restart!.kind === 'penalty' ||
        this.restart!.kind === 'corner' ||
        (this.restart!.kind === 'freeKick' && this.fkWall !== null));
    if (this.simTime >= nominal + STOPPAGE_MAX) {
      // Patience over: a ball IN FLIGHT or a live set piece still holds it
      // (the corner that waited for the keeper must land, or the theater
      // is cut at its climax). No keep-ball exploit: pendingPass clears on
      // every reception, and the whistle takes the gap between passes.
      return !(this.pendingShot !== null || this.pendingPass !== null || setPiece);
    }
    let holdOn = false;
    if (this.pendingShot || this.pendingPass) holdOn = true;
    else if (this.phase === 'restart') holdOn = setPiece;
    else if (this.possessionSide !== -1) {
      const t = this.teams[this.possessionSide];
      holdOn = t.localX(this.ball.pos.x) > 12; // live attack plays out
    }
    if (holdOn && !this.stoppageAnnounced) {
      this.stoppageAnnounced = true;
      this.pushEvent('info', -1, 'Stoppage time — the attack plays out');
    }
    return !holdOn;
  }

  /** Run the rest of the match headless. Same trajectory as watching it. */
  runToCompletion(): MatchResult {
    while (!this.finished) this.step(DT);
    return this.getResult();
  }

  getResult(): MatchResult {
    return {
      score: [this.score[0], this.score[1]],
      stats: [this.teams[0].stats, this.teams[1].stats],
      playerStats: this.playerStats,
      injuries: this.injuriesOut,
      events: this.events,
      duration: this.duration,
    };
  }

  /* ---------------- kicks (delegated to mechanics) ---------------- */

  shotQuality(p: Player): number {
    return mech.shotQuality(this, p);
  }
  /** `powerChoice` is C1-A's dormant weight input; every live caller omits it. */
  performPass(
    p: Player, mate: Player, offsideExempt = false, powerChoice = 1,
    ptpLead: Readonly<V2> | null = null,
  ): void {
    // ⭐ DV T2-T0 §SEAM — THE DELIVERY CAPTURE, the T2-C0 census's own idiom made
    // in-world: a strike is counted ONLY when the engine's own `lastPassKind` object is
    // replaced by the call, i.e. when the shipped guard actually let the kick through —
    // the ENGINE's truth, never a re-implemented guard. The family is the ground-pass
    // family the DV seam prices (DV-T0 §SEAM's scope note); the index is the AIM zone in
    // the passing team's own frame, through the SHIPPED `receptionZoneIndex`. The seat is
    // null in every production path, so this reads one field and delegates.
    const dvBefore = this.dvLearn === null ? null : this.lastPassKind;
    // ⭐⭐ PW T0b §SEAM — THE ONE CONSUMPTION SITE. The chooser's deposit replaces the shipped
    // literal weight for the body that chose it, at the tick it chose it, and is consumed here
    // so one choice is exactly one strike. `pwStrikePower` is null in every production path, so
    // this reads one field and delegates with the incumbent `powerChoice` verbatim.
    const pw = this.pwStrikePower;
    let struckPower = powerChoice;
    if (this.pwWeightChooser && pw !== null && pw.gid === p.gid && pw.tick === this.simTick) {
      struckPower = pw.power;
      this.pwStrikePower = null;
      if (struckPower !== 1) this.pwChooserLedger.struckAtChosenPower++;
    }
    mech.performPass(this, p, mate, offsideExempt, struckPower, ptpLead);
    if (this.dvLearn !== null && this.lastPassKind !== dvBefore) {
      this.dvLearn.noteDelivery(
        p.side, receptionZoneIndex(this.teams[p.side].localX(mate.pos.x)), this.simTime,
      );
    }
  }
  performThroughBall(p: Player, runner: Player, lofted = false, offsideExempt = false): void {
    mech.performThroughBall(this, p, runner, lofted, offsideExempt);
  }
  performCross(p: Player, target: Player, offsideExempt = false, pull = 0.18, at?: V2): void {
    mech.performCross(this, p, target, offsideExempt, pull, at);
  }
  performKeeperThrow(p: Player, mate: Player): void {
    mech.performKeeperThrow(this, p, mate);
  }
  performLoftedPass(p: Player, mate: Player, offsideExempt = false): void {
    mech.performLoftedPass(this, p, mate, offsideExempt);
  }
  performShot(p: Player): void {
    mech.performShot(this, p);
  }

  performCutback(p: Player, mate: Player): void {
    mech.performCutback(this, p, mate);
  }
  performFreeKick(p: Player): void {
    mech.performFreeKick(this, p);
  }
  performClear(p: Player): void {
    mech.performClear(this, p);
  }

  /* ---------------- goal-channel telemetry (Phase 113) ---------------- */

  /**
   * Per-step band-entry tracker — the launch-anatomy probe's loop, in-engine.
   * Watches the carrier: a FRESH crossing into the final 15m with zero
   * goal-side outfielders is a breakaway entry, classified by what served it.
   * Pure observation of already-computed state; nothing reads the result but
   * the shot log.
   */
  private trackAttackEntry(): void {
    const o = this.ball.owner;
    // No owner (incl. his own pushed touch in flight) or dead ball: the
    // carry clock and any live entry simply persist — same as the probe.
    if (!o || this.phase !== 'playing') return;
    const team = this.teams[o.side];
    const ox = team.localX(o.pos.x);
    if (!this.carryStart || this.carryStart.gid !== o.gid) {
      this.carryStart = { gid: o.gid, t: this.simTime, x: ox };
      // Took over already inside the band (or is the keeper) — not a fresh
      // entry; only a crossing observed from OUTSIDE counts.
      this.bandInside = ox >= HALF_L - 15 || o.role === 'GK';
      // A turnover kills the other side's live entry — the attack it
      // classified is over.
      if (this.attackEntry && this.attackEntry.side !== o.side) this.attackEntry = null;
    }
    if (!this.bandInside && ox >= HALF_L - 15) {
      this.bandInside = true;
      // Breakaway only: zero goal-side outfielders (the walk-in pipe).
      const goalSide = this.teams[1 - o.side].players.some(
        (q) => q.role !== 'GK' && !q.sentOff && team.localX(q.pos.x) > ox,
      );
      if (!goalSide && this.restartKickGid !== o.gid) {
        this.attackEntry = { side: o.side, kind: this.classifyBandEntry(o, ox), t: this.simTime };
      }
    }
  }

  /** What LAUNCHED a fresh breakaway band entry (launch-anatomy classes;
   * lofted long balls fold into `through` — both are balls IN BEHIND — and
   * short-pass/loose service folds into `walkin`: the line was simply beaten). */
  private classifyBandEntry(p: Player, ox: number): GoalChannel {
    const cs = this.carryStart;
    if (cs && cs.gid === p.gid && this.simTime - cs.t > 2.2 && ox - cs.x > 9) return 'carry';
    const lp = this.lastCompletedPass;
    if (lp && lp.receiverGid === p.gid && this.simTime - lp.t < 3.5) {
      if (this.allPlayers[lp.passerGid].role === 'GK') return 'keeper';
      const kind =
        this.lastPassKind && this.simTime - this.lastPassKind.t < 3.5
          ? this.lastPassKind.kind
          : 'pass';
      if (kind === 'through' || kind === 'lofted') return 'through';
      if (kind === 'cross') return 'cross';
    }
    return 'walkin';
  }

  /**
   * The channel a shot by `shooter` would bank if it scores — priced at the
   * STRIKE (context is freshest there; a rebound re-prices on the live
   * entry). Priority: set piece → the live breakaway entry's launch class →
   * cross/cutback service → worked buildup.
   */
  goalChannelFor(shooter: Player): GoalChannel {
    const rk = this.lastRestartKick; // only ever corner / freeKick / penalty
    if (rk && rk.side === shooter.side && this.simTime - rk.t < 6) return 'setpiece';
    const e = this.attackEntry;
    if (e && e.side === shooter.side && this.simTime - e.t < 12) return e.kind;
    if (this.lastCutback && this.lastCutback.side === shooter.side && this.simTime - this.lastCutback.t < 5) {
      return 'cross';
    }
    const pk = this.lastPassKind;
    if (pk && pk.kind === 'cross' && this.simTime - pk.t < 2.5) return 'cross';
    return 'buildup';
  }

  /** Resolve the in-flight shot's timeline entry (first outcome wins). */
  markShotOutcome(outcome: 'goal' | 'saved' | 'miss'): void {
    const shot = this.pendingShot;
    if (!shot) return;
    const entry = this.shotLog[shot.logIndex];
    if (entry && entry.outcome === 'pending') entry.outcome = outcome;
  }

  private contestOrigin(): ContestOrigin {
    if (this.pendingPass !== null) return 'passArrival';
    if (this.dribbleTouch !== null) return 'looseBall';
    return 'looseBall';
  }

  /** Passive M3 ledger write. Never read by contact/control decisions. */
  private traceContact(
    claims: readonly GroundContactClaim[],
    player: Player,
    kind: ContestContact['kind'],
  ): void {
    if (!this.traceContests) return;
    if (this.activeContest === null) {
      const episode: MutableContestEpisode = {
        id: this.nextContestId++,
        startedTick: this.stepCount,
        origin: this.contestOrigin(),
        initialBallMode: this.ball.physicalMode,
        possessionSideAtStart: this.possessionSide,
        contenderGids: [],
        contacts: [],
      };
      this.activeContest = episode;
      this.contestEpisodes.push(episode);
    }
    for (const claim of claims) {
      const gid = claim.player.gid;
      if (!this.activeContest.contenderGids.includes(gid)) this.activeContest.contenderGids.push(gid);
    }
    this.activeContest.contacts.push({
      tick: this.stepCount,
      gid: player.gid,
      side: player.side,
      kind,
      ballModeAfter: this.ball.physicalMode,
    });
  }

  private resolveContest(resolution: ContestResolution): void {
    if (this.activeContest === null) return;
    this.activeContest.resolution = resolution;
    this.activeContest = null;
  }

  private resolveContestControlled(player: Player): void {
    this.resolveContest({ kind: 'controlled', tick: this.stepCount, gid: player.gid, side: player.side });
  }

  /**
   * Low-level kick: releases the ball with velocity and a re-capture cooldown.
   * `loft` (Phase 28) is the vertical launch speed — 0 keeps it on the grass.
   */
  kickBall(p: Player, dir: V2, speed: number, loft = 0): void {
    const ball = this.ball;
    this.pendingControl = null;
    ball.owner = null;
    ball.lastTouch = p;
    ball.vel = scale(dir, speed);
    ball.pos = add(p.pos, scale(dir, 0.9));
    ball.z = 0;
    ball.vz = loft;
    ball.spin = 0; // plain kicks fly straight — curlKick re-sets after
    p.gkDistributing = false;
    p.kickCooldown = KICK_COOLDOWN;
    p.firstTouchWindow = 0; // any kick consumes the one-touch window
    // The kick starts the wall's release timer (Phase 32): the bodies hold
    // their line while the ball clears them, THEN break for their marks.
    if (this.fkWall && this.fkWall.until === null) this.fkWall.until = this.simTime + 0.7;
  }

  /** Give a player clean control of the ball, resolving pass bookkeeping. */
  giveBall(p: Player): void {
    // Offside (Phase 29): the flag frozen at kick time becomes an offence the
    // moment the flagged target touches the ball. Checked before ANY
    // bookkeeping — an offside "reception" is not a dribble or a completed
    // pass, it's a dead ball.
    const flagged = this.pendingPass;
    if (flagged && flagged.offside && p.side === flagged.side && p.gid === flagged.targetGid) {
      this.pendingControl = null;
      this.pendingPass = null;
      this.resolveContest({ kind: 'deadBall', tick: this.stepCount });
      this.callOffside(p, flagged.offsideSpot ?? p.pos);
      return;
    }
    const ball = this.ball;
    ball.owner = p;
    // ⭐⭐ GK T0c §M-GK.3′ RELEASE (c) — REGAIN-CLEARED (docs/world-model/GK-T0-DIVE-LAW.md;
    // contract GK-KEEPER-BODY-CONTRACT.md §2; ruling #400 item 3). A FRESH GAIN RETIRES A
    // STALE CAUGHT CONTACT. The ownership sweep above the restart/ball fork clears a loss
    // that PERSISTS to the next sweep; a keeper who loses the ball and regains it INSIDE one
    // `step` presents the same owner to that sweep, so without this line his old contact
    // survives the loss and the waiting law snaps the ball back to it (the verifier's
    // hand-built regather: a 5.000000 m jump). It sits IMMEDIATELY AFTER the gain because the
    // retirement is the gain's CONSEQUENCE — no statement can later slip in between and read
    // an owner who still carries the contact of a possession he has already lost.
    // ⭐ It is AFTER the offside early-return, so it runs on EVERY successful gain and on no
    // dead ball. Flag off ⇒ the field is null on every body ⇒ the first conjunct
    // short-circuits and NO assignment executes (G-NULL).
    if (p.saveContact !== null && p.saveContact.caught) p.saveContact = null;
    ball.lastTouch = p;
    ball.vel = v2();
    ball.z = 0;
    ball.vz = 0;
    ball.spin = 0;
    const team = this.teams[p.side];

    // Settle on the ball: carry it briefly before the next decision instead of
    // one-touch ping-pong. Outfielders start driving forward immediately.
    // Back-pass law (Phase 32.2, 出球门将): a DELIBERATE teammate ball may
    // not be picked up — the keeper plays it with his FEET: pressable, no
    // hold, no box clearance, no calm reset. Saves, claims and loose
    // pickups keep the hands. This is what makes the ball-playing keeper
    // (and pressing him) possible at all.
    const backPass =
      this.pendingPass !== null &&
      this.pendingPass.side === p.side &&
      this.pendingPass.passerGid !== p.gid;
    // Re-collecting your own pushed touch is the SAME carry continuing
    // (Phase 36) — not a fresh dribble for the stats, and the next
    // decision comes quicker (the touch was the setup, not a reception).
    const recollect = this.dribbleTouch !== null && this.dribbleTouch.gid === p.gid;
    this.dribbleTouch = null;
    // Hands only inside the box (Phase 28.5, user report "门将出击到禁区外
    // 用手接球了"): a keeper plays with his FEET on a back-pass (by rule) AND
    // whenever he collects the ball OUTSIDE his own area — a sweeper who
    // rushed/chased off his line (GoalkeeperRush / ChaseBall are deliberately
    // un-clamped) may control and clear, but he may not scoop it up and hold.
    // Restart takers (goal kicks) keep their own quick-kick path. This one
    // gate covers every hands entry that funnels through giveBall — the loose
    // capture (tryCapture) and the high claim (tryAerial).
    const gkFeet =
      p.role === 'GK' &&
      this.restartKickGid !== p.gid &&
      (backPass || !this.inPenaltyBox(p.pos, p.side));
    if (p.role !== 'GK') {
      p.action = { type: 'Dribble', scores: p.action.scores };
      if (!recollect) team.stats.dribbles++;
      // The settle beat before the next push: the first decision after any
      // capture happens ON the ball (touchTimer ≥ the decision settle).
      // A continuing carry (recollect) chains faster — 一步一带 lives here:
      // regather, half a beat, next touch (36.1).
      p.touchTimer = (recollect ? 0.2 : 0.32) + (1 - p.attrs.dribbling) * 0.08;
    } else if (gkFeet) {
      p.action = { type: 'Dribble', scores: p.action.scores }; // at his feet, on the clock
    } else if (this.restartKickGid !== p.gid) {
      // Keeper hold (Phase 27.2): scoop it up and hold before distributing —
      // hands, not feet. Restart first touches (goal kicks) stay quick.
      // Game state prices the hold (Phase 35): a keeper protecting a lead
      // milks the clock; a keeper whose side is chasing gets it moving.
      p.gkHoldTimer = 1.1 * (1 + team.mentality.holding * 0.5 - team.mentality.urgency * 0.3);
      p.gkDistributing = true; // the release is deliberate (28.3)
      p.gkShapeWait = 0; // a fresh hold gets a fresh shape-wait budget (30.3)
    }
    // Snap decisions in shooting range (Phase 28.2): a receiver in front of
    // goal decides NOW — the first-time finish exists. Everywhere else the
    // settle touch stays (one-touch ping-pong was the original disease).
    const inShootingRange =
      p.role !== 'GK' &&
      team.localX(p.pos.x) > HALF_L - 24 &&
      dist(p.pos, team.oppGoal()) < 20;
    p.decisionTimer = Math.max(p.decisionTimer, inShootingRange ? 0.08 : recollect ? 0.18 : 0.3);
    // A keeper with the ball at his FEET is on the press's clock (32.2):
    // he moves it in a beat, he doesn't stroll on it like an outfielder.
    // A sweeper stranded outside his box (28.5) is on the same clock.
    if (gkFeet) p.decisionTimer = Math.min(p.decisionTimer, 0.18);

    const pass = this.pendingPass;
    if (pass) {
      if (p.side === pass.side && p.gid !== pass.passerGid) {
        team.stats.passesCompleted++;
        this.passChain[p.side]++;
        // The give-and-go completed (Phase 34): the wall's return found the
        // bursting passer inside his license window.
        if (p.wallRun && this.simTime < p.wallRun.until && p.wallRun.partnerGid === pass.passerGid) {
          team.stats.oneTwos++;
          p.wallRun = null;
        }
        // The third-man release arrived (Phase 34).
        if (pass.bounce && p.gid === pass.targetGid) team.stats.thirdMan++;
        // The overlap release arrived WIDE (Phase 34). Position-gated only:
        // receivers brake to take the ball, so an in-stride velocity test
        // (tried) zeroed the count at the capture instant.
        if (team.overlapper === p.index && Math.abs(p.pos.y) > 11) team.stats.overlaps++;
        this.lastCompletedPass = { passerGid: pass.passerGid, receiverGid: p.gid, t: this.simTime };
        // 一脚出球 (Phase 31.9, user request): a PRESSURED intended receiver
        // plays the ball as it comes — decide now, and a pass kicked inside
        // the window carries a first-time noise penalty priced by technique
        // (mechanics). Pressure-triggered only: the 0.3s settle above stays
        // the default, or one-touch ping-pong (the original disease) is
        // back. High-tempo sides live closer to the edge and release under
        // looser pressure.
        if (!inShootingRange && p.role !== 'GK' && p.gid === pass.targetGid) {
          const trigger = 3.0 + team.genome.tempo * 1.5;
          let nearOpp = Infinity;
          for (const o of this.teams[1 - p.side].players) {
            if (o.sentOff) continue;
            const d = dist(o.pos, p.pos);
            if (d < nearOpp) nearOpp = d;
          }
          // C5 T0: the window is ELECTABLE as well as pressure-granted. The
          // elected branch sets exactly the same two fields, so it enters the
          // same `oneTouchMul` / `touchFailChance` paths and prices nothing of
          // its own (gate A4). `forcedTouchFork` is null in every production
          // path, so with the flag off this reads bit-for-bit as before.
          const elected = this.c5TouchFork && this.forcedTouchFork === p.gid;
          if (nearOpp < trigger || elected) {
            p.decisionTimer = 0.07;
            p.firstTouchWindow = 0.28;
          }
        }
      } else if (p.side !== pass.side) {
        // No feed line (Phase 28.2): at ~25 per match, "X intercepts" drowned
        // the feed in noise (failure mode 7) — the stats panel carries the
        // count, the debug overlays show the moment.
        team.stats.interceptions++;
        this.stat(p.gid).recoveries++;
      }
      this.pendingPass = null;
    }
    if (this.pendingShot && p.side !== this.pendingShot.side) {
      this.markShotOutcome('miss'); // no-op if the keeper already logged a save
      this.pendingShot = null;
    }

    if (this.possessionSide !== p.side) {
      // The dispossessed side's passing move is over (Phase 33).
      this.endPassMove((1 - p.side) as Side);
      team.possessionGainedAt = this.simTime;
      team.resetProgress(team.localX(ball.pos.x));
      this.possessionSide = p.side;
      // Possession swung — both brains re-evaluate promptly.
      this.teams[0].brainTimer = Math.min(this.teams[0].brainTimer, 0.05);
      this.teams[1].brainTimer = Math.min(this.teams[1].brainTimer, 0.05);
    }
    this.pendingControl = null;
    this.resolveContestControlled(p);
  }

  /* ------------- C6 T1 the honest offset (docs/world-model/C6-T1-HONEST-OFFSET.md) ------------- */

  /** Record the outfield carrier's post-step heading in its ring, keyed by tick
   *  (doc §SEAM). Fixed-size ring; world-neutral bookkeeping. */
  private recordC6Heading(gid: number, hx: number, hy: number): void {
    let ring = this.c6HeadingHist.get(gid);
    if (ring === undefined) {
      ring = [];
      this.c6HeadingHist.set(gid, ring);
    }
    ring.push({ tick: this.stepCount, hx, hy });
    if (ring.length > C6_HEADING_RING) ring.shift();
  }

  /** The body's own heading `tick` ticks ago, from its ring (doc §LAW lag term).
   *  Returns null when that frame is not in the ring (history too short / a gap —
   *  the caller falls back to the current heading, the T0 `candLagFallback`). */
  private c6HeadingAt(gid: number, tick: number): { hx: number; hy: number } | null {
    const ring = this.c6HeadingHist.get(gid);
    if (ring === undefined) return null;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].tick === tick) return ring[i];
    }
    return null;
  }

  /**
   * Apply the honest carrying offset to `ball.pos` for the outfield carrier
   * `owner` (doc §LAW). Reads ONLY the body's own `|v|`, its heading sweep rate
   * `|ω|` and its own `dribbling` (I2). The lag reads the heading τ(drb) ticks
   * back from the ring; the wobble is a keyed zero-mean gaussian on (gid, tick),
   * never `match.rng`. Writes ball.pos only — never ball.owner (#48.3).
   */
  private applyC6HonestOffset(ball: Ball, owner: Player): void {
    const drb = owner.attrs.dribbling;
    const speed = Math.sqrt(owner.vel.x * owner.vel.x + owner.vel.y * owner.vel.y);
    // heading sweep rate |ω|, from consecutive recorded headings (the current
    // tick was just recorded by the seam); no prior frame ⇒ straight (ω = 0).
    const prev = this.c6HeadingAt(owner.gid, this.stepCount - 1);
    let omega = 0;
    if (prev !== null) {
      const a0 = Math.atan2(prev.hy, prev.hx);
      const a1 = Math.atan2(owner.heading.y, owner.heading.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      omega = Math.abs(d) / DT;
    }
    // the lagged offset direction: the body's heading τ(drb) ticks back.
    const lagged = this.c6HeadingAt(owner.gid, this.stepCount - c6TauTicks(drb));
    const dirX = lagged !== null ? lagged.hx : owner.heading.x;
    const dirY = lagged !== null ? lagged.hy : owner.heading.y;
    const carryLen = c6CarryLen(speed, omega, drb);
    // dir(θ_ball) is a unit heading vector; scale by carryLen, add keyed wobble.
    const sigma = c6Sigma(omega, drb);
    const noise = c6KeyedGaussian2D(owner.gid, this.stepCount);
    ball.pos.x = owner.pos.x + dirX * carryLen + noise.x * sigma;
    ball.pos.y = owner.pos.y + dirY * carryLen + noise.y * sigma;
  }

  /* ------------- BK T0 the facing law (docs/world-model/BK-T0-FACING-LAW.md) ------------- */

  /**
   * BK T0 §SEAM: the ONE consumption site of the facing §LAW — called from both arm methods
   * on the ARMED path only. Returns the added ticks and books the receipt. It reads the
   * body's own heading and the arm-time aim and NOTHING else (I2); it draws no rng (I1); the
   * ledger it writes is never read back by the sim, so the returned integer is the seam's
   * entire causal footprint.
   */
  private bkNoteFacing(heading: V2, aim: V2, from: V2): number {
    const extra = bkFacingExtraTicks(heading, aim.x, aim.y, from.x, from.y);
    const led = this.bkFacingLedger;
    led.armsSeen++;
    if (extra > 0) {
      led.armsExtended++;
      led.extraTicksTotal += extra;
      if (extra > led.maxExtraTicks) led.maxExtraTicks = extra;
    }
    return extra;
  }

  /* ------------- C7 T1 the shot wind-up (docs/world-model/C7-T1-PENDINGKICK.md) ------------- */

  /**
   * §SEAM: arm the shot wind-up — the release-side mirror of `pendingControl`.
   * Called ONLY from the open-play/one-touch shot commit (PlayerBrain, the
   * non-freeKick branch) when `c7Windup` is armed; every production path leaves
   * this untouched (`c7Windup` OFF ⇒ never reached). The body commits: it holds
   * the still-owned ball at its carry offset and turns toward `aim` for W ticks,
   * then the strike resolves at `readyTick`. W reads only the body's own |v|, |ω|
   * and `dribbling` (I2) and carries no rng draw (I1) — the noise half of craft
   * already lives in the orientation/curl prices paid at strike time.
   */
  armPendingKick(shooter: Player, aim: V2): void {
    // O1 T2 #180.3(iii) PRECEDENCE, the other order — the ONE line the O1 seam adds
    // to this certified method, gated on `o1PassWindup` so the C7 path is EXACTLY
    // as certified in every production world (flag OFF ⇒ `pendingPassWindup` is null
    // ⇒ never taken, and byte-identity is re-proved). A body has one set of legs:
    // arming the shot CANCELS a live same-gid pass wind-up, so no pass can leave the
    // foot from a body that has since committed to a strike.
    if (
      this.o1PassWindup && this.pendingPassWindup !== null
      && this.pendingPassWindup.gid === shooter.gid
    ) {
      this.pwNoteWindupChoiceVoid(this.pendingPassWindup); // PW T0c (#293.3 (c))
      this.pendingPassWindup = null;
      this.o1WindupLedger.cancelledByPendingKick++;
    }
    const drb = shooter.attrs.dribbling;
    const v = Math.sqrt(shooter.vel.x * shooter.vel.x + shooter.vel.y * shooter.vel.y);
    // |ω| from the two most-recent recorded headings (the c6 ring, recorded
    // post-physics each owned tick — so at this decide instant the latest entry
    // is last tick's heading). No prior frame ⇒ straight (ω = 0), the c6 fallback.
    const h1 = this.c6HeadingAt(shooter.gid, this.stepCount - 1);
    const h0 = this.c6HeadingAt(shooter.gid, this.stepCount - 2);
    let omega = 0;
    if (h1 !== null && h0 !== null) {
      let d = Math.atan2(h1.hy, h1.hx) - Math.atan2(h0.hy, h0.hx);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      omega = Math.abs(d) / DT;
    }
    const wTicks = c7WindupTicks(v, omega, drb);
    // BK T0 §SEAM (docs/world-model/BK-T0-FACING-LAW.md, contract M-BK.1) — THE FACING LAW,
    // its OWN armed-only statement: the timeline absorbs the turn the strike REQUIRES beyond
    // the cone the shipped cap already pays for. `bkFacingLaw` OFF ⇒ the literal integer 0 ⇒
    // `readyTick` is the certified C7 expression, byte for byte. The body's turn itself needs
    // no new code — `faceTarget` below is the shipped integrator, and it now has the time.
    const bkTicks = this.bkFacingLaw ? this.bkNoteFacing(shooter.heading, aim, shooter.pos) : 0;
    this.pendingKick = { gid: shooter.gid, readyTick: this.stepCount + wTicks + bkTicks, aim: { x: aim.x, y: aim.y } };
    // The committed body turns toward the aim: the heading integrator (capped at
    // TURN_RATE) does its work over the window, so the strike reads an improved
    // heading and pays LESS of the EXISTING misalignment price (no new term, I1).
    shooter.faceTarget = { x: aim.x, y: aim.y };
  }

  /**
   * §SEAM: resolve the shot wind-up at `readyTick`. The strike is the EXISTING
   * `performShot` math, evaluated AT STRIKE TIME (I1) — reached from the seam
   * instead of the commit line, reading the body's now-integrated heading and the
   * keeper's now-current pos. If the body is no longer a valid striker (ball won
   * inside the window / stunned / sent off / phase left playing / a contact locked
   * the boot), the interruption already resolved through its EXISTING channel and
   * NO strike runs — the seam adds nothing (I3). Dormant: `c7Windup` OFF ⇒
   * `pendingKick` is always null, so this is a no-op in every production path.
   */
  private resolvePendingKick(): void {
    const pk = this.pendingKick;
    if (!this.c7Windup || pk === null || this.stepCount < pk.readyTick) return;
    this.pendingKick = null;
    const shooter = this.allPlayers[pk.gid];
    if (shooter === undefined) return;
    shooter.faceTarget = null; // release the aim lock; the follow-through resumes
    if (
      this.phase !== 'playing' || this.ball.owner !== shooter
      || shooter.sentOff || shooter.stunTimer > 0 || shooter.kickCooldown > 0
    ) return;
    this.performShot(shooter);
  }

  /**
   * O1 T1 §SEAM (docs/world-model/O1-T1-PASS-WINDUP.md): arm the shortPass
   * wind-up. Called ONLY from the `performPass` commit statement in
   * `PlayerBrain`'s `case 'Pass'` (the open-play, non-restart, window-closed
   * branch) when `o1PassWindup` is armed; every production path leaves that
   * statement's synchronous `performPass` exactly as shipped.
   *
   * The body commits: it holds the still-owned ball at its carry offset and turns
   * toward the mate's ARM-TIME position for W ticks, then the pass resolves at
   * `readyTick` through the EXISTING `performPass` math evaluated at strike time.
   * W is the C7 §LAW — the same frozen constants, the same `c7WindupTicks`
   * function, the same clamp [3,11] — reading only the body's own |v|, |ω| (the C6
   * heading ring) and, the ONE designed deviation (#178.4/#179.2), **`passing`**:
   * the pass family's own attribute on the shared price chain
   * (`mechanics.ts:78-88` takes `passing` as `tec` on every pass path,
   * `dribbling` on every shot path). It reads no opponent, no percept, no
   * ball-context (I2) and draws NO rng (I1) — the accuracy/power/hurry/pressure
   * halves are already priced at strike time and O1 prices TIME only (the
   * NO-TOUCH list).
   */
  armPendingPass(passer: Player, mate: Player, offsideExempt = false): void {
    const tech = passer.attrs.passing;
    const v = Math.sqrt(passer.vel.x * passer.vel.x + passer.vel.y * passer.vel.y);
    // |ω| from the two most-recent recorded headings (the c6 ring), read exactly as
    // `armPendingKick` reads it. No prior frame ⇒ straight (ω = 0), the c6 fallback.
    const h1 = this.c6HeadingAt(passer.gid, this.stepCount - 1);
    const h0 = this.c6HeadingAt(passer.gid, this.stepCount - 2);
    let omega = 0;
    if (h1 !== null && h0 !== null) {
      let d = Math.atan2(h1.hy, h1.hx) - Math.atan2(h0.hy, h0.hx);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      omega = Math.abs(d) / DT;
    }
    const wTicks = c7WindupTicks(v, omega, tech);
    // BK T0 §SEAM (docs/world-model/BK-T0-FACING-LAW.md, contract M-BK.1) — THE FACING LAW,
    // its OWN armed-only statement, the pass channel. The aim is the mate's ARM-TIME position
    // — the SAME point `faceTarget` is set to below, so the turn the law charges for is
    // exactly the turn the body then performs. `bkFacingLaw` OFF ⇒ the literal integer 0 ⇒
    // `readyTick` is the certified O1 expression, byte for byte.
    const bkTicks = this.bkFacingLaw ? this.bkNoteFacing(passer.heading, mate.pos, passer.pos) : 0;
    // #180.3(ii) EVICTION ACCOUNTING, IN-ENGINE: the pass wind-up slot is single, so
    // a new arm while one is live overwrites it. That record is necessarily STALE
    // (only the ball owner can arm and the re-decide lock holds a winding-up owner),
    // and its resolve would have bailed on the ownership guard anyway — but the
    // overwrite is COUNTED here rather than assumed away.
    if (this.pendingPassWindup !== null) {
      this.pwNoteWindupChoiceVoid(this.pendingPassWindup); // PW T0c (#293.3 (c))
      this.o1WindupLedger.evictions++;
    }
    // #180.3(iii) PRECEDENCE, stated explicitly: a body has ONE set of legs. The arm
    // that fires LAST owns them, so arming the pass CANCELS a live same-gid shot
    // wind-up (no strike runs; the C7 slot is simply cleared, exactly as its own
    // interruption path leaves it). Unreachable in a live match — the C7 re-decide
    // lock returns before a winding-up owner can re-decide — so this is the
    // defensive half of the rule, and the counter shows if it ever fires.
    if (this.pendingKick !== null && this.pendingKick.gid === passer.gid) {
      this.pendingKick = null;
      this.o1WindupLedger.cancelledPendingKick++;
    }
    this.o1WindupLedger.arms++;
    const pwDeposit = this.pwStrikePower;
    let pwArmPower = 1;
    if (
      this.pwWeightChooser && pwDeposit !== null
      && pwDeposit.gid === passer.gid && pwDeposit.tick === this.simTick
    ) {
      pwArmPower = pwDeposit.power;
      this.pwStrikePower = null;
    }
    // ⭐⭐ DX T0 §SEAM — THE ELECTED AIM IS CAPTURED AT ARM TIME (M-DX.1), the PW deposit
    // idiom above, verbatim in form. The chooser's own winning displacement is taken off
    // the match for THIS body at THIS tick and consumed, so it can never reach another
    // kick; `dxWindupAim` OFF ⇒ the fork that deposits never runs ⇒ this is `null` and the
    // record below is the certified one.
    const dxDeposit = this.dxStrikeAim;
    let dxArmLead: V2 | null = null;
    if (
      this.dxWindupAim && dxDeposit !== null
      && dxDeposit.gid === passer.gid && dxDeposit.tick === this.simTick
    ) {
      dxArmLead = dxDeposit.lead;
      this.dxStrikeAim = null;
    }
    this.pendingPassWindup = {
      gid: passer.gid,
      readyTick: this.stepCount + wTicks + bkTicks,
      aim: { x: mate.pos.x, y: mate.pos.y },
      targetGid: mate.gid,
      targetRosterIdx: mate.rosterIdx,
      offsideExempt,
      // ⭐ PW T0b: the chosen weight is CAPTURED AT ARM TIME (and the deposit consumed, so it
      // cannot also fire a synchronous strike) and rides the wind-up to `readyTick`. It is the
      // literal 1 on every path but an armed `pwWeightChooser` one, so the certified arm is
      // unchanged.
      powerChoice: pwArmPower,
      // ⭐⭐ DX T0: the elected displacement rides to `readyTick`. `null` on every certified
      // path — the wind-up then resolves at the aim it always resolved at.
      aimLead: dxArmLead,
    };
    // The committed body turns toward the aim: the heading integrator (capped at
    // TURN_RATE) does its work over the window, so the release reads an improved
    // heading and pays LESS of the EXISTING misalignment price (no new term, I1).
    passer.faceTarget = { x: mate.pos.x, y: mate.pos.y };
  }

  /**
   * O1 T1 §SEAM: resolve the shortPass wind-up at `readyTick`. The release is the
   * EXISTING `performPass` math, evaluated AT STRIKE TIME (I1) — reached from the
   * seam instead of the commit line, with the mate and the `offsideExempt` flag
   * captured at ARM time and the lead/speed/spray/orientation prices all computed
   * now, once, against the body's now-integrated heading. If the body is no longer
   * a valid passer (ball lost inside the window / stunned / sent off / phase left
   * playing / a contact stamped the kick cooldown), the interruption already
   * resolved through its EXISTING channel and NO pass runs — the seam adds nothing
   * (the C7 I3 form). Dormant: `o1PassWindup` OFF ⇒ `pendingPassWindup` is always
   * null,
   * so this is a no-op in every production path.
   */
  private resolvePendingPassWindup(): void {
    const pp = this.pendingPassWindup;
    if (!this.o1PassWindup || pp === null || this.stepCount < pp.readyTick) return;
    this.pendingPassWindup = null;
    const passer = this.allPlayers[pp.gid];
    const mate = this.allPlayers[pp.targetGid];
    if (passer === undefined) { this.pwNoteWindupChoiceVoid(pp); return; }
    passer.faceTarget = null; // release the aim lock; the follow-through resumes
    if (mate === undefined) { this.pwNoteWindupChoiceVoid(pp); return; }
    if (
      this.phase !== 'playing' || this.ball.owner !== passer
      || passer.sentOff || passer.stunTimer > 0 || passer.kickCooldown > 0
    ) { this.pwNoteWindupChoiceVoid(pp); return; }
    // #180.3(i) INT-MATE: the arm-time MATE must still be on the pitch and still be
    // HIM. A send-off parks the body on the apron (`removeFromPitch`) and an injury
    // substitution swaps a NEW identity into the same pitch slot (`becomeSub` — the
    // gid is the slot, not the man), so a gid-only check would fire the pass at an
    // empty apron or at a stranger who was never picked. Either case CANCELS: no
    // pass runs, the ball stays with the passer, and the existing channel that took
    // the mate away owns the outcome (the C7 I3 form — the seam adds nothing).
    if (mate.sentOff || mate.rosterIdx !== pp.targetRosterIdx) {
      this.pwNoteWindupChoiceVoid(pp); // PW T0c (#293.3 (c))
      this.o1WindupLedger.cancelledMate++;
      return;
    }
    this.o1WindupLedger.struck++;
    // ⭐ PW T0b (#291.5 correction 4): the ARM-TIME weight is RE-DEPOSITED for this tick, so the
    // release below — the certified 3-argument call, untouched — strikes at the chosen weight
    // through the SAME consumption site every other pass uses. `powerChoice` is 1 on every path
    // that is not an armed `pwWeightChooser` one, so the certified release is unchanged.
    if (this.pwWeightChooser && pp.powerChoice !== 1) {
      this.pwChooserLedger.windupCarried++;
      this.pwStrikePower = { gid: passer.gid, power: pp.powerChoice, tick: this.simTick };
    }
    // ⭐⭐ DX T0 §SEAM — THE PLUMB-THROUGH (M-DX.1), and the ONLY behavioural statement this
    // seam owns: the ARM-TIME elected displacement is handed to the SHIPPED `performPass` lead
    // input — the very argument the synchronous led-strike statement in `PlayerBrain` already
    // hands it — so the wound-up kick is struck toward the point the argmax scored instead of
    // discarding it. `aimLead` is `null` on every certified path, and `performPass`'s own
    // default for that parameter is `null`, so this call is the certified 3-argument release
    // byte for byte. ⛔ No speed, height, curl or timing statement is added: WHICH POINT is
    // the whole change.
    this.performPass(passer, mate, pp.offsideExempt, 1, pp.aimLead);
  }

  /**
   * ⭐⭐ PW T0c (#293.3 (c)) — THE CANCELLED WIND-UP'S CHOSEN WEIGHT, ACCOUNTED NOT RE-DEPOSITED.
   *
   * The engine's own cancel semantics decide the form. Every cancel path here means the SAME
   * thing: **no pass runs**, the ball stays with the passer, and the channel that interrupted
   * owns the outcome (the C7 I3 form) — the body then re-decides at his next owned tick and the
   * chooser re-prices the whole ladder against a world that has moved. So the arm-time decision
   * is VOID, not pending: re-depositing its weight would leave a slot that, by construction, no
   * strike this tick can consume (the deposit is gid+tick keyed and the only consumer already
   * returned), i.e. a re-deposit would be a no-op dressed as a fix. The honest form the ruling's
   * second branch names is taken instead — AN EXPLICIT COUNTER — so that the choice ledger
   * CLOSES: deposited = struck + voided + abandoned + in flight, and the one measured silent
   * loss of PW-T0b becomes a named, countable event.
   */
  private pwNoteWindupChoiceVoid(
    pp: Readonly<{ powerChoice: number }> | null,
  ): void {
    if (this.pwWeightChooser && pp !== null && pp.powerChoice !== 1) {
      this.pwChooserLedger.windupChoiceVoided++;
    }
  }

  /* ---------------- ball physics ---------------- */

  private stepBall(dt: number): void {
    const ball = this.ball;
    if (ball.owner) {
      // Discrete touches (Phase 36, 可见的触球): an outfield carrier DRIVING
      // in open field pushes the ball ahead and chases it — the magnet-ball
      // glue below is only close control now (pressure, shielding, keepers,
      // restart takers). touchTimer ≥ the capture settle guarantees the
      // first decision happens ON the ball, so the pass game keeps its
      // timing and restart takers kick before a push can fire.
      const o = ball.owner;
      // ⭐⭐ CB T0 §SEAM (b) — THE ONE TOUCH-PAST FORK IN `src/**`. It sits at the head of the
      // owned-ball branch, beside the incumbent push it borrows its release from, and requires
      // BOTH the door and the instrument seam naming this very carrier — `forcedTouchPast` is
      // null in every production path, so the statement is unreachable there rather than merely
      // inert. The aiming, and one day the choosing, live outside: CB-T2 owns the seat.
      if (
        this.cbTouchPast &&
        this.forcedTouchPast !== null &&
        this.forcedTouchPast.gid === o.gid &&
        this.phase === 'playing' &&
        o.role !== 'GK' &&
        o.gkHoldTimer <= 0 &&
        o.kickCooldown <= 0
      ) {
        const aim = this.forcedTouchPast.dir;
        this.forcedTouchPast = null;
        mech.performTouchPast(this, o, aim);
        return; // the ball is free — it integrates from next step, and the race is on
      }
      if (
        this.phase === 'playing' &&
        o.role !== 'GK' &&
        o.action.type === 'Dribble' &&
        o.touchTimer <= 0 &&
        o.gkHoldTimer <= 0 &&
        // A slow or turning carrier keeps the ball at his feet — pushes
        // belong to the DRIVE (walking pace = close control by definition).
        o.vel.x * o.vel.x + o.vel.y * o.vel.y > 2.5 * 2.5
      ) {
        let nearOpp = Infinity;
        for (const q of this.teams[1 - o.side].players) {
          if (q.sentOff) continue;
          const d = dist(q.pos, o.pos);
          if (d < nearOpp) nearOpp = d;
        }
        if (nearOpp > TOUCH_CONTROL_DIST) {
          mech.performDribbleTouch(this, o);
          return; // the ball is free — it integrates from next step
        }
      }
      // Dribble: the ball rides slightly ahead of the owner's heading — or
      // tight to the chest while a keeper holds it in their hands (27.2).
      // In-place writes (was add/scale/clone — 3 vectors per step); ball.pos
      // and ball.vel are never aliased, all other writers assign fresh objects.
      // Span the WHOLE hold/distribute, not just the gkHoldTimer window: the
      // timer re-arms in 0.25s quanta and hits 0 in the gaps, which sawtoothed
      // the held ball 0.3↔0.85m at ~3Hz — the keeper (whose spot tracks
      // ball.pos.y) and nearby teammates (who reference the ball) jittered with
      // it (user report "门将拿球一抽一抽,队友也抽"). gkDistributing already
      // spans the hold for the other consumers (clearance guard, heldByGk).
      const carry =
        ball.owner.gkHoldTimer > 0 || (ball.owner.role === 'GK' && ball.owner.gkDistributing)
          ? 0.3
          : 0.85;
      if (carry === 0.85) {
        // C6 T1: record the outfield carrier's heading for the lag law's
        // lookback. UNCONDITIONAL (not gated on `c6Carry`) and world-neutral —
        // never touches ball/players/rng/phase, so the OFF signature is
        // byte-identical — so that a world FORKED from an OFF base match carries
        // the pre-fork heading history the ON arm's lag reads (doc §SEAM).
        this.recordC6Heading(ball.owner.gid, ball.owner.heading.x, ball.owner.heading.y);
      }
      // ⭐⭐ GK T0b §M-GK.3′ — THE CAUGHT BALL WAITS UNTIL ARRIVAL
      // (docs/world-model/GK-T0-DIVE-LAW.md; contract GK-KEEPER-BODY-CONTRACT.md §2
      // M-GK.3′; ruling #399 item 3(ii)). THE ONE waiting branch in `src/**`, placed BEFORE
      // the normal placement so a caught ball is never snapped to the keeper's feet while
      // his body is still on its way. GK-C0 measured that snap: on 0.985375 of catches the
      // ball's next-tick displacement exceeds the keeper's own cap, a mean 1.711552 m in
      // one tick.
      //
      // ⭐⭐ THE GATE IS THE `caught` MARK, NOT THE ANIMATION TIMER. GK-T0 read
      // `saveAnimTimer > 0` here and the jump was merely DEFERRED to the tick the window
      // expired (2.050600 m on tick 42 — ruling #399 item 1(i)); and because the gate tested
      // ownership and role rather than the branch of the save, a keeper who REGATHERED HIS
      // OWN PARRY inside the window pinned the ball to the PRE-PARRY contact up to
      // 5.481300 m away (#399 item 1(iii)). Both are gone: only a CATCH sets `caught`, and
      // the wait ends on the PHYSICAL event — arrival, below, or the loss of ownership
      // (`stepBall`'s head).
      //
      // The ball HOLDS at the contact point until the body's own carry point — the same
      // `carry` length this tick's normal placement uses, no new distance constant — comes
      // within `carry` of it; then the hands have arrived, `saveContact` is CONSUMED and
      // the shipped placement runs THE SAME TICK, so the release hands the ball straight to
      // the carry point: a displacement of at most `carry`, by construction. The keyed
      // noise term is NOT applied while waiting: the ball is held, not dribbled.
      //
      // Flag off ⇒ `gkHands` is null by the first conjunct and the placement below is
      // HEAD's byte for byte.
      const gkHands = this.gkDiveBody && ball.owner.role === 'GK'
        && ball.owner.saveContact !== null && ball.owner.saveContact.caught
        ? ball.owner.saveContact : null;
      let heldAtHands = false;
      if (gkHands !== null) {
        const cx = ball.owner.pos.x + ball.owner.heading.x * carry - gkHands.x;
        const cy = ball.owner.pos.y + ball.owner.heading.y * carry - gkHands.y;
        if (cx * cx + cy * cy > carry * carry) heldAtHands = true;
        else ball.owner.saveContact = null; // consumed: the hands have arrived
      }
      if (heldAtHands && gkHands !== null) {
        ball.pos.x = gkHands.x;
        ball.pos.y = gkHands.y;
      } else if (this.c6Carry && carry === 0.85) {
        // C6 T1 — THE HONEST OFFSET (docs/world-model/C6-T1-HONEST-OFFSET.md
        // §LAW): the outfield glued ball follows the body's own kinematics and
        // technique instead of riding rigid at heading·0.85. Writes ball.pos
        // only; never ball.owner (#48.3 structural zero-loose). The GK 0.3 case
        // and the de-glue branch never reach here.
        this.applyC6HonestOffset(ball, ball.owner);
      } else {
        ball.pos.x = ball.owner.pos.x + ball.owner.heading.x * carry;
        ball.pos.y = ball.owner.pos.y + ball.owner.heading.y * carry;
      }
      ball.vel.x = ball.owner.vel.x;
      ball.vel.y = ball.owner.vel.y;
      // Ball in the keeper's hands (Phase 28.1): opponents are held off the
      // same way a restart holds them — you cannot challenge a keeper in
      // possession, so let them RELEASE in peace too (the crowd used to
      // stand in the tackle circle waiting for the ball to touch grass).
      // The WHOLE distribution counts (Phase 31.9, user report "手拿球时
      // 对方疯狂抽动"): the shape-wait re-arms the hold in 0.25s quanta,
      // and in the timer==0 gaps between quanta the clearance died — 22%
      // of distribution time was gap, box intrusion ran 7× higher there,
      // and opponents surged in and got expelled at ~4Hz. gkDistributing
      // spans hand-to-kick, so the calm holds without gaps.
      if (ball.owner.gkHoldTimer > 0 || (ball.owner.role === 'GK' && ball.owner.gkDistributing)) {
        const gk = ball.owner;
        for (const o of this.teams[1 - gk.side].players) {
          if (o.sentOff) continue;
          const d = dist(o.pos, gk.pos);
          if (d < GK_HOLD_CLEARANCE) {
            const dir = d < 1e-6 ? v2(this.teams[1 - gk.side].attackDir, 0) : norm(sub(o.pos, gk.pos));
            o.pos = add(gk.pos, scale(dir, GK_HOLD_CLEARANCE));
            o.pos.x = Math.max(-HALF_L + 0.3, Math.min(HALF_L - 0.3, o.pos.x));
            o.pos.y = Math.max(-HALF_W + 0.3, Math.min(HALF_W - 0.3, o.pos.y));
            o.vel.x *= 0.2; // braced — no treadmill legs (28.3)
            o.vel.y *= 0.2;
          }
          // A held ball clears the BOX too (Phase 31.8, user call — same
          // deliberate calm-reset simplification as the offside goal kick;
          // the real law only forbids challenging). Same x-clamp as the
          // goal-kick hold: opponents ride the box edge until the release.
          if (this.inPenaltyBox(o.pos, gk.side)) {
            const attackDir = this.teams[gk.side].attackDir;
            o.pos.x = -attackDir * HALF_L + attackDir * (BOX_DEPTH + 0.4);
            o.vel.x *= 0.2; // braced, like the circle clamp — no treadmill
            o.vel.y *= 0.2;
          }
        }
        return; // untackleable, unsmotherable — hands beat everything
      }
      mech.tryTackles(this);
      mech.tryTacticalFoul(this); // guards internally: owner may be gone
      mech.trySlideTackle(this); // Phase 110 — the recovery slide
      mech.trySmother(this);
      return;
    }
    // Magnus (Phase 37): sidespin rotates the velocity — a constant rate is
    // a circular arc, so every projection has an exact closed form. Spin
    // bleeds slowly in the air, fast on the grass, and dies on the bounce.
    if (ball.spin !== 0) {
      const a = ball.spin * dt;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const vx = ball.vel.x;
      ball.vel.x = vx * c - ball.vel.y * s;
      ball.vel.y = vx * s + ball.vel.y * c;
      ball.spin *= Math.exp(
        -(ball.z > 0 ? BALL_AIR_SPIN_DECAY : BALL_GROUND_SPIN_DECAY) * dt,
      );
      if (ball.spin > -0.02 && ball.spin < 0.02) ball.spin = 0;
    }
    ball.pos.x += ball.vel.x * dt;
    ball.pos.y += ball.vel.y * dt;
    if (ball.z > 0 || ball.vz !== 0) {
      // Airborne (Phase 28): friction-free parabola, landing bounces. Ground
      // balls never enter this branch — their trajectories are untouched.
      ball.z += ball.vz * dt;
      ball.vz -= GRAVITY * dt;
      if (ball.z <= 0) {
        ball.z = 0;
        if (ball.vz < -BOUNCE_MIN_VZ) {
          ball.vz = -ball.vz * BALL_BOUNCE;
          ball.vel.x *= BOUNCE_DAMP;
          ball.vel.y *= BOUNCE_DAMP;
          ball.spin *= BALL_BOUNCE_SPIN_RETENTION;
        } else {
          ball.vz = 0;
        }
      }
    } else {
      const fr = Math.exp(-BALL_FRICTION_K * dt);
      ball.vel.x *= fr;
      ball.vel.y *= fr;
    }
    // A ball already over the goal line is coasting clear (Phase 41.1): let it
    // run, freeze goal + out re-checks, and award the restart once it's had its
    // moment out of play.
    if (this.pendingOut !== null) {
      if (this.simTime >= this.pendingOut.until) {
        const o = this.pendingOut;
        this.pendingOut = null;
        this.awardRestart(o.kind, o.side, o.spot);
      }
      return;
    }
    if (this.checkGoal()) return;
    if (this.checkWoodwork()) return; // clanged back into play — not out
    if (this.checkOutOfPlay()) return;
    mech.tryShotBlock(this);
    mech.tryKeeperSave(this);
    // ⭐⭐ BK T1 §SEAM (2) — THE Z PARTITION. Shipped: the ground channel runs at
    // z <= CONTROL_MAX_HEIGHT (1.30) and `tryAerial` returns below HEADER_MIN_HEIGHT (1.35),
    // so z ∈ (1.30, 1.35) is a band NO channel may touch (BK-C0: 8.494 ball-ticks a match).
    // Armed: the SAME edge on both sides — feet below 1.35, heads at 1.35 and above — so the
    // two bands partition by construction, with no shipped constant edited. One boolean on
    // the flag-OFF path; `bkContactLaw` OFF ⇒ the shipped expression, character for character.
    const aerialOnly = this.bkContactLaw ? ball.z >= HEADER_MIN_HEIGHT : ball.z > CONTROL_MAX_HEIGHT;
    if (this.bkContactLaw && ball.z > CONTROL_MAX_HEIGHT && !aerialOnly) {
      this.bkContactLedger.partitionGroundTicks += 1;
    }
    if (aerialOnly) {
      // Too high for feet: only heads (or the keeper's hands) can meet it.
      const order = this.stepCount % 2 === 0 ? this.allPlayers : this.allPlayersReversed;
      mech.tryAerial(this, order);
      return;
    }
    this.tryCapture();
  }

  /**
   * WOODWORK (Phase 100 — the queue-tail item that unlocks the recorded
   * crossbar sample): a ball crossing the goal plane in the OUTER band of a
   * post (|y| just past the frame) or just OVER the bar clangs back into
   * play instead of going out. Deliberately outer-half only: the inner
   * half of the frame stays a goal exactly as before — woodwork converts
   * former near-miss OUTS into live rebounds, so the goal rate is
   * untouched at first order and NO new rng draws are consumed (the
   * bounce is deterministic: reflected, damped, spin killed).
   */
  private checkWoodwork(): boolean {
    const ball = this.ball;
    if (this.phase !== 'playing' || ball.owner !== null) return false;
    if (Math.abs(ball.pos.x) <= HALF_L) return false;
    const sign = ball.pos.x > 0 ? 1 : -1;
    if (ball.vel.x * sign <= 2) return false; // must be DRIVEN out, not trickling
    // Interpolate the crossing point back to the plane (a 30 m/s shot
    // travels 0.5m in one step — the post-step position overshoots).
    const stepX = Math.abs(ball.vel.x) * DT;
    const frac = Math.min(1, (Math.abs(ball.pos.x) - HALF_L) / Math.max(stepX, 1e-6));
    const yAt = ball.pos.y - ball.vel.y * DT * frac;
    const zAt = Math.max(0, ball.z - ball.vz * DT * frac);
    const BAND = 0.17; // post/bar radius + ball radius
    const post = Math.abs(yAt) >= GOAL_WIDTH / 2 && Math.abs(yAt) < GOAL_WIDTH / 2 + BAND && zAt < GOAL_HEIGHT;
    const bar = zAt >= GOAL_HEIGHT && zAt < GOAL_HEIGHT + BAND && Math.abs(yAt) < GOAL_WIDTH / 2 + BAND;
    if (!post && !bar) return false;
    // The clang: reflect off the plane, damped DEAD (the frame wins; a
    // lively 0.52 rebound fed the six-yard scramble and pushed calibrate
    // seed 2024 to 3.61 — the mechanic must not be a goal channel). Post
    // hits also ricochet OUTWARD toward the flank, off the frame's curve.
    ball.pos.x = sign * (HALF_L - (Math.abs(ball.pos.x) - HALF_L) * 0.4 - 0.01);
    ball.vel.x *= -0.4;
    if (post) ball.vel.y = Math.sign(yAt || 1) * Math.max(Math.abs(ball.vel.y) * 0.82, 3);
    else ball.vel.y *= 0.82;
    if (bar) ball.vz = -Math.abs(ball.vz) * 0.35; // off the bar it comes DOWN
    ball.spin = 0;
    // Credit the striker's side (sign>0 = the +x goal = team 0's attack).
    const shooterSide: Side = this.pendingShot?.side ?? (sign > 0 ? 0 : 1);
    this.pushEvent('woodwork', shooterSide, bar ? '🔩 Off the CROSSBAR!' : '🔩 Off the post!');
    this.markShotOutcome('miss'); // on the frame ≠ on target
    return true;
  }

  private checkGoal(): boolean {
    const ball = this.ball;
    if (ball.z >= GOAL_HEIGHT) return false; // over the bar (Phase 28)
    if (Math.abs(ball.pos.x) <= HALF_L || Math.abs(ball.pos.y) >= GOAL_WIDTH / 2) return false;
    // Team 0 attacks +x: ball past +x line = goal for team 0.
    const scorer: Side = ball.pos.x > 0 ? 0 : 1;
    this.onGoal(scorer);
    return true;
  }

  private onGoal(side: Side): void {
    const team = this.teams[side];
    // The move's feed line lands BEFORE the goal line it produced (Phase 33).
    this.endPassMove(side);
    this.score[side]++;
    team.stats.goals++;
    this.markShotOutcome(this.pendingShot?.side === side ? 'goal' : 'miss');
    // Bank the goal channel (Phase 113): the tag priced at the strike; an
    // own goal / untracked scramble falls back to `buildup`.
    const channel =
      this.pendingShot && this.pendingShot.side === side
        ? this.shotLog[this.pendingShot.logIndex]?.channel ?? 'buildup'
        : 'buildup';
    team.stats.goalChannels[channel]++;
    // Cutback payoff bookkeeping (Phase 31): a goal within 5s of the
    // pull-back credits the routine (the directional test's metric).
    if (this.lastCutback && this.lastCutback.side === side && this.simTime - this.lastCutback.t < 5) {
      team.stats.cutbackGoals++;
    }

    let scorerText: string;
    const shot = this.pendingShot;
    if (shot && shot.side === side) {
      team.stats.shotsOnTarget++;
      const shooter = this.allPlayers[shot.shooterGid]; // allPlayers is gid-indexed
      scorerText = shooter ? `${shooter.name} (${shooter.role})` : team.info.name;
      this.lastScorerGid = shot.shooterGid;
      this.stat(shot.shooterGid).goals++;
      if (shot.assistGid !== null) this.stat(shot.assistGid).assists++;
    } else if (this.ball.lastTouch && this.ball.lastTouch.side !== side) {
      scorerText = `${this.ball.lastTouch.name} (og)`;
      this.lastScorerGid = this.ball.lastTouch.gid;
      // Own goals credit nobody's tally.
    } else {
      scorerText = this.ball.lastTouch ? `${this.ball.lastTouch.name} (scramble)` : team.info.name;
      this.lastScorerGid = this.ball.lastTouch?.gid ?? null;
      if (this.ball.lastTouch) this.stat(this.ball.lastTouch.gid).goals++;
    }
    this.pushEvent(
      'goal',
      side,
      `GOAL! ${team.info.name} — ${scorerText}  ${this.score[0]}–${this.score[1]}`,
    );

    this.pendingShot = null;
    this.pendingPass = null;
    this.possessionSide = -1;
    this.ball.owner = null;
    this.ball.vel = v2();
    this.ball.z = 0;
    this.ball.vz = 0;
    this.kickoffSide = (1 - side) as Side;
    this.phase = 'goalPause';
    this.phaseTimer = 2.0;
  }

  /* ---------------- set pieces (Phase 14) ---------------- */

  /**
   * Real boundaries: over the touchline = kick-in against the last touch;
   * over the goal line (outside the mouth — goals were checked first) =
   * corner if the defending side touched it last, else goal kick.
   */
  private checkOutOfPlay(): boolean {
    const ball = this.ball;
    const lastSide: Side = this.ball.lastTouch?.side ?? 0;
    if (Math.abs(ball.pos.y) > HALF_W) {
      const sy = ball.pos.y >= 0 ? 1 : -1;
      const pos = v2(
        Math.max(-HALF_L + 1, Math.min(HALF_L - 1, ball.pos.x)),
        sy * (HALF_W - 0.4),
      );
      this.awardRestart('kickIn', (1 - lastSide) as Side, pos);
      return true;
    }
    if (Math.abs(ball.pos.x) > HALF_L) {
      const sx = ball.pos.x >= 0 ? 1 : -1;
      // Team 0 attacks +x: the +x goal line is defended by team 1.
      const defSide: Side = sx > 0 ? 1 : 0;
      // Don't snap to the spot the instant it crosses — let the ball coast out
      // (Phase 41.1) and place the restart a beat later. Goal detection is
      // frozen while pendingOut is set (see stepBall).
      const until = this.simTime + OUT_PLAY_COAST;
      if (lastSide === defSide) {
        const sy = ball.pos.y >= 0 ? 1 : -1;
        this.pendingOut = { kind: 'corner', side: (1 - defSide) as Side, spot: v2(sx * (HALF_L - 0.6), sy * (HALF_W - 0.6)), until };
      } else {
        this.pendingOut = { kind: 'goalKick', side: defSide, spot: v2(sx * (HALF_L - 7), 0), until };
      }
      return true;
    }
    return false;
  }

  /** Is `pos` inside `defSide`'s own penalty box? (Same box the pitch draws.) */
  inPenaltyBox(pos: V2, defSide: Side): boolean {
    if (Math.abs(pos.y) > BOX_WIDTH / 2) return false;
    const goalLineX = -this.teams[defSide].attackDir * HALF_L;
    return goalLineX > 0 ? pos.x >= goalLineX - BOX_DEPTH : pos.x <= goalLineX + BOX_DEPTH;
  }

  /** True while a ball is over the goal line and coasting clear before its
   * corner/goal-kick is placed (Phase 41.1) — lets the renderer and tests tell
   * this brief, deliberate out-of-play excursion from genuine live play. */
  get ballCoastingOut(): boolean {
    return this.pendingOut !== null;
  }

  /**
   * A failed tackle turned foul (Phase 20): free kick where the ball was —
   * or a penalty when the offender fouled inside their own box.
   */
  awardFoul(offender: Player, victim: Player): void {
    const side = victim.side; // the fouled team takes the kick
    this.teams[offender.side].stats.fouls++;
    if (this.inPenaltyBox(this.ball.pos, offender.side)) {
      this.teams[side].stats.penalties++;
      const goalLineX = -this.teams[offender.side].attackDir * HALF_L;
      const spot = v2(goalLineX - Math.sign(goalLineX) * PENALTY_SPOT_DIST, 0);
      this.pushEvent('foul', side, `PENALTY! ${offender.name} brings down ${victim.name} in the box`);
      this.awardRestart('penalty', side, spot);
    } else {
      // Advantage (Phase 27.2): failed-tackle fouls don't stop play — the
      // carrier kept the ball, so the whistle only ever interrupted the
      // attacking team's own move. The foul still counts and still draws
      // cards; box fouls above still concede a penalty. (The PROFESSIONAL
      // foul is different — the carrier goes down — see awardTacticalFoul.)
      // EXCEPT the danger band (Phase 32): with the direct free kick real,
      // the set piece out-values scrappy possession there — the ref brings
      // it back the way real ones do when the foul is in range. Everywhere
      // else the whistle stays swallowed (fluency, the 27.2 user call).
      const dGoal = dist(this.ball.pos, this.teams[side].oppGoal());
      if (this.teams[side].localX(this.ball.pos.x) > 0 && dGoal < 28 && dGoal > 9) {
        this.pushEvent('foul', side, `Foul by ${offender.name} on ${victim.name} — free kick in range`);
        this.awardRestart('freeKick', side, clone(this.ball.pos));
      } else {
        this.pushEvent('foul', side, `Foul by ${offender.name} on ${victim.name} — advantage`);
      }
    }
    this.maybeCard(offender);
    this.maybeInjure(victim);
  }

  /**
   * Cards (Phase 25): a foul is sometimes a booking (aggressive-marking sides
   * pick up more); a second booking — or a rare straight red — is a sending
   * off. Keepers are never carded: with no bench, a red keeper would break
   * the one-goalkeeper premise, and box fouls already concede a penalty.
   */
  private maybeCard(offender: Player): void {
    if (offender.role === 'GK') return;
    const team = this.teams[offender.side];
    // 0.16 → 0.12 in 29.1: professional fouls added their own near-automatic
    // bookings, so the base rate eased to keep cards at a watchable level.
    // Phase 62 (CARDS THAT BIND) reprices upward with a STEEPER aggression
    // slope: probe A found the whole league drawing only 52-67 yellows a
    // season (player median 0) — too thin for any suspension threshold to
    // bind — and club yellows coupling to style at just r≈0.18 (MA) /
    // 0.31 (press). Cards now carry systemic weight (bans), so the referee
    // prices the aggressive STYLE, not just the moment: base 0.16, slope
    // 0.28 (MA 0.3 ⇒ 0.24/foul, MA 0.9 ⇒ 0.41/foul). Referees still
    // MANAGE the game (29.1): a player already booked gets benefit of the
    // doubt on ordinary fouls (×0.45) — the second-yellow governor.
    let yellowP = 0.16 + team.genome.markingAggression * 0.28;
    if (offender.booked) yellowP *= 0.45;
    if (this.rng.chance(yellowP)) {
      team.stats.yellows++;
      this.stat(offender.gid).yellows++;
      if (offender.booked) {
        this.pushEvent('card', offender.side, `Second yellow — ${offender.name} is SENT OFF`);
        this.sendOff(offender);
      } else {
        offender.booked = true;
        this.pushEvent('card', offender.side, `${offender.name} is booked`);
      }
    } else if (this.rng.chance(0.009)) {
      this.pushEvent('card', offender.side, `STRAIGHT RED! ${offender.name} is sent off`);
      this.sendOff(offender);
    }
  }

  /**
   * Send a player off: park them on the apron beside their own half and
   * remove them from every sim interaction (all player loops skip `sentOff`).
   * The team plays a man short for the rest of the match.
   */
  sendOff(p: Player): void {
    if (p.sentOff) return;
    this.teams[p.side].stats.reds++;
    this.stat(p.gid).reds++; // the ban is PERSONAL (Phase 62)
    this.removeFromPitch(p);
  }

  /** Park a player on the apron and clear every assignment pointing at
   * him — send-offs and bench-less serious injuries (Phase 118) share
   * this. Tallies (reds) stay with the callers. */
  private removeFromPitch(p: Player): void {
    p.sentOff = true;
    const team = this.teams[p.side];
    p.pos = v2(-team.attackDir * 12, (p.side === 0 ? -1 : 1) * (HALF_W + 4));
    p.vel = v2();
    p.desiredVel = v2();
    p.action = { type: 'HoldPosition', scores: [] };
    // An injured CARRIER can leave mid-advantage (Phase 118) — the ball
    // he was holding becomes loose. Send-offs never own the ball.
    if (this.ball.owner === p) {
      this.ball.owner = null;
      this.possessionSide = -1;
    }
    // Clear stale assignments in both directions and make both brains
    // re-coordinate promptly (same pattern as possession swings).
    team.chasers.delete(p.index);
    team.marks.delete(p.index);
    team.runners.delete(p.index);
    const opp = this.teams[1 - p.side];
    for (const [own, target] of opp.marks) {
      if (target === p.index) opp.marks.delete(own);
    }
    this.teams[0].brainTimer = Math.min(this.teams[0].brainTimer, 0.05);
    this.teams[1].brainTimer = Math.min(this.teams[1].brainTimer, 0.05);
  }

  /**
   * INJURIES (Phase 118, user-ratified defaults): a foul SOMETIMES hurts
   * the man it fouled — no reward channel for the fouler beyond what cards
   * and penalties already price; injury is a side effect of the foul
   * economy, never an incentive. Rare by design (~1-2 per club-season,
   * `injury-census` probe): 70% are KNOCKS — he plays on, visibly slower —
   * the rest come OFF now and miss 2-4 rounds through the suspension seam.
   * Tired legs and old legs are the frailest. Keepers only ever take
   * knocks: no reserve GK exists (the "keepers are never carded" premise).
   */
  private maybeInjure(victim: Player): void {
    if (victim.sentOff || victim.injured) return;
    // stamina 1 → ×0.6 … 0.05 → ×1.55; age 27 = ×1 ± 6%/year in [0.65, 1.5].
    const fatigue = 1.6 - victim.stamina;
    const age = Math.max(0.65, Math.min(1.5, 1 + ((victim.age ?? 27) - 27) * 0.06));
    if (!this.rng.chance(INJURY_BASE * fatigue * age)) return;
    this.teams[victim.side].stats.injuries++;
    if (victim.role === 'GK' || !this.rng.chance(0.3)) {
      victim.takeKnock();
      this.pushEvent('info', victim.side, `🚑 ${victim.name} picks up a knock — plays on`);
      return;
    }
    victim.injured = 'serious';
    const rounds = 2 + Math.floor(this.rng.range(0, 3)); // out 2-4 rounds
    this.injuriesOut[victim.side * ROSTER_SIZE + victim.rosterIdx] = rounds;
    this.pushEvent('info', victim.side, `🚑 ${victim.name} can't continue — stretchered off`);
    this.forceSubstitution(victim);
  }

  /**
   * ⭐⭐ BF T0 — THE ONE WRITE (ruling #375 item 3): every body of both teams carries this
   * match's facing depth. `BF_DEPTH` when the door is open, 0 when it is shut — and 0 is
   * what `Player`'s field is born with, so on the shipped path this method writes the
   * value that is already there and nothing downstream ever branches.
   * Called after `this.teams` is built and again after EVERY `becomeSub` (a substitute is
   * a new man in an old pitch slot; the bench itself holds no `Player` objects).
   */
  private setFacingDepth(): void {
    const depth = this.bfFacingCost ? BF_DEPTH : 0;
    for (const t of this.teams) for (const p of t.players) p.facingDepth = depth;
  }

  /** The injury sub (Phase 118): bypasses the rotation threshold — this
   * man is coming off NOW. Same bench budget and like-for-like pick as
   * trySubstitution; with nothing left he leaves anyway and the side
   * plays short (the send-off geometry, no red, no tally). */
  private forceSubstitution(out: Player): void {
    const team = this.teams[out.side];
    const available = team.bench.filter((b) => !b.used);
    if (team.subsUsed < SUBS_MAX && available.length > 0) {
      const sub = available.find((b) => b.role === out.role) ?? available[0];
      sub.used = true;
      team.subsUsed++;
      const offName = out.name;
      out.becomeSub(sub, v2(out.side === 0 ? -1.2 : 1.2, HALF_W - 0.6));
      this.setFacingDepth(); // ⭐ BF T0: the new man carries this match's depth too
      // ⭐ THE PRE-EXAM AMENDMENT (a) (#298 item 4): a sub inherits NOTHING. Dormant — the
      // seat is null in every production path.
      this.pcLatency?.forgetBody(out.gid);
      out.decisionTimer = 0.05;
      team.policies[out.index] = sub.policy;
      this.stat(out.gid).apps = 1;
      this.pushEvent('info', out.side, `🔄 ${sub.name} on for the injured ${offName}`);
      return;
    }
    this.removeFromPitch(out);
  }

  /**
   * The professional foul (Phase 29.1): a beaten defender hauls down a
   * breakaway carrier from behind. Unlike the failed-tackle foul (advantage
   * — the carrier KEPT the ball there), this one kills the move dead, so
   * the whistle genuinely blows: free kick where the carrier went down, and
   * the cynical foul is a near-automatic booking — the last man denying a
   * clear run occasionally sees straight red.
   */
  awardTacticalFoul(offender: Player, victim: Player): void {
    const team = this.teams[offender.side];
    team.stats.fouls++;
    this.pushEvent('foul', victim.side, `Cynical! ${offender.name} hauls down ${victim.name} on the break`);
    victim.stunTimer = 0.8; // brought down — picks himself up as the kick is set
    victim.kickCooldown = 0.4;
    if (offender.role !== 'GK') {
      if (this.rng.chance(0.03)) {
        this.pushEvent('card', offender.side, `STRAIGHT RED! ${offender.name} is sent off for the professional foul`);
        this.sendOff(offender);
      } else if (this.rng.chance(0.52)) {
        team.stats.yellows++;
        this.stat(offender.gid).yellows++;
        if (offender.booked) {
          this.pushEvent('card', offender.side, `Second yellow — ${offender.name} is SENT OFF`);
          this.sendOff(offender);
        } else {
          offender.booked = true;
          this.pushEvent('card', offender.side, `${offender.name} is booked for the cynical foul`);
        }
      }
    }
    const pos = v2(
      Math.max(-HALF_L + 2, Math.min(HALF_L - 2, this.ball.pos.x)),
      Math.max(-HALF_W + 1, Math.min(HALF_W - 1, this.ball.pos.y)),
    );
    this.awardRestart('freeKick', victim.side, pos);
    this.maybeInjure(victim); // hauled down hard (Phase 118)
  }

  /**
   * Offside whistle (Phase 29 → 31.6): stat against the offender's team,
   * feed line, and the ball to the DEFENDERS' KEEPER as a goal kick.
   * DELIBERATE law simplification (user call, 2026-07-12): the real award
   * is an indirect free kick at the offence spot, but at this match scale
   * that read as "a scrambly free kick somewhere in the defensive third" —
   * the goal-kick restart (keeper takes it, box clears, the team WAITS for
   * shape) is the calm reset the flag is FOR. The 🚩 offside flag keeps
   * the UI honest about why the keeper has the ball.
   */
  callOffside(offender: Player, _spot: V2): void {
    const attTeam = this.teams[offender.side];
    attTeam.stats.offsides++;
    const defSide = (1 - offender.side) as Side;
    // The trap school's visible face (Phase 115, the 109 debt): when a
    // committed trap side (the 'Offside trap' nameplate threshold) wins the
    // flag, the feed credits the SCHOOL, not the runner's error. Same one
    // line either way — no feed spam. Read from the RAW genome: identity,
    // not the mentality-bent view.
    const trap = this.teams[defSide].info.genome.trapBias ?? 0.5;
    this.pushEvent('foul', defSide, trap > 0.72
      ? `🪤 The trap springs — ${offender.name} caught by the ${this.teams[defSide].info.name} line`
      : `Offside — ${offender.name} (${attTeam.info.name})`);
    const goalLineX = -this.teams[defSide].attackDir * HALF_L;
    const pos = v2(goalLineX - Math.sign(goalLineX) * 7, 0);
    this.awardRestart('goalKick', defSide, pos);
    this.restart!.offside = true; // the UI labels the dead ball 🚩 offside
  }

  private awardRestart(kind: RestartKind, side: Side, pos: V2): void {
    // A free kick is always placed ON the pitch (Phase 46): a whistle can
    // catch the ball marginally over a line mid-scramble, and an unclamped
    // spot parked the dead ball out of bounds through the whole setup
    // (probed: x=45.06 for the full 8s timer). Refs put it on the line.
    if (kind === 'freeKick') {
      pos = v2(
        Math.max(-HALF_L + 0.2, Math.min(HALF_L - 0.2, pos.x)),
        Math.max(-HALF_W + 0.2, Math.min(HALF_W - 0.2, pos.y)),
      );
    }
    this.pendingControl = null;
    this.resolveContest(
      kind === 'kickIn' || kind === 'corner' || kind === 'goalKick'
        ? { kind: 'out', tick: this.stepCount }
        : { kind: 'deadBall', tick: this.stepCount },
    );
    const team = this.teams[side];
    // A shot that went out is a miss; any pass in flight is dead.
    this.markShotOutcome('miss');
    this.pendingShot = null;
    this.pendingPass = null;
    // The whistle ends any passing move (Phase 33).
    this.endPassMove(0);
    this.endPassMove(1);
    // A dead ball ends any corner crash still running (Phase 31.9) — and any
    // open-play cross licence, on the same reasoning (C4 T2-ARRIVAL).
    this.teams[0].cornerCrash = null;
    this.teams[1].cornerCrash = null;
    this.teams[0].crossFlight = null;
    this.teams[1].crossFlight = null;

    this.ball.owner = null;
    this.ball.pos = clone(pos);
    this.ball.vel = v2();
    this.ball.z = 0;
    this.ball.vz = 0;

    // The restart team is "in possession" for shape/marking purposes.
    this.possessionSide = side;
    team.possessionGainedAt = this.simTime;
    team.resetProgress(team.localX(pos.x));
    this.teams[0].brainTimer = Math.min(this.teams[0].brainTimer, 0.05);
    this.teams[1].brainTimer = Math.min(this.teams[1].brainTimer, 0.05);

    if (kind === 'corner') {
      team.stats.corners++;
      this.pushEvent('corner', side, `Corner — ${team.info.name}`);
    }

    this.restart = { kind, side, pos: clone(pos), timer: 0, takerGid: this.pickTaker(kind, side, pos) };
    this.phase = 'restart';

    // Substitutions happen at dead balls (Phase 61) — after the taker is
    // picked, so the man walking over is never the man walking off.
    this.trySubstitution(0);
    this.trySubstitution(1);

    // Free-kick wall (Phase 32): a danger-zone FK gets 2–3 defending
    // bodies assigned to the ball–goal line. Nearest outfielders take the
    // duty (they can actually arrive during setup); closer kicks earn the
    // bigger wall.
    this.fkWall = null;
    if (kind === 'freeKick') {
      const goal = v2(this.teams[side].attackDir * HALF_L, 0);
      const dGoal = dist(pos, goal);
      if (dGoal < 30 && dGoal > 8) {
        const defSide = (1 - side) as Side;
        const wallers = this.teams[defSide].players
          .filter((p) => p.role !== 'GK' && !p.sentOff)
          .map((p) => ({ p, d: dist(p.pos, pos) }))
          .sort((a, b) => a.d - b.d || a.p.index - b.p.index)
          .slice(0, dGoal < 19 ? 3 : 2);
        if (wallers.length > 0) {
          this.fkWall = { gids: wallers.map((w) => w.p.gid), pos: clone(pos), side: defSide, until: null };
        }
      }
    }
  }

  /**
   * The SUBSTITUTION (Phase 61, N2 — rotation as an EVOLVABLE strategy).
   * The substrate provides only the laws-of-the-game frame: subs happen
   * at dead balls, at most SUBS_MAX per match, no re-entry, keepers stay.
   * Everything strategic is DNA: WHEN is the coach's `rotationBias` read
   * as a fatigue threshold; WHO comes off is simply the tiredest body
   * below it; WHO comes on prefers the like-for-like nominal role — and
   * which attrs sit on the bench at all is the roster budget's evolvable
   * allocation (a deep bench is paid for by a shallower XI). Deterministic:
   * no rng draws, pure sim state.
   */
  private trySubstitution(side: Side): void {
    const team = this.teams[side];
    if (team.subsUsed >= SUBS_MAX) return;
    const available = team.bench.filter((b) => !b.used);
    if (available.length === 0) return;
    // rotationBias 0 → threshold 0.25 (ride the XI); 1 → 0.75 (carousel).
    const threshold = 0.25 + (team.info.genome.rotationBias ?? 0.5) * 0.5;
    let out: Player | null = null;
    for (let i = 1; i < TEAM_SIZE; i++) {
      const p = team.players[i];
      if (p.sentOff) continue;
      if (this.restart !== null && this.restart.takerGid === p.gid) continue;
      if (p.stamina >= threshold) continue;
      if (out === null || p.stamina < out.stamina) out = p;
    }
    if (out === null) return;
    const sub = available.find((b) => b.role === out!.role) ?? available[0];
    sub.used = true;
    team.subsUsed++;
    const offName = out.name;
    // Enter from the touchline by the halfway line (the bench side).
    out.becomeSub(sub, v2(side === 0 ? -1.2 : 1.2, HALF_W - 0.6));
    this.setFacingDepth(); // ⭐ BF T0: the new man carries this match's depth too
    // ⭐ THE PRE-EXAM AMENDMENT (a) (#298 item 4): a sub inherits NOTHING. Dormant — the seat
    // is null in every production path.
    this.pcLatency?.forgetBody(out.gid);
    out.decisionTimer = 0.05; // think on arrival, not a stale slot's cadence
    team.policies[out.index] = sub.policy;
    this.stat(out.gid).apps = 1;
    // The coach's call by name (Phase 66, N3) — the club keeps the credit
    // only when no coach travels with the team sheet (ad-hoc, old replays).
    const coach = team.info.coachName;
    this.pushEvent('info', side, coach
      ? `🔄 ${coach} sends on ${sub.name} for ${offName}`
      : `🔄 ${team.info.name}: ${sub.name} on for ${offName}`);
  }

  /**
   * GK takes goal kicks; the best finisher steps up for penalties;
   * otherwise the nearest outfielder walks over.
   */
  private pickTaker(kind: RestartKind, side: Side, pos: V2): number {
    const team = this.teams[side];
    if (kind === 'goalKick') return team.goalkeeper.gid;
    // Only outfielders still on the pitch take kicks; if (absurdly) all four
    // are sent off, the keeper steps up so resolution stays total.
    const eligible = team.players.filter((p) => p.role !== 'GK' && !p.sentOff);
    if (eligible.length === 0) return team.goalkeeper.gid;
    if (kind === 'penalty') {
      let taker = eligible[0];
      for (const p of eligible) {
        if (p.attrs.finishing > taker.attrs.finishing) taker = p;
      }
      return taker.gid;
    }
    // A danger-zone free kick belongs to the SPECIALIST (Phase 32): the
    // best striker of a dead ball steps up — among those who can ARRIVE.
    // An unbounded pick summoned the far full-back and the 6s failsafe
    // handed him the ball 6m short of the spot (probed: the strike left
    // from the wrong geometry entirely).
    if (kind === 'freeKick') {
      const goal = v2(this.teams[side].attackDir * HALF_L, 0);
      if (dist(pos, goal) < 30) {
        const reachable = eligible.filter((p) => dist(p.pos, pos) < 26);
        if (reachable.length > 0) {
          let taker = reachable[0];
          let bestS = -Infinity;
          for (const p of reachable) {
            const s = p.attrs.finishing + p.attrs.passing * 0.5;
            if (s > bestS) {
              bestS = s;
              taker = p;
            }
          }
          return taker.gid;
        }
      }
    }
    let best = eligible[0];
    let bestD = Infinity;
    for (const p of eligible) {
      const d = dist(p.pos, pos);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best.gid;
  }

  /**
   * A restart is live play with a dead ball: the taker walks to the spot
   * (their brain chases the stationary ball), defenders reshape but are held
   * out of the clearance circle, and once the taker arrives (or a failsafe
   * timeout passes) they get the ball with a must-kick first touch.
   */
  private stepRestart(dt: number): void {
    const r = this.restart!;
    r.timer += dt;
    const ball = this.ball;
    ball.owner = null;
    ball.pos = clone(r.pos);
    ball.vel = v2();
    ball.z = 0;
    ball.vz = 0;

    // Hold everyone who isn't part of the restart out of the clearance
    // circle (slide along its edge). Penalties clear a wider circle and it
    // applies to BOTH teams — only the taker and the defending keeper (who
    // stands on the line, outside the circle) are near the ball.
    const clearance =
      r.kind === 'penalty' ? PENALTY_CLEARANCE
      // Corners AND free kicks use the real-law 9.15m (Phase 31.9/32): at
      // 6m the FK arc had to float so high the deep defenders beat it to
      // the drop — the flatter flight over a law-distance wall is a shot.
      : r.kind === 'corner' || r.kind === 'freeKick' ? CORNER_CLEARANCE
      : RESTART_CLEARANCE;
    for (const o of this.allPlayers) {
      if (o.sentOff || o.gid === r.takerGid) continue;
      // Strikers HOLD THE LINE at their own goal kicks (Phase 71, user
      // report "站到对面球门里…开大脚完全没有越位" + the ruling that goal
      // kicks now play under normal offside): campers stranded deep by the
      // previous attack get walked back to the line during the setup, so
      // the punt is a flick-on contest, not a goalmouth cherry-pick. Must
      // run BEFORE the same-side skip below (teammates are otherwise free).
      if (r.kind === 'goalKick' && o.side === r.side && o.role !== 'GK') {
        const team = this.teams[r.side];
        const line = offsideLineLocalX(team, this.teams[1 - r.side].players, team.localX(this.ball.pos.x));
        const lx = team.localX(o.pos.x);
        if (lx > line - 0.3) {
          o.pos.x = (line - 0.3) * team.attackDir;
          o.vel.x *= 0.2; // braced at the line, like every restart clamp
        }
      }
      if (o.side === r.side && r.kind !== 'penalty') continue; // only penalties hold teammates
      if (o.side !== r.side && r.kind === 'penalty' && o.role === 'GK') continue; // keeper keeps the line
      // Wall members pass freely (Phase 32): their slot sits on the GOAL
      // side of the ball, so the walk to the wall crosses the circle — the
      // radial clamp read as a glass wall and no wall ever formed.
      if (this.fkWall?.gids.includes(o.gid)) continue;
      const d = dist(o.pos, r.pos);
      if (d < clearance) {
        const dir = d < 1e-6 ? v2(-this.teams[r.side].attackDir, 0) : norm(sub(o.pos, r.pos));
        o.pos = add(r.pos, scale(dir, clearance));
        o.pos.x = Math.max(-HALF_L + 0.3, Math.min(HALF_L - 0.3, o.pos.x));
        o.pos.y = Math.max(-HALF_W + 0.3, Math.min(HALF_W - 0.3, o.pos.y));
        // Braced at the line (Phase 28.3): kill the inward velocity too, or
        // the run animation plays while the clamp holds them still — legs
        // sprinting on a treadmill at the edge of the circle.
        o.vel.x *= 0.2;
        o.vel.y *= 0.2;
      }
      // Goal kicks (Phase 27.3): opponents must be OUT OF THE BOX until the
      // kick is taken — held at the edge, not camped on the six-yard line.
      if (r.kind === 'goalKick' && o.side !== r.side && this.inPenaltyBox(o.pos, r.side)) {
        const attackDir = this.teams[r.side].attackDir;
        o.pos.x = -attackDir * HALF_L + attackDir * (BOX_DEPTH + 0.4);
        o.vel.x *= 0.2; // braced, like the circle clamp — no treadmill
        o.vel.y *= 0.2;
      }
    }

    const taker = this.allPlayers[r.takerGid];
    // Corner routine (Phase 31): once the defensive picture has ~formed,
    // the taking side reads the box and commits to a routine — the runner
    // licenses and crash spots key off it for the rest of the setup.
    if (r.kind === 'corner' && r.routine === undefined && r.timer > 0.6) {
      r.routine = pickCornerRoutine(this, r);
    }
    // Kick-ins and corners breathe (Phase 28.1): the taker settles the ball
    // and both teams get a beat to shape up — instant touchline restarts
    // read as chaos, and the box picture needs time to form for a cross.
    const minSetup =
      r.kind === 'kickIn' ? 1.8
      : r.kind === 'corner' ? 2.0
      // A danger FK breathes (Phase 32): the wall needs ~2s to form and the
      // set-piece read as instant chaos without the pause. Quick option below.
      : r.kind === 'freeKick' && this.fkWall ? 2.2
      : RESTART_MIN_SETUP;
    let ready = dist(taker.pos, r.pos) < 1.3 && r.timer >= minSetup;
    // The QUICK free kick (Phase 32): if the taker arrives fast, the wall
    // has not formed yet, and an open teammate exists, play it NOW — real
    // football's punishment for a slow defensive reset.
    if (!ready && r.kind === 'freeKick' && this.fkWall && r.timer < 0.8 && dist(taker.pos, r.pos) < 1.3) {
      const goal = v2(this.teams[r.side].attackDir * HALF_L, 0);
      const wallCenter = add(r.pos, scale(norm(sub(goal, r.pos)), CORNER_CLEARANCE));
      let wallFormed = false;
      for (const gid of this.fkWall.gids) {
        if (dist(this.allPlayers[gid].pos, wallCenter) < 4) {
          wallFormed = true;
          break;
        }
      }
      if (!wallFormed) {
        // A CLEARLY open mate AHEAD of the ball only: half the danger FKs
        // went quick at looser gates and the wall-and-curler spectacle
        // never happened — a sideways quick kick is worth less than the
        // placed strike, so only a forward outlet justifies skipping it.
        const takerTeam = this.teams[r.side];
        for (const mate of takerTeam.players) {
          if (mate.gid === taker.gid || mate.sentOff) continue;
          if (takerTeam.localX(mate.pos.x) <= takerTeam.localX(r.pos.x) + 2) continue;
          if (opennessOf(mate, this.teams[1 - r.side].players) > 0.85) {
            ready = true;
            break;
          }
        }
      }
    }
    // The keeper WAITS for shape (Phase 30 step 3): a goal kick is not
    // struck until the outfielders settle near their attacking spots — the
    // kick finds SET receivers instead of gifting a midfield scramble.
    // Timeout-capped (pure sim-state, invariant 3); RESTART_TIMEOUT is the
    // outer failsafe either way.
    if (ready && r.kind === 'goalKick' && r.timer < minSetup + 4 && !shapeReady(this.teams[r.side], ball, 6, this.abandonRestDesignation === r.side)) {
      ready = false;
    }
    // The corner WAITS for its crashers (Phase 31 — the 30.3 pattern): a
    // delivery into empty zones is a delivery wasted (failure mode 14), so
    // the taker stands over the ball until at least two licensed runners
    // are attacking their crash spots. Timeout-capped like everything else.
    // The free kick WAITS for its wall (Phase 32, the corner crasher-wait
    // pattern): a reachable specialist arrives inside 2s while the wall
    // bodies may need 3 — striking early made the set piece a formality.
    // ON THEIR SLOTS (<1.5m), not merely nearby: a waller still 2m short
    // stands exactly where the climb crosses the header band and free-
    // headed the kick (probed at z 2.3-2.5, six seeds in thirty).
    // Timeout-capped; the QUICK option above already beat this gate.
    if (ready && r.kind === 'freeKick' && this.fkWall && r.timer < minSetup + 3) {
      const goal = v2(this.teams[r.side].attackDir * HALF_L, 0);
      const slots = fkWallSlots(r.pos, goal, this.fkWall.gids.length);
      let set = 0;
      this.fkWall.gids.forEach((gid, i) => {
        if (dist(this.allPlayers[gid].pos, slots[i]) < 1.5) set++;
      });
      if (set < Math.min(2, this.fkWall.gids.length)) ready = false;
    }
    if (ready && r.kind === 'corner' && r.timer < minSetup + 3.5) {
      const team = this.teams[r.side];
      const spots = cornerCrashSpots(r.routine, team.attackDir, r.pos.y);
      const ranked = [...team.runners].sort((a, b) => a - b);
      let set = 0;
      for (const idx of ranked) {
        const p = team.players[idx];
        if (dist(p.pos, spots[ranked.indexOf(idx) % 3]) < 7) set++;
      }
      if (set < Math.min(2, ranked.length)) ready = false;
    }
    // 门将上前 (Phase 35): the taker WAITS for his sprinting keeper — the
    // broadcast moment. The chase positioning already carried him to
    // halfway, so the last ~45m fit inside the extended window.
    const keeperUpWait = r.kind === 'corner' && this.teams[r.side].keeperUp;
    if (keeperUpWait && r.timer < 8) {
      const team = this.teams[r.side];
      if (team.localX(team.goalkeeper.pos.x) < HALF_L - 24) ready = false;
    }
    if (ready || r.timer >= (keeperUpWait ? 8.5 : RESTART_TIMEOUT)) {
      this.restart = null;
      this.phase = 'playing';
      this.restartKickGid = taker.gid;
      this.restartKickKind = r.kind;
      this.restartKickRoutine = r.kind === 'corner' ? r.routine ?? null : null;
      // Corner crash state survives the hand-off (Phase 31.9): the taker's
      // kick is still ~0.2–0.5s away and the delivery flies ~1.6s more —
      // without this, the licenses died HERE and the crashers turned back
      // toward their formation spots before the ball was struck.
      if (r.kind === 'corner') {
        const team = this.teams[r.side];
        team.cornerCrash = {
          routine: r.routine ?? 'farPost', y: r.pos.y, until: this.simTime + 2.8,
          runners: [...team.runners], arriver: team.arriver,
        };
      }
      this.giveBall(taker);
      taker.decisionTimer = 0.12; // kick promptly (giveBall's settle is for open play)
    }
  }

  /**
   * E2b-1R: refresh one body's percept at its own decision tick. Keepers are
   * excluded exactly as every other perception consumer excludes them.
   */
  private refreshPerception(p: Player): void {
    if (p.role === 'GK' || p.sentOff) return;
    let memory = this.perceptionMemories.get(p.gid);
    if (memory === undefined) {
      memory = createPerceptionMemory();
      this.perceptionMemories.set(p.gid, memory);
    }
    if (this.edsPerceivedChoice && this.edsEagerPerception) {
      // E3R2's reference path (E3's original): observe every visible body at
      // scan time, whether or not anybody asks. Kept only so the lazy path can
      // be pinned against it field for field.
      advancePerceptionMemory(
        this.perceptionTruth(), p.gid, this.edsAwareness, this.perceptionSeed, memory,
      );
      this.perceivedBalls.set(p.gid, memory.ball
        ? { ...memory.ball, ageTicks: this.stepCount - memory.ball.observedTick }
        : null);
      return;
    }
    // Consumption-scoped (ruling #10.3): the ball is the only percept anything
    // in the sim reads, so no squad-wide truth capture and no array build.
    const scanTickBefore = memory.nextScanTick;
    this.perceivedBalls.set(p.gid, observeBall(
      memory,
      { gid: p.gid, side: p.side, pos: p.pos, vel: p.vel, bodyDir: p.bodyDir, sentOff: p.sentOff },
      { pos: this.ball.pos, vel: this.ball.vel, ownerGid: this.ball.owner?.gid ?? null },
      this.stepCount,
      this.edsAwareness,
      this.perceptionSeed,
    ));
    // E3R2: the scan clock just fired for this body, so THIS is a moment its
    // eyes were open. Record the truth of the moment; the bodies in it are
    // observed only if something asks (ruling #13.3, perception is PULL).
    // P2 §2.3: the dormant EYE is a perception consumer too, so its observers
    // need their scan moments recorded or the pull would reconstruct from an
    // empty history and every body would believe he is alone. Disclosed in the
    // P2 contract's implementation notes; `stationEye` is null in production,
    // so the recorded condition is unchanged there.
    if ((this.edsPerceivedChoice || this.stationEye !== null)
      && memory.nextScanTick !== scanTickBefore) {
      this.recordObserverScanFrame(p.gid);
    }
  }

  /**
   * E3R2: record ONE scan moment for this observer — the truth of the moment his
   * eyes were open, replayed later by the pull. Pure code motion out of
   * `refreshPerception` (same three statements, same order), so that the O2 LOOK
   * can record a scan moment through the SAME recorder rather than a second one.
   * Draws no rng (`recordScanFrame` is a copy; `perceptionTruth` is a buffer refill).
   */
  private recordObserverScanFrame(gid: number): void {
    let ring = this.scanFrames.get(gid);
    if (ring === undefined) {
      ring = { frames: Array.from({ length: SCAN_FRAME_RING }, () => createScanFrame()), next: 0 };
      this.scanFrames.set(gid, ring);
    }
    recordScanFrame(ring.frames[ring.next], this.perceptionTruth());
    ring.next = (ring.next + 1) % SCAN_FRAME_RING;
  }

  /**
   * O2 T0 §SEAM (docs/world-model/O2-T0-DORMANT-SEAM.md): arm a LOOK.
   *
   * Called ONLY from the percept-path decision fork in `PlayerBrain` (the C5-T2
   * whether fork's own eligible-choice predicate, evaluated one step earlier),
   * and only when `o2Look` is armed. The body commits to standing and looking for
   * `O2_LOOK_TICKS` ticks: he plants, he does not act, and one scan moment is
   * recorded per tick — starting with THIS one, so the look begins with a look.
   *
   * It reads no truth, opens no channel and draws NO rng (I1). The refresh is
   * entirely a change of scan CADENCE through the existing recorder; what his
   * heading cannot cover stays uncovered (`visibleDistance`'s cone is applied
   * unchanged when the frames are replayed).
   */
  /**
   * ⭐⭐ CB T2 §SEAM — THE CHOSEN KNOCK, armed. The `armO2Look` idiom: the brain's decision
   * writes the seam CB-T0 already owns, and CB-T0's ONE fork in `stepBall` fires it at this
   * body's next owned tick (and consumes it). The arming is OVERWRITTEN by this body's own
   * next decision and WITHDRAWN by `clearTouchPastArming` if that decision no longer wants
   * the knock, so an aim can never fire stale.
   *
   * Called from exactly one place, and only when the choice seat exists — i.e. only when the
   * `cbChoiceSeat` door is armed AND the team's style gene is non-absent.
   */
  armTouchPast(p: Player, dir: Readonly<V2>, backHalf: boolean): void {
    this.forcedTouchPast = { gid: p.gid, dir: { x: dir.x, y: dir.y } };
    this.cbChoiceLedger.armings += 1;
    this.cbChoiceLedger.chosen += 1;
    if (backHalf) this.cbChoiceLedger.chosenBackHalf += 1;
  }

  /**
   * ⭐ CB T2 §SEAM — the withdrawal half of the arming, so no aim is ever one tick stale: a
   * body whose new decision is NOT a knock takes back any arming that names HIM. It can never
   * touch an arming naming anyone else.
   */
  clearTouchPastArming(p: Player): void {
    if (this.forcedTouchPast === null || this.forcedTouchPast.gid !== p.gid) return;
    this.forcedTouchPast = null;
    this.cbChoiceLedger.armingsCleared += 1;
  }

  armO2Look(p: Player): void {
    this.o2LookWindow = {
      gid: p.gid, startTick: this.stepCount, untilTick: this.stepCount + O2_LOOK_TICKS,
    };
    this.o2LookLedger.looks += 1;
    this.recordObserverScanFrame(p.gid);
    this.o2LookLedger.scans += 1;
  }

  /**
   * O2 T0 §SEAM: advance the live LOOK window by one tick — abort it if the body
   * no longer qualifies, close it at `untilTick`, otherwise record this tick's
   * scan moment. Every bail is an EXISTING channel (ownership, phase, stun,
   * sending-off); the seam adds no attack surface (the C7 I3 form). Dormant:
   * `o2Look` OFF ⇒ `o2LookWindow` is always null ⇒ never called.
   */
  private stepO2Look(): void {
    const w = this.o2LookWindow;
    if (!this.o2Look || w === null) return;
    const body = this.allPlayers.find((p) => p.gid === w.gid);
    if (body === undefined || this.ball.owner !== body) {
      this.o2LookLedger.abortedLoss += 1;
      this.o2LookWindow = null;
      return;
    }
    if (this.phase !== 'playing' || body.sentOff || body.stunTimer > 0 || body.role === 'GK') {
      this.o2LookLedger.abortedPhase += 1;
      this.o2LookWindow = null;
      return;
    }
    if (this.stepCount >= w.untilTick) {
      this.o2LookLedger.completed += 1;
      this.o2LookWindow = null;
      return;
    }
    this.recordObserverScanFrame(body.gid);
    this.o2LookLedger.scans += 1;
  }

  /**
   * OBM T0 §SEAM: record the policy this body just computed. Called ONLY from the
   * single `obmMovement` fork in `PlayerBrain.decideOffBall`, i.e. once per decision
   * per in-possession off-ball body — the M-OBM.4 cadence law, in code.
   * Draws no rng, reads no truth, changes no tick by itself.
   */
  setObmPolicy(gid: number, plane: ObmPlane): void {
    this.obmPolicies.set(gid, { plane, tick: this.stepCount });
  }

  /**
   * OBM T0 §SEAM: the plane position this body last decided on, or null if he never
   * decided one or if it is older than his own decision interval
   * (`OBM_POLICY_TTL_TICKS`, derived from `AI_INTERVAL / DT`). The TTL is the CAP
   * that keeps the executor — which runs EVERY tick — from ever pulling a percept:
   * the seat reads at the brain's cadence and the legs re-use what it read.
   * Null in every production path (nothing ever writes the map there).
   */
  obmPlaneFor(p: Player): ObmPlane | null {
    const entry = this.obmPolicies.get(p.gid);
    if (entry === undefined) return null;
    if (this.stepCount - entry.tick > OBM_POLICY_TTL_TICKS) return null;
    return entry.plane;
  }

  /** E3R2: this observer's recorded scan moments, oldest first. */
  private observerScanFrames(gid: number): ScanFrame[] {
    const ring = this.scanFrames.get(gid);
    if (ring === undefined) return [];
    const ordered: ScanFrame[] = [];
    for (let index = 0; index < SCAN_FRAME_RING; index++) {
      const frame = ring.frames[(ring.next + index) % SCAN_FRAME_RING];
      if (frame.tick >= 0) ordered.push(frame);
    }
    return ordered;
  }

  /**
   * E3: the reusable truth buffer, refilled in place. Only ever read by the
   * perception trunk, and only when the choice flag is on.
   */
  private perceptionTruth(): PerceptionTruth {
    const players = this.allPlayers;
    if (this.truthBuffer === null || this.truthBuffer.players.length !== players.length) {
      this.truthBuffer = {
        tick: this.stepCount,
        ball: { pos: v2(0, 0), vel: v2(0, 0), ownerGid: null },
        players: players.map((p) => ({
          gid: p.gid, side: p.side, pos: v2(0, 0), vel: v2(0, 0), bodyDir: v2(0, 0), sentOff: false,
        })),
      };
    }
    const buffer = this.truthBuffer;
    buffer.tick = this.stepCount;
    buffer.ball.pos.x = this.ball.pos.x;
    buffer.ball.pos.y = this.ball.pos.y;
    buffer.ball.vel.x = this.ball.vel.x;
    buffer.ball.vel.y = this.ball.vel.y;
    buffer.ball.ownerGid = this.ball.owner?.gid ?? null;
    for (let index = 0; index < players.length; index++) {
      const p = players[index];
      const into = buffer.players[index];
      into.gid = p.gid;
      into.side = p.side;
      into.pos.x = p.pos.x;
      into.pos.y = p.pos.y;
      into.vel.x = p.vel.x;
      into.vel.y = p.vel.y;
      into.bodyDir.x = p.bodyDir.x;
      into.bodyDir.y = p.bodyDir.y;
      into.sentOff = p.sentOff;
    }
    return buffer;
  }

  /**
   * E3: the snapshot ONE body reads at the moment it is asked a question — the
   * materialise half of the split, paid once per pass decision rather than once
   * per tick per body. Null when this body keeps no memory (keepers, sent off).
   */
  perceivedSnapshot(p: Player, scope: ReadonlySet<number> | null = null): PerceptionSnapshot | null {
    const memory = this.perceptionMemories.get(p.gid);
    if (memory === undefined) return null;
    const truth = this.perceptionTruth();
    if (!this.edsEagerPerception) {
      // E3R2: the pull. Everything this body's scans would have shown, computed
      // now, from the moments its eyes were actually open.
      reconstructBodyMemory(
        memory, this.observerScanFrames(p.gid), truth, p.gid, this.edsAwareness,
        this.perceptionSeed,
      );
    }
    return materialisePerceptionSnapshot(truth, p.gid, this.edsAwareness, memory, scope);
  }

  /**
   * E3: the reach profiles a pass evaluation prices bodies with. Physical
   * capability, not perception — the same profile set every probe built.
   */
  reachProfiles(): Map<number, KnownReachProfile> {
    const profiles = new Map<number, KnownReachProfile>();
    for (const p of this.allPlayers) {
      if (p.sentOff) continue;
      profiles.set(p.gid, { topSpeed: p.topSpeed, accel: p.accel, dribbling: p.attrs.dribbling });
    }
    return profiles;
  }

  /** M3: collect every contact claim from one immutable post-physics snapshot. */
  private collectGroundContactClaims(
    order: Player[],
    speed: number,
    deflectable: boolean,
  ): GroundContactClaim[] {
    const ball = this.ball;
    const claims: GroundContactClaim[] = [];
    for (const p of order) {
      if (p.sentOff || p.kickCooldown > 0 || p.stunTimer > 0) continue;
      const dx = p.pos.x - ball.pos.x;
      if (dx >= CONTROL_RADIUS || dx <= -CONTROL_RADIUS) continue;
      const dy = p.pos.y - ball.pos.y;
      if (dy >= CONTROL_RADIUS || dy <= -CONTROL_RADIUS) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= CONTROL_RADIUS) continue;
      const access = directBallAccess(p, ball, this.allPlayers, CONTROL_RADIUS);
      if (!access.canDirectlyContact) continue;

      const intended =
        this.pendingPass !== null &&
        this.pendingPass.targetGid === p.gid &&
        this.pendingPass.side === p.side;
      const maxSpeed = p.role === 'GK' ? GK_CONTROL_MAX_SPEED : intended ? 24 : CONTROL_MAX_SPEED;
      const kind = speed <= maxSpeed ? 'controlAttempt' : deflectable ? 'deflection' : null;
      if (kind === null) continue;

      const rvx = ball.vel.x - p.vel.x;
      const rvy = ball.vel.y - p.vel.y;
      const horizontalRelative = Math.sqrt(rvx * rvx + rvy * rvy);
      claims.push({
        player: p,
        access,
        reachMargin: access.sectorCenterReach - d,
        kind,
        relativeSpeed: horizontalRelative + Math.abs(ball.vz) * 0.6,
        incomingDir: horizontalRelative > 1e-8
          ? { x: rvx / horizontalRelative, y: rvy / horizontalRelative }
          : { x: -access.geometry.direction.x, y: -access.geometry.direction.y },
      });
    }
    // ⭐⭐ BK T1 §SEAM (1) — THE BODY STRIKE. One boolean on the flag-OFF path; the shipped
    // loop above is byte-untouched (its filter line is the census's own citation and stays
    // exactly as written). Dormant ⇒ no claim of kind `bodyStrike` can ever exist.
    if (this.bkContactLaw) this.bkCollectBodyStrikes(order, claims);
    return claims;
  }

  /**
   * ⭐⭐ BK T1 §SEAM — the lawful channel for the body the shipped claim filter drops.
   *
   * WHO: not `sentOff`; excluded by the filter above (`kickCooldown > 0 || stunTimer > 0`);
   * and NOT the ball's own `lastTouch` — the ball sitting inside the boot that just struck it
   * is a self-contact artefact, not 球穿身 (BK-C0 §3(b)'s own exclusion, verbatim in intent),
   * and it is what keeps `KICK_COOLDOWN`'s stated job — "lets passes leave" — intact.
   *
   * WHERE: inside his PHYSICAL SHELL, `coreRadius + ball.radius` — the `clearance`
   * expression `accessLineGeometry` already uses when this same core BLOCKS another body's
   * access line to the ball. NOT the 1.25 m `CONTROL_RADIUS` reach: a reach is a deliberate
   * stretch, and a body who has just kicked or is picking himself up makes none. He does not
   * reach for the ball — the ball hits him.
   *
   * NO ROLL. Existence is geometry (H-BK.2: rolls may decide contact QUALITY, never the
   * EXISTENCE of the chance). The oriented sector and the opponent screening in
   * `directBallAccess` are read for the contact NORMAL only and gate nothing: a ball inside
   * your torso does not care which way you face or who is standing beyond you.
   */
  private bkCollectBodyStrikes(order: Player[], claims: GroundContactClaim[]): void {
    const ball = this.ball;
    for (const p of order) {
      if (p.sentOff) continue;
      const cooling = p.kickCooldown > 0;
      if (!cooling && p.stunTimer <= 0) continue; // the shipped loop already claimed for him
      // ⭐⭐ THE ANTI-PINBALL ANCHOR (BK-T1 §COMMANDER CORRECTIONS item 2, ruling #308 —
      // "NAMED FRAGILITY OF RECORD"; the anchor it asked for, planted by R8, ruling #312
      // item 3). ⭐ THE NO-RE-STRIKE / ANTI-BUZZ PROPERTY OF THE ARMED WORLD — measured as
      // **818 → 46 strikes/match** — RESTS ON THIS ONE LINE. Without it the body that was just
      // struck is re-collected on the very next tick (he IS `ball.lastTouch`, and the strike
      // put him on `kickCooldown`, so the filter above hands him straight back to this loop)
      // and the ball buzzes inside him like a pinball.
      // ⚠ THE FRAGILITY, NAMED: the exclusion is read HERE, at CLAIM COLLECTION, while the
      // strike is applied LATER, at resolution — `bkApplyBodyStrike` is what assigns
      // `ball.lastTouch = p` (see its comment: "next tick the same body is excluded by the
      // `lastTouch` rule above"). ⇒ ANY future seam that REASSIGNS `ball.lastTouch` between
      // claim collection and strike resolution REOPENS THE BUZZ — silently, with a green
      // suite. If you add such a seam, this line is the thing you must re-derive first.
      // (Honesty note on the number: the 818/46 pair was MEASURED by toggling the CLOSING
      // condition below (BK-T1 §1) — it sizes the buzz, it does not apportion it between the
      // two guards. They are the anti-buzz PAIR: the closing test kills the
      // two-adjacent-cooling-bodies buzz, this line kills the same-body re-strike buzz.
      // §CORR 2 is the ruling of record on what THIS line carries.)
      if (p === ball.lastTouch) continue;
      const shell = p.coreRadius + ball.radius;
      const dx = p.pos.x - ball.pos.x;
      if (dx >= shell || dx <= -shell) continue;
      const dy = p.pos.y - ball.pos.y;
      if (dy >= shell || dy <= -shell) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= shell) continue;
      const access = directBallAccess(p, ball, this.allPlayers, CONTROL_RADIUS);
      const rvx = ball.vel.x - p.vel.x;
      const rvy = ball.vel.y - p.vel.y;
      // ⭐ THE CLOSING CONDITION — the engine's OWN M1 rule, stated at `resolveOverlaps`:
      // "Remove ONLY closing relative velocity along the contact normal: tangential motion
      // and already-separating pairs stay untouched." A ball moving OUT of the shell is not
      // striking this body, it is leaving him. Without it the shell buzzes: two adjacent
      // cooling bodies trade a barely-moving ball every tick. This is not a softening of the
      // existence claim — a flight that crosses a body always closes on him first.
      const n0 = access.geometry.direction; // body → ball
      if (rvx * n0.x + rvy * n0.y >= 0) continue;
      const horizontalRelative = Math.sqrt(rvx * rvx + rvy * rvy);
      claims.push({
        player: p,
        access,
        reachMargin: shell - d,
        kind: 'bodyStrike',
        relativeSpeed: horizontalRelative + Math.abs(ball.vz) * 0.6,
        incomingDir: horizontalRelative > 1e-8
          ? { x: rvx / horizontalRelative, y: rvy / horizontalRelative }
          : { x: -access.geometry.direction.x, y: -access.geometry.direction.y },
      });
      const led = this.bkContactLedger;
      if (cooling) led.strikeClaimsCooldown += 1; else led.strikeClaimsStunned += 1;
    }
  }

  /**
   * ⭐⭐ BK T1 §SEAM — resolving a body strike: the ball comes OFF him, and he gets nothing.
   *
   * THE OUTCOME IS THE SHIPPED DEFLECTION'S, with its EXISTENCE ROLL REMOVED. `tryDeflection`
   * ends `ball.vel = scale(rotate(norm(ball.vel), rng.range(-1.2, 1.2)), rng.range(4, 8))` —
   * the engine's own model of a ball knocked loose off a body that nobody controls. Two
   * derivations, no new quantity:
   *
   * * **the base direction is the contact NORMAL**, not the incoming line — `tryDeflection`
   *   rotates the incoming direction because a stretched leg meets a ball it read; a torso the
   *   ball runs into sends it back out along `directBallAccess`'s own body→ball normal, the
   *   same vector `applyControlContact` releases along. The DEFLECT family's own ±1.2 rad
   *   spread rides on it unchanged. Every carom therefore leaves the shell — the anti-pinball
   *   half of the design.
   * * **a passive body adds no pace**: the drawn 4–8 m/s is CAPPED by the speed the ball
   *   arrived with. A ball trickling into a stunned man's shin does not fly off at 8 m/s.
   *
   * Removed on purpose: no `pendingControl`, no `attemptFirstTouch`, no `giveBall`, no
   * `kickCooldown` reset, no `tackleAnimTimer` (that is a deliberate stretch, and this body
   * made none). A body that just kicked must not gain a superpower by being struck — and the
   * `CONTACT_*` cushion was rejected for exactly that reason: it kills a 20 m/s ball dead at
   * the feet of the one man who is not allowed to control it.
   *
   * `ball.lastTouch = p` is what a deflection off a body IS in football (it decides the
   * throw-in, and it is the engine's own record of who touched it last) — and it is also the
   * anti-pinball guard: next tick the same body is excluded by the `lastTouch` rule above.
   */
  private bkApplyBodyStrike(
    claim: GroundContactClaim,
    allClaims: readonly GroundContactClaim[],
  ): void {
    const ball = this.ball;
    const p = claim.player;
    const n = claim.access.geometry.direction;
    const incoming = Math.sqrt(ball.vel.x * ball.vel.x + ball.vel.y * ball.vel.y);
    // the DEFLECT family's own two draws, in its own order
    const spread = this.rng.range(-1.2, 1.2);
    const pace = Math.min(incoming, this.rng.range(4, 8));
    const cos = Math.cos(spread);
    const sin = Math.sin(spread);
    ball.vel.x = (n.x * cos - n.y * sin) * pace;
    ball.vel.y = (n.x * sin + n.y * cos) * pace;
    ball.lastTouch = p;
    this.pendingControl = null; // the deflection precedent: that attempt's ball is gone
    const led = this.bkContactLedger;
    led.strikesApplied += 1;
    if (p.kickCooldown > 0) led.strikesAppliedCooldown += 1; else led.strikesAppliedStunned += 1;
    if (claim.relativeSpeed > led.maxStrikeRelativeSpeed) {
      led.maxStrikeRelativeSpeed = claim.relativeSpeed;
    }
    this.traceContact(allClaims, p, 'body');
  }

  /** Contact changes the independent ball; it never assigns owner. */
  private applyControlContact(claim: GroundContactClaim, allClaims: readonly GroundContactClaim[]): void {
    const ball = this.ball;
    const p = claim.player;
    const n = claim.access.geometry.direction;
    const rvx = ball.vel.x - p.vel.x;
    const rvy = ball.vel.y - p.vel.y;
    const relativeNormal = rvx * n.x + rvy * n.y;
    const tx = rvx - relativeNormal * n.x;
    const ty = rvy - relativeNormal * n.y;
    const release = Math.min(
      CONTACT_RELEASE_MAX_SPEED,
      Math.max(
        CONTACT_RELEASE_MIN_SPEED,
        CONTACT_RELEASE_MIN_SPEED + Math.abs(relativeNormal) * CONTACT_RELEASE_INCOMING_SHARE,
      ),
    );
    // ⭐⭐ BQ T0 §SEAM — THE ONE SEAM (M-BK.5, ruling #384 item 5). Shipped: the cushion
    // pushes the ball OFF the foot — outward along the body→ball normal at `release`, plus
    // the tangential retention's share of whatever sideways motion the ball had — and three
    // ticks later the resolver wants it back inside the reach it was touched from, plus the
    // retention margin, so a contact made at the edge of reach loses by geometry before the
    // roll is ever asked (BQ-C1 §R2). Armed: the ball takes the body's
    // velocity and NOTHING else — the relative velocity after the touch is ZERO, and whether
    // the touch sticks is the ROLL's to say. `release`, `tx` and `ty` above are pure locals
    // (no rng, no state): on the flag-OFF path the two assignments below are the SHIPPED
    // expression, character for character, and the whole shipped-path delta is this branch
    // test (G-OFF proves the byte-identity rather than asserting it).
    if (!this.bqCushion) {
      ball.vel.x = p.vel.x + n.x * release + tx * CONTACT_TANGENTIAL_RETENTION;
      ball.vel.y = p.vel.y + n.y * release + ty * CONTACT_TANGENTIAL_RETENTION;
    } else {
      ball.vel.x = p.vel.x;
      ball.vel.y = p.vel.y;
    }
    ball.vz *= 0.25;
    ball.spin *= 0.4;
    ball.lastTouch = p;
    p.kickCooldown = Math.max(p.kickCooldown, CONTACT_COMMIT_TIME);
    this.traceContact(allClaims, p, 'controlAttempt');

    const flagged = this.pendingPass;
    if (flagged && flagged.offside && p.side === flagged.side && p.gid === flagged.targetGid) {
      this.pendingPass = null;
      this.pendingControl = null;
      this.resolveContest({ kind: 'deadBall', tick: this.stepCount });
      this.callOffside(p, flagged.offsideSpot ?? p.pos);
      return;
    }
    this.pendingControl = {
      gid: p.gid,
      readyTick: this.stepCount + CONTACT_CONTROL_DELAY_TICKS,
      relativeSpeed: claim.relativeSpeed,
      incomingDir: claim.incomingDir,
    };
  }

  private resolvePendingControlAttempt(): boolean {
    const attempt = this.pendingControl;
    if (attempt === null || this.stepCount < attempt.readyTick) return false;
    this.pendingControl = null;
    const p = this.allPlayers[attempt.gid];
    if (!p || p.sentOff || p.stunTimer > 0) return false;
    const access = directBallAccess(p, this.ball, this.allPlayers, CONTROL_RADIUS);
    // Screening gates the EARLIER contact claim. Once this body has actually
    // touched the ball, re-applying the blocker test makes two nearby cores
    // mutually veto control forever. A rival must submit a real new contact
    // during the window; mere presence does not cancel an established touch.
    if (access.geometry.centerDistance > access.sectorCenterReach + CONTACT_CONTROL_RETENTION_MARGIN) return false;
    p.kickCooldown = 0; // this player's contact commitment has completed
    const clean = mech.attemptFirstTouch(this, p, {
      relativeSpeed: attempt.relativeSpeed,
      incomingDir: attempt.incomingDir,
    });
    if (clean) this.giveBall(p);
    return true; // clean or spilled: this control attempt consumed the tick
  }

  private tryCapture(): void {
    if (this.resolvePendingControlAttempt()) return;
    const ball = this.ball;
    const speed = Math.hypot(ball.vel.x, ball.vel.y);
    // Lane anticipation remains for drilled passes, never shots.
    const shotInFlight = this.pendingShot !== null && !this.pendingShot.resolved;
    const deflectable = speed > CONTROL_MAX_SPEED && speed <= DEFLECT_MAX_SPEED && !shotInFlight;
    const order = this.stepCount % 2 === 0 ? this.allPlayers : this.allPlayersReversed;
    const claims = this.collectGroundContactClaims(order, speed, deflectable);
    const remaining = [...claims];

    // Reach margin is the physical first-contact mediator, not a duel score.
    // Exact ties keep the already-alternating snapshot order.
    while (remaining.length > 0) {
      let first = 0;
      for (let i = 1; i < remaining.length; i++) {
        if (remaining[i].reachMargin > remaining[first].reachMargin) first = i;
      }
      const claim = remaining.splice(first, 1)[0];
      const p = claim.player;
      if (claim.kind === 'bodyStrike') {
        // BK T1: existence is geometry — this branch has no roll and cannot `continue`.
        this.bkApplyBodyStrike(claim, claims);
        return;
      }
      if (claim.kind === 'deflection') {
        if (mech.tryDeflection(this, p)) {
          this.pendingControl = null;
          this.traceContact(claims, p, 'deflection');
          return;
        }
        continue; // a whiff is not contact; the next snapshot claim may meet it
      }

      const intended =
        this.pendingPass !== null &&
        this.pendingPass.targetGid === p.gid &&
        this.pendingPass.side === p.side;
      if (!intended && this.pendingPass !== null && speed > 7) {
        const bx = ball.vel.x / speed;
        const by = ball.vel.y / speed;
        const blind = (1 + (bx * p.heading.x + by * p.heading.y)) / 2;
        const pContact = Math.min(0.95, Math.max(
          0.1,
          (0.95 - (speed - 7) * 0.04) * (1 - blind * CONTACT_BLIND_PEN),
        ));
        if (!this.rng.chance(pContact)) {
          p.kickCooldown = 0.3;
          continue;
        }
      }
      this.applyControlContact(claim, claims);
      return;
    }
  }

  /* ---------------- player constraints ---------------- */

  private resolveOverlaps(): void {
    const ps = this.allPlayers;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.sentOff) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.sentOff) continue;
        // Cheap reject before the sqrt: √(x²+y²) ≥ |x| holds bitwise in IEEE
        // round-to-nearest, so |dx| or |dy| ≥ PLAYER_MIN_DIST guarantees the
        // d-check below would continue anyway. Most of the 45 pairs exit here.
        const dx = a.pos.x - b.pos.x;
        if (dx >= PLAYER_MIN_DIST || dx <= -PLAYER_MIN_DIST) continue;
        const dy = a.pos.y - b.pos.y;
        if (dy >= PLAYER_MIN_DIST || dy <= -PLAYER_MIN_DIST) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= PLAYER_MIN_DIST) continue;
        if (d < 1e-6) {
          a.pos.x += 0.02 * (i + 1);
          a.pos.y += 0.01;
          continue;
        }
        // Flat form of the old norm/scale/add push — same op order, in place.
        const k = (PLAYER_MIN_DIST - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        const px = nx * k;
        const py = ny * k;
        // A keeper stands their ground in their own box against opponents
        // (Phase 28): the carrier bounces off — nobody bulldozes the keeper
        // back into the net a half-push at a time.
        const gkA = a.role === 'GK' && b.side !== a.side && this.inPenaltyBox(a.pos, a.side);
        const gkB = b.role === 'GK' && a.side !== b.side && this.inPenaltyBox(b.pos, b.side);
        if (gkA && !gkB) {
          b.pos.x -= px * 2;
          b.pos.y -= py * 2;
        } else if (gkB && !gkA) {
          a.pos.x += px * 2;
          a.pos.y += py * 2;
        } else {
          a.pos.x += px;
          a.pos.y += py;
          b.pos.x -= px;
          b.pos.y -= py;
        }

        // M1 (World-Model Foundation): position-only separation left the
        // pair's velocity driving straight back into penetration next frame.
        // Remove ONLY closing relative velocity along the contact normal:
        // tangential motion and already-separating pairs stay untouched. Equal
        // bodies share the correction (mean normal velocity is conserved); an
        // anchored in-box keeper gives the whole correction to the opponent.
        // Pair order + one fixed pass remain the determinism contract — no
        // convergence tolerance or early-stop loop.
        const relativeNormal = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny;
        if (relativeNormal < 0) {
          const remove = -relativeNormal;
          if (gkA && !gkB) {
            b.vel.x -= nx * remove;
            b.vel.y -= ny * remove;
          } else if (gkB && !gkA) {
            a.vel.x += nx * remove;
            a.vel.y += ny * remove;
          } else {
            const half = remove / 2;
            a.vel.x += nx * half;
            a.vel.y += ny * half;
            b.vel.x -= nx * half;
            b.vel.y -= ny * half;
          }
        }
      }
    }
  }

  private clampPlayersToPitch(): void {
    for (const p of this.allPlayers) {
      if (p.sentOff) continue; // parked on the apron, outside the pitch
      p.pos.x = Math.max(-HALF_L + 0.3, Math.min(HALF_L - 0.3, p.pos.x));
      p.pos.y = Math.max(-HALF_W + 0.3, Math.min(HALF_W - 0.3, p.pos.y));
    }
  }

  /* ---------------- phases ---------------- */

  private setupKickoff(kickSide: Side): void {
    this.pendingControl = null;
    this.resolveContest({ kind: 'deadBall', tick: this.stepCount });
    this.phase = 'kickoff';
    this.phaseTimer = 0.9;
    this.kickoffSide = kickSide;
    this.pendingPass = null;
    this.markShotOutcome('miss');
    this.pendingShot = null;
    this.lastCompletedPass = null;
    this.restart = null; // a restart pending at half-time is simply not taken
    this.pendingOut = null; // drop any ball still coasting out (e.g. at the whistle)
    this.restartKickGid = null;
    this.restartKickKind = null;
    this.carryStart = null; // goal-channel telemetry resets with the dead ball
    this.bandInside = false;
    this.attackEntry = null;
    this.lastRestartKick = null;
    this.ball.reset();

    for (const team of this.teams) {
      team.mode = 'ResetShape';
      team.chasers.clear();
      team.marks.clear();
      for (const p of team.players) {
        if (p.sentOff) continue; // stays parked on the apron
        p.resetForKickoff(formationSpot(p, team, this.ball, team.side === kickSide, undefined, this.abandonRestDesignation === team.side));
        // Everyone starts in their OWN half at kickoff (27.5) — the base
        // striker spot sits past halfway and used to straddle the line.
        const lx = team.localX(p.pos.x);
        if (lx > -1.5) p.pos.x = -1.5 * team.attackDir;
      }
    }

    const kicking = this.teams[kickSide];
    // The striker kicks off; if he was sent off, the deepest remaining
    // outfielder steps in (keeper as the absurd-case failsafe).
    let st = kicking.goalkeeper;
    for (let i = TEAM_SIZE - 1; i >= 1; i--) {
      if (!kicking.players[i].sentOff) {
        st = kicking.players[i];
        break;
      }
    }
    st.pos = v2(-kicking.attackDir * 1.2, 0);
    st.heading = v2(kicking.attackDir, 0);
    st.decisionTimer = 0.05;
    this.kickoffKickGid = st.gid;
    this.ball.owner = st;
    this.ball.lastTouch = st;
    this.possessionSide = kickSide;
    kicking.possessionGainedAt = this.simTime;
    kicking.resetProgress(kicking.localX(this.ball.pos.x));
    this.pushEvent('kickoff', kickSide, `${kicking.info.name} kick off`);
  }

  private endMatch(): void {
    if (this.finished) return;
    // ⭐ DV T2-T0 §SEAM — THE WHISTLE. One last read of the public state (idempotent: a
    // repeat of an already-seen tick changes nothing), then every still-open label closes
    // with what it knows, because no further concession can arrive.
    if (this.dvLearn !== null) { this.dvLearnObserve(); this.dvLearn.flush(); }
    // ⭐ EK T0 §SEAM — THE WHISTLE. One last read of the public state (idempotent), then
    // every still-open hold label closes UNPUNISHED, because no further loss can arrive.
    if (this.ekHold !== null) { this.ekHoldObserve(); this.ekHold.flush(); }
    // ⭐ L3 T0 §SEAM — THE WHISTLE. One last sweep of the public state, then every window the
    // whistle truncated is CENSORED (out of the denominator, counted — never a zero).
    if (this.l3Defence !== null) { this.l3DefenceObserve(); this.l3Defence.flush(); }
    this.pendingControl = null;
    this.resolveContest({ kind: 'stillLoose', tick: this.stepCount });
    this.markShotOutcome('miss'); // a shot in flight at the whistle didn't go in
    this.endPassMove(0);
    this.endPassMove(1);
    // Fold per-player physical output into team stats.
    for (const team of this.teams) {
      for (const p of team.players) {
        team.stats.distance += p.distance;
        team.stats.staminaSpent += p.staminaSpent;
      }
    }
    // Match ratings (Phase 33): written once, at the whistle — MatchResult
    // carries them, so the League and the feed read the same numbers. Only
    // players who actually APPEARED are rated (Phase 61: bench rows that
    // never came on stay at 0 — "didn't play", not "played badly").
    const diff = this.score[0] - this.score[1];
    this.playerStats.forEach((s, ri) => {
      if (s.apps > 0) s.rating = matchRating(s, ri < ROSTER_SIZE ? diff : -diff);
    });
    this.phase = 'fulltime';
    this.finished = true;
    this.pushEvent(
      'fulltime',
      -1,
      `Full time: ${this.teams[0].info.name} ${this.score[0]}–${this.score[1]} ${this.teams[1].info.name}`,
    );
    // Man of the match: best rating, goals then earlier roster row break ties.
    let motm = 0;
    this.playerStats.forEach((s, ri) => {
      const b = this.playerStats[motm];
      if (s.rating > b.rating || (s.rating === b.rating && s.goals > b.goals)) motm = ri;
    });
    const motmSide: Side = motm < ROSTER_SIZE ? 0 : 1;
    this.pushEvent('info', motmSide, `⭐ Man of the match: ${this.rosterNames[motm]} (${this.playerStats[motm].rating.toFixed(1)})`);
  }
}
