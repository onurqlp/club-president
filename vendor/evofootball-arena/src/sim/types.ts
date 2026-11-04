import type { V2 } from '../utils/vec';
import type { TacticalGenome } from '../evolution/genome';
import type { PlayerAttributes } from '../evolution/playerGenome';

export type Side = 0 | 1;

/**
 * First-class possession phase (S0 — docs/SUBSTRATE-MAP.md). A DERIVED, read-only
 * classification of who has the ball RIGHT NOW, making the implicit `owner===null`
 * scramble explicit + testable. Introduced (slice-1a) as pure observation — nothing
 * in the decision path reads it yet, so it is bit-identical. Later cuts drive the
 * physical 50-50 contest off `contested`, replacing the instant 1.25m owner-flip.
 */
export type PossessionPhase =
  | { kind: 'controlled'; side: Side; gid: number }
  | { kind: 'contested'; near: [number, number] } // bodies within CONTEST_RADIUS, per side
  | { kind: 'loose'; likelyFirst: Side | -1 }
  | { kind: 'deadBall' };
export type Role = 'GK' | 'DF' | 'MF' | 'WG' | 'ST';
/**
 * Squad slot order (Phase 30: 6v6). The Role SET is unchanged — WG simply
 * appears twice (slot 3 = left winger, slot 4 = right winger; two wings was
 * the whole point of the 6th player). Everything player-array-shaped
 * (playerNames, squad, ages, careers, playerAgg, cup.playerGoals) is indexed
 * by this list; gid = side * TEAM_SIZE + index.
 */
export const ROLES: Role[] = ['GK', 'DF', 'MF', 'WG', 'WG', 'ST'];
export const TEAM_SIZE = ROLES.length;

/**
 * The BENCH (Phase 61, N2): a club's roster is the starting six plus three
 * substitutes. Bench slots carry NOMINAL roles (market matching, records,
 * founding bias) — on the pitch a substitute ASSUMES the slot he replaces,
 * exactly like a midfielder covering at wing. Everything player-array-shaped
 * at the FRANCHISE level (playerNames, squad, squadStyles, ages, careers,
 * playerAgg, cup.playerGoals) is ROSTER_SIZE long; the on-pitch world
 * (gids, formations, marks) stays TEAM_SIZE. MatchResult.playerStats is
 * roster-indexed so a substitute's goals land on HIS career, not his slot's.
 */
export const BENCH_ROLES: Role[] = ['DF', 'MF', 'ST'];
export const ROSTER_ROLES: Role[] = [...ROLES, ...BENCH_ROLES];
export const ROSTER_SIZE = ROSTER_ROLES.length;
/** Substitutions allowed per team per match (no re-entry). */
export const SUBS_MAX = 3;

export type TeamMode = 'BuildUp' | 'Attack' | 'Defend' | 'Press' | 'CounterAttack' | 'ResetShape';

/**
 * Formation system (Phase 30): every team owns a FIXED attacking formation,
 * a FIXED defending formation and a marking scheme — its tactical identity,
 * shown on the team card and inherited through rebirth. Names read as
 * outfield lines from the back (the keeper is implicit).
 */
/**
 * The attack-shape library (Phase 67, N5). The two CLASSIC shapes are what
 * founders derive and what most clubs play; the NOVEL shapes ('twin-st',
 * 'false-nine') can only be DISCOVERED — they enter through the rare style
 * mutation at reduced weight (the zonal entry lesson) and survive purely on
 * results. Structural diversity is earned, never seeded.
 */
export type AttackFormationId =
  | 'wide-212' | 'narrow-122' | 'twin-st' | 'false-nine' | 'overload' | 'target-man';
export type DefendFormationId = 'low-32' | 'press-23' | 'mid-41' | 'high-line';
export type MarkScheme = 'man' | 'zonal';

export interface TeamStyle {
  formationAtk: AttackFormationId;
  formationDef: DefendFormationId;
  scheme: MarkScheme;
}

