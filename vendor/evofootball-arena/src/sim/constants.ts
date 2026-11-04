/** All simulation units are meters / seconds. Coordinates: origin at pitch
 * center, +x toward the right goal, +y downward on screen. Team 0 attacks +x,
 * team 1 attacks -x (no side swap at half time — keeps formation math simple).
 *
 * Boundaries are real (Phase 14): a ball over the touchline is a kick-in,
 * over the goal line a corner or goal kick. Restarts are live dead-ball
 * phases — the clock runs while the taker walks over and defenders reshape.
 */
/** Read a positive probe-only scale without introducing browser assumptions. */
const positiveEnv = (key: string): number | undefined => {
  const raw = typeof process !== 'undefined' && process.env ? Number(process.env[key]) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
};

/**
 * World-model parameter authority (M0, docs/world-model/FOUNDATION.md).
 *
 * `PITCH_SCALE` used to couple field density, goal width, penalty-box geometry,
 * and the centre circle. These independent dimensions are backfilled to the
 * exact values that shipped before M0: field + goal/box at 0.70; bodies,
 * control reach, and speed/time at their unscaled 1.00 values. A legacy
 * PITCH_SCALE env value still feeds the two formerly-coupled geometry scales
 * when their new explicit env keys are absent, so old density-probe commands
 * remain reproducible without keeping an ambiguous runtime constant.
 */
const LEGACY_PITCH_SCALE = positiveEnv('PITCH_SCALE');
export const FIELD_SCALE = positiveEnv('FIELD_SCALE') ?? LEGACY_PITCH_SCALE ?? 0.7;
export const GOAL_AND_BOX_SCALE =
  positiveEnv('GOAL_AND_BOX_SCALE') ?? LEGACY_PITCH_SCALE ?? 0.7;
export const BODY_SCALE = positiveEnv('BODY_SCALE') ?? 1;
export const CONTROL_REACH_SCALE = positiveEnv('CONTROL_REACH_SCALE') ?? 1;
export const SPEED_TIME_SCALE = positiveEnv('SPEED_TIME_SCALE') ?? 1;

export const PITCH_LENGTH = 90 * FIELD_SCALE;
export const PITCH_WIDTH = 58 * FIELD_SCALE;
export const HALF_L = PITCH_LENGTH / 2;
export const HALF_W = PITCH_WIDTH / 2;

/** A ball over the GOAL line (a wide or over-the-bar shot) coasts this long
 * before its corner / goal-kick is awarded (Phase 41.1) — it reads as sailing
 * OUT, not vanishing the instant it crosses. Goal-line only; touchline kick-ins
 * stay instant. Goal detection runs first and is frozen out during the coast,
 * so a wide ball drifting behind the line can never register a phantom goal. */
export const OUT_PLAY_COAST = 0.5;

export const GOAL_WIDTH = 7 * GOAL_AND_BOX_SCALE;
export const GOAL_DEPTH = 2.2;
/** Crossbar height (m) — a ball crossing the goal line above this is OVER the bar. */
export const GOAL_HEIGHT = 2.44;
export const BOX_DEPTH = 13 * GOAL_AND_BOX_SCALE;
export const BOX_WIDTH = 28 * GOAL_AND_BOX_SCALE;
export const CENTER_CIRCLE_R = 7 * FIELD_SCALE;

/** Fixed simulation timestep (s). */
export const DT = 1 / 60;
/** Default full match duration in sim-seconds (2 halves). Display clock maps this to 90'. */
export const MATCH_DURATION = 240;
/**
 * Max sim-seconds a half runs past its nominal end waiting for a safe break
 * (Phase 27.4 stoppage time) — ≈3 added display minutes on the 90' clock.
 */
export const STOPPAGE_MAX = 8;

/**
 * The currently shipped turf response, named as one authority so a later
 * factorial can compare surfaces without scattering friction/bounce edits.
 * M0 adds no alternative profile and no runtime selection.
 */
export interface SurfaceProfile {
  readonly id: 'current';
  readonly ballFrictionK: number;
  readonly ballBounce: number;
  readonly bounceDamp: number;
  readonly bounceMinVz: number;
  readonly airSpinDecay: number;
  readonly groundSpinDecay: number;
  readonly bounceSpinRetention: number;
}