/**
 * Derive a team's tactical identity from its genome — legible thresholds on
 * the genes that already MEAN width, pressing and marking, so the identity
 * is the DNA's readout, not a separate random draw. Called once at franchise
 * creation/rebirth and STORED (mid-life gene mutation must not flip a
 * club's formation every season — switching is Phase 31's explicit,
 * lineage-logged mutation).
 */
export function deriveTeamStyle(genome: TacticalGenome): TeamStyle {
  return {
    formationAtk: genome.attackingWidth >= 0.5 ? 'wide-212' : 'narrow-122',
    formationDef: genome.pressIntensity >= 0.5 ? 'press-23' : 'low-32',
    // Zonal is the RARE identity (~1 in 5 clubs): a parked zone lattice is
    // structurally much harder to score on than man-marking (measured ~3.5
    // vs ~8 shots conceded — man-markers get DRAGGED out of shape, zones
    // don't), so a 50/50 league collapsed to 1.1 goals/match. Rare keeps
    // the texture ("the league's zone side") without sinking the league.
    scheme: genome.markingAggression >= 0.3 ? 'man' : 'zonal',
  };
}

export type ActionType =
  | 'MoveToFormationSpot'
  | 'MoveToPoint'
  | 'TrackRelativePoint'
  | 'ChaseBall'
  | 'ReceivePass'
  | 'MakeRun'
  | 'MarkOpponent'
  | 'InterceptPass'
  | 'SupportBallCarrier'
  | 'Dribble'
  | 'Pass'
  | 'LoftedPass'
  | 'ThroughBall'
  | 'Cross'
  | 'ThrowOut'
  | 'HoldUp'
  /** C5 T0: the generalized shield-hold. Dormant — reachable only through
   *  `Match.forcedHold` while `c5Hold` is armed. Legacy `HoldUp` is untouched. */
  | 'ShieldHold'
  | 'Shoot'
  | 'ClearBall'
  | 'GoalkeeperSave'
  | 'GoalkeeperPosition'
  | 'GoalkeeperRush'
  | 'HoldPosition';

/** One scored candidate from utility evaluation — kept for the debug panel. */
export interface UtilityScore {
  action: ActionType;
  score: number;
  /** Short human-readable factor breakdown, e.g. "lane 0.8 · open 0.6 · passBias×1.3". */
  why: string;
}

export interface ActionState {
  type: ActionType;
  /** Static target (dribble direction, clear direction...). Dynamic targets are recomputed each frame. */
  targetPos?: V2;
  /** Moving-player reference for the dormant generic TrackRelativePoint primitive. */
  relativeToGid?: number;
  /** x = attack-frame forward metres; y = fixed pitch-axis lateral metres. */
  relativeOffset?: V2;
  /** Opponent index (for marking) or teammate gid (for receive). */
  targetIdx?: number;
  /** Top candidates from the last decision, for explainability. */
  scores: UtilityScore[];
  /**
   * ⭐⭐ RC T0b (dormant, `rcReady`) — THE READY OVERLAY: the gid of the same-side carrier
   * this body chose to open his body toward BEFORE the ball is struck. It is an OVERLAY on a
   * plan, never a plan: `type` above stays the runner-up's own action type, so every
   * exhaustive map over `ActionType`, the PC seat's `remember`, PT-C0's classes and the stats
   * see the plan the body actually runs. ⛔ ABSENT on every shipped path — the property is
   * written only inside the flag's own fork, so a shut world's action records are
   * byte-identical.
   */
  readyFaceGid?: number;
  /**
   * ⭐⭐ RC T0b §FIX (dormant, `rcReady`; ruling #379 items 3 and 5) — THE TRADE'S BENEFIT:
   * `w · belief · s_receive`, what this body believes opening up toward `readyFaceGid` is
   * worth. ⚠ UNIT-NAME TRUTH (canon, home: ruling #294 item 3 — "a field carries the unit its
   * name claims"): it is a PRIORITY in the utility menu's own currency — the same currency as
   * `scores[i].score` — and therefore DIMENSIONLESS; it is not a probability (the belief alone
   * is), not a speed and not a distance. `actionExecutor` compares it against the movement's
   * forfeited speed fraction `(1 − f(φ)) · S_move`, quoted in that same currency. ⛔ ABSENT on
   * every shipped path — written only inside the flag's own fork, always beside
   * `readyFaceGid`, never without it.
   */
  readyBenefit?: number;
}