export const SURFACE_PROFILE: SurfaceProfile = Object.freeze({
  id: 'current',
  ballFrictionK: 0.55,
  ballBounce: 0.45,
  bounceDamp: 0.72,
  bounceMinVz: 2.2,
  airSpinDecay: 0.25,
  groundSpinDecay: 1.5,
  bounceSpinRetention: 0.55,
});

/** Ball exponential velocity decay per second: v *= exp(-K * dt). */
export const BALL_FRICTION_K = SURFACE_PROFILE.ballFrictionK;
export const BALL_AIR_SPIN_DECAY = SURFACE_PROFILE.airSpinDecay;
export const BALL_GROUND_SPIN_DECAY = SURFACE_PROFILE.groundSpinDecay;
export const BALL_BOUNCE_SPIN_RETENTION = SURFACE_PROFILE.bounceSpinRetention;

/* ---- The energy economy (Phase 58 — it BINDS now) ---- */
/**
 * The N1 matrix probe found the meta uncounterable and the phase-58
 * diagnostic found out why nothing tires it: full-time stamina sat at
 * 0.98-0.99 (recovery 0.014/s dwarfed drain 0.006·e²/s), so every payoff
 * built on fatigue — the stamina attribute, staminaConservation's
 * "fresher legs late", the tired-legs brain gate — was dead. Repriced so
 * a match SPENDS legs: sustained sprinters finish ~0.6-0.8, patient
 * sides ~0.9. Sweep + gates in the phase-58 ledger entry.
 */
export const STAMINA_DRAIN = 0.01;
/**
 * C5 T0: what a shield-hold costs in legs, per second, before the pressure
 * scale. Sized against `STAMINA_DRAIN`: a fully squeezed hold burns roughly
 * what a three-quarter-effort run does, so holding under a press is a real
 * spend and holding in space is nearly free — which is the shape football has.
 */
export const SHIELD_STAMINA_DRAIN = 0.012;
export const STAMINA_RECOVERY = 0.009;
/**
 * A tackle lunge is a burst the movement integral never saw (the lunge is
 * instantaneous): each attempt — win or whiff — costs a flat chunk,
 * scaled by the same per-player drain modifiers. Aggressive markers
 * attempt ~2× a patient side's volume (probe: 9.4 vs 5.2 WON tackles),
 * so relentless pressing now buys its late-game price.
 */
export const TACKLE_LUNGE_COST = 0.02;

/**
 * Blind-side deflection penalty (Phase 59, N1.5 lever 2): you can only
 * stick a leg on a drilled ball you SEE. The cutback anatomy probe found
 * ~60% of pull-backs dying in flight to legs with NO facing check — a
 * defender retreating goalward deflected the ball zipping behind his heels
 * at the same odds as a set, facing interceptor, which re-sealed the very
 * arc the collapsed block cedes. Fully blind ⇒ deflection odds ×(1−this);
 * facing ⇒ unchanged. Buffs every DRILLED delivery (cutbacks, driven
 * switches, hard through balls) against unset bodies only.
 */
export const DEFLECT_BLIND_PEN = 0.75;
/**
 * The same seeing-the-ball principle at the CAPTURE contact (Phase 59):
 * the anatomy probe's kill telemetry showed pull-back flights dying 7:1 to
 * the full-capture branch, not the deflection stretch — friction decays a
 * 19 m/s cutback under CONTROL_MAX_SPEED mid-flight, and every bystander
 * within 1.25m then got an UNCONDITIONAL touch (a failed control still
 * squirts the ball = the pass dies either way). Now a bystander must
 * REACT to a live pass rolling past: contact odds fall with ball speed
 * and blind-side arrival; the INTENDED receiver is set for it (exempt),
 * dead/loose scrambles (no pass in flight) keep the old physics.
 */
export const CONTACT_BLIND_PEN = 0.7;
/**
 * The UNSET WALL (Phase 60, N1.5 lever 3): a body on the shot corridor
 * only blocks in FULL when it is set (still) and facing the strike. The
 * cutback anatomy measured 38-50% of delivered pull-backs arriving with a
 * "blocked" corridor whose bodies were 64-83% UNSET — sprinting goalward
 * or blind — and both the shoot decision (laneBlockers-suppressed appetite)
 * and the block physics treated them as a set wall, so the arc arrival
 * recycled instead of striking first-time. Weight per corridor body:
 * this floor + (1−floor)·readiness, readiness = facing · stillness.
 */
export const UNSET_BLOCK_WEIGHT = 0.55;

/**
 * The MEETABLE cross (Phase 63, the route-one channel): open-play crosses
 * used to lead the target by his FULL velocity × flight — the pre-31.9
 * corner bug alive in open play. Probed (aerial-anatomy): as the delivery
 * dropped into the header band the intended target was a median 8-9m away
 * (header reach is 1.35m) — attacker headers ran 1-10% of crosses and 47%
 * died in defenders' laps on the ground. The delivery now leads a MEETABLE
 * fraction of the run, capped in meters: the crasher keeps his momentum
 * (the running jump IS his duel edge) and covers the difference himself
 * (ReceivePass chases the landing).
 */
export const CROSS_LEAD_FRAC = 0.4;
export const CROSS_LEAD_MAX = 3.5;

/* ---- The aerial game (Phase 28) ---- */
/** Gravity on the lofted ball (m/s²). Airborne balls fly friction-free. */
export const GRAVITY = 9.81;
/** Vertical restitution on landing: bounce vz = -vz · this. */
export const BALL_BOUNCE = SURFACE_PROFILE.ballBounce;
/** Horizontal speed kept per bounce (the turf bites). */
export const BOUNCE_DAMP = SURFACE_PROFILE.bounceDamp;
/** Landing slower than this vertically just settles into a roll. */
export const BOUNCE_MIN_VZ = SURFACE_PROFILE.bounceMinVz;
/** Above this height a ball can't be trapped or deflected — only headed. */
export const CONTROL_MAX_HEIGHT = 1.3;
/** Header contest window: ball height where outfielders can attack it... */
export const HEADER_MIN_HEIGHT = 1.35;
export const HEADER_MAX_HEIGHT = 2.5;
/** ...standing within this horizontal radius of the ball. */
export const HEADER_RADIUS = 1.35;
/**
 * C4 T1-FLIGHT: the flight time whose ballistic APEX lands exactly on the
 * outfield header band's floor. A lofted kick launches `vz = GRAVITY·T/2`, so
 * its peak is `g·T²/8`; solving `g·T²/8 = HEADER_MIN_HEIGHT` gives this.
 *
 * DERIVED, never chosen — written as the expression so it cannot drift from
 * the two constants it depends on. Under the shared distance law
 * `T = clamp(0.5 + dEff·0.038, 0.7, 1.7)` this floor corresponds to a delivery
 * of ~14.45 m, which is why a shorter cross could never reach a head.
 */
export const CROSS_FLIGHT_MIN_S = Math.sqrt((8 * HEADER_MIN_HEIGHT) / GRAVITY);
/**
 * Chest / thigh trap (Phase 28.6, user report "球在两个球员之间弹来弹去 —
 * 是不是没有胸部停球"): a ball dropping through the LOWER header band that no
 * opponent is contesting can be CUSHIONED to the feet instead of headed.
 * Heading a hanging ball just nods it to the next man — the endless aerial
 * rally. The take-down is priced by technique/first-touch and spills under
 * pressure (a failed trap keeps the scramble). Ceiling below a leaping
 * header (you can't chest a 2m ball); only a descending/apex ball (vz gate);
 * the trapper must be almost under it (tighter than HEADER_RADIUS).
 */
export const CHEST_TRAP_MAX_HEIGHT = 1.7;
export const CHEST_TRAP_RADIUS = 1.05;
/** Above this upward vz the ball is rising too hard to cushion (just bounced/headed up). */
export const CHEST_TRAP_MAX_VZ = 1.5;
/** Keepers can claim high balls up to here (jump + hands). */
export const GK_CLAIM_HEIGHT = 2.55;
/**
 * Opponents are held this far from a keeper holding the ball in their hands
 * (Phase 28.1) — you can't challenge a keeper in possession, so crowding
 * them was pointless harassment that turned every release into a turnover.
 */