export interface KitColors {
  primary: number;
  secondary: number;
}

/**
 * Utility-policy weights (Phase 18): the hand-tuned constants of the
 * PlayerBrain scorers, exposed as data so a "wildcard" team can carry a
 * LEARNED policy. DEFAULT_POLICY holds the exact literals the brain always
 * used — a team without an explicit policy is bit-identical to before.
 */
export interface PolicyParams {
  shootBase: number;
  shootGene: number;
  shootModeMul: number;
  shootPressurePen: number;
  passBase: number;
  passLaneW: number;
  passOpenW: number;
  passFwdBase: number;
  passFwdRisk: number;
  passBackPen: number;
  passOutletMul: number;
  dribbleBase: number;
  dribbleSpaceW: number;
  dribbleGeneBase: number;
  dribbleGeneW: number;
  dribblePressurePen: number;
  clearBase: number;
  clearPressureW: number;
  supportBase: number;
  supportProxW: number;
  formationBase: number;
  chaseBase: number;
  markBase: number;
  interceptScore: number;
  /** Off-ball attacking run priority (assigned runners, Phase 19). */
  runScore: number;
  /** Through-ball scoring: base + open-lane and behind-the-line weights. */
  throughBase: number;
  throughOpenW: number;
  throughBehindW: number;
  /** Cross scoring (Phase 28): base + weight on the best box target. */
  crossBase: number;
  crossBoxW: number;
  /** Lofted switch scoring: base + weight on the receiver's open space. */
  loftBase: number;
  loftOpenW: number;
  /** Long-range shot appetite bonus (16–30m, scaled by shootBias). */
  longShotW: number;
  /** Combo appetites (Phase 45): multipliers on the 套路 trigger gates —
   * 2过1 license / third-man bounce bonus / 套边 overlap license. */
  wallPassW: number;
  thirdManW: number;
  overlapW: number;
}

export const DEFAULT_POLICY: PolicyParams = {
  shootBase: 1.9,
  shootGene: 2.2,
  shootModeMul: 1.2,
  shootPressurePen: 0.25,
  passBase: 0.2,
  passLaneW: 0.3,
  passOpenW: 0.2,
  passFwdBase: 0.35,
  passFwdRisk: 0.75,
  passBackPen: 0.25,
  passOutletMul: 1.15,
  dribbleBase: 0.28,
  dribbleSpaceW: 0.55,
  dribbleGeneBase: 0.45,
  dribbleGeneW: 1.0,
  dribblePressurePen: 0.35,
  clearBase: 0.12,
  clearPressureW: 0.55,
  supportBase: 0.3,
  supportProxW: 0.35,
  formationBase: 0.45,
  chaseBase: 0.85,
  markBase: 0.62,
  interceptScore: 0.95,
  runScore: 0.95,
  throughBase: 0.22,
  throughOpenW: 0.35,
  throughBehindW: 0.52,
  crossBase: 0.26,
  crossBoxW: 0.5,
  loftBase: 0.14,
  loftOpenW: 0.38,
  // 0.38 -> 0.55 in Phase 30.4: set defences (formations + zonal) park the
  // block, and the realistic answer to a parked block is shooting over it.
  longShotW: 0.55,
  // Combo appetites (Phase 45): 1.0 = the Phase-34 hand-tuned behavior;
  // per-franchise evolution moves them so combo-heavy vs combo-averse
  // styles are EARNED by selection, not set.
  wallPassW: 1.0,
  thirdManW: 1.0,
  overlapW: 1.0,
};