export const GK_HOLD_CLEARANCE = 3;

/** Opponents are held this far from a dead-ball restart spot. */
export const RESTART_CLEARANCE = 6;
/** Corners use the real-law 9.15m (Phase 31.9): the delivery's ascent is
 * inside the header band (z 1.35–2.5) until ~7.8m from the flag, so a
 * sentry camped on the generic 6m edge got a free header at every
 * climbing corner — the silent killer of the whole corner routine. */
export const CORNER_CLEARANCE = 9.15;
/** Penalty spot distance from the goal line — matches the drawn spot (BOX_DEPTH · 0.72). */
export const PENALTY_SPOT_DIST = BOX_DEPTH * 0.72;
/**
 * Everyone except the taker (and the defending keeper, who stands ~9.4m away
 * on the goal line) is held this far from the penalty spot during setup.
 */
export const PENALTY_CLEARANCE = 8;
/** Restart setup: minimum dead-ball time before the kick can be taken... */
export const RESTART_MIN_SETUP = 1.0;
/** ...and a failsafe: after this long the taker kicks from wherever they are. */
export const RESTART_TIMEOUT = 6;

/** A player controls a free ball inside this radius... */
export const CONTROL_RADIUS = 1.25 * CONTROL_REACH_SCALE;
/**
 * M2 oriented interaction shell. The stable core and ball radius are never
 * scaled by these values — only the leg/foot extension outside them is.
 * Front and lateral contact keep the old CONTROL_RADIUS exactly. Rear contact
 * keeps 90% of the outer extension: close back-heels remain possible, while an
 * edge-of-envelope ball directly behind the body requires a small turn.
 */
export const BALL_ACCESS_SIDE_EXTENSION_FACTOR = 1;
export const BALL_ACCESS_BACK_EXTENSION_FACTOR = 0.9;
// S0 (docs/SUBSTRATE-MAP.md): both sides with a body within this of a loose ball =
// a genuine contest. Classification-only today; the physical 50-50 will use it later.
export const CONTEST_RADIUS = 3;
/** ...if it is slower than this (outfield) — keepers can handle faster balls. */
export const CONTROL_MAX_SPEED = 14;
export const GK_CONTROL_MAX_SPEED = 23;
/**
 * M3 contact→control separation. A foot contact leaves the ball physically
 * free for three fixed ticks before the same body may establish control;
 * another body can contact it during that window and replace the attempt.
 */
export const CONTACT_CONTROL_DELAY_TICKS = 3;
export const CONTACT_COMMIT_TIME = 0.08;
/** Foot follow-through retained after real contact; not available to a fresh claim. */
export const CONTACT_CONTROL_RETENTION_MARGIN = 0.02;
/** Relative normal speed left after a cushioning contact. */
export const CONTACT_RELEASE_MIN_SPEED = 0.25;
export const CONTACT_RELEASE_MAX_SPEED = 1.2;
export const CONTACT_RELEASE_INCOMING_SHARE = 0.12;
/** Tangential relative ball motion survives the contact at this share. */
export const CONTACT_TANGENTIAL_RETENTION = 0.35;
/**
 * Faster balls (hard passes, not shots — SHOT_SPEED is 27) can still be
 * DEFLECTED by a player in their path (Phase 27 lane anticipation).
 */
export const DEFLECT_MAX_SPEED = 24;

/** After kicking, a player can't re-capture for this long (lets passes leave). */
export const KICK_COOLDOWN = 0.45;

/**
 * C1-A pass POWER as an executable input (docs/world-model/PASS-POWER-SLICE.md
 * §8). Ordinary ground-pass weight stopped being a pure distance formula: a
 * passer may mean 0.85 (rolled) .. 1.15 (drilled), leads the receiver on the
 * power he MEANT, and the ball leaves at what he actually struck. Nothing
 * chooses a power yet — every live call passes 1.0, which draws no RNG and
 * changes no arithmetic (that is what the fingerprint gate proves).
 */
export const PASS_POWER_MIN = 0.85;
export const PASS_POWER_MAX = 1.15;
/**
 * Weighting a ball away from its natural pace is a technique act: the error
 * grows with how far from 1.0 the passer reaches and shrinks with passing.
 * Same shape as bentKick's weight error. σ ≈ 7.7% of power for an average
 * passer's 1.15 ball, ≈ 3.7% for an elite one.
 */