/** Everything a Match needs to know about one participating team. */
export interface TeamInfo {
  id: string;
  name: string;
  short: string;
  colors: KitColors;
  /** Surnames in slot order [GK, DF, MF, WGL, WGR, ST]. */
  playerNames: string[];
  genome: TacticalGenome;
  /** Per-player attribute genes in slot order [GK, DF, MF, WGL, WGR, ST]. */
  squad: PlayerAttributes[];
  /** Player ages in role order (Phase 26) — display only, never read by the sim. */
  ages?: number[];
  /**
   * The named coach in the dugout (Phase 66, N3) — feed attribution and the
   * 3D touchline figure only, never read by mechanics. Missing (ad-hoc
   * teams, old replays) = the calls stay credited to the club.
   */
  coachName?: string;
  /**
   * Tactical identity (Phase 30). Optional: a TeamInfo without one (tests,
   * ad-hoc teams) derives it from the genome — same thresholds, same result.
   */
  style?: TeamStyle;
  /**
   * Club Elo at kickoff (Phase 64): the strength READING the underdog
   * shift bends against. Missing on either side = nobody shifts (ad-hoc
   * teams, probes and old replays keep pure-identity tactics).
   */
  elo?: number;
  /** Confidence carried into the match (Phase 111) — 0.5 when absent, so
   * ad-hoc teams, probes and old replays play at neutral morale. */
  morale?: number;
  /** Evolvable / learned utility-policy weights; MISSING keys fall back to
   * DEFAULT_POLICY (Phase 42 franchises carry the attacking-style subset). */
  policy?: Partial<PolicyParams>;
  /**
   * Per-slot policy vectors in slot order [GK, DF, MF, WGL, WGR, ST]
   * (Phase 23; since Phase 54 the personal-style wire: the coach's policy
   * run through each player's own appetites). A missing entry falls back
   * to `policy` (then DEFAULT_POLICY), so a team without this field is
   * bit-identical to the shared-policy path; missing KEYS read as the
   * hand-tuned defaults.
   */
  rolePolicies?: Partial<PolicyParams>[];
  /**
   * Match-day availability (Phase 62 — suspensions): roster rows in playing
   * order — first TEAM_SIZE start (slot order, a banned starter's row
   * replaced by his bench cover), the rest are the available bench. All
   * other TeamInfo arrays stay ROSTER-ordered; this is the only reordering.
   * Missing = everyone available = [0..n-1], bit-identical to Phase 61.
   */
  lineup?: number[];
}

export type MatchPhase = 'kickoff' | 'playing' | 'restart' | 'goalPause' | 'halftime' | 'fulltime';

/**
 * Dead-ball restart kinds. Futsal-style kick-ins (not throws) from the
 * touchline; free kicks and penalties are awarded for fouls (Phase 20).
 */
export type RestartKind = 'kickIn' | 'corner' | 'goalKick' | 'freeKick' | 'penalty';

/**
 * Corner routines (Phase 31): each is a target-spot table plus which
 * box-crash runners attack it. Chosen by the taking side once the
 * defensive picture forms, from the openness of each routine's key zone.
 */
export type CornerRoutine = 'nearPost' | 'farPost' | 'short' | 'arcCutback';

/**
 * GOAL CHANNEL (Phase 113): what CREATED a goal — the launch-anatomy
 * probe's classes, gone player-facing. Priced at shot time from telemetry
 * the match already keeps (zero RNG, zero behavior), one exclusive bucket
 * per goal, priority top-down:
 *   setpiece — within 6s of a corner / free kick / penalty kick
 *   keeper   — a fresh final-15m breakaway entry launched by the keeper's
 *              distribution (the phase-98 roll/sling/punt)
 *   through  — the entry came on a ball IN BEHIND (ground through-ball or
 *              the lofted launch — the trap school's prey, both timings)
 *   carry    — the carrier dribbled through the line himself (>2.2s, >9m)
 *   cross    — entered on a cross, or served by a cross/cutback at the shot
 *   walkin   — a breakaway entry with no classifiable service: the line
 *              was simply BEATEN (short pass into space, loose ball, ...)
 *   buildup  — everything else (worked goals against a set line; also the
 *              own-goal/scramble fallback when no tracked shot scored)
 */
export type GoalChannel =
  | 'setpiece' | 'keeper' | 'through' | 'carry' | 'cross' | 'walkin' | 'buildup';

export const GOAL_CHANNELS: readonly GoalChannel[] = [
  'setpiece', 'keeper', 'through', 'carry', 'cross', 'walkin', 'buildup',
];

export const emptyChannels = (): Record<GoalChannel, number> => ({
  setpiece: 0, keeper: 0, through: 0, carry: 0, cross: 0, walkin: 0, buildup: 0,
});

export interface RestartState {
  kind: RestartKind;
  /** Team taking the restart. */
  side: Side;
  pos: V2;
  /** Sim-seconds since the restart was awarded. */
  timer: number;
  /** The player walking over to take it (GK for goal kicks). */
  takerGid: number;
  /** Corner routine (Phase 31) — picked mid-setup, undefined until then. */
  routine?: CornerRoutine;
  /**
   * Display only (Phase 29): this free kick is an offside award — the UI
   * labels it 🚩 offside instead of ⚠ free kick (since 27.2 outfield fouls
   * play advantage, so offside is the ONLY source of free kicks; without
   * the flag every whistle read as "fouls are back").
   */
  offside?: boolean;
}

export type EventType =
  | 'goal'
  | 'shot'
  | 'save'
  | 'woodwork'
  | 'interception'
  | 'tackle'
  | 'keypass'
  | 'corner'
  | 'foul'
  | 'card'
  | 'kickoff'
  | 'halftime'
  | 'fulltime'
  | 'info';

export interface MatchEvent {
  t: number;
  /** Display minute (sim time scaled to a 90' clock). */
  minute: number;
  type: EventType;
  /** -1 for neutral events. */
  side: Side | -1;
  text: string;
}

export interface TeamMatchStats {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  /** Direct balls played into a runner's path (subset of passes). */
  throughBalls: number;
  /** Passes played ≥2m toward the opponent goal (subset of passes, Phase 27). */
  passesForward: number;
  /** First touches that got away from the receiver (forced errors, Phase 27). */
  miscontrols: number;
  /** Lofted balls whipped into the box from wide (Phase 28). */
  crosses: number;
  /** Byline pull-backs driven to the edge-of-box arc (Phase 31). */
  cutbacks: number;
  /** Goals within 5s of a completed cutback (Phase 31 — the payoff metric). */
  cutbackGoals: number;
  /** First-time passes — struck inside a pressured reception's one-touch
   * window, with the technique-priced accuracy penalty (Phase 31.9). */
  oneTouch: number;
  /** Aerial duels won — headed shots, clears and knockdowns (Phase 28). */
  headersWon: number;
  /** Lofted long deliveries — switches/diagonals + chipped through balls (Phase 28). */
  longBalls: number;
  keyPasses: number;
  interceptions: number;
  tackles: number;
  /** Shots thrown a body in front of (Phase 31) — the blocked drive becomes a loose ball. */
  blocks: number;
  clearances: number;
  saves: number;
  dribbles: number;
  corners: number;
  /** Fouls committed — each hands the opponents a free kick or penalty. */
  fouls: number;
  /** Offside flags against this team (Phase 29) — free kick to the opponents. */
  offsides: number;
  /** Penalties won (fouled inside the opponents' box). */
  penalties: number;
  /** Bookings picked up (a second yellow counts here AND as a red). */
  yellows: number;
  /** Players sent off — the team plays a man short from that moment. */
  reds: number;
  possessionTime: number;
  distance: number;
  staminaSpent: number;
  /** Longest chain of consecutive completed passes in one move (Phase 33). */
  bestPassChain: number;
  /** Completed give-and-gos: the wall return found the bursting passer (Phase 34). */
  oneTwos: number;
  /** Completed third-man releases: fresh receiver → bounce → runner (Phase 34). */
  thirdMan: number;
  /** Completed overlap releases: the wide ball found the overlapping runner (Phase 34). */
  overlaps: number;
  /** Goals scored by channel (Phase 113) — the against side is the opponent's row. */
  goalChannels: Record<GoalChannel, number>;
  /** Injuries suffered this match (Phase 118) — knocks + serious together. */
  injuries: number;
}