export const PASS_POWER_NOISE_K = 0.60;
/** A mis-struck ball stays physically sane. */
export const PASS_POWER_EXECUTED_MIN = 0.70;
export const PASS_POWER_EXECUTED_MAX = 1.30;

/**
 * Discrete dribble touches (Phase 36, 可见的触球): an outfield carrier
 * DRIVING in space pushes the ball ahead and chases it — between touches
 * the ball is a free body an opponent in the path may poke away. Under
 * pressure (an opponent inside TOUCH_CONTROL_DIST) the carry stays glued:
 * close control IS short touches, and the tackle/shield duel lives there.
 */
/** Nearest-opponent distance above which the carrier plays open touches.
 * First cut 3.5/1.7/0.38 rolled the ball 1.1s ahead and 39% of pushes were
 * poked away — a coin flip per carry. */
export const TOUCH_CONTROL_DIST = 4.2;
/**
 * Carry REGIMES (36.1, user report "跑动应该有不同的触球频率"): the push
 * range is wide on purpose — in traffic it's a stride-length nudge
 * (一步一带, ~0.9 m/s over the run), into 10m of open grass it's a real
 * knock (爆趟, up to ~4.7); walking pace keeps the glue (慢带). Cadence
 * follows: the poke window scales with the push, so a long knock is a
 * long chase and a dribble regathers in a step.
 */
/** Base speed added to the carrier's own on the push. */
export const TOUCH_PUSH_BASE = 0.9;
/** Extra push per meter of open cone ahead (capped at 9m in mechanics).
 * 0.38 + cooldown slope 0.06 overshot: pokes 26%, 13% rolled dead, goals
 * −0.27 (probed) — the mid-range carry bled possession. */
export const TOUCH_PUSH_SPACE = 0.32;
/** The no-recollect window: base + slope·push — the poke window. */
export const TOUCH_RECOLLECT_BASE = 0.26;
export const TOUCH_RECOLLECT_PER_PUSH = 0.04;
/** A keeper ahead is not open grass (Phase 46): any roll that reaches him
 * is DEAD (GK_CONTROL_MAX_SPEED 23 vs outfield 14, plus hands in the box),
 * and he covers ~GK 6.4 m/s × the ~0.8s loose window while a knock is
 * un-regatherable. The carry cone prices him at that envelope upfield of
 * his body — the substrate fix for 趟球太大送门将 (breakaway probe:
 * keeper-collects stuck at 8-9% even with maxed technique). */
export const GK_RUSH_ENVELOPE = 5;

/** How often each player re-evaluates its utility scores (staggered). */
export const AI_INTERVAL = 0.15;
/**
 * ⭐ THE INCUMBENT OFF-BALL FATIGUE MULTIPLIER, named by OBM-T0 (#227). PURE CODE
 * MOTION: `0.6` is the very factor `decideOffBall` has always applied to the
 * `SupportBallCarrier` and `MakeRun` scores when `tired` (`s *= 0.6`, four sites).
 * Given a name so the off-ball eyes seat's score-modulation span can be written as
 * a reference to the engine's own standing answer to "how much may a body's own
 * state scale exactly these two scores" instead of as a fresh literal (#202).
 * Lives here rather than in `PlayerBrain.ts` only to keep the seat module free of
 * an import cycle; the use site is `decideOffBall` and nowhere else.
 */
export const OFFBALL_TIRED_MUL = 0.6;
/** How often each TeamBrain re-picks a tactical mode / assignments. */
export const TEAM_AI_INTERVAL = 0.4;

export const SHOT_SPEED = 27;
/** Minimum distance between player centers (hard separation). */
export const PLAYER_MIN_DIST = 1.05 * BODY_SCALE;
/** Radius of the stable kinematic core disc represented by PLAYER_MIN_DIST. */
export const PLAYER_CORE_RADIUS = PLAYER_MIN_DIST / 2;
/** IFAB size-5 ball: circumference 68–70cm ⇒ radius approximately 0.11m. */
export const BALL_RADIUS = 0.11;