export const emptyStats = (): TeamMatchStats => ({
  goals: 0,
  shots: 0,
  shotsOnTarget: 0,
  xg: 0,
  passes: 0,
  passesCompleted: 0,
  throughBalls: 0,
  passesForward: 0,
  miscontrols: 0,
  crosses: 0,
  cutbacks: 0,
  cutbackGoals: 0,
  oneTouch: 0,
  headersWon: 0,
  longBalls: 0,
  keyPasses: 0,
  interceptions: 0,
  tackles: 0,
  blocks: 0,
  clearances: 0,
  saves: 0,
  dribbles: 0,
  corners: 0,
  fouls: 0,
  offsides: 0,
  penalties: 0,
  yellows: 0,
  reds: 0,
  possessionTime: 0,
  distance: 0,
  staminaSpent: 0,
  bestPassChain: 0,
  oneTwos: 0,
  thirdMan: 0,
  overlaps: 0,
  goalChannels: emptyChannels(),
  injuries: 0,
});

/** Per-player counters for awards/records — passive, never read by the sim. */
export interface PlayerMatchStats {
  /**
   * Appearances (Phase 61): 1 if this roster member was on the pitch at any
   * point this match, 0 otherwise. Before the bench everyone played every
   * match, so rating averages divided by team matches; now they divide by
   * apps (a two-cameo bench player is a 2-app average, not a 30-match one).
   */
  apps: number;
  goals: number;
  assists: number;
  shots: number;
  saves: number;
  recoveries: number;
  /** First touches that got away (Phase 33 — the rating's malus side). */
  miscontrols: number;
  /**
   * Personal discipline (Phase 62, CARDS THAT BIND): bookings and sendings-
   * off now belong to the MAN, not just the team tally — the league's
   * suspension system reads these. A second yellow counts in both fields
   * (mirrors the team-stats convention).
   */
  yellows: number;
  reds: number;
  /**
   * Match rating on the 6.0–10.0 scale, written once at full time
   * (`sim/ratings.ts`). In `League.playerAgg` this field accumulates the
   * season SUM — divide by matches played for the average.
   */
  rating: number;
}

export const emptyPlayerStats = (): PlayerMatchStats => ({
  apps: 0,
  goals: 0,
  assists: 0,
  shots: 0,
  saves: 0,
  recoveries: 0,
  miscontrols: 0,
  yellows: 0,
  reds: 0,
  rating: 0,
});

export interface MatchResult {
  score: [number, number];
  stats: [TeamMatchStats, TeamMatchStats];
  /**
   * ROSTER-indexed (Phase 61): 0..ROSTER_SIZE-1 home, ROSTER_SIZE.. away.
   * A substitute's counters land on HIS roster row, not his slot's — the
   * career/award pipeline reads people, the pitch reads slots. Unused bench
   * rows stay empty (apps 0, rating 0).
   */
  playerStats: PlayerMatchStats[];
  /** Rounds out per roster row (Phase 118, same addressing as playerStats);
   * 0 = fit. Optional: old replays/ad-hoc results simply lack it. */
  injuries?: number[];
  events: MatchEvent[];
  duration: number;
}
