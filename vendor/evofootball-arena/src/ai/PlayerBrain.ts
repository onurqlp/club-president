import { clamp, clamp01 } from '../utils/math';
import { dist, dot, norm, sub, v2 } from '../utils/vec';
import type { V2 } from '../utils/vec';
import { HALF_L, HALF_W } from '../sim/constants';
import {
  cornerKeyZone, defenderLineLocalX, offsideLineLocalX, runBurstPoint, shapeReady, supportSpot,
} from './formations';
import { obmOffballPolicy } from './offballEyes';
import { RUN_PRIOR_MAX, runRank, runnerCount } from './TeamBrain';
import { OFFBALL_TIRED_MUL } from '../sim/constants';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { Team } from '../sim/Team';
import type { UtilityScore } from '../sim/types';
import { aerialSense, kickMisalignment, orientationPowerMul } from '../sim/mechanics';
import {
  airLaneOpenness, canInterceptPass, effectiveBlockers, interceptBall, laneOpenness, opennessAt,
  opennessOf, escapeCarry, pressureAt, spaceAhead, timeToPoint,
} from './perception';
import { laneOpenness as laneOpennessShipped, laneOpennessFront } from './perception';
import { passLeadOffset, passLeadSeatOf } from './passLeadSeat';
import { deliveryChoiceSeatOf, ledDelivery } from './deliveryChoiceSeat';
import { groundStrikeGrid, strikePlaneSeatOf } from './strikePlaneSeat';
import {
  BK_CORRIDOR_FAMILIES, bkCorridorPriceLed, bkCorridorPriceOf, deliveryRiskPrice,
  deliveryValueSeatOf, groundShellHazard,
} from './deliveryValueSeat';
import { receiverAccessSeatOf, receiverAccessDeficit } from './receiverAccessSeat';
import { carryChoiceSeatOf, knockCandidates } from './carryChoiceSeat';
import {
  choosePerceivedPassTarget, passChoiceCandidateGids, preferredPassPower,
} from './perceivedPassChoice';
import { choosePassWeight } from './passWeightChooser';
import { PASS_POWER_MAX, PASS_POWER_MIN } from '../sim/constants';
import { whetherEyeDecision, whetherEyeInScope } from './whetherEye';
import { o2LookDecision, o2LookEligible } from './lookSeat';
import { buildCarrierSnapshotView, snapshotTeamView } from './inSnapshotView';
import { inLookGate } from './inLookAct';
import { lnOwnLaneWeightOf, rcAnticipationWeightOf } from '../evolution/genome';
import { ownLaneOpenness, ownLanePrice, ownLaneScopeGids } from './ownLaneSeat';
import {
  alignmentRank, rcReadyBelief, rcReadyCell, type RcMateBearing,
} from './receiverReadySeat';

/** E3's canary prices the chosen pass at the substrate's own power range. */
const PASS_CANARY_POWERS: readonly number[] = [PASS_POWER_MIN, 1, PASS_POWER_MAX];

/**
 * ⭐⭐ RC T0b §SEAM — `ReceivePass`'s OWN score literal, HOISTED so it has ONE home.
 *
 * The off-ball menu's `ReceivePass` push scores `1.2` and always has; RC-T0b's candidate is
 * scored `w · belief · s_receive` against exactly that anchor (M-RC.3: "certainty at gene 1
 * recovers exactly the shipped priority; belief and gene DISCOUNT it"). Rather than typing
 * `1.2` a SECOND time, the literal is named here and BOTH sites read the name — so the shipped
 * push still scores exactly 1.2 (its value is unchanged, character for character in effect)
 * and no second copy can drift. Canon, VERBATIM: "a src-extracted constant pins its extraction
 * to the NAMED call site — anchored match + line receipt — never first-occurrence" (home:
 * BK-C0-BODYBALL-CENSUS.md §COMMANDER CORRECTIONS item 1).
 */
const RC_S_RECEIVE = 1.2;

/**
 * PlayerBrain — utility AI. Each decision tick the player scores a set of
 * candidate actions; the best one wins. Every score is a product/sum of
 * normalized factors with the gene multipliers spelled out, and the top
 * candidates are stored on the action for the debug panel.
 *
 * Kicks (Pass/Shoot/Clear) execute immediately at decision time; movement
 * actions are executed continuously by actionExecutor until the next tick.
 */
export function decidePlayer(p: Player, match: Match): void {
  const team = match.teams[p.side];
  const opp = match.teams[1 - p.side];

  // C7 T1 §SEAM: a body winding up a shot is committed and cannot re-decide (the
  // mirror of pendingControl's held window / CONTACT_COMMIT_TIME). Its action
  // stays { type: 'Shoot' }; the strike resolves at readyTick. Dormant in
  // production (c7Windup OFF ⇒ pendingKick null ⇒ never taken). Only holds while
  // the wind-up body still owns the ball — once it loses it (a charge-down inside
  // the window), the commitment lapses and it decides normally again.
  if (
    match.c7Windup && match.pendingKick !== null && match.pendingKick.gid === p.gid
    && match.ball.owner === p
  ) return;

  // O1 T1 §SEAM: the same re-decide lock, transferred to the shortPass wind-up (a
  // SEPARATE block so the C7 block above stays byte-identical). Its action stays
  // { type: 'Pass' }; the release resolves at readyTick. Dormant in production
  // (o1PassWindup OFF ⇒ pendingPassWindup null ⇒ never taken). Only holds while the
  // winding-up body still owns the ball — once it loses it, the commitment lapses.
  if (
    match.o1PassWindup && match.pendingPassWindup !== null && match.pendingPassWindup.gid === p.gid
    && match.ball.owner === p
  ) return;

  // O2 T0 §SEAM: the same re-decide lock, for a body who is LOOKING (a THIRD
  // separate block, so the C7 and O1 blocks above stay byte-identical). His action
  // stays the `Dribble` label set at the arm fork; he plants, does not act, and the
  // window closes at `untilTick` in `Match.stepO2Look` — which runs at the head of
  // the tick, so the very next decision he makes is on the REFRESHED percept.
  // Dormant in production (o2Look OFF ⇒ o2LookWindow null ⇒ never taken). Only
  // holds while the looking body still owns the ball.
  if (
    match.o2Look && match.o2LookWindow !== null && match.o2LookWindow.gid === p.gid
    && match.ball.owner === p
  ) return;

  // Dead-ball restart: the taker walks to the spot (chasing the stationary
  // ball); everyone else runs their normal logic against the dead ball —
  // defenders reshape and mark, attackers hold width around the spot.
  if (match.phase === 'restart' && match.restart) {
    if (p.gid === match.restart.takerGid) {
      p.action = { type: 'ChaseBall', scores: [{ action: 'ChaseBall', score: 1, why: 'taking the restart' }] };
      return;
    }
  } else if (match.phase !== 'playing') {
    p.action = { type: 'MoveToFormationSpot', scores: [] };
    return;
  }

  // ⭐⭐ IN T1 §SEAM (docs/world-model/IN-T1-THE-LOOK.md; contract IN-SNAPSHOT-CONTRACT.md
  // §2 M-IN.2/M-IN.3/M-IN.4; ruling #327 item 5) — THE LOOK, the ONE `inLookAct` fork in
  // `src/**`. It sits HERE, above the carrier / keeper / off-ball dispatch, because ANY
  // BODY MAY LOOK (#327 item 5's 接球前观察 scope) — one law, one cadence, no role
  // carve-out. The whole act lives in `inLookAct.ts`: the free PASSIVE half (every body
  // refreshes his IN-T0 book for the field centred on his own heading — M-IN.1's own
  // sentence, which IN-T0 could only apply at the carrier's gateway), and the PRICED
  // LOOK (aim at a body he REMEMBERS but cannot see, pay `ceil(theta/(TURN_RATE·DT))`
  // ticks of not re-deciding with the passive half suspended). A `true` return means the
  // body must not re-decide: he is either paying for a look or taking one.
  //
  // ⚠ THE CONSUMER IS UNCHANGED (#327 item 5): only `decideCarrier`'s IN-T0 gateway ever
  // PRICES a body off the book, so an off-ball look buys a fresh book for the moment the
  // ball arrives and nothing else. PHYSICS STAYS TRUTH (M-IN.1): no heading write, no
  // `faceTarget`, no action, no rng — the cost is TIME and only time.
  //
  // Flag off ⇒ ZERO statements run, and `decidePlayer` is HEAD's byte for byte.
  if (match.inLookAct && inLookGate(p, match)) return;

  if (match.ball.owner === p) {
    decideCarrier(p, team, opp, match);
    return;
  }
  // The carry continues (Phase 36): between discrete touches the ball is
  // free but it is HIS — he chases his own push instead of falling into
  // off-ball logic (which would send him to a spot while the ball rolls).
  if (
    match.ball.owner === null &&
    match.dribbleTouch !== null &&
    match.dribbleTouch.gid === p.gid &&
    match.simTime < match.dribbleTouch.until
  ) {
    p.action = { type: 'ChaseBall', scores: [{ action: 'ChaseBall', score: 1, why: 'chasing my own touch' }] };
    return;
  }
  if (p.role === 'GK') {
    decideGoalkeeper(p, team, match);
    return;
  }
  decideOffBall(p, team, opp, match);
}

/* ------------------------------------------------------------------ */
/* Ball carrier                                                        */
/* ------------------------------------------------------------------ */

function decideCarrier(p: Player, teamTruth: Team, oppTruth: Team, match: Match): void {
  // ⭐⭐ IN T0 §SEAM (docs/world-model/IN-T0-SNAPSHOT-LAW.md; contract
  // IN-SNAPSHOT-CONTRACT.md §2 M-IN.1/M-IN.3/M-IN.4; ruling #324 item 4) — THE SNAPSHOT
  // LAW AT THE CARRIER'S CHOOSER GATEWAY, the ONE `inSnapshotLaw` fork in `src/**`.
  //
  // ⭐ THE GATEWAY, NOT THE READS (IN-C0 §R-FIX.6): the census proved the carrier's 255
  // other-body TRUTH reads sit DOWNSTREAM of the ~79 sites where the named world
  // collections are handed out, so the law interposes ONCE, HERE — the two `Team`
  // bindings this whole function reads through are SHADOWED by per-reader snapshot views,
  // and every existing read below (`team.players`, `opp.players`, and the `opponents`
  // parameter of `pressureAt` · `opennessAt`/`opennessOf` · `laneOpenness` ·
  // `airLaneOpenness` · `effectiveBlockers`→`blockReadiness` · `spaceAhead` ·
  // `escapeCarry` · `offsideLineLocalX` · `defenderLineLocalX` ·
  // `runBurstPoint`→`runTarget` · `knockCandidates`→`touchPastPushFor` ·
  // `deliveryRiskPrice`→`flightExposure`) is byte-identical in source and snapshot-borne
  // at run time. The call-graph homework #319 item 3 ordered is discharged site by site in
  // the stage doc's §HOMEWORK table: not one of those helpers re-enters `team`/`opp`/
  // `match` for another body's position — each takes it from its own parameter. ⚠ THE ONE
  // HELPER THAT DOES REACH FOR A ROSTER is `whetherEyeDecision`, which walks
  // `match.teams[p.side].players` at `whetherEye.ts:147` for IDENTITY only (`role` /
  // `sentOff`) while taking the POSITION it prices from the whether-seat's OWN snapshot —
  // so it is NAMED OUT of this seam with that provenance, not covered by it (IN-T0 §P4's
  // "REACHED FOR, not passed" row; ordered here by ruling #325 §CORR 3).
  //
  // ⭐ WHY SHADOWING AND NOT RENAMING: a dozen of those exact source lines are PINNED
  // VERBATIM by other seams' permanent suites, and A PINNED TEST IS A STOP, NEVER AN EDIT
  // (this file's own DLC-T0s §SEAM states the rule). Shadowing keeps every pin green and
  // makes the seam ONE fork instead of thirty.
  //
  // ⭐ FLAG OFF ⇒ `inView` is null ⇒ `team` IS `teamTruth` and `opp` IS `oppTruth`, the
  // very same objects the shipped function always received, so every double below is
  // HEAD's byte for byte (the dormancy pins MEASURE that; they do not assume it).
  //
  // ⚠ THE VIEW IS BUILT ONCE AT ENTRY, so the refresh half of the law also fires on the
  // pre-ladder restart/keeper branches below (a body on the ball is looking at the picture
  // whether or not he ends up scoring options). Stated, not hidden.
  //
  // ⚠ NAMED OUT OF THE SEAM (the full list with provenance is the stage doc's §SEAM MAP):
  // `match.shotQuality(p)` — its `pressureAt` is SHARED with `mechanics.performShot`, so
  // interposing there would price a STRIKE off a snapshot and break M-IN.1; the roster and
  // identity reads of the forced-target / EDS-chooser / PW-chooser blocks (already
  // percept-side or registered truth-measured scopes of record, IN-C0 §R-FIX.4); every
  // other body's `heading`/`bodyDir` (#324 item 4 scopes the law to position/velocity);
  // and every `perform*` call, heading write and executor read (M-IN.1: physics is truth).
  const inView = match.inSnapshotLaw
    ? buildCarrierSnapshotView(
      p, teamTruth.players, oppTruth.players, match.inSnapshotStore, match.simTick,
      match.inSnapshotField, match.inSnapshotLedger,
    )
    : null;
  const team = inView === null ? teamTruth : snapshotTeamView(teamTruth, inView.mates);
  const opp = inView === null ? oppTruth : snapshotTeamView(oppTruth, inView.opps);
  const g = team.genome;
  const W = team.policies[p.index]; // utility weights — DEFAULT_POLICY unless a wildcard carries learned ones
  const ball = match.ball;
  // Restart first touch must be a kick (kick-in/corner/goal kick/free kick)
  // — dribbling straight off the spot would break the dead-ball fiction.
  const mustKick = match.restartKickGid === p.gid;
  const kickKind = mustKick ? match.restartKickKind : null;
  const kickRoutine = mustKick ? match.restartKickRoutine : null;
  if (mustKick) {
    match.restartKickGid = null;
    match.restartKickKind = null;
    match.restartKickRoutine = null;
    // Goal-channel telemetry (Phase 113): stamp the SET-PIECE first touch —
    // a goal within the window banks as `setpiece`. Kick-ins and goal kicks
    // are restarts but not set pieces.
    if (kickKind === 'corner' || kickKind === 'freeKick' || kickKind === 'penalty') {
      match.lastRestartKick = { kind: kickKind, side: p.side, t: match.simTime };
    }
  }
  // A penalty's first touch IS the shot — no utility scoring from the spot.
  if (kickKind === 'penalty') {
    p.action = { type: 'Shoot', scores: [{ action: 'Shoot', score: 1, why: 'penalty kick' }] };
    match.performShot(p);
    return;
  }
  // Keeper hold (Phase 27.2): ball in the hands — no distribution decision
  // until the hold runs out.
  if (p.gkHoldTimer > 0) {
    p.action = { type: 'HoldPosition', scores: [{ action: 'HoldPosition', score: 1, why: 'ball in hands' }] };
    return;
  }
  // The keeper WAITS for shape (Phase 30.3): a held ball is released to SET
  // receivers. Until the outfielders settle near their attacking spots, the
  // hold re-arms in small quanta — every hands protection (untackleable,
  // clearance bubble, nobody presses) keys off gkHoldTimer and keeps
  // applying. Budget-capped so a scattered team can't stall the match.
  if (p.role === 'GK' && p.gkDistributing && p.gkShapeWait < 4 && !shapeReady(team, match.ball, 6, match.abandonRestDesignation === team.side)) {
    p.gkHoldTimer = 0.25;
    p.gkShapeWait += 0.25;
    p.action = { type: 'HoldPosition', scores: [{ action: 'HoldPosition', score: 1, why: 'waiting for shape' }] };
    return;
  }
  // ⭐⭐ LN T0 §SEAM (docs/world-model/LN-T0-OWN-LANE-PRICE.md; contract
  // LN-OWN-LANE-CONTRACT.md §2 M-LN.1/.2/.3; ruling #393 item 5) — THE OWN-LANE SEAT, the
  // ONE `lnOwnLanePrice` fork in `src/**`. Armed, the passer's pricers stop being blind to
  // his own men: each pays `w · (1 − ownLaneOpenness)` — the SHIPPED `laneOpenness` geometry
  // over own outfield bodies minus the passer minus the intended target (LN-C1's own
  // reconstruction; `src/ai/ownLaneSeat.ts`) — for a line one of ours is standing in.
  //
  // ⭐ HOISTED ABOVE THE KICK-OFF BRANCH ON PURPOSE. LN-C3 measured the kick-off play-back
  // as 0.403488 of all caroms, and that branch RETURNS before the ladder ever runs, so a
  // seat built beside the ground-corridor seat below would never reach it. ONE flag read,
  // FOUR sites, all inside this function: the hoisted `groundCandidate` pricer, the kick-off
  // play-back loop, the EDS chooser's snapshot SCOPE and its executable-option price.
  // Seat null ⇒ no scope statement runs, no openness is computed and every score is the
  // shipped double (G-OFF); gene absent ⇒ `w = 0` ⇒ every price is exactly `+0` and every
  // factor exactly `1` (G-IDENT). ⛔ NO LINE IS BANNED (#200 / #328): the argmax decides.
  const lnSeat = match.lnOwnLanePrice ? { w: lnOwnLaneWeightOf(g) } : null;
  // Kickoff first touch (Phase 27.3): played BACKWARD to a teammate — no
  // driving forward off the spot, no long ball over the top. Everyone else
  // starts behind the ball at kickoff, so the fallback is nearly unreachable.
  if (match.kickoffKickGid === p.gid) {
    match.kickoffKickGid = null;
    let back: Player | null = null;
    let backScore = -Infinity;
    for (const mate of team.players) {
      if (mate === p || mate.sentOff) continue;
      if (team.localX(mate.pos.x) > -0.5) continue; // must be behind the ball
      const d = dist(p.pos, mate.pos);
      // Open, and comfortably ~12m back — not the keeper 40m away.
      let s = opennessOf(mate, opp.players) - Math.abs(d - 12) * 0.02 - (mate.role === 'GK' ? 0.3 : 0);
      // LN T0 §SEAM — SITE (b), THE KICK-OFF PLAY-BACK. The shipped scorer reads a RADIAL
      // opponent openness AT THE MATE'S BODY and no line at all (LN-C3 §R2: its
      // `readsOwnBodiesNotAtAll` is TRUE), while the restart's own shape packs the whole team
      // behind the ball — own-openness mean 0.413493 against 0.77–0.90 for every other
      // family. This is the ONE statement this stage adds to the loop; the shipped expression
      // above is unchanged character for character (only `const` became `let`).
      if (lnSeat !== null) {
        s -= ownLanePrice(lnSeat.w, ownLaneOpenness(p.pos, mate.pos, team.players, p.gid, mate.gid));
      }
      if (s > backScore) {
        backScore = s;
        back = mate;
      }
    }
    // ⭐⭐ IN T0 §SEAM — THE THIRD RESOLUTION SITE. This pre-ladder branch scores its own
    // target off `team.players` (the SHADOW) and then STRIKES, so the winner is resolved
    // here for exactly the M-IN.1 reason the ladder's winners are: the turn and the pass
    // are EXECUTOR work and must land on the truth body. (At kickoff the cold-start rule
    // makes every entry truth anyway, so this is a correctness guard, not a live path —
    // stated rather than relied on.) Flag off ⇒ `inView` is null ⇒ ZERO statements run.
    if (inView !== null && back !== null) back = inView.real(back);
    if (back) {
      const hx = back.pos.x - p.pos.x;
      const hy = back.pos.y - p.pos.y;
      const hl = Math.sqrt(hx * hx + hy * hy);
      if (hl > 1e-6) p.heading = { x: hx / hl, y: hy / hl };
      p.action = {
        type: 'Pass',
        targetIdx: back.gid,
        scores: [{ action: 'Pass', score: 1, why: 'kickoff — played back' }],
      };
      match.performPass(p, back);
      return;
    }
  }
  // C5 T0 (docs/world-model/C5-T0-HOLD-MECHANICS.md): the dormant shield-hold.
  // Modelled on `forcedPassTarget` below — `forcedHold` is null in every
  // production path, so this branch is unreachable in the shipped game and no
  // `cands` entry can produce `ShieldHold`. The WHETHER integration is T2's
  // work under its own contract; T0 only builds the capability.
  if (
    match.c5Hold && match.forcedHold !== null && match.forcedHold.gid === p.gid
    && match.simTick < match.forcedHold.untilTick && !mustKick && p.role !== 'GK'
  ) {
    // ⚠ EK T0 §SEAM: the TRAINING-GROUND DRILL HOLD is NOT captured here. The brain only
    // re-decides every `AI_INTERVAL`, so a capture on this branch would carry a band up to
    // a decision interval stale; the commitment itself is public state, so `Match`
    // captures it at the head of the very tick it starts (see `ekHoldObserve`).
    p.action = {
      type: 'ShieldHold',
      scores: [{ action: 'ShieldHold', score: 1, why: 'forced hold (C5 T0 probe seam)' }],
    };
    return;
  }
  const cands: UtilityScore[] = [];
  const pressure = pressureAt(p.pos, opp.players);
  const goal = team.oppGoal();
  const dGoal = dist(p.pos, goal);
  const localX = team.localX(p.pos.x);
  // Offside awareness (Phase 29): real-law dead-ball exemptions, and the
  // line every delivery below checks its target against. Players avoid
  // teammates stood CLEARLY offside (beyond the 1.2m margin) but back their
  // judgment on tight ones — the referee judges at +0.2m, so the marginal
  // band is exactly where real flags come from (a runner who broke on the
  // previous kick and hasn't checked back level yet).
  // DELIBERATE law deviation (Phase 71, user call "门将开大脚应该有越位"):
  // real goal kicks are offside-exempt, but at this match scale the
  // exemption read as a legal cherry-pick — a striker camped at the
  // opponent's goal, fed by the timeout punt (probed: 19% of goal kicks
  // had a man within 12m of goal). Goal kicks now play under normal
  // offside, same family as the offside→goal-kick restart simplification.
  // Kick-ins keep the real throw-in exemption; corners are geometrically
  // exempt anyway (you cannot be offside level with the goal line ball).
  const offsideExemptKick = kickKind === 'kickIn' || kickKind === 'corner';
  const offLine = offsideLineLocalX(team, opp.players, localX) + 2.2;
  // Territory pressure (Phase 27): 0 while the move is fresh or gaining
  // ground, 1 after ~8s of possession going nowhere. It tilts every carrier
  // choice toward the opponent goal — sideways recycling stops being free.
  const stagnation = clamp01((team.staleTime - 3) / 5);

  // An OPEN RUN (Phase 31, user report "单刀回传"): nobody goal-side within
  // striking territory. Shared state for the whole carrier economy — the
  // finish boost inside 17m (28.4), the drive boost outside it, and the
  // back-pass suppression all key off it. Computed once.
  let openRun = false;
  if (dGoal < 28) {
    openRun = true;
    for (const o of opp.players) {
      if (o.role === 'GK' || o.sentOff) continue;
      if (dist(o.pos, goal) < dGoal - 1) {
        openRun = false;
        break;
      }
    }
  }

  // --- Shoot: worth it when the chance quality (xG) is decent; shootBias
  // scales it from "only tap-ins" (0) to "shoot on sight" (1).
  if (dGoal < 30 && p.kickCooldown <= 0) {
    const q = match.shotQuality(p);
    // NOTE: finishing deliberately does NOT raise shot utility — it pays off
    // in execution (tighter spread in mechanics.performShot), not in shot
    // selection. Coupling it to utility made finishers take worse shots and
    // turned the attribute into a net negative.
    let s = q * (W.shootBase + g.shootBias * W.shootGene);
    if (team.mode === 'Attack' || team.mode === 'CounterAttack') s *= W.shootModeMul;
    s *= 1 - pressure * W.shootPressurePen;
    // Facing away from goal (Phase 27): turn first instead of snap-shooting
    // blind. Restart takers are exempt — they set themselves before kicking.
    if (!mustKick) s *= 1 - kickMisalignment(p, norm(sub(goal, p.pos))) * 0.3;
    // 1v1 (Phase 28.4): nobody between you and the keeper — FINISH. The
    // old economy kept Dribble marginally ahead, so breakaways were walked
    // all the way onto the keeper's toes instead of being struck from 10m.
    const breakaway = openRun && dGoal < 17;
    if (breakaway) s *= 1.6;
    // Long-range appetite (Phase 28): when the sight is clear, have a dig
    // from 16–30m instead of recycling forever — a stale move digs sooner.
    let dig = 0;
    if (dGoal > 16) {
      // Pressure gate eased 0.7 → 0.5 (29.1): a containing jockey 2.6m off
      // shouldn't extinguish the dig — shooting over the delay IS the
      // counter to being contained (and the user wants the 20m strike).
      dig =
        W.longShotW *
        (0.3 + g.shootBias * 0.7) *
        (1 - pressure * 0.5) *
        (0.55 + stagnation * 0.45) *
        clamp01((30 - dGoal) / 14);
      s += dig;
    }
    // Lane-aware selection (Phase 31): shotQuality's distance·angle·pressure
    // cannot see the parked bodies on the path — carriers shot into walls,
    // and since 30.4 those flew harmlessly (not even a deflection). Each
    // corridor body discounts the whole appetite (dig included — the 20m
    // dig into a wall is exactly the doomed shot); the carrier works for an
    // angle instead, and tryShotBlock makes daring it anyway a real cost.
    // shootBias loosens the discount — daring traffic IS what the gene
    // means (a flat 0.62 inverted it: the shoot-happy team lost its whole
    // expression channel and out-shot NOBODY).
    // Phase 60 (the UNSET WALL): the appetite sees READINESS-weighted
    // bodies — a mid-collapse retreater discounts far less than a set,
    // facing wall, so the first-time arc strike gets dared while the
    // block is still arriving. Math.pow takes the fractional count fine.
    const blockers = breakaway ? 0 : effectiveBlockers(p.pos, goal, opp.players);
    if (blockers > 0) s *= Math.pow(0.55 + g.shootBias * 0.15, blockers);
    cands.push({
      action: 'Shoot',
      score: s,
      why: `xG ${q.toFixed(2)} · shootBias ${g.shootBias.toFixed(2)}${breakaway ? ' · 1v1 — finish it' : ''}${dig > 0.03 ? ` · long-range dig ${dig.toFixed(2)}` : ''}${blockers > 0 ? ` · ${blockers.toFixed(1)} ready in the lane` : ''}`,
    });
  }

  // --- Direct free kick (Phase 32): the danger-band placed ball is the
  // specialist's REAL strike — performFreeKick curls it over the wall, so
  // lane blockers don't apply and the ordinary shot economics (pressure,
  // misalignment) don't either. Competes with crossing/passing the FK.
  if (kickKind === 'freeKick' && localX > 0 && dGoal > 9 && dGoal < 28) {
    // Steep in range: the wall pulls two defenders out of the marking
    // scheme, so an FK always HAS an open mate — and real takers still
    // shoot from 17-22m. The pass only outscores from the band's edge.
    const sFK =
      (0.55 + (28 - dGoal) * 0.02) *
      (0.7 + (p.attrs.finishing + p.attrs.dribbling * 0.5) * 0.45) *
      (0.85 + g.shootBias * 0.3);
    cands.push({ action: 'Shoot', score: sFK, why: `direct free kick · ${dGoal.toFixed(0)}m out` });
  }

  // --- Pass: score every teammate, keep the best. Long targets also get a
  // LOFTED variant (Phase 28): the switch flies over the press, so it skips
  // the ground lane and the 32m suppression — its risks are the charge-down
  // at the kicker's feet and the scatter/first touch at the far end.
  // CB T2 §SEAM — the winning knock, kept for the arming. Null in every world in which the
  // choice seat is not armed, and the candidate is pushed into `cands` LAST (see below).
  let knockCand: UtilityScore | null = null;
  let knockDir: V2 | null = null;
  let knockBack = false;
  let bestMate: Player | null = null;
  let bestPass = 0;
  let bestLane = 0;
  let bestOpen = 0;
  let bestLoftMate: Player | null = null;
  let bestLoft = 0;
  let bestLoftOpen = 0;
  // One aerial-lane read per decision — the pass loop and the through-ball
  // loop used to each run the same scan with the same arguments.
  const airLane = p.kickCooldown <= 0 ? airLaneOpenness(p.pos, opp.players) : 0;
  // PTP T0 (docs/world-model/PTP-T0-DORMANT-SEAM.md §SEAM) — THE PASS-LEAD SEAT, the
  // ONE `ptpPassLead` fork in `src/**`. Built once per decision (so a percept world
  // pulls at most ONE snapshot here, never one per candidate mate), it carries the
  // gene weight and the world-appropriate MOTION source: truth velocity in a bare
  // world — the same source `mate.pos` already is — and this body's own REMEMBERED
  // percept velocity when `edsPerceivedChoice` has swapped the chooser onto his
  // snapshot. Flag off ⇒ `ptpSeat` is null ⇒ every aim below is `mate.pos` itself,
  // the same object the shipped loop passes, so the arithmetic is byte-identical
  // (G-OFF / G-BORN / G-ZERO). Born absent ⇒ weight 0 ⇒ every lead is exactly ±0.
  const ptpSeat = match.ptpPassLead ? passLeadSeatOf(p, match, g, match.edsPerceivedChoice) : null;
  // DLC T0 (docs/world-model/DLC-T0-DORMANT-SEAM.md §SEAM) — THE DELIVERY CONTEST, the
  // ONE `dlcDeliveryChoice` fork in `src/**`. Armed (flag + a NON-ABSENT
  // `passLeadSupport` gene), every support-mode mate is priced TWICE — once TO FEET
  // (the incumbent arithmetic, byte for byte) and once LED (the banked PTP-T0
  // projection) — and both enter the SAME `bestPass` argmax below. No threshold, no
  // taste multiplier, no new comparison logic: the argmax IS the choice. Flag off or
  // gene absent ⇒ `dlcSeat` is null ⇒ the led candidate never forms and the loop is the
  // shipped one (G-OFF / G-BORN). Built ONCE per decision, so a percept world pulls at
  // most one snapshot here, never one per candidate mate.
  const dlcSeat = match.dlcDeliveryChoice ? deliveryChoiceSeatOf(p, match, g, match.edsPerceivedChoice) : null;
  // DLC T0s (docs/world-model/DLC-T0S-DORMANT-SEAM.md §SEAM) — THE GROUND STRIKE PLANE,
  // the ONE `dlcStrikePlane` fork in `src/**`. Armed (flag + a NON-ABSENT
  // `passLeadSupport` gene — PRESENCE only; the gene's magnitude retired at #240/#241),
  // every support-mode mate is priced over a SAMPLED GRID of ground strikes: direction ×
  // power, K = 9, of which the (0,0) member IS TODAY'S KICK. All of them enter the SAME
  // `bestPass` argmax below, so the argmax picks THE KICK — no threshold, no taste
  // multiplier, no new comparison logic. Flag off or gene absent ⇒ `spSeat` is null ⇒ no
  // grid forms and the loop is the shipped one (G-OFF / G-BORN). Built ONCE per decision,
  // so a percept world pulls at most one snapshot here, never one per candidate mate.
  const spSeat = match.dlcStrikePlane ? strikePlaneSeatOf(p, match, g, match.edsPerceivedChoice) : null;
  // DV T0 (docs/world-model/DV-T0-DORMANT-SEAM.md §SEAM) — THE RISK-PRICING SEAT, the ONE
  // `dvDeliveryValue` fork in `src/**`. Armed (flag + a NON-ABSENT `dvExposureWeight` or
  // `dvLossBelief`), the ONE hoisted `groundCandidate` pricer subtracts this delivery's
  // FLIGHT EXPOSURE (weighted by the exposure gene) and the team's own EARNED loss-cost
  // BELIEF for the candidate's RECEPTION zone (weighted by the pricer's own `passBase`)
  // from every candidate's score — so to-feet, led and strike-plane candidates are all
  // priced by the SAME risk law, downstream of which delivery seam formed them. Genes
  // absent ⇒ `dvSeat` is null ⇒ nothing is computed and the pricer is the shipped one
  // (G-OFF / G-BORN); genes present at zero ⇒ the subtraction is exactly `−(+0)`
  // (G-ZERO). Built ONCE per decision, and it reads nothing but the genome.
  const dvSeat = match.dvDeliveryValue ? deliveryValueSeatOf(g) : null;
  // ⭐⭐ BK T3 §SEAM (docs/world-model/BK-T3-CORRIDOR-HAZARD.md) — THE CORRIDOR-HAZARD
  // SEAT, the ONE `bkCorridorPrice` fork in `src/**`. Armed (flag + a NON-ABSENT DV gene),
  // the FOUR LOFTED delivery choosers — the keeper's punt (which carried no lane, corridor
  // or flight term at all: BK-C1 §R6), the open-play loft switch, the dink over the top
  // and the keeper's hand throw — each subtract `wExposure · hazard`, where the hazard is
  // `flightExposure`'s SHIPPED form restricted to the bodies THIS FLIGHT WOULD ACTUALLY
  // STRIKE (the contact law's own shell and its own 1.35 m edge, at the trajectory's own
  // `g·T²/8` height). It is `deliveryRiskPrice`'s exposure limb at the SAME born-absent
  // gene, so a zero-gene world prices byte-identically with the path LIVE (G-ZERO), and
  // the loss-belief limb is deliberately NOT extended to lofted deliveries.
  // ⛔ NO ARC IS RAISED (#328 item 3): the price makes going over a body PAY, and the
  // chooser — comparing punt against throw against the short game — decides. Built ONCE
  // per decision, and it reads nothing but the genome.
  const bkSeat = match.bkCorridorPrice ? deliveryValueSeatOf(g) : null;
  // ⭐⭐ GC T0 §SEAM (docs/world-model/GC-T0-DORMANT-SEAM.md; contract
  // GC-GROUND-CORRIDOR-CONTRACT.md §2 M-GC.1/.2/.3; ruling #343 item 4) — THE
  // GROUND-CORRIDOR SEAT, the ONE `bkGroundCorridor` fork in `src/**`. Armed (flag + a
  // NON-ABSENT DV gene — the SAME arming rule and the SAME `deliveryValueSeatOf` accessor
  // the lofted corridor seat above uses, so ONE knob prices the whole corridor family),
  // the ONE hoisted `groundCandidate` pricer subtracts `wExposure · hazard`, where the
  // hazard is BK-C2 §P.4's own BINARY shell discriminator over ALL non-sent-off bodies on
  // BOTH TEAMS minus the kicker and minus the intended receiver (BK-C1 §4(ii)'s arriving
  // rule). The LOFTED family is NOT touched — it prices on its own `sL` chain through
  // `bkCorridorPriceLed`, and this term never reaches it.
  // Seat null ⇒ nothing is computed and the pricer is the shipped one (G-OFF / G-BORN);
  // gene present at zero ⇒ the subtraction is exactly `−(+0)` (G-ZERO).
  // ⛔ NO LINE IS BANNED (#328 item 3): the price makes striking a body PAY and the
  // chooser — comparing every candidate at the same argmax — decides. Built ONCE per
  // decision, and it reads nothing but the genome.
  const gcSeat = match.bkGroundCorridor ? deliveryValueSeatOf(g) : null;
  // ⭐ NO NEW PERCEPTION CHANNEL (M-GC.3): the body set is the two collections this
  // function is ALREADY reading through — `team.players` (the mate loop's own) and
  // `opp.players` (the corridor read's own) — which are the snapshot-borne views wherever
  // the percept world is armed (the IN-T0 shadowing at this file's L155-159 convention).
  // Built ONCE per decision beside the seat, so no priced candidate allocates, and it is
  // `[]` while the seat is null so a dormant world builds nothing at all.
  const gcBodies: readonly (readonly Player[])[] =
    gcSeat === null ? [] : [team.players, opp.players];
  // ⭐⭐ RA T0 §SEAM (docs/world-model/RA-T0-DORMANT-SEAM.md; rulings #358/#359/#360 — the
  // user's election 「①′ 接应时间入价」, licensed by DX-C2's DISCRIMINATES) — THE
  // RECEIVER-ACCESS SEAT, the ONE `raAccessPrice` fork in `src/**`. Armed (flag + a
  // NON-ABSENT `raAccessWeight` gene), the ONE hoisted `groundCandidate` pricer subtracts
  // `weight · deficit(E) · passBase` — the seconds by which the intended receiver's own
  // chase arithmetic (interceptBall's time-to-point over the chooser's own flight law,
  // DX-C2 §P.A byte for byte) says he MISSES this candidate's own aim — so to-feet, led
  // and strike-plane candidates are all priced by the same access law, downstream of
  // which delivery seam formed them. A knock (receiver = the kicker) is out of scope by
  // the seat's own GATE. Flag off or gene absent ⇒ `raSeat` is null ⇒ nothing is computed
  // and the pricer is the shipped one (G-OFF / G-BORN); gene present at zero ⇒ the
  // subtraction is exactly `−(+0)` (G-ZERO). Built ONCE per decision, and it reads
  // nothing but the genome.
  const raSeat = match.raAccessPrice ? receiverAccessSeatOf(g) : null;
  // ⭐⭐ CB T2 (docs/world-model/CB-T2-CHOICE-SEAT.md §SEAM) — THE LAYER-2 CHOICE SEAT,
  // the ONE `cbChoiceSeat` fork in `src/**`. Armed (flag + a NON-ABSENT
  // `cbCarryProneness` gene), the carrier's whole COMPASS of touch-past candidates is
  // priced by the SAME hoisted `groundCandidate` that prices to-feet, led and
  // strike-plane deliveries — a knock is a delivery whose RECEIVER IS THE CARRIER
  // HIMSELF, aimed at the point the ball reaches when its own race resolves. One table,
  // no per-seam scoring path (M-CB.2). Flag off or gene absent ⇒ `cbSeat` is null ⇒ no
  // compass forms, nothing is priced and no candidate is pushed (G-OFF / G-BORN).
  const cbSeat = match.cbChoiceSeat && !mustKick && p.role !== 'GK' ? carryChoiceSeatOf(g) : null;
  let bestLeadX = 0;
  let bestLeadY = 0;
  if (p.kickCooldown <= 0) {
    const lp = match.lastCompletedPass;
    const layingOff = p.action.type === 'HoldUp'; // pivot lay-off (Phase 28)
    // Shared style/tilt multipliers (identical for ground and lofted). PURE CODE
    // MOTION out of the mate loop (PTP T0 §DEV 9): the statements, their order and
    // their operands are the shipped chain verbatim, so every call reproduces HEAD's
    // double exactly (G-IDENT / G-FP measure that, they do not assume it). It is a
    // function of the FORWARD-GAIN READ so the LOFTED switch — out of slice (M-PTP.4),
    // striking on its OWN incumbent lead, never this slice's aim — keeps its incumbent
    // BODY pricing while the ground pass keeps the gain it will actually be struck with.
    const passMul = (mate: Player, d: number, gain: number): number => {
      let mul = 1;
      if (gain > 0.05) mul *= 1 + gain * stagnation * 0.35;
      else mul *= 1 - stagnation * 0.3;
      if (team.mode === 'CounterAttack' && gain > 0) mul *= 1.3;
      if (team.mode === 'BuildUp' && gain < 0) mul *= 1.1; // patient recycling is fine
      mul *= 0.7 + g.passBias * 0.75;
      mul *= 0.85 + g.tempo * 0.3;
      if (mate.role === 'GK') {
        // The keeper as a build-up OUTLET (Phase 32.2, 出球门将): a
        // traditional side treats the back-pass as a last resort; a
        // ball-playing side (passBias + riskTolerance) uses him to escape
        // the press — the modern relief valve, priced by the same genes
        // that make the keeper himself play instead of hoof.
        const ballPlay = (g.passBias + g.riskTolerance) / 2;
        mul *= (0.25 + ballPlay * 0.55) * (0.7 + pressure * 1.1);
      }
      // Turning back on an OPEN RUN is the last resort (Phase 31 — the
      // reported "单刀回传"): with nobody goal-side, the chaser at your back
      // reads as pressure and the outlet multiplier used to make the
      // trailing back-pass BEAT driving on. Squaring it forward is fine.
      if (openRun && gain < 0) mul *= 0.35;
      // A mate stood offside is a dead target (Phase 29) — near-suppressed,
      // not zero: the rare desperate ball into them is where flags come from.
      if (!offsideExemptKick && team.localX(mate.pos.x) > offLine + 0.2) mul *= 0.08;
      // Playing the ball where the body doesn't face costs accuracy (Phase 27)
      // — prefer passes we're facing; technique loosens the constraint. Kept
      // mild: the time-gated stagnation tilt is the forward driver, this is
      // only the body-mechanics tiebreak. Restart takers are exempt.
      if (!mustKick) mul *= 1 - kickMisalignment(p, norm(sub(mate.pos, p.pos))) * 0.12 * (1 - p.attrs.passing * 0.5);
      // A pivot lays off short after holding up (Phase 28).
      if (layingOff && d < 12) mul *= 1.3;
      return mul;
    };
    // DLC T0 §SEAM — ONE GROUND-PASS CANDIDATE, priced at ONE aim point. PURE CODE
    // MOTION out of the mate loop (the `passMul` precedent of PTP-T0 §DEV 9): the
    // statements, their order and their operands are the shipped chain VERBATIM, so
    // every call reproduces HEAD's doubles exactly (G-IDENT / G-FP measure that, they do
    // not assume it). Hoisting it is what lets the SAME arithmetic price BOTH deliveries
    // — to feet and led — so the contest can never be a second, drifting copy of the
    // pricing. `d` (the flight band), the offside read, the kick misalignment and the
    // lay-off test stay anchored to the BODY inside `passMul`, exactly as they were.
    const groundCandidate = (mate: Player, aim: Readonly<V2>, d: number): {
      s: number; lane: number; open: number; gain: number; mul: number;
    } => {
      // OP T0 §SEAM — THE LICENCE'S LANE (M-OP.1, ruling #432): the ONE `laneOpenness` call of
      // this pricer resolves to `laneOpennessFront` (M-OP.2 — the man strictly AHEAD of the
      // kicker within 1.5 m is read at CONTROL_RADIUS) when the dormant door is armed, and to
      // the shipped `laneOpenness` otherwise — same arguments, the playmaker's ×1.15 and the
      // `min(1, …)` below byte-unchanged. Scoped to THIS closure: no other caller sees it.
      const laneOpenness = match.opFrontMan ? laneOpennessFront : laneOpennessShipped;
      // The playmaker (Phase 39) reads passing lanes 15% more open than
      // they look — the trait is vision, priced into lane weight only.
      const lane = Math.min(
        1,
        laneOpenness(p.pos, aim, opp.players) * (p.traits.includes('playmaker') ? 1.15 : 1),
      );
      const open = opennessAt(aim, opp.players);
      // Forward progress of the pass, normalized to ±1 over 30m.
      const gain = clamp01((team.localX(aim.x) - localX + 30) / 60) * 2 - 1;

      // The GROUND pass's style/tilt chain, on the gain of the pass it would strike.
      const mul = passMul(mate, d, gain);

      let s = W.passBase + lane * W.passLaneW + open * W.passOpenW;
      if (gain > 0) s *= 1 + gain * (W.passFwdBase + g.riskTolerance * W.passFwdRisk);
      else s *= 1 + gain * W.passBackPen; // mild penalty for going backward
      // Contested forward balls are gated by riskTolerance — but patience
      // runs out: a stale move plays the risky forward ball anyway.
      // (30.5 tried gating blocked SIDEWAYS balls too — it starved the
      // feed out to the held-width winger and neutral-genome populations
      // stopped scoring; the fan's wide outlet needs that half-blocked ball.)
      if (gain > 0.15 && lane < 0.4) {
        const gate = 0.35 + g.riskTolerance * 0.65;
        s *= gate + (1 - gate) * stagnation * 0.4;
      }
      s *= mul;
      if (d > 32) s *= 0.5;
      if (d < 5) s *= 0.75;
      // 2过1 return (Phase 34): the original passer is BURSTING — the return
      // into his stride is the whole point of the wall pass, so it flips the
      // "don't hand it straight back" rule below into a bonus (forward only).
      const wallReturn =
        mate.wallRun !== null &&
        match.simTime < mate.wallRun.until &&
        mate.wallRun.partnerGid === p.gid &&
        gain > 0.2; // the runner must genuinely be IN BEHIND, not alongside
      if (wallReturn) {
        s *= 1.15 + (g.tempo + g.passBias) * 0.25;
      } else if (lp && lp.passerGid === mate.gid && lp.receiverGid === p.gid && match.simTime - lp.t < 2.5 && gain < 0.1) {
        // Don't just hand it straight back to the passer unless it progresses.
        s *= 0.55;
      }
      // Third man (Phase 34): freshly received with a runner ahead — the
      // quick bounce releases HIM, not the man who fed you (that's a 2过1).
      if (
        lp && lp.receiverGid === p.gid && match.simTime - lp.t < 1.5 &&
        lp.passerGid !== mate.gid && mate.action.type === 'MakeRun' && gain > 0.15
      ) {
        s *= 1 + g.passBias * 0.3 * W.thirdManW;
      }
      // 套边 release (Phase 34): the ball down the line into the overlap —
      // but only once the run has COME AROUND (wide, level or beyond).
      // Bonusing the licensed man wherever he stood released the ball
      // instantly to a runner still 3m BEHIND (probed: median reception
      // |y| 9.6 — a central recycle wearing the overlap's name).
      if (
        team.overlapper === mate.index &&
        Math.abs(mate.pos.y) > 9 &&
        team.localX(mate.pos.x) > localX - 6
      ) {
        // A DEVELOPED overlap is the best ball on the pitch — priced like it
        // (the run happens ~1.6s/match, probed; a timid bonus never cashed it).
        s *= 1.3 + g.attackingWidth * 0.6;
      }
      // DV T0 §SEAM — THE RISK PRICE (M-DV.3), the LAST thing the shared pricer does and
      // the ONLY statement this stage adds to it: `score′ = score − wExposure · exposure
      // − belief[zone(aim)] · passBase`. Both limbs are computed AT THIS CANDIDATE'S OWN
      // aim, so every delivery seam's candidates are priced by the same risk law without
      // any of them knowing it exists. Seat null ⇒ `s` itself, the shipped double.
      const sDv = dvSeat === null ? s
        : s - deliveryRiskPrice(dvSeat, p.pos, aim, opp.players, team.localX(aim.x), W.passBase);
      // GC T0 §SEAM — THE GROUND-CORRIDOR PRICE (M-GC.1), the LAST subtraction the shared
      // pricer performs and the ONLY statement this stage adds to it: `s″ = s′ − wExposure
      // · groundShellHazard`. The hazard is evaluated at THIS CANDIDATE'S OWN aim and THIS
      // CANDIDATE'S OWN intended receiver (`mate` — who is `p` himself on a knock, the
      // self-delivery, so kicker and receiver coincide and both exclusions bite the same
      // body), so every GROUND delivery seam's candidates — to feet, led, strike-plane and
      // knock — are priced by the same shell law without any of them knowing it exists.
      // Seat null ⇒ `sDv` itself, the shipped double.
      const sGc = gcSeat === null ? sDv
        : sDv - gcSeat.exposureWeight * groundShellHazard(p.pos, aim, gcBodies, p.gid, mate.gid);
      // RA T0 §SEAM — THE RECEIVER-ACCESS PRICE (#360 item 3), the LAST subtraction the
      // shared pricer performs and the ONLY statement this stage adds to it:
      // `s‴ = s″ − weight · deficit(aim) · passBase`. The deficit is evaluated at THIS
      // CANDIDATE'S OWN aim for THIS CANDIDATE'S OWN intended receiver, in the DV belief
      // limb's own `passBase` currency. Seat null ⇒ `sGc` itself, the shipped double.
      // LN T0 §SEAM — SITE (a), THE LANE ARGMAX (M-LN.3(a)), one more subtraction AFTER the
      // ground-corridor shell and BEFORE the receiver-access term: `s⁗ = s″ − w · (1 −
      // ownLaneOpenness)`. The binary 0.635 m shell STAYS as it is — LN-C2 measured it firing
      // on 0.014374 of the legacy path's passes — and this graded term COMPLEMENTS it, at
      // THIS CANDIDATE'S OWN aim and THIS CANDIDATE'S OWN intended receiver (`mate`, who is
      // `p` himself on a knock, so both exclusions bite the same body). Every ground delivery
      // seam's candidates — to feet, led, strike-plane, knock and the keeper's — are priced
      // by the same own-lane law without any of them knowing it exists. Seat null ⇒ `sGc`
      // itself, the shipped double.
      const sLn = lnSeat === null ? sGc
        : sGc - ownLanePrice(lnSeat.w, ownLaneOpenness(p.pos, aim, team.players, p.gid, mate.gid));
      const sRa = raSeat === null ? sLn
        : sLn - raSeat.weight * receiverAccessDeficit(p.pos, aim, mate, p.gid) * W.passBase;
      return { s: sRa, lane, open, gain, mul };
    };
    for (const mate of team.players) {
      if (mate === p || mate.sentOff) continue;
      // PTP T0: the point this pass is PRICED AT. Seat absent ⇒ literally `mate.pos`
      // (to feet, the shipped loop); seat present ⇒ his feet plus the gene's share of
      // the displacement he is projected to make over the flight. THE THREE SCORING
      // INPUTS BELOW MOVE WITH IT — lane, open and gain are read AT the aim, so the
      // chooser prices the pass it would actually play.
      //
      // ⭐ WHAT STAYS ANCHORED TO THE BODY, stated exactly (the verify-round
      // correction — an earlier version of this comment claimed "every bonus", which
      // was FALSE): `d` (the flight the lead itself is derived from, and the
      // long/short bands), the offside read (the flag is judged on where he STANDS),
      // the kick misalignment (body mechanics), the lay-off distance test, and — via
      // `passMul(mate, d, gainBody)` — the whole style/tilt chain AND the openness of
      // the LOFTED switch, out of slice (M-PTP.4), striking on its OWN incumbent lead.
      //
      // ⭐ WHAT RIDES THE LED GAIN, BY DESIGN, for the GROUND pass this seat prices:
      // every gain-derived score gate below — the stagnation tilt, the CounterAttack
      // and BuildUp mode tilts, the open-run back-pass suppression, the forward-gain
      // and back-pass terms, the risk/lane contest gate, the 2过1 wall-return test,
      // the "don't hand it back" test and the third-man release test. They gate THE
      // PASS THE CHOOSER WILL ACTUALLY STRIKE, so they read the gain of that pass;
      // pricing a led ball against the body's forward progress would be the
      // incoherence, not the fix. Enumerated as BONUS_GATE rows in the read-fork
      // inventory (G-FORK) rather than left to a reader's eye.
      const lead = ptpSeat === null ? null : passLeadOffset(ptpSeat, p.pos, mate);
      const aim = lead === null ? mate.pos : { x: mate.pos.x + lead.x, y: mate.pos.y + lead.y };
      const d = dist(p.pos, mate.pos);
      // DLC T0 §SEAM — CANDIDATE (a), TO FEET: the incumbent candidate, priced at the
      // incumbent's own aim (which is `mate.pos` itself unless the banked PTP forced-aim
      // door is the one that is open). It is scored FIRST and compared FIRST, so the
      // argmax's strict `>` resolves every tie in the INCUMBENT's favour — that is the
      // whole of why a zero-displacement led candidate is inert (§LAW, G-ZERO).
      const feet = groundCandidate(mate, aim, d);
      const { lane, open, gain, mul } = feet;

      if (feet.s > bestPass) {
        bestPass = feet.s;
        bestMate = mate;
        bestLane = lane;
        bestOpen = open;
        // PTP T0: the winner's own led displacement, kept so the STRIKE can follow
        // the PRICING. Seat absent ⇒ these stay 0 and no led strike is ever built.
        bestLeadX = lead === null ? 0 : lead.x;
        bestLeadY = lead === null ? 0 : lead.y;
      }

      // DLC T0 §SEAM — CANDIDATE (b), LED: the SAME arithmetic at the banked PTP-T0
      // projection's aim, entering the SAME argmax. No threshold, no taste multiplier,
      // no new comparison (#236 amendment 1 / M-DLC.1): if it wins, the ball is struck
      // into his stride through the existing led-strike machinery; if it loses, the ball
      // goes to feet. THAT is 想怎么传 — the pricing's own answer, per pass.
      if (dlcSeat !== null) {
        const ledBall = ledDelivery(dlcSeat, p.pos, mate);
        const ledCand = groundCandidate(mate, ledBall.aim, d);
        if (ledCand.s > bestPass) {
          bestPass = ledCand.s;
          bestMate = mate;
          bestLane = ledCand.lane;
          bestOpen = ledCand.open;
          bestLeadX = ledBall.lead.x;
          bestLeadY = ledBall.lead.y;
        }
      }

      // Lofted switch: only worth the hang time for genuinely long balls
      // into space; long passing is a skill (technique gates execution AND
      // selection — poor passers don't trust the diagonal). Keep it 24m+
      // (30.5 tried 18m: the loft cannibalized healthy ground passes and
      // through balls in the 18–24m band and goals sank with them).
      if (d > 24 && !layingOff) {
        // ⭐ PTP T0 — THE LOFT KEEPS ITS INCUMBENT BODY PRICING (M-PTP.4, kept TRUE).
        // `performLoftedPass` strikes on its OWN incumbent lead (`mechanics.ts`:
        // `mate.pos + mate.vel · flight0 · 0.7`, measured mean 0.72 m) — neither the
        // body nor this slice's aim. That strike is the INCUMBENT's and is untouched
        // here; what this restores is the incumbent BODY-anchored PRICING, because a
        // ptpLead-priced loft would be priced against an aim its execution never uses.
        // So openness, forward gain and style chain are read at `mate.pos`. Seat absent
        // ⇒ `aim` IS `mate.pos`, so the arithmetic is HEAD's byte for byte (G-OFF/ZERO).
        const openBody = lead === null ? open : opennessAt(mate.pos, opp.players);
        const gainBody = lead === null ? gain
          : clamp01((team.localX(mate.pos.x) - localX + 30) / 60) * 2 - 1;
        const mulBody = lead === null ? mul : passMul(mate, d, gainBody);
        let sL = (W.loftBase + openBody * W.loftOpenW) * airLane;
        if (gainBody > 0) sL *= 1 + gainBody * (W.passFwdBase + g.riskTolerance * W.passFwdRisk) * 0.8;
        else sL *= 1 + gainBody * W.passBackPen;
        sL *= mulBody;
        sL *= 0.55 + p.attrs.passing * 0.75;
        // BK T3 §SEAM — THE LOFT SWITCH'S CORRIDOR HAZARD, with `performLoftedPass`'s own
        // family. The shipped `* airLane` factor above is UNTOUCHED: it is a height-blind
        // read of the kicker's own surroundings, this is the flight's own line.
        // ⭐ BK T4 §RIDER (#335 item 5): priced at the LINE THE STRIKE ACTUALLY FLIES —
        // `mate.pos + mate.vel · flight0 · 0.7`, `performLoftedPass`'s own lead — not at the
        // standing body (BK-T3 §P10 item 4's disclosed gap, struck at #334 item 3).
        if (bkSeat !== null) {
          sL -= bkCorridorPriceLed(bkSeat, p.pos, mate, opp.players, BK_CORRIDOR_FAMILIES.loft);
        }
        if (sL > bestLoft) {
          bestLoft = sL;
          bestLoftMate = mate;
          bestLoftOpen = openBody;
        }
      }

      // DLC T0s §SEAM — THE GROUND STRIKE PLANE (M-DLC.1″, slice one-s: 控制的是那一脚).
      // K = 9 sampled ground strikes for this mate — direction × power, elevation 0 and
      // spin 0 — each priced by the SAME hoisted `groundCandidate` AT ITS OWN RECEIVING
      // POINT, all entering the SAME argmax. The (0,0) member is TODAY'S KICK: its
      // displacement is exactly ±0, so it prices to the incumbent's own double and the
      // strict `>` keeps the incumbent on every tie (the zero-point wins ties, §LAW).
      // The winner's own displacement rides `bestLeadX/Y` into the BANKED led-strike
      // statement — ZERO new strike statements, so the direction and the power of the
      // chosen kick are carried by the machinery `performPass` already owns (the struck
      // bearing is the bearing to the handed point, and the shipped
      // `clamp(d·0.6 + 8.2, 9, 22)` speed law makes the struck distance the weight).
      // THE PRECEDENCE CHAIN, frozen ex ante: this is the NEWEST seam, so it yields to
      // every banked one — no grid forms while the banked two-point contest (`dlcSeat`)
      // or the banked forced aim (`ptpSeat`) is open, which makes armed-both byte-for-byte
      // identical to the banked door armed alone (G-CROSS). Gates on SEATS, never on
      // another seam's flag, because those flag lines are pinned VERBATIM by their own
      // tests and a pinned test is a STOP, never an edit.
      if (spSeat !== null && dlcSeat === null && ptpSeat === null) {
        for (const strike of groundStrikeGrid(spSeat, p.pos, mate)) {
          const planeCand = groundCandidate(mate, strike.aim, d);
          if (planeCand.s > bestPass) {
            bestPass = planeCand.s;
            bestMate = mate;
            bestLane = planeCand.lane;
            bestOpen = planeCand.open;
            bestLeadX = strike.strike.x;
            bestLeadY = strike.strike.y;
          }
        }
      }
    }
    // ⭐⭐ CB T2 §SEAM — THE TOUCH-PAST CANDIDATES, IN THE ONE TABLE (M-CB.2). The carrier's
    // own compass (derived resolution, anchored on the incumbent push's own bearing) is
    // priced by the VERY SAME hoisted `groundCandidate` the pass candidates just used, with
    // the RECEIVER being this body — a knock is a delivery to yourself into space, and its
    // aim is where the ball IS when its own race resolves. No second pricing path, no
    // threshold, no taste multiplier: only the born-absent style gene, which enters as the
    // appetite the derivation of the neutral form forces (absent ⇒ no seat at all; present
    // at 0 ⇒ every knock prices to exactly 0 and, pushed LAST, can never win a tie).
    //
    // ⭐ `d` is the KNOCK'S OWN LENGTH — the flight of this delivery — exactly as `d` is the
    // flight of a pass; and the body-relationship terms inside `passMul` are evaluated on
    // the actual receiver, who is `p`. The terms that DEGENERATE on a self-delivery are
    // enumerated and MEASURED in the stage doc's §STRAIN rather than special-cased away,
    // because a per-seam exception is exactly what the one-table rule forbids.
    if (cbSeat !== null) {
      match.cbChoiceLedger.seats += 1;
      let bestKnock = 0;
      for (const knock of knockCandidates(p, match.ball.pos, opp.players)) {
        match.cbChoiceLedger.candidates += 1;
        const cand = groundCandidate(p, knock.aim, dist(p.pos, knock.aim));
        const sK = cand.s * cbSeat.proneness;
        if (sK > bestKnock) {
          bestKnock = sK;
          knockDir = knock.dir;
          knockBack = knock.back;
          knockCand = {
            action: 'Dribble',
            score: sK,
            why: `knock past · step ${knock.step}${knock.back ? ' (BACK half)' : ''} · push ${
              knock.push.toFixed(2)}m · lane ${cand.lane.toFixed(2)} · open ${
              cand.open.toFixed(2)} · carry ${cbSeat.proneness.toFixed(2)}`,
          };
        }
      }
    }
    if (pressure > 0.5) bestPass *= W.passOutletMul; // pass is the pressure outlet
    // From the HANDS, the ground pass is a SCHOOL choice (Phase 98): the
    // build-up keeper plays it constantly, the punt-first keeper barely
    // trusts his feet. Outfield passing is untouched.
    if (p.role === 'GK' && p.gkDistributing) bestPass *= 0.6 + g.passBias * 0.8;
    // The why string is built once for the winner — building it per improved
    // candidate inside the loop was pure string churn (toFixed × 3 each time).
    if (bestMate) {
      cands.push({
        action: 'Pass',
        score: bestPass,
        why: `to ${bestMate.name} · lane ${bestLane.toFixed(2)} · open ${bestOpen.toFixed(2)} · passBias ${g.passBias.toFixed(2)}${stagnation > 0.01 ? ` · stale ${stagnation.toFixed(2)}` : ''}`,
      });
    }
    if (bestLoftMate) {
      cands.push({
        action: 'LoftedPass',
        score: bestLoft,
        why: `switch to ${bestLoftMate.name} · open ${bestLoftOpen.toFixed(2)} · air lane ${airLane.toFixed(2)} · passing ${p.attrs.passing.toFixed(2)}`,
      });
    }
  }

  // --- Through ball: feed an assigned runner IN THEIR PATH, not to feet.
  // Scored by the lane to the projected point and how far beyond the last
  // defender it lands; riskTolerance gates it (direct sides live on these).
  let bestRunner: Player | null = null;
  let bestThrough = 0;
  let bestBehind = 0;
  let bestThroughLane = 0;
  let bestThroughChip = false;
  if (p.kickCooldown <= 0) {
    const line = defenderLineLocalX(team, opp.players);
    // Third man (Phase 34): p JUST received — the bounce to a runner within a
    // beat is the possession game's release. Modulated by passBias.
    const lpT = match.lastCompletedPass;
    const fresh = lpT !== null && lpT.receiverGid === p.gid && match.simTime - lpT.t < 1.5;
    for (const mate of team.players) {
      if (mate === p || mate.sentOff || mate.action.type !== 'MakeRun') continue;
      const bounceMul = fresh && lpT!.passerGid !== mate.gid ? 1 + g.passBias * 0.35 * W.thirdManW : 1;
      const flight = dist(p.pos, mate.pos) / 18;
      // Meet the run, not the hover (Phase 29): a runner held onside shows
      // ~zero velocity, so the aim point projects the burst they will make.
      const burst = runBurstPoint(mate, team, opp.players, flight);
      const point = {
        x: clamp(burst.x, -HALF_L + 2, HALF_L - 2),
        y: clamp(burst.y, -HALF_W + 2, HALF_W - 2),
      };
      if (team.localX(point.x) < localX + 5) continue; // must genuinely penetrate
      const lane = laneOpenness(p.pos, point, opp.players);
      const behind = clamp01((team.localX(point.x) - line) / 10);
      let gates = (0.45 + g.riskTolerance * 0.85) * (0.85 + g.tempo * 0.3) * (1 + stagnation * 0.2);
      // A runner ALREADY beyond the offside line is flagged the moment this
      // ball is struck (Phase 29) — wait for them to check their run instead.
      // The held run (executor clamp) makes the legal version of this ball.
      if (!offsideExemptKick && team.localX(mate.pos.x) > offLine + 0.2) gates *= 0.1;
      // The behind term alone used to float a fully-walled ball over the
      // selection bar (Phase 30.5): 82% of through balls went into blocked
      // lanes at 36% completion (probe-pass). Openness now gates the score
      // multiplicatively — open balls unchanged, walls discount hard.
      const s =
        (W.throughBase + lane * W.throughOpenW + behind * W.throughBehindW) *
        gates * (0.4 + 0.6 * clamp01(lane / 0.45)) * bounceMul;
      if (s > bestThrough) {
        bestThrough = s;
        bestRunner = mate;
        bestThroughLane = lane;
        bestBehind = behind;
        bestThroughChip = false;
      }
      // Chip over the top (Phase 28): when bodies block the ground lane but
      // the runner is going in behind, go over them instead — slower to
      // arrive and harder to bring down (technique gates the trust in it).
      // Judged at the LANDING (Phase 30.5): airLane only sees the kicker's
      // surroundings, so packed drop zones looked wide open — the chip's
      // real risk is who stands where the ball comes down.
      if (lane < 0.45) {
        const landOpen = 1 - pressureAt(point, opp.players);
        let sC =
          (W.throughBase + landOpen * W.throughOpenW * 0.8 + behind * W.throughBehindW) *
          gates * 0.9 * (0.55 + p.attrs.passing * 0.7) *
          (0.7 + airLane * 0.3) * (0.4 + 0.6 * clamp01(landOpen / 0.45)) * bounceMul;
        // BK T3 §SEAM — THE DINK'S CORRIDOR HAZARD, priced at the aim this chooser already
        // judges the chip at (`point`, the projected burst) with `performThroughBall`'s own
        // LOFTED family. The shipped factors above are untouched.
        if (bkSeat !== null) {
          sC -= bkCorridorPriceOf(bkSeat, p.pos, point, opp.players, BK_CORRIDOR_FAMILIES.dink);
        }
        if (sC > bestThrough) {
          bestThrough = sC;
          bestRunner = mate;
          bestThroughLane = landOpen;
          bestBehind = behind;
          bestThroughChip = true;
        }
      }
    }
    if (bestRunner) {
      cands.push({
        action: 'ThroughBall',
        score: bestThrough,
        why: `${bestThroughChip ? 'chipped over the top ' : ''}into ${bestRunner.name}'s run · lane ${bestThroughLane.toFixed(2)} · behind ${bestBehind.toFixed(2)} · risk ${g.riskTolerance.toFixed(2)}`,
      });
    }
  }

  // --- Cross (Phase 28): from wide and advanced (or the corner flag), whip
  // it at the best aerial target attacking the box. Wide-overload football
  // lives here: attackingWidth is the style gene that trusts the delivery.
  let bestCrossMate: Player | null = null;
  let bestCrossT = 0;
  const isCorner = kickKind === 'corner';
  if (p.kickCooldown <= 0 && (isCorner || (Math.abs(p.pos.y) > 10 && localX > 10))) {
    for (const mate of team.players) {
      if (mate === p || mate.sentOff || mate.role === 'GK') continue;
      const mLocalX = team.localX(mate.pos.x);
      if (mLocalX < 16 || Math.abs(mate.pos.y) > 13) continue; // must attack the box channel
      let t =
        aerialSense(mate) * 0.6 +
        opennessOf(mate, opp.players) * 0.4 +
        clamp01((mLocalX - 18) / 20) * 0.25;
      // Corner routine (Phase 31): a post routine aims the delivery at the
      // crasher attacking the KEY zone — the separation run the 29.1
      // momentum lever needed but never got a delivery for.
      if (isCorner && (kickRoutine === 'nearPost' || kickRoutine === 'farPost')) {
        t += clamp01(1 - dist(mate.pos, cornerKeyZone(kickRoutine, team.attackDir, p.pos.y)) / 10) * 0.6;
      }
      // Open-play crosses are judged like any pass (Phase 29) — an offside
      // box target wastes the delivery. Corners are exempt (real law).
      if (!offsideExemptKick && mLocalX > offLine + 0.2) t *= 0.12;
      if (t > bestCrossT) {
        bestCrossT = t;
        bestCrossMate = mate;
      }
    }
    if (bestCrossMate) {
      let sX = W.crossBase + bestCrossT * W.crossBoxW;
      sX *= 0.75 + g.attackingWidth * 0.5;
      sX *= 0.7 + g.passBias * 0.4;
      if (p.role === 'WG') sX *= 1.25; // it's what wingers are FOR (28.3)
      if (team.mode === 'Attack' || team.mode === 'CounterAttack') sX *= 1.15;
      // The corner IS a cross — deliver it. Unless the routine says the
      // ball goes SHORT or to the ARC (Phase 31): then the whip is the
      // fallback, not the plan.
      if (isCorner) sX *= kickRoutine === 'short' || kickRoutine === 'arcCutback' ? 0.7 : 2.4;
      if (!mustKick) sX *= 1 - kickMisalignment(p, norm(sub(bestCrossMate.pos, p.pos))) * 0.12 * (1 - p.attrs.passing * 0.5);
      cands.push({
        action: 'Cross',
        score: sX,
        why: `${isCorner ? 'corner — ' : ''}to ${bestCrossMate.name} in the box · target ${bestCrossT.toFixed(2)} · width ${g.attackingWidth.toFixed(2)}`,
      });
    }
  }

  // --- Cutback (Phase 31): from the byline zone, the hard pull-back to the
  // arc — real football's canonical set-defence beater. The regular pass
  // loop can never pick it (gain < 0 reads as a back-pass and gets
  // penalized), so it scores as its own candidate aimed at the licensed
  // ARRIVER, whose late run the executor routes to the arc. The receiver's
  // snap-decision window (giveBall) makes the first-time strike.
  let cutbackMate: Player | null = null;
  let cutbackCand: UtilityScore | null = null;
  const cornerCutback = kickKind === 'corner' && kickRoutine === 'arcCutback';
  if (
    p.kickCooldown <= 0 && (!mustKick || cornerCutback) && team.arriver !== null &&
    Math.abs(p.pos.y) > 10 && localX > HALF_L - 17
  ) {
    const arr = team.players[team.arriver];
    if (arr !== p && !arr.sentOff) {
      const lane = laneOpenness(p.pos, arr.pos, opp.players);
      const open = opennessOf(arr, opp.players);
      const arrLocalX = team.localX(arr.pos.x);
      const inArc = arrLocalX > HALF_L - 26 && Math.abs(arr.pos.y) < 12;
      let sCB =
        (0.48 + lane * 0.3 + open * 0.28) *
        (inArc ? 1.15 : 0.6) *
        (0.8 + g.attackingWidth * 0.4);
      // The corner routine committed to this ball (Phase 31) — the arc
      // strike IS the plan, the whipped cross is the fallback.
      if (cornerCutback) sCB *= 2.2;
      cutbackMate = arr;
      cutbackCand = {
        action: 'Pass',
        score: sCB,
        why: `cutback to ${arr.name} at the arc · lane ${lane.toFixed(2)} · open ${open.toFixed(2)}`,
      };
      cands.push(cutbackCand);
    }
  }

  // --- Hold-up (Phase 28): the pivot's back-to-goal game. A striker with
  // the ball, back to goal and a defender on them shields it and waits for
  // support instead of forcing a turn — the lay-off boost in the pass loop
  // is the payoff. Patience isn't free: stagnation drains it.
  // 34.3 (user report "中锋接球之后不转身"): the zone extends into the own
  // half — the target-man outlet shields wherever the long ball finds him.
  // 打卡油角 (Phase 35): killing the game at the corner flag, ANY carrier
  // shields — the pivot's back-to-goal craft, borrowed for the clock.
  const cornerHold =
    team.mentality.holding > 0.5 && localX > HALF_L - 18 && Math.abs(p.pos.y) > 10;
  if (!mustKick && ((p.role === 'ST' && localX > -12 && localX < 32) || cornerHold)) {
    const backToGoal = kickMisalignment(p, norm(sub(goal, p.pos))); // 1 = facing own goal
    if (backToGoal > 0.45 && pressure > 0.2) {
      const sH =
        (0.36 + pressure * 0.3) *
        (0.55 + p.attrs.dribbling * 0.7) *
        (0.5 + backToGoal * 0.5) *
        (1 - stagnation * 0.5) *
        (cornerHold ? 1 + team.mentality.holding * 0.6 : 1);
      cands.push({
        action: 'HoldUp',
        score: sH,
        why: `back to goal · pressure ${pressure.toFixed(2)} · dribbling ${p.attrs.dribbling.toFixed(2)}`,
      });
    }
  }

  // --- Dribble: needs space ahead; dribbleBias makes it a first choice.
  // Never for a keeper (32.2): a back-pass puts the ball at his FEET and
  // his job is to move it, not to carry it out of the box (the reported
  // 门将带球跑出禁区 class of nonsense is fenced here for good).
  if (!mustKick && p.role !== 'GK') {
    // Wide and advanced (Phase 31): the drive goes DOWN THE LINE toward the
    // byline, not diagonally into the packed box — 下底. Space is measured
    // along the actual path (the touchline channel is usually open when the
    // central cone is a wall), and dribbleTarget steers the same way, so
    // the utility and the legs agree. This is what puts carriers in the
    // pull-back zone at all: measured before it, the byline was occupied
    // for 0.16s per MATCH.
    const wideDrive = Math.abs(p.pos.y) > 13 && localX > 20 && localX < HALF_L - 7;
    const toGoal = wideDrive
      ? norm(sub(v2((HALF_L - 8) * team.attackDir, Math.sign(p.pos.y) * (HALF_W - 12)), p.pos))
      : norm(sub(goal, p.pos));
    const space = spaceAhead(p, toGoal, opp.players);
    let sD = (W.dribbleBase + space * W.dribbleSpaceW) * (W.dribbleGeneBase + g.dribbleBias * W.dribbleGeneW);
    sD *= 1 - pressure * W.dribblePressurePen;
    // The TURN TAX (34.3, user report "球员朝向也挺重要"): driving forward
    // with your back to the play means turning ON the ball — a contested
    // touch when someone is close. Facing forward, or free of pressure,
    // costs nothing; back-to-goal under a marker, the forward drive yields
    // to holding up, escaping, or the first-time ball.
    sD *= 1 - kickMisalignment(p, toGoal) * pressure * 0.3;
    // Drive the OPEN RUN (Phase 31, the reported "大空间不突破就硬要传球"):
    // big space ahead used to lose to forced passes. The boost is a flat
    // multiplier ON TOP of the pressure penalty — an earlier cut also
    // EXEMPTED open-run dribbles from back-pressure, and that possession-
    // longevity freebie inverted the shootBias gene (patient teams simply
    // outlasted everyone into MORE shots; genes.test caught it). Inside
    // 15m the 28.4 breakaway boost takes over: FINISH, don't carry it in.
    if (openRun && dGoal > 15) sD *= 1.35;
    if (team.mode === 'CounterAttack') sD *= 1.25;
    sD *= 1 + stagnation * 0.28; // carrying it forward relieves stagnation (Phase 27)
    cands.push({
      action: 'Dribble',
      score: sD,
      why: `space ${space.toFixed(2)} · dribbleBias ${g.dribbleBias.toFixed(2)}${openRun && dGoal > 15 ? ' · open run — drive' : ''}${stagnation > 0.01 ? ` · stale ${stagnation.toFixed(2)}` : ''}`,
    });
    // 脱压带球 (34.2, user report): pressured with the front door closed,
    // the craft answer is to CARRY it back or sideways and buy an outlet —
    // not to stop dead (the old forward-only dribble died to the pressure
    // penalty here and the carrier froze). Escaping pressure is the point,
    // so the penalty barely applies; basic craft, only half-gated by flair.
    const holdCorner = team.mentality.holding > 0.5;
    const esc = escapeCarry(p, team.attackDir, localX, opp.players, holdCorner);
    if (esc && !openRun) {
      let sE =
        (W.dribbleBase + esc.space * W.dribbleSpaceW) *
        (W.dribbleGeneBase + g.dribbleBias * 0.5 * W.dribbleGeneW);
      sE *= 1 - pressure * 0.1;
      // Killing the game (Phase 35): the carry to the corner outranks the
      // risky ball — possession IS the shot now.
      if (holdCorner && localX > 0) sE *= 1 + team.mentality.holding * 0.4;
      cands.push({
        action: 'Dribble',
        score: sE,
        why: holdCorner && localX > 0
          ? `carrying it to the corner — killing the game · space ${esc.space.toFixed(2)}`
          : `carrying it OUT of the press · escape space ${esc.space.toFixed(2)}`,
      });
    }
  }

  // --- Keeper distribution from the HANDS (Phase 28.3 → 98, user-ratified
  // "门将出球选择应该和战术有关"): the one-size throw becomes the coach's
  // choice — three genome-scored releases:
  //   · the short roll to feet    — the build-up school (passBias): tempo
  //     from the back, restart the pattern;
  //   · the fast long sling       — the counter launch (counterAttackBias):
  //     forward gain is the whole point, priced up with the gene;
  //   · the PUNT (new)            — closed outlets + no build-up genes: a
  //     long lofted drop the phase-63 aerial channel contests on descent —
  //     STRENGTH picks the target, so the tall outlet man is a buyable
  //     package for punt-first coaches.
  // The 28.3 no-hoof contract stands: every release still has a NAME on it.
  let bestThrowMate: Player | null = null;
  let bestThrow = 0;
  let puntCand: (typeof cands)[number] | null = null;
  let puntMate: Player | null = null;
  if (p.role === 'GK' && p.gkDistributing && p.kickCooldown <= 0) {
    let bestOpenNear = 0; // how playable the short game is right now
    // The counter WINDOW: every opponent still committed in our half at the
    // catch is a man the quick sling beats — the fast break is launched
    // from the keeper's hands or it isn't a fast break at all.
    let committed = 0;
    let oppOutfield = 0;
    for (const o of opp.players) {
      if (o.role === 'GK' || o.sentOff) continue;
      oppOutfield++;
      if (team.localX(o.pos.x) < 0) committed++;
    }
    const transition = oppOutfield > 0 ? committed / oppOutfield : 0;
    for (const mate of team.players) {
      if (mate === p || mate.sentOff) continue;
      const d = dist(p.pos, mate.pos);
      const open = opennessOf(mate, opp.players);
      if (d >= 8 && d <= 16) bestOpenNear = Math.max(bestOpenNear, open);
      if (d < 8 || d > 30) continue;
      const gain = clamp01((team.localX(mate.pos.x) - localX + 30) / 60) * 2 - 1;
      let sT =
        d <= 16
          ? (0.3 + open * 0.5) * (0.6 + g.passBias * 0.8)
          : (0.3 + open * 0.5) *
            (0.5 + g.counterAttackBias * 0.7) *
            (1 + Math.max(gain, 0) * (0.2 + g.counterAttackBias * 0.55)) *
            (1 + transition * g.counterAttackBias * 1.3);
      // LOOK BEFORE YOU THROW (the keeper-release fix): the flat throw/sling
      // is a GROUND ball — a body parked in the lane blocks it and it bounces
      // back into the box (measured: hands releases blocked-lane 9-18% vs the
      // lane-aware goal kick's 4-5%, lane-HITs landing 60-79% in our own
      // defensive third). Every outfield pass already reads laneOpenness
      // (`passBase + lane*passLaneW + …`); the hands distribution never did —
      // it picked by receiver-openness alone. A clear lane is now required,
      // not merely an open receiver. The lofted PUNT below clears heads and
      // keeps its openness-of-landing logic.
      sT *= 0.3 + laneOpenness(p.pos, mate.pos, opp.players) * 0.7;
      // BK T3 §SEAM — THE HAND THROW'S CORRIDOR HAZARD. ⭐ EXTEND, NOT DUPLICATE: the
      // shipped ground-lane factor on the line above is left exactly as it is (a pinned
      // statement is a STOP, never an edit) and NO second lane term is added — what this
      // adds is the HEIGHT half the shipped read cannot see, at `performKeeperThrow`'s own
      // family (T ≤ 1.5 s ⇒ apex ≤ 2.76 m, so a throw genuinely clears some bodies and
      // genuinely strikes others). The over-pricing this leaves on the ONE delivery that
      // already priced a corridor is declared in the stage doc's §HONESTY.
      // ⭐ BK T4 §RIDER (#335 item 5): at `performKeeperThrow`'s OWN lead
      // (`mate.pos + mate.vel · flight0 · 0.7`), the line the thrown ball actually flies.
      if (bkSeat !== null) {
        sT -= bkCorridorPriceLed(bkSeat, p.pos, mate, opp.players, BK_CORRIDOR_FAMILIES.keeperThrow);
      }
      if (sT > bestThrow) {
        bestThrow = sT;
        bestThrowMate = mate;
      }
    }
    if (bestThrowMate) {
      cands.push({
        action: 'ThrowOut',
        score: bestThrow,
        why: `thrown to ${bestThrowMate.name} · open ${opennessOf(bestThrowMate, opp.players).toFixed(2)} · ${dist(p.pos, bestThrowMate.pos) <= 16 ? `roll to feet · passBias ${g.passBias.toFixed(2)}` : `counter sling · counterBias ${g.counterAttackBias.toFixed(2)}`}`,
      });
    }
    let bestPuntFit = 0;
    for (const mate of team.players) {
      if (mate === p || mate.sentOff) continue;
      const d = dist(p.pos, mate.pos);
      if (d < 24) continue;
      const fit = clamp01((team.localX(mate.pos.x) - localX) / 60) * 0.6 + mate.attrs.strength * 0.5;
      if (fit > bestPuntFit) {
        bestPuntFit = fit;
        puntMate = mate;
      }
    }
    if (puntMate) {
      const closed = 1 - bestOpenNear;
      let sP =
        (0.2 + closed * 0.55) *
        (1.4 - (g.passBias + g.riskTolerance) * 0.6) *
        (0.7 + bestPuntFit * 0.45);
      // ⭐⭐ BK T3 §SEAM — THE PUNT'S FIRST CORRIDOR TERM (the user's mandate, made src):
      // until this statement the keeper's launch priced the bodies in front of it at
      // nothing at all (BK-C1 §R6, needle-by-needle). Priced at the punt's OWN target with
      // `performLoftedPass`'s own family; the target picker above is UNTOUCHED (choosing a
      // different man is a separate question, BK-C1 §8's honest exclusion).
      // ⭐ BK T4 §RIDER (#335 item 5): at the punt's own strike lead, not the standing man.
      if (bkSeat !== null) {
        sP -= bkCorridorPriceLed(bkSeat, p.pos, puntMate, opp.players, BK_CORRIDOR_FAMILIES.loft);
      }
      puntCand = {
        action: 'LoftedPass',
        score: sP,
        why: `PUNT to ${puntMate.name} · outlets closed ${closed.toFixed(2)} · strength ${puntMate.attrs.strength.toFixed(2)}`,
      };
      cands.push(puntCand);
    }
  }

  // --- Clear: panic button deep in our half; risk-averse teams use it more.
  // A keeper distributing from the HANDS never panic-hoofs (Phase 28.3) —
  // they had a full second to pick a target.
  if (localX < -18 && p.kickCooldown <= 0 && !(p.role === 'GK' && p.gkDistributing)) {
    let sC = (W.clearBase + pressure * W.clearPressureW) * (1.25 - g.riskTolerance * 0.8);
    // A keeper with the ball at his feet (32.2): the TRADITIONAL keeper
    // hoofs it; the ball-playing one (passBias + riskTolerance) trusts his
    // feet and plays through the press — the same genes that make his
    // teammates use him as the outlet.
    if (p.role === 'GK') sC *= 1.9 - (g.passBias + g.riskTolerance) * 0.55;
    cands.push({ action: 'ClearBall', score: sC, why: `pressure ${pressure.toFixed(2)} · risk-averse ${(1 - g.riskTolerance).toFixed(2)}` });
  }

  // ⭐ CB T2 §SEAM — the knock enters the table LAST, on purpose: `Array.prototype.sort` is
  // stable, so a knock that merely TIES the incumbent's best option stays behind it and the
  // shipped choice survives. That is what makes the present-at-zero gene inert (its score is
  // exactly 0) and what keeps every tie the incumbent's, the DLC-T0s zero-point precedent.
  if (knockCand !== null) cands.push(knockCand);
  // ⭐⭐ IN T0 §SEAM — THE RESOLUTION BACK TO TRUTH (M-IN.1: PHYSICS STAYS TRUTH). The
  // whole ladder above was priced on this body's SNAPSHOT; from here down every winner is
  // his TRUTH object again, so the heading he sets, the `targetIdx` he publishes and the
  // `perform*` strike that follows all read the world as it IS. That split is the law,
  // not a concession: he CHOOSES on what he believes and the ball then goes where his
  // legs actually send it — the world corrects him, and staleness costs him nothing but
  // being wrong (M-IN.1's 延迟期间 principle, extended from time to space).
  //
  // A body that was never staled resolves to itself, so this is a no-op for every winner
  // the reader was facing. Flag off ⇒ `inView` is null ⇒ ZERO statements run.
  if (inView !== null) {
    if (bestMate !== null) bestMate = inView.real(bestMate);
    if (bestLoftMate !== null) bestLoftMate = inView.real(bestLoftMate);
    if (bestRunner !== null) bestRunner = inView.real(bestRunner);
    if (bestCrossMate !== null) bestCrossMate = inView.real(bestCrossMate);
    if (cutbackMate !== null) cutbackMate = inView.real(cutbackMate);
    if (bestThrowMate !== null) bestThrowMate = inView.real(bestThrowMate);
    if (puntMate !== null) puntMate = inView.real(puntMate);
  }
  cands.sort((a, b) => b.score - a.score);
  // Degenerate fallback (kick still on cooldown): carry the ball as today.
  if (cands.length === 0) {
    p.action = { type: 'Dribble', scores: [] };
    return;
  }
  const top = cands[0];
  const scores = cands.slice(0, 4);

  // O2 T0 — THE LOOK (docs/world-model/O2-T0-DORMANT-SEAM.md, contract
  // O2-LOOK-CONTRACT §2). The ONE place a look is spent, and it sits IMMEDIATELY
  // BEFORE the whether fork on purpose: 抬头观察 is what you do BEFORE you judge,
  // and the seat that consumes the refreshed percept (M-O2.4) is the very next
  // block. Taking a look costs REAL TICKS — the body plants for `O2_LOOK_TICKS`
  // and does NOT act, while pressure closes (M-O2.2; there is no score subsidy
  // anywhere in this seam). Dormant: `o2Look` is false in every production path,
  // and even armed the decision is incumbent-equivalent unless an instrument
  // forces it (`lookSeat.ts`), so nothing here can be reached in the shipped game.
  if (o2LookEligible(p, match, top.action, mustKick)) {
    const look = o2LookDecision(p, match);
    if (look.take) {
      match.armO2Look(p);
      // No new action TYPE at T0: the readable body cue is the contract's T2+ exit
      // item. He is still carrying, so he keeps the incumbent carry label and the
      // executor's O2 plant block slows him on his own spot.
      p.action = { type: 'Dribble', scores: [{ action: 'Dribble', score: 1, why: look.why }] };
      return;
    }
  }

  // C5 T2 — THE WHETHER SEAT (docs/world-model/C5-T2-WHETHER-SEAT.md §2.2). The
  // ONE place the whether fork is read. Dormant: `whetherEye` is null in every
  // production path, so this branch is unreachable in the shipped game (X-FP /
  // X-OFF-IDENT / X-SEAM). When armed, at the eligible WHETHER fork — after
  // `cands` are sorted so A0 (`top`) is known, and BEFORE the perceived pass
  // chooser and the action commit — the perceived chooser may "keep holding":
  // the census's own eligible-choice predicate (settled control · not a forced
  // release · A0 not Shoot/Clear, C5-RECENSUS §1.5 repair iv) gates it, and the
  // seat prices a HOLD from THIS body's own percept, taking it ONLY where the
  // perceived cell's certified interval reaches zero (R-B, #64.1). A taken hold
  // overrides `top` with a percept-compliant `ShieldHold` for k ticks (the C5 T0
  // hold machinery, reachable now through `whetherEye` as well as
  // `forcedHold && c5Hold`); otherwise `top` runs unchanged and the pass chooser
  // is untouched — mirroring the census fork exactly (A0 = untouched top).
  if (
    match.whetherEye !== null && whetherEyeInScope(match.whetherEye, p)
    && !mustKick && p.role !== 'GK' && p.firstTouchWindow <= 0
    && top.action !== 'Shoot' && top.action !== 'ClearBall'
  ) {
    const decision = whetherEyeDecision(p, match, match.whetherEye.table);
    // ⭐ EK T0 §SEAM — THE INDEX, at its source (M-EK.1): the book indexes the band THIS
    // BODY'S OWN SEAT just placed from its own percept. Recorded for every placed cell so
    // a training-ground drill hold carries the seat's own band too. Dormant: `ekHold` is
    // null in every production path, and so is `whetherEye`.
    if (match.ekHold !== null && decision.perceived !== null) {
      match.ekHold.noteSeatBand(p.gid, decision.perceived.pressureBand, match.simTick);
    }
    if (decision.cls === 'D-HOLD' && decision.k !== null) {
      // ⭐⭐ EK T0 §SEAM — THE COMPARATIVE VETO (M-EK.3, #261.3(iv)). The certified table
      // has ALREADY licensed this hold; armed, the team's own book may DECLINE it when
      // its own experience says this band is strictly worse than its own cross-band
      // reference. Declining runs the act-now branch the seat would have run anyway —
      // nothing is added, nothing is subsidised, and an unlicensed hold is never reached.
      const ekBand = decision.perceived === null ? null : decision.perceived.pressureBand;
      if (ekBand === null || !match.ekHoldDeclines(p.side, ekBand)) {
        match.whetherHoldState.set(p.gid, {
          untilTick: match.simTick + decision.k,
          cellAtDecision: decision.cell ?? '',
          k: decision.k,
        });
        // The take is a hold the team EXPERIENCES: the book learns from it too.
        if (match.ekHold !== null && ekBand !== null) {
          match.ekHold.noteTakeHold(p.side, ekBand, match.simTime);
        }
        p.action = {
          type: 'ShieldHold',
          scores: [{ action: 'ShieldHold', score: 1, why: `whether-hold k${decision.k} cell ${decision.cell}` }],
        };
        return;
      }
    }
  }

  // EDS E2a-2: dormant target-choice intervention. A census of PLAYED passes
  // is a selected sample — the chooser already filtered for options it liked —
  // so the option-space prior has to be measured counterfactually. This is the
  // one seam where "what if he had picked that man instead" can be asked
  // without touching how the pass is then struck. Null in every production
  // path; the cutback has its own machinery and is never substituted.
  let passMate = bestMate;
  if (match.forcedPassTarget !== null && top.action === 'Pass' && top !== cutbackCand) {
    const forced = team.players.find(
      (mate) => mate.gid === match.forcedPassTarget && mate !== p && !mate.sentOff,
    );
    if (forced) passMate = forced;
  } else if (
    match.edsPerceivedChoice && top.action === 'Pass' && top !== cutbackCand
    && p.role !== 'GK' && bestMate !== null
  ) {
    // EDS E3 — the live perceived chooser (design contract §2.1). The brain has
    // already decided to pass; WHO gets it is priced from this body's own
    // snapshot on E2b-0's measured probability axis, over executable options
    // only. Keepers are excluded exactly as every perception consumer excludes
    // them, and the cutback keeps its own machinery.
    // E3R (ruling #12.4 (d)): candidate-scoped materialisation. The pricing
    // reads this body, the options it is pricing, and the opponents the
    // corridor read scans — so that is what gets built into an array, at the
    // one tick it is asked. Candidates are enumerated from the roster, which
    // needs no snapshot at all (§5 (c)'s registered truth-measured window).
    const candidateGids = passChoiceCandidateGids(p, team.players);
    const scope = new Set<number>([p.gid, ...candidateGids]);
    for (const other of opp.players) if (!other.sentOff) scope.add(other.gid);
    // LN T0 §SEAM — SITE (c1), THE SCOPE. LN-C2 put 0.678909 of the traced caroms on this
    // chooser, which reads the corridor for OPPONENTS and never for us. The passer can only
    // price a line his own men are standing in if he PERCEIVES them, so his own outfield gids
    // enter the materialisation scope — through the SAME eyes, at the snapshot's own age, no
    // new channel. ⛔ Seat null ⇒ this ternary's else-branch never runs and not one gid is
    // added, so the scope, the snapshot and therefore the world are byte-identical (G-OFF).
    const lnOwnGids = lnSeat === null ? null : ownLaneScopeGids(p.gid, team.players);
    if (lnOwnGids !== null) for (const gid of lnOwnGids) scope.add(gid);
    const snapshot = candidateGids.length === 0 ? null : match.perceivedSnapshot(p, scope);
    const reachProfiles = snapshot === null ? null : match.reachProfiles();
    // LN T0 §SEAM — SITE (c2), THE OPTION PRICE. The chooser's argmax compares `price`, so
    // the own-lane read must land on the compared quantity and nowhere else: each EXECUTABLE
    // option's price is multiplied by `1 − w · (1 − ownLaneOpenness)` BEFORE the reduce. The
    // hook is passed INTO `choosePerceivedPassTarget` rather than re-ranked here, because
    // re-ranking would require a SECOND copy of the argmax and its tie rule, and a second
    // copy of a decision law is exactly what drifts. ⚠ THE CURRENCY MIX — a score-unit weight
    // applied multiplicatively to a MEASURED PROBABILITY — is this seam's DECLARED
    // APPROXIMATION (contract §4; T0 doc §4). The perceived own bodies are the snapshot's own
    // entries for exactly the gids added above (own outfield, not sent off, not the passer),
    // so the population is the same one the two score sites price over.
    const lnOwnPerceived = lnOwnGids === null || snapshot === null ? null
      : snapshot.players.filter((entry) => lnOwnGids.includes(entry.gid));
    const lnOwnLaneFactor = lnSeat === null || snapshot === null || lnOwnPerceived === null
      ? undefined
      : (targetGid: number): number => {
        const seenPasser = snapshot.players.find((entry) => entry.gid === p.gid);
        const seenTarget = snapshot.players.find((entry) => entry.gid === targetGid);
        if (seenPasser === undefined || seenTarget === undefined) return 1;
        return 1 - ownLanePrice(lnSeat.w, ownLaneOpenness(
          seenPasser.pos, seenTarget.pos, lnOwnPerceived, p.gid, targetGid,
        ));
      };
    const choice = snapshot === null || reachProfiles === null || candidateGids.length === 0 ? null
      : choosePerceivedPassTarget({
        snapshot,
        passerGid: p.gid,
        candidateGids,
        attackDir: team.attackDir,
        reachProfiles,
        valueAxis: match.edsValueAxis,
        ownLaneFactor: lnOwnLaneFactor,
        // OP T0b §SEAM (M-OP.5, ruling #435 item 3(c)) — the ONE call-site argument: the dormant
        // front-chooser door. Shut (every world) ⇒ false ⇒ every option priced as shipped.
        frontContact: match.opFrontChooser,
      });
    const chosen = choice === null ? null
      : team.players.find((mate) => mate.gid === choice.targetGid) ?? null;
    // No executable option means he can see nobody he could honestly aim at.
    // v1 keeps the legacy choice there rather than suppressing a pass the
    // action layer already committed to — the seam is target choice only. The
    // rate is traced (`chosenGid === -1`) and reported, never hidden.
    if (chosen) passMate = chosen;
    if (match.traceChoice) {
      const power = choice === null || snapshot === null || reachProfiles === null
        ? null : preferredPassPower({
          snapshot,
          passerGid: p.gid,
          targetGid: choice.targetGid,
          attackDir: team.attackDir,
          reachProfiles,
          powers: PASS_CANARY_POWERS,
          heavyTouchCost: match.edsTouchCost,
        });
      match.passChoiceTrace.push({
        tick: match.simTick,
        passerGid: p.gid,
        chosenGid: choice?.targetGid ?? -1,
        legacyGid: bestMate.gid,
        candidates: candidateGids.length,
        read: choice?.options.filter((o) => o.infoClass === 'READ').length ?? 0,
        seenUnread: choice?.options.filter((o) => o.infoClass === 'SEEN-UNREAD').length ?? 0,
        unseen: choice?.options.filter((o) => o.infoClass === 'UNSEEN').length ?? 0,
        price: choice?.price ?? Number.NaN,
        reception: choice?.reception ?? Number.NaN,
        value: choice?.value ?? Number.NaN,
        distance: choice?.distance ?? Number.NaN,
        blindOutpricesRead: choice?.blindOutpricesRead ?? false,
        blindOutpricesBand: choice?.blindOutpricesBand ?? false,
        preferredPowerIndex: power?.preferredIndex ?? -1,
        powerPrices: power?.prices ?? [],
        powerThreatSeconds: power?.threatSeconds ?? [],
        powerTouchFailPriors: power?.touchFailPriors ?? [],
        // E5g: the menu, exactly as priced. Pure observation.
        options: (choice?.options ?? []).map((option) => ({
          targetGid: option.targetGid,
          infoClass: option.infoClass,
          price: option.price,
          executable: option.executable,
          cell: option.cell,
          band: option.band,
        })),
      });
    }
  }

  // ⭐⭐ PW T0b §SEAM — THE RUNG-GRAIN WEIGHT CHOOSER (docs/world-model/PW-T0B-WEIGHT-CHOOSER.md;
  // contract §2 M-PW.2; design fixed by ruling #292.4). A SEPARATE block, deliberately not folded
  // into the E3 chooser above, so that banked seam stays byte-identical and this one owns its own
  // arming. Dormant: `pwWeightChooser` is OFF in every production path, so `pwPower` is the
  // literal 1 the three strike statements below have always carried, and `executedPassPower(1)`
  // draws no rng — byte-identity off.
  //
  // The grain: every (mate × rung) pair over the engine's OWN canary ladder is admitted by the
  // SHIPPED oracle AT ITS OWN POWER and priced by the SAME two factors the shipped joining rule
  // uses; the argmax picks man and weight together. The E2a-2 forced-target seam keeps
  // precedence (a probe that names a man is not overruled by a chooser), and the cutback keeps
  // its own machinery, exactly as the E3 block scopes itself.
  //
  // ⭐ DIVERGENCE-1 (#291.1(c), #292.3): the orientation multiplier handed in below is the
  // PASSER'S OWN body — computed from his heading and the PERCEIVED direction to the mate, never
  // from truth — and it exists ONLY on this flagged path.
  if (
    match.pwWeightChooser && match.forcedPassTarget === null && !mustKick
    && top.action === 'Pass' && top !== cutbackCand && p.role !== 'GK' && bestMate !== null
  ) {
    const pwGids = passChoiceCandidateGids(p, team.players);
    const pwScope = new Set<number>([p.gid, ...pwGids]);
    for (const other of opp.players) if (!other.sentOff) pwScope.add(other.gid);
    const pwSnapshot = pwGids.length === 0 ? null : match.perceivedSnapshot(p, pwScope);
    const pwReach = pwSnapshot === null ? null : match.reachProfiles();
    if (pwSnapshot !== null && pwReach !== null) {
      const orientationMul = new Map<number, number>();
      for (const gid of pwGids) {
        const seenMate = pwSnapshot.players.find((entry) => entry.gid === gid);
        const seenSelf = pwSnapshot.players.find((entry) => entry.gid === p.gid);
        if (seenMate === undefined || seenSelf === undefined) continue;
        const dx = seenMate.pos.x - seenSelf.pos.x;
        const dy = seenMate.pos.y - seenSelf.pos.y;
        const dl = Math.sqrt(dx * dx + dy * dy);
        if (!(dl > 1e-6)) continue;
        orientationMul.set(gid, orientationPowerMul(
          kickMisalignment(p, { x: dx / dl, y: dy / dl }), p.attrs.passing,
        ));
      }
      // ⭐ PW T0c (#293.3 (a)): the LADDER is still the engine's own canary ladder; a probe may
      // COLLAPSE it (`pwPowerLadder`) — the objective-fidelity instrument, whose whole purpose is
      // to run this chooser at {1} and show that it then IS the shipped chooser.
      const pwLadder = match.pwPowerLadder ?? PASS_CANARY_POWERS;
      const pw = choosePassWeight({
        snapshot: pwSnapshot,
        passerGid: p.gid,
        candidateGids: pwGids,
        attackDir: team.attackDir,
        reachProfiles: pwReach,
        powers: pwLadder,
        // ⭐ PW T0c: the WORLD'S OWN objective — the same axis flag the shipped chooser above
        // priced with, so the mate is chosen on the world's own price and only the RUNG differs.
        valueAxis: match.edsValueAxis,
        orientationMul,
      });
      match.pwChooserLedger.pairsAsked += pw === null
        ? pwGids.length * pwLadder.length : pw.pairsAsked;
      if (pw !== null) {
        const pwMate = team.players.find((mate) => mate.gid === pw.targetGid) ?? null;
        // No admitted pair means no chooser opinion: the incumbent choice stands untouched,
        // exactly as the E3 chooser's own null leaves it.
        if (pwMate) {
          // ⭐ PW T0c: the FIDELITY COUNTER — did the weight chooser move the man off the
          // incumbent (in the v7 world, the shipped perceived chooser's own pick)? With the
          // ladder collapsed to {1} this must be 0: same objective, same candidates, same
          // tie-break ⇒ same man.
          if (pwMate !== passMate) match.pwChooserLedger.mateSwitches++;
          passMate = pwMate;
          // ⭐ THE DEPOSIT (the `forcedTouchPast` idiom): the chosen weight is left on the match
          // for THIS body at THIS tick and consumed by the strike itself, so the banked strike
          // statements below stay byte-identical and the choice cannot leak to another kick.
          match.pwStrikePower = { gid: p.gid, power: pw.power, tick: match.simTick };
          const led = match.pwChooserLedger;
          led.decisions++;
          // ⭐ PW T0c (#293.3 (c)): the ACCOUNTING NUMERATOR — every non-default weight that was
          // ever deposited. The engine then accounts each one's fate (struck · voided by a
          // cancelled wind-up · abandoned), so a silently dropped choice is impossible to hide.
          if (pw.power !== 1) led.depositsNonDefault++;
          if (pw.powerIndex < led.chosenByRung.length) led.chosenByRung[pw.powerIndex]++;
          led.pairsAdmittedOnlyOffReference += pw.pairsAdmittedOnlyOffReference;
          led.matesAdmittedOnlyOffReference += pw.matesAdmittedOnlyOffReference;
          led.pairsDroppedForOtherRungRefusal += pw.pairsDroppedForOtherRungRefusal;
          led.pairsLive += pw.pairsLive;
          led.matesLive += pw.matesLive;
          led.pairsLiveOnlyOffReference += pw.pairsLiveOnlyOffReference;
          led.matesLiveOnlyOffReference += pw.matesLiveOnlyOffReference;
          // ⭐ PW T0c — the parity counters (§OBJECTIVE FIDELITY).
          led.matesPriced += pw.matesPriced;
          led.matesNotExecutable += pw.matesNotExecutable;
          led.referenceAdmissionsWithoutOracleRead += pw.referenceAdmissionsWithoutOracleRead;
          led.rungsWithoutReferenceNormaliser += pw.rungsWithoutReferenceNormaliser;
        }
      }
    }
  }

  // ⭐⭐ IN T0 §SEAM — THE SECOND RESOLUTION SITE, and WHY THERE ARE TWO. `passMate` is
  // re-seated by THREE blocks that run BELOW the ladder's resolution above — the E2a-2
  // forced target, the perceived pass chooser's `chosen`, and the PW chooser's `pwMate` —
  // and each of them finds its body by scanning `team.players`, which is the SHADOW. Left
  // alone, a stale view body would reach `performPass`/`armPendingPass` and PHYSICS WOULD
  // STRIKE A GHOST (M-IN.1 breached). So the substituted target is resolved here, at the
  // last statement before any action can be dispatched.
  //
  // ⚠ AND IT IS THE RIGHT SEMANTICS, not just the safe one: `passMate === bestMate` below
  // gates the PTP lead on "the chooser's OWN winner is the man being passed to". Comparing
  // a view against a truth object would answer NO for the very same body; comparing two
  // truth objects answers the football question. Flag off ⇒ `inView` is null ⇒ ZERO
  // statements run and the identity is HEAD's.
  if (inView !== null && passMate !== null) passMate = inView.real(passMate);

  // A restart taker sets themselves before striking (the run-up): face the
  // chosen target so orientation penalties don't gut dead-ball deliveries —
  // corners arrived weak and wild while the taker still faced the flag.
  if (mustKick) {
    const at =
      top === cutbackCand ? cutbackMate!.pos // the corner arc cutback (31)
      : top.action === 'Pass' ? passMate!.pos
      : top.action === 'LoftedPass' ? bestLoftMate!.pos
      : top.action === 'Cross' ? bestCrossMate!.pos
      : top.action === 'ThroughBall' ? bestRunner!.pos
      : top.action === 'Shoot' ? goal
      : null; // clears/dribbles: face straight upfield
    if (at) {
      const hx = at.x - p.pos.x;
      const hy = at.y - p.pos.y;
      const hl = Math.sqrt(hx * hx + hy * hy);
      if (hl > 1e-6) p.heading = { x: hx / hl, y: hy / hl };
    } else {
      p.heading = { x: team.attackDir, y: 0 };
    }
  }

  // ⭐⭐ CB T2 §SEAM — THE CHOSEN KNOCK IS ARMED (M-CB.2), and the ARMING IS WITHDRAWN when
  // this body's own new decision no longer wants it, so an aim can never fire one tick
  // stale. Nothing else changes: the knock carries the incumbent CARRY label, so the switch
  // below runs its `default` branch verbatim (`p.action = { type: 'Dribble', scores }`) and
  // ZERO new action types, executor branches or strike statements exist. CB-T0's own fork in
  // `stepBall` fires the knock at this body's next owned tick, subject to its own conjuncts —
  // so a chosen knock in a world without the `cbTouchPast` door simply never happens, which
  // is the arming checklist's whole point. The banked seams keep precedence by construction:
  // the O2 look and the whether seat both RETURN above this line.
  if (cbSeat !== null) {
    // ⭐ THE PRICE GAP, recorded before anything is armed: what the one table said the best
    // knock was worth, beside what it said the winner was worth. Bookkeeping only — nothing
    // in the sim reads it back, and it is the evidence §STRAIN 1 is argued on.
    match.cbChoiceLedger.bestKnockScoreSum += knockCand === null ? 0 : knockCand.score;
    match.cbChoiceLedger.winnerScoreSum += top.score;
    if (knockCand !== null && top === knockCand) match.armTouchPast(p, knockDir!, knockBack);
    else match.clearTouchPastArming(p);
  }

  // Kicks resolve instantly; movement actions persist until next tick.
  switch (top.action) {
    case 'Pass':
      if (top === cutbackCand) {
        p.action = { type: 'Pass', targetIdx: cutbackMate!.gid, scores };
        match.performCutback(p, cutbackMate!);
      } else {
        p.action = { type: 'Pass', targetIdx: passMate!.gid, scores };
        // O1 T1 (docs/world-model/O1-T1-PASS-WINDUP.md §SEAM): the single arm site,
        // cut-1 = shortPass ONLY. An open-play shortPass enters the wind-up instead
        // of releasing synchronously — the body commits and turns toward the mate for
        // W ticks, then the pass resolves at readyTick through the SAME performPass
        // math. Excluded, each for its own ruled reason: `mustKick` (restart takers
        // share this door — the C7 free-kick precedent needs an explicit test here)
        // and `firstTouchWindow > 0` (THE DESIGNED BYPASS — a one-touch release goes
        // now, at its existing oneTouchMul price; no new charge). Dormant:
        // o1PassWindup is OFF in every production path, so this is the shipped
        // synchronous release verbatim (no rng draw added, no reordering). The
        // cutback branch above is untouched.
        // PTP T0 §SEAM (EXECUTION CARRIES THE PRICING): a pass PRICED against a led
        // point hands its OWN priced displacement to the strike — which ADDS it to the
        // incumbent strike-time correction, so the ball lands BEYOND the priced aim
        // rather than on it (§HONESTY 5 / §DEV 2, measured in the stage doc's smoke).
        // Its own armed-only statement — the incumbent statements
        // around it are byte-identical, and the O1 wind-up keeps precedence (that
        // banked seam owns the release timing; with both armed the strike resolves
        // through the wind-up's own aim, an honest limit stated in the stage doc).
        // Guards, not predicates: the lead rides only when the chooser's OWN winner
        // is the man being passed to (a substituted target — the E2a-2 forced probe
        // or the perceived chooser — was never priced with a lead), and only when the
        // lead is non-zero, so the born-absent and zero-gene worlds never even reach
        // this statement.
        // PW T0b §SEAM: ZERO NEW STRIKE STATEMENTS — the chosen weight is DEPOSITED on
        // `match.pwStrikePower` by the chooser block above and CONSUMED inside `performPass`
        // (and captured at arm time by `armPendingPass`, so it rides the wind-up: #291.5
        // correction 4). The three statements below are the banked ones, byte-for-byte.
        // ⭐⭐ DX T0 §SEAM (docs/world-model/DX-T0-WINDUP-AIM-SEAM.md; contract
        // DX-DELIVERY-EXECUTION-CONTRACT.md §2 M-DX.1/M-DX.2; ruling #352 item 3) — THE
        // ELECTED AIM'S DEPOSIT, the ONE `dxWindupAim` fork in `src/**`. THE DISCARD THIS
        // FIXES: the wind-up branch below hands `armPendingPass` no aim at all, so a pass
        // the argmax scored at a DISPLACED point is wound up and struck at the target's
        // body — 脑子会选,腿不会踢 (GC-T1B's `O1-WINDUP-PRECEDENCE`: displaced share
        // EXACTLY 0 over 30,318 wind-up decisions). Armed, the winner's OWN displacement —
        // the SAME `bestLeadX` / `bestLeadY` the synchronous led-strike statement below
        // hands to `performPass`, under the SAME two guards (the chooser's own winner is the man
        // being passed to, and the displacement is non-zero) — is left on the match for
        // THIS body at THIS tick and captured by `armPendingPass`. ⚠ It is spelled as an
        // object literal, NOT as `v2(…)`, so that PTP-T0's banked ordering pin (the led
        // STRIKE statement comes after the wind-up fork) keeps comparing against the strike
        // statement it was written about — a pinned test is a STOP, never a silent edit.
        // ZERO new candidates,
        // ZERO new scoring terms, ZERO genes, ZERO rng, and no flight parameter is
        // touched: only WHICH POINT the shipped kick is struck toward. Flag off ⇒ this
        // reads one boolean and no statement runs; the three banked statements below are
        // byte-for-byte the certified ones.
        if (match.dxWindupAim && passMate === bestMate && (bestLeadX !== 0 || bestLeadY !== 0)) {
          match.dxStrikeAim = {
            gid: p.gid, lead: { x: bestLeadX, y: bestLeadY }, tick: match.simTick,
          };
        }
        if (match.o1PassWindup && !mustKick && p.firstTouchWindow <= 0) {
          match.armPendingPass(p, passMate!, offsideExemptKick);
        } else if (passMate === bestMate && (bestLeadX !== 0 || bestLeadY !== 0)) {
          match.performPass(p, passMate!, offsideExemptKick, 1, v2(bestLeadX, bestLeadY));
        } else match.performPass(p, passMate!, offsideExemptKick);
      }
      break;
    case 'LoftedPass': {
      // The keeper's punt (Phase 98) routes to ITS target — the aerial
      // outlet — not the ground game's best switch.
      const loftTo = top === puntCand ? puntMate! : bestLoftMate!;
      p.action = { type: 'LoftedPass', targetIdx: loftTo.gid, scores };
      match.performLoftedPass(p, loftTo, offsideExemptKick);
      break;
    }
    case 'Cross':
      p.action = { type: 'Cross', targetIdx: bestCrossMate!.gid, scores };
      // A routine corner delivers to the KEY ZONE, not to a led body
      // (Phase 31.9): the crasher's burst is timed onto the zone, and a
      // velocity lead on a sprinting man overshot the whole picture by
      // ~9m. The small pull keeps the drop off the keeper's claim radius.
      match.performCross(
        p, bestCrossMate!, offsideExemptKick,
        kickKind === 'corner' ? 0.06 : 0.18,
        kickKind === 'corner' && (kickRoutine === 'nearPost' || kickRoutine === 'farPost')
          ? cornerKeyZone(kickRoutine, team.attackDir, p.pos.y)
          : undefined,
      );
      break;
    case 'ThrowOut':
      p.action = { type: 'ThrowOut', targetIdx: bestThrowMate!.gid, scores };
      match.performKeeperThrow(p, bestThrowMate!);
      break;
    case 'ThroughBall':
      p.action = { type: 'ThroughBall', targetIdx: bestRunner!.gid, scores };
      match.performThroughBall(p, bestRunner!, bestThroughChip, offsideExemptKick);
      break;
    case 'Shoot':
      p.action = { type: 'Shoot', scores };
      // A free-kick strike is a different kick entirely (Phase 32): the
      // placed ball curls OVER the wall on its own flight profile.
      if (kickKind === 'freeKick') match.performFreeKick(p);
      // C7 T1 (docs/world-model/C7-T1-PENDINGKICK.md §SEAM): the single fork
      // point. An open-play/one-touch shot enters the wind-up instead of
      // striking synchronously — the body commits and turns toward goal for W
      // ticks, then the strike resolves at readyTick via the SAME performShot
      // math. Dormant: c7Windup is OFF in every production path, so this is the
      // shipped synchronous strike verbatim (no rng draw added, no reordering).
      else if (match.c7Windup) match.armPendingKick(p, goal);
      else match.performShot(p);
      break;
    case 'ClearBall':
      p.action = { type: 'ClearBall', scores };
      match.performClear(p);
      break;
    case 'HoldUp':
      p.action = { type: 'HoldUp', scores };
      break;
    default:
      p.action = { type: 'Dribble', scores };
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Goalkeeper                                                          */
/* ------------------------------------------------------------------ */

function decideGoalkeeper(p: Player, team: Team, match: Match): void {
  const ball = match.ball;
  const ownGoal = team.ownGoal();

  // Shot incoming at our goal -> drop everything and save.
  const shot = match.pendingShot;
  if (
    shot && !shot.resolved && shot.side !== p.side && ball.owner === null &&
    dot(ball.vel, sub(ownGoal, ball.pos)) > 0
  ) {
    p.action = { type: 'GoalkeeperSave', scores: [{ action: 'GoalkeeperSave', score: 1, why: 'shot incoming' }] };
    return;
  }

  // 门将上前 (Phase 35): licensed for a stoppage-time attacking corner —
  // the goal stands EMPTY behind him; a cleared ball into the counter is
  // the price of the theater. TeamBrain tears the license up within one
  // brain tick of the moment dying and he falls through to positioning,
  // which sprints him home.
  if (team.keeperUp) {
    p.action = {
      type: 'MakeRun',
      scores: [{ action: 'MakeRun', score: 1, why: 'keeper UP for the corner — nothing left to lose' }],
    };
    return;
  }

  // 1v1 rush (Phase 27.5): an opponent carrier bearing down with nobody
  // goal-side — charge them down and make the goal small. keeperAggression
  // sets how far out the keeper is willing to leave the line.
  // Phase 103 (user design, 门将出击到禁区外) probed BOTH extensions and
  // kept one: charging a CONTROLLED carrier far out is bad football — the
  // rush-anatomy A/B measured the extended charge at GA +1.3-1.8 vs the
  // timid school in both regimes (attackers simply shoot past the
  // advancing keeper: xg/shot faced 0.16→0.20). The carrier charge keeps
  // its classic range; the sweeper's REAL range gain is the loose-ball
  // interception below (through balls are where 出击 pays).
  const carrier = ball.owner;
  if (carrier && carrier.side !== p.side) {
    const aggr = team.genome.keeperAggression;
    const dGoal = dist(carrier.pos, ownGoal);
    if (dGoal < 9 + aggr * 8) {
      let goalside = 0;
      for (const mate of team.players) {
        if (mate === p || mate.sentOff) continue;
        if (dist(mate.pos, ownGoal) < dGoal - 1) goalside++;
      }
      // The RACE READ (Phase 103): charge only when he can MEET the carrier
      // before the shot. Inside the box the old reflex stands (make the
      // goal small); outside it, an unwinnable charge just opens an empty
      // net — probed: an always-charge sweeper conceded 5.13/match vs the
      // timid school's 2.05. The gene prices the accepted margin, the
      // physics decide the race.
      let raceWon = true;
      if (goalside === 0 && !match.inPenaltyBox(carrier.pos, p.side)) {
        const toGoal = norm(sub(ownGoal, carrier.pos));
        const closing = carrier.vel.x * toGoal.x + carrier.vel.y * toGoal.y;
        raceWon =
          closing > 1.2 &&
          timeToPoint(p, carrier.pos) < (dGoal - 11) / closing + (aggr - 0.5) * 0.4;
      }
      if (goalside === 0 && raceWon) {
        p.action = {
          type: 'GoalkeeperRush',
          scores: [{ action: 'GoalkeeperRush', score: 1, why: `1v1 — rushing out · aggr ${aggr.toFixed(2)}` }],
        };
        return;
      }
    }
  }

  // Loose ball near our goal that we can claim first. The gate is on where
  // the ball is COMING DOWN (Phase 28) — a cross dropping into the box pulls
  // the keeper off the line to meet it even while it's still out wide.
  if (ball.owner === null) {
    const sol = interceptBall(p, ball);
    // The sweeper's interception range (Phase 103): a through ball coming
    // down 20-27m out is the high-line keeper's to eat — feet only out
    // there (the 28.5 giveBall gate). Timid keepers keep the old 15m.
    if (dist(sol.point, ownGoal) < 15 + Math.max(0, team.genome.keeperAggression - 0.5) * 24) {
      // Running min over the same values in the same order — the old
      // filter/map/spread allocated two arrays per GK decision.
      let rivalT = Infinity;
      for (const q of match.allPlayers) {
        if (q === p || q.sentOff) continue;
        const t = timeToPoint(q, sol.point);
        if (t < rivalT) rivalT = t;
      }
      if (sol.tMe < rivalT || (ball.airborne && sol.tMe <= sol.tBall + 0.2)) {
        p.action = { type: 'ChaseBall', scores: [{ action: 'ChaseBall', score: 0.9, why: ball.airborne ? 'attack the dropping ball' : 'claim loose ball in box' }] };
        return;
      }
    }
  }

  p.action = {
    type: 'GoalkeeperPosition',
    scores: [{ action: 'GoalkeeperPosition', score: 0.6, why: `keeperAggression ${team.genome.keeperAggression.toFixed(2)}` }],
  };
}

/* ------------------------------------------------------------------ */
/* Off-ball outfielders                                                */
/* ------------------------------------------------------------------ */

function decideOffBall(p: Player, team: Team, opp: Team, match: Match): void {
  const g = team.genome;
  const W = team.policies[p.index];
  const ball = match.ball;
  const possession = match.possessionSide;
  const cands: UtilityScore[] = [];
  let markTarget: number | undefined;
  let receiveFlag = false;
  // ⭐⭐ RC T0b §FIX (ruling #379 item 5) — THE TRADE'S TWO INPUTS, declared at the function's
  // own scope because they are recorded on the action record the foot builds. ⛔ THE MOVEMENT
  // MENU IS UNTOUCHED: nothing is pushed into `cands`, nothing is spliced back out. Shut, both
  // stay at their initial values and every statement that reads them is skipped.
  let rcReadyCarrierGid = -1;
  let rcReadyBenefit = 0;

  const tired = p.stamina < 0.4 && g.staminaConservation > 0.5;

  if (possession === team.side) {
    // ----- We have the ball -----
    // ⭐ OBM T0 (#227, contract §2 M-OBM.1–3) — THE OFF-BALL EYES SEAT: read fork 2
    // of 2 in src/**, and the seat's ONLY percept pull, taken here at the body's own
    // AI_INTERVAL decision cadence (M-OBM.4). The policy's PLANE half is handed to
    // the match so the executor can re-use it without looking again; its two SCORE
    // multipliers modulate the candidates below.
    // ⭐ TWO DOORS, TWO ARGUMENTS (the OBM-T0 verify catch): `match.ctbSupportPlane`
    // rides in TWICE and does two different jobs. (1) As the fourth `supportSpot`
    // argument it makes the ANCHOR the point this body would ACTUALLY take with the
    // seat absent under whatever flag state the world is in — so the f3 space reading
    // is honest in every configuration, while still excluding the seat's OWN output
    // (self-feedback avoidance retained). (2) As the fifth `obmOffballPolicy`
    // argument it is the CTB DOOR: the banked static genes enter the plane
    // composition only when their own flag is armed, so arming THIS seat alone can
    // never spend the banked CTB gene bank.
    // Flag off ⇒ both multipliers stay exactly 1 and `s *= 1` is an IEEE-754
    // identity, so the shipped scores are byte-identical (G-OFF / G-BORN / G-ZERO).
    let obmSupportMul = 1;
    let obmRunMul = 1;
    if (match.obmMovement) {
      const obm = obmOffballPolicy(
        p, match, g, supportSpot(p, team, ball, match.ctbSupportPlane), match.ctbSupportPlane,
      );
      match.setObmPolicy(p.gid, obm.plane);
      obmSupportMul = obm.supportMul;
      obmRunMul = obm.runMul;
    }
    const pass = match.pendingPass;
    if (pass && pass.side === team.side && pass.targetGid === p.gid) {
      cands.push({ action: 'ReceivePass', score: RC_S_RECEIVE, why: 'pass is coming to me' });
      receiveFlag = true;
    }
    // ⭐⭐ RC T0b §SEAM (docs/world-model/RC-T0B-READY-SEAM.md; ruling #378 item 6; contract
    // RC §2-AMENDMENT M-RC.3b, BF M-BF.4) — THE READY LIMB, the ONE `rcReady` fork in `src/**`
    // and the WHOLE of this seam's live read set: the same-side CARRIER's `pos` / `vel` /
    // `heading` (external body state) and his heading one step earlier (the match's own
    // flag-gated memory), each mate's `pos` / `gid` / `side` / `sentOff` (external), my own
    // `gid`, and the team's own anticipation gene. ⛔ NOT `pendingPassWindup`, NOT
    // `pendingPass`, NOT `faceTarget`, NOT a TeamBrain designation, NOT `info.genome` — the
    // seat could not read them if it wanted to (its import list is closed), and this call site
    // does not hand them over. The pin suite pins THIS argument list as the read set.
    //
    // 「看见自己人拿球正转向我,先把身子打开对着他」. Armed (flag + a NON-ABSENT
    // `rcAnticipationWeight` gene — the RA `raAccessPrice` gating idiom), this fork computes
    // the BENEFIT of opening the body — `w · belief · s_receive`, where the belief is RC-C0b's
    // OWN measured joint for the cell the carrier's body is in — and records it, with the
    // carrier's gid, as an OVERLAY on the action record.
    //
    // ⭐⭐ THE TRADE IS THE DECISION (ruling #379 item 3; contract RC §2-AMENDMENT M-RC.3b):
    // 「转不转身,不该和"跑不跑"抢同一个名额;该和"转过去会慢多少"比」. Turning to face a
    // teammate does not stop a body running, so it must NOT compete inside the movement argmax
    // (the commander's own error of record at #378 item 6(iv), measured by G-REACH). It
    // competes with what it COSTS — the speed the body forfeits by facing off its line, which
    // is BF's own facing law. The BENEFIT is computed HERE (the brain's belief, at his decision
    // cadence); the COST is resolved in `actionExecutor` at the face-write site, every frame,
    // against that frame's own intended direction and the movement plan's own priority.
    //
    // ⛔ NOTHING IS RECORDED when `w · belief` is 0, so a body with nothing to believe carries
    // NO overlay field at all and his record is byte-identical to shut (G-INERT).
    if (match.rcReady) {
      const holder = ball.owner;
      const w = rcAnticipationWeightOf(team.effGenome);
      if (holder !== null && holder !== p && holder.side === p.side && !holder.sentOff
        && !p.sentOff && w !== null) {
        const prevH = match.rcReadyPrevHeading(holder.gid);
        if (prevH !== null) {
          const mates: RcMateBearing[] = [];
          for (const q of match.allPlayers) {
            if (q.gid === holder.gid || q.side !== holder.side || q.sentOff) continue;
            mates.push({ gid: q.gid, x: q.pos.x, y: q.pos.y });
          }
          const rank = alignmentRank(
            holder.pos.x, holder.pos.y, holder.heading.x, holder.heading.y, mates, p.gid,
          );
          const cell = rcReadyCell(
            Math.sqrt(holder.vel.x * holder.vel.x + holder.vel.y * holder.vel.y),
            prevH.x, prevH.y, holder.heading.x, holder.heading.y, rank,
          );
          const score = w * rcReadyBelief(cell) * RC_S_RECEIVE;
          if (score > 0) {
            rcReadyCarrierGid = holder.gid;
            rcReadyBenefit = score;
          }
        }
      }
    }
    // OUR loose ball (36.2): TeamBrain assigned this player to the 50/50
    // (a squirt/miscontrol/knockdown while possession is nominally ours) —
    // go win it back; the race outranks shape and support.
    if (ball.owner === null && team.chasers.has(p.index)) {
      cands.push({ action: 'ChaseBall', score: 1.1, why: 'our loose ball — contest it' });
    }
    const carrier = ball.owner;
    // The DF slot is the REST DEFENCE (Phase 31): once the ball crosses
    // halfway he does not join the siege — formationSpot clamps his spot
    // deep (≤ −12 local) and he holds it as the +1 cover and the recycling
    // outlet. Without this the support fan pulled even the last outfielder
    // to the ball, nobody covered, and every turnover was an uncontested
    // breakaway — which is how a 5v6 side out-scored its full-strength
    // self (the besieged team lives on counters).
    // A4-P1b (#133): the DESIGNATION POLICY's first in-possession face. When the
    // side is abandoned (probe-only, side-scoped), restDefence collapses to false
    // ⇒ the index-1 body is NO LONGER excluded from the support fan below — he
    // scores SupportBallCarrier like any outfielder (STATUE-safe: no freeze, just
    // the special law removed). null in production ⇒ identical to HEAD.
    const restDefence = p.index === 1 && team.localX(ball.pos.x) > 0
      && match.abandonRestDesignation !== team.side;
    if (carrier && carrier !== p && !restDefence) {
      const d = dist(p.pos, carrier.pos);
      const roleBonus = p.role === 'ST' ? 0.12 : p.role === 'WG' ? 0.1 : p.role === 'MF' ? 0.06 : 0;
      const modeMul = team.mode === 'Attack' || team.mode === 'CounterAttack' ? 1.2 : team.mode === 'BuildUp' ? 1.0 : 0.6;
      let s = (W.supportBase + clamp01(1 - d / 30) * W.supportProxW + roleBonus) * modeMul;
      if (tired) s *= OFFBALL_TIRED_MUL; // conserve energy: prefer holding shape
      // OBM T0 — SCORE SITE 1 of 2 (M-OBM.1). Bounded multiplicative, applied last so
      // the incumbent arithmetic above is untouched; `obmSupportMul === 1` unless the
      // seat is armed AND dosed, and `s *= 1` is exact.
      s *= obmSupportMul;
      cands.push({ action: 'SupportBallCarrier', score: s, why: `dist ${d.toFixed(0)}m · mode ${team.mode}` });
    }
    // Assigned runner: sprint in behind and drag the line — the movement a
    // through ball needs. Tired legs sit the run out. During a corner setup
    // there is no carrier yet — the licensed box-crashers run anyway
    // (Phase 28: the cross needs bodies attacking the area, not spectators).
    // The ARRIVER (Phase 31) runs on the same license — executor routes
    // their run to the edge-of-box arc instead of in behind.
    const arriving = team.arriver === p.index;
    // A corner delivery in FLIGHT has no carrier and phase is 'playing' —
    // without the cornerCrash clause the licensed crashers lost their run
    // the instant the ball left the taker's boot and walked back to their
    // formation spots while it was still in the air (Phase 31.9).
    const crashLive = team.cornerCrash !== null && match.simTime < team.cornerCrash.until;
    // C4 T2-ARRIVAL: the identical clause for an OPEN-PLAY cross. This line is
    // the defect the stage exists for — without a third term here, the licence
    // TeamBrain just re-asserted has no candidate to attach to, and every body
    // it names still walks back to its formation spot mid-flight.
    const crossLive = match.c4Arrival && team.crossFlight !== null
      && match.simTime < team.crossFlight.until;
    if ((team.runners.has(p.index) || arriving) && (carrier ? carrier !== p : match.phase === 'restart' || crashLive || crossLive)) {
      let s = W.runScore;
      if (tired) s *= OFFBALL_TIRED_MUL;
      // OBM T0 — SCORE SITE 2 of 2 (M-OBM.1: the ALREADY-LICENSED run). The wall-pass
      // burst and the overlap below are their own committed licenses with their own
      // timing laws and are NOT in slice one — see the stage doc's §LAW.
      s *= obmRunMul;
      cands.push({
        action: 'MakeRun',
        score: s,
        why: arriving
          ? 'arriving late at the cutback arc'
          : match.phase === 'restart' || crashLive ? 'attacking the box for the delivery' : 'licensed run in behind',
      });
    }
    // 2过1 (Phase 34): just played the wall pass under pressure — burst past
    // the marker NOW; the return is scored to find this run. The BURST is
    // short (1.2s) even though the return credit runs 2.3s: a full-window
    // sprint pulled the passer out of the support structure for so long it
    // cost goals across the calibrate seeds — dart, then re-join.
    if (p.wallRun && match.simTime < p.wallRun.until - 1.1 && carrier && carrier !== p) {
      let s = W.runScore * (1.05 + (g.tempo + g.passBias) * 0.25);
      if (tired) s *= OFFBALL_TIRED_MUL;
      cands.push({ action: 'MakeRun', score: s, why: 'bursting for the one-two return' });
    }
    // 套边 (Phase 34): licensed to overlap outside the confronted wide
    // carrier — width genes commit harder to the run.
    if (team.overlapper === p.index && carrier && carrier !== p) {
      let s = W.runScore * (1 + g.attackingWidth * 0.3);
      if (tired) s *= OFFBALL_TIRED_MUL;
      cands.push({ action: 'MakeRun', score: s, why: 'overlapping outside the carrier' });
    }
    // ⭐⭐⭐ DS T0 §SEAM — 「自己的前插」 THE OWN RUN (docs/world-model/DS-T0-OWN-RUN-SEAM.md;
    // contract DS-DESIGNATION-CONTRACT.md §2 M-DS.1/M-DS.2/M-DS.3/M-DS.5; ruling #405 item 3).
    // DORMANT (Road B) — the ONE `match.dsOwnRun` fork in `src/**`.
    //
    // DS-C0's read of record: EVERY open-play run in this engine is a HAT. All five `MakeRun`
    // pushes are hat-guarded and `hatClass.shareOfMakeRun.OTHER` is 0 of 964,441 attacking
    // `MakeRun` decisions — a body has no way to say "I want to go". This block is that way:
    // ONE candidate, for a body carrying NO hat, priced like every other candidate and
    // settled by the same argmax.
    //
    // ⭐ THE PRIOR IS THE COACH'S OWN RANKING, MOVED TO THE PLAYER (M-DS.2, VISION §1
    // 「共同 prior,不是逐 tick commander」): `assignRunners` ranks bodies by
    // `RUN_ROLE_W[role] + localX/45` and hands the top `count` a hat. Here the SAME
    // expression, divided by its OWN maximum (`RUN_PRIOR_MAX`, derived in code), is a [0,1]
    // prior on the body's own score. Nobody is banned and nobody is chosen: a deep DF simply
    // prices his run at ~0 and loses the argmax to shape.
    //
    // ⭐ THE EYES ARE THE OBM SEAT'S (M-DS.3): the SAME `obmRunMul` the licensed run above
    // already uses — exactly 1 when `obmMovement` is absent, and `s *= 1` is an IEEE-754
    // identity. NO new feature, NO new gene, NO percept pull at T0.
    //
    // ⛔ THE COMPLETE READ SET of this fork: his own `pos`, `role` and (through `tired`)
    // `stamina`; his own team's HAT BOARD (`team.runners` / `team.arriver` /
    // `team.overlapper` / his own `p.wallRun`) — a read of his own side's licence board,
    // STATED AS SUCH, not a percept; `obmRunMul`; `W.runScore`; `team.localX`. NOT
    // `pendingPass`, NOT `pendingPassWindup`, NOT any opponent's truth position, NOT
    // `info.genome`.
    //
    // ⛔ NO PREDICATE ON A FOOTBALL QUANTITY (#200): the whole conditional set of this block
    // is the GATE (the flag), the GUARDS (the four not-hatted reads — set membership, index
    // equality and the licence's own clock liveness), the CAP (`clamp01`) and the incumbent
    // `tired` multiplier. Nothing branches on a distance, a space or an opponent.
    //
    // ⭐ THE CARRIER AND THE KEEPER are excluded STRUCTURALLY, not by a new test:
    // `decideOffBall` is only reached after `decidePlayer` has returned for `ball.owner === p`
    // and for `p.role === 'GK'` (pinned).
    //
    // Its executor routing is the `MakeRun` case's EXISTING default branch — an unhatted body
    // falls past the crash / cross / arriver / overlapper arms to `runTarget` — so NOT ONE
    // executor line moves. Flag off ⇒ nothing here runs and the menu is HEAD's byte for byte.
    //
    // ⭐⭐⭐ DS T0c §LAW-C — THE RANK SLICE (docs/world-model/DS-T0-OWN-RUN-SEAM.md §LAW-C;
    // contract §2 M-DS.6″/M-DS.7; ruling #409 item 4). SAME FLAG, no new flag. It AMENDS
    // DS-T0b's §LAW-B, whose velocity mass is REMOVED, not kept beside.
    //
    // DS-T1 measured that with the coach's hats off the own run FLOODED
    // (`r1.runsPerInPossessionTick` 0.584786 → 1.832816). DS-T0b answered with a VELOCITY
    // MASS and DS-T1b measured that it OVER-CORRECTED: `r1.runsPerInPossessionTick`
    // 0.585428 → 0.138356 (the own run a quarter of the coach's designations),
    // `guard.throughBallsPerMatch` 6.156156 → 2.133133 (a breach DOWNWARD), the seam's own
    // `restraint` mean 0.570614 with `exactlyZeroShare` 0.191379. Ruling #409 item 3(iv)
    // read the cause: the coach did not weigh MOTION, he RANKED — the top `count` bodies by
    // `RUN_ROLE_W[role] + localX/RUN_DEPTH_DIV` were licensed and all others were not.
    //
    // ⭐ M-DS.6″ — THE RANK RESTRAINT. `runRank` is the coach's own ranking expression,
    // CODE-MOVED out of `assignRunners`' `.map` (never re-typed — the shipped map CALLS it),
    // and `runnerCount` is his count expression, code-moved at DS-T0b. Both are 共同 prior:
    // team mode, genome, mentality and the convention's role weights are the side's SHARED
    // knowledge, agreed before kick-off, DECLARED as such and not a percept. `rankAbove` =
    // how many of the mates HIS OWN EYES hold rank above him by that convention (ties broken
    // exactly as the coach's sort breaks them), and `restraint = clamp01(count − rankAbove)`
    // — EXACTLY the coach's `scored.slice(0, count)` expressed as a cap: 1 for the top
    // `count` bodies he can see, 0 for the rest. Its softening (a continuous rank weight) is
    // a later slice, not this one.
    //
    // ⭐ M-DS.7 — THE STATE GUARD, PERCEIVED. The shipped licence's own condition — "a
    // carrier who is not me" — read off `snapshot.ball.ownerGid` instead of
    // `match.ball.owner`. The in-flight and the restart run are WITHDRAWN from this slice;
    // a run onto a ball in flight is REAL football and is NAMED as the next slice (§HONESTY-B
    // H-DS-4), not smuggled in and not dismissed.
    //
    // ⛔ THE COMPLETE READ SET of this fork (DS-T0c §LAW-C): the SNAPSHOT
    // (`snapshot.ball.ownerGid`, and each observed body's `gid` / `side` / `pos` — ⚠ its
    // `vel` is NO LONGER READ: the velocity mass is GONE, ruling #409 item 3(iv)); his own
    // `pos`, `role`, `gid`, `index`, `wallRun` and (through `tired`) `stamina` — ⚠ his
    // `topSpeed` is NO LONGER READ either, it was the velocity term's normaliser; the ROSTER
    // by gid (`team.players`' `gid` / `role` / `sentOff` / `index` — who is on my team, who
    // is the keeper, who has been sent off and the number on his back is shared knowledge,
    // DECLARED, not a percept); his own side's HAT BOARD as before; `team.localX` (which
    // reads `team.attackDir`); the count's three inputs; `obmRunMul`; `W.runScore`;
    // `match.simTime` through the wall clock. ⛔ NOT `match.ball`, NOT `ball.owner`, NOT
    // `pendingPass`, NOT `pendingPassWindup`, NOT any other body's TRUTH `pos`/`vel` (the
    // SNAPSHOT's copies only), NOT `info.genome`.
    //
    // ⛔ THE PULL IS GATED BY THE FLAG. `perceivedSnapshot` MUTATES perception memory (the
    // E3R2 recorder trunk), so it is taken INSIDE this `if` and only when the not-hatted
    // guard has already passed: flag absent ⇒ ZERO pulls ⇒ the world is HEAD's byte for byte
    // (G-OFF, and a pull counter pins it). ONE pull per own-run evaluation, at the body's
    // EXISTING decision cadence — the OBM seat's own bound (M-OBM.4), and when that seat is
    // armed this site takes a SECOND, idempotent pull rather than reach into
    // `obmOffballPolicy`'s signature (§DEVIATIONS-B 1 — `offballEyes.ts` is off-limits by
    // ruling #407 item 5(vi), and the seat's own pins stay green).
    //
    // ⛔ STILL NO PREDICATE ON A FOOTBALL QUANTITY (#200): gate (the flag), guards (the hat
    // reads, the wall licence's own clock, and IDENTITY tests on gid / side / role), zero and
    // cap (`clamp01`). The count's inner comparisons are the coach's expression moved whole
    // and live in `runnerCount`, declared. ⚠ DS-T0c adds the COACH'S OWN COMPARATOR — a
    // ranking against a ranking and an index against an index (`b.s - a.s || a.p.index -
    // b.p.index`, the sort `assignRunners` already runs) — and NOT a comparison against any
    // constant or threshold: the block's only inequality against a NUMBER is still the 2过1
    // licence's clock (§PINS-C, narrowed positively; §DEVIATIONS-C 1).
    if (match.dsOwnRun) {
      // ⭐⭐⭐ IF T0 — 「球在飞时的前插」 THE FLIGHT-RUN SEAM (contract IF-FLIGHT-RUN-CONTRACT.md
      // §2 M-IF.1–6; ruling #417 item 3 as amended by #418 item 5, #419 item 2 and ⭐ #422
      // items 2–3 — IF T0b 「看见出脚」). The second dormant door, the per-body belief, the
      // per-body LOOK COUNTER and the WHISTLE are ALIASED HERE, INSIDE the own-run fork, as
      // its FIRST four statements — M-IF.4 puts the flag INSIDE the fork, so every one of
      // these property reads executes ONLY under `dsOwnRun`, and DS-T0c's `match.*` member-set
      // pin is narrowed POSITIVELY to say so: SEVEN members, not five (#422 item 2, the third
      // and last authorised narrow). All four are property reads: no rng, no side effect,
      // nothing observable with the door shut.
      const ifFlightRun = match.ifFlightRun;
      const ifLastSeenOwner = match.ifLastSeenOwnerGid;
      const ifLookMap = match.ifLook;
      const ifPhase = match.phase;
      const hatted = team.runners.has(p.index) || team.arriver === p.index
        || team.overlapper === p.index;
      // the 2过1 licence's OWN liveness expression (`p.wallRun !== null && simTime < until`)
      const wallLive = p.wallRun !== null && match.simTime < p.wallRun.until;
      if (!hatted && !wallLive) {
        const snapshot = match.perceivedSnapshot(p);
        const seenBall = snapshot === null ? null : snapshot.ball;
        const ownerGid = seenBall === null ? null : seenBall.ownerGid;
        // M-DS.7: the perceived owner is a MATE and is NOT me — the roster resolves his side.
        let carrierIsMate = false;
        if (ownerGid !== null && ownerGid !== p.gid) {
          for (const mate of team.players) {
            if (mate.gid === ownerGid) carrierIsMate = true;
          }
        }
        // ⭐⭐⭐ M-IF.2 — HIS OWN MEMORY OF WHO HE LAST SAW WITH THE BALL. Written ONLY under
        // the flight door, ONLY from the snapshot ALREADY PULLED above (⛔ no second pull),
        // and only when that percept HAS an owner — a mate, an opponent, or himself. An
        // opponent seen with the ball therefore CLEARS the mate state; a restart taker seen
        // with it becomes the last owner; a ball never seen leaves the entry absent.
        // ⛔ Never the truth's `lastTouch`, ⛔ never another body's memory.
        // ⭐⭐⭐ M-IF.1 — THE SECOND PERCEIVED STATE: the ball he SEES has NO owner and the
        // last owner he REMEMBERS resolves on the ROSTER to a same-side mate who is not him.
        // Identity tests only (#200) — no distance, no age bound, no velocity, no constant —
        // and the two states are mutually exclusive by construction (the seventh needs
        // `ownerGid !== null`, the eighth `ownerGid === null`).
        // ⚠ THE STATE TEST IS `carrierIsMate || ifOntoFlight`, widened THROUGH THE GUARD'S
        // OWN VARIABLE rather than by re-wording the shipped `if`: not one shipped statement
        // is deleted, reordered or reworded, so this file's whole diff is a PURE INSERTION
        // (IF-T0 §DEVIATIONS 1–2).
        // ⭐⭐⭐ M-IF.6 — THE LOOK COUNTER (IF T0b, #422 item 2). ONE increment per own-run
        // evaluation, under the door, from HIS OWN entry: this is his decision cadence,
        // because a hatted or wall-licensed body never reaches this statement. `ifPrev` is
        // the belief AS IT STOOD BEFORE this look — read before the write below, so "the
        // previous look" is a fact about the past, never about this one.
        const ifThisLook = ifFlightRun ? (ifLookMap.get(p.gid) ?? 0) + 1 : 0;
        const ifPrev = ifFlightRun
          ? (ifLookMap.set(p.gid, ifThisLook), ifLastSeenOwner.get(p.gid) ?? null)
          : null;
        // ⭐⭐⭐ M-IF.2 (write rule UNCHANGED) + M-IF.6 (the look index carried with it): when
        // the percept HAS an owner the belief is overwritten with `{ ownerGid, look }` and the
        // eighth state cannot hold anyway (it needs `ownerGid === null`); otherwise the
        // remembered gid is HIS PREVIOUS LOOK'S, and only his previous look's — an INDEX
        // EQUALITY `ifPrev.look === ifThisLook - 1` of the `cands.length - 1` kind, ⛔ not a
        // tick bound, ⛔ not an age bound. A sighting two looks ago resolves to null.
        const ifLastSeenGid = ifFlightRun && ownerGid !== null
          ? (ifLastSeenOwner.set(p.gid, { ownerGid, look: ifThisLook }), null)
          : (ifPrev !== null && ifPrev.look === ifThisLook - 1 ? ifPrev.ownerGid : null);
        let ifMateRemembered = false;
        for (const mate of team.players) {
          ifMateRemembered = ifMateRemembered || mate.gid === ifLastSeenGid;
        }
        // ⭐⭐⭐ M-IF.5 — THE GAME IS LIVE. `ifPhase === 'playing'` is the whistle, an identity
        // test on a state every body on the pitch shares (the coach's own licence reads the
        // same field through `restart`). At a dead ball the eighth state is FALSE; the
        // seventh is untouched.
        const ifOntoFlight = ifFlightRun && ifPhase === 'playing'
          && seenBall !== null && ownerGid === null
          && ifLastSeenGid !== null && ifLastSeenGid !== p.gid && ifMateRemembered;
        carrierIsMate = carrierIsMate || ifOntoFlight;
        if (snapshot !== null && carrierIsMate) {
          // M-DS.6″(b): WHERE HE STANDS IN THE QUEUE, by the side's shared convention, over
          // the mates his OWN EYES hold. `runRank` is the coach's own ranking expression,
          // code-moved (TeamBrain.ts) — the ROLE off the ROSTER, the POSITION off the
          // SNAPSHOT's copy, never the mate's truth `pos`. A mate outside the cone is not in
          // `snapshot.players` at all and does NOT outrank him, and a stale reading ranks him
          // where he WAS — a body with bad eyes ranks HIMSELF higher (§HONESTY-C, limit).
          const mine = runRank(p.role, team.localX(p.pos.x));
          let rankAbove = 0;
          for (const mate of team.players) {
            if (mate.gid === p.gid || mate.gid === ownerGid) continue;
            if (mate.role === 'GK' || mate.sentOff) continue;
            for (const body of snapshot.players) {
              if (body.gid !== mate.gid || body.side !== p.side) continue;
              const theirs = runRank(mate.role, team.localX(body.pos.x));
              // TIES EXACTLY AS THE COACH BREAKS THEM (`b.s - a.s || a.p.index - b.p.index`):
              // an EQUAL ranking and a LOWER roster index ranks above him; a higher does not.
              if (theirs > mine || (theirs === mine && mate.index < p.index)) rankAbove++;
            }
          }
          // M-DS.6″(c): the coach's own `scored.slice(0, count)`, expressed as a CAP — 1 for
          // the top `count` bodies he can see, 0 for the rest. No new constant; its softening
          // (a continuous rank weight) is a later slice (contract §4).
          const restraint = clamp01(runnerCount(
            team.mode, team.genome.tempo, team.mentality.urgency,
          ) - rankAbove);
          const prior = clamp01(mine / RUN_PRIOR_MAX);
          let s = W.runScore * prior * restraint;
          if (tired) s *= OFFBALL_TIRED_MUL;
          s *= obmRunMul;
          cands.push({ action: 'MakeRun', score: s, why: 'own run in behind' });
          // ⭐⭐⭐ M-IF.1 — THE EIGHTH LITERAL. The SAME candidate at the SAME score (M-IF.3):
          // only the `why` differs, and it is chosen by WHICH state admitted him. It is
          // written as a RELABEL of the candidate the shipped statement above pushed, so that
          // statement keeps every byte it had (IF-T0 §DEVIATIONS 1).
          const ifCand = cands[cands.length - 1];
          ifCand.why = ifOntoFlight ? 'own run onto the flight' : ifCand.why;
        }
      }
    }
    cands.push({
      action: 'MoveToFormationSpot',
      score: W.formationBase + (tired ? 0.2 : 0),
      why: tired ? 'keeping shape (stamina conservation)' : 'keeping shape',
    });
  } else {
    // ----- They have the ball (or it's loose) -----
    // Cut out a pass in flight — unless it's sailing overhead (Phase 28);
    // lofted balls are contested at the landing point via ChaseBall instead.
    if (ball.owner === null && match.pendingPass && match.pendingPass.side !== team.side && ball.z <= 0.5) {
      // EDS E2b-1: the geometry this entry is computed from is the ball —
      // where it is and where it is going. With perceived defending on, that
      // comes from THIS defender's own percept, so a stale read aims at the
      // wrong lane and no read at all cannot enter. Not looking has to cost
      // something or the arm is theatre. The trigger itself (a pass is in
      // flight) stays as it is: v1 makes the READ perceived, not the alarm.
      const seen = match.edsPerceivedDefence
        ? (match.perceivedBalls.get(p.gid) ?? null)
        : null;
      const inter = match.edsPerceivedDefence
        ? (seen === null ? null : canInterceptPass(p, { pos: seen.pos, vel: seen.vel } as typeof ball))
        : canInterceptPass(p, ball);
      if (inter?.ok) cands.push({ action: 'InterceptPass', score: W.interceptScore, why: 'can reach the passing lane first' });
    }
    // Chase only if the TeamBrain assigned us — this is what stops ball-swarming.
    if (team.chasers.has(p.index)) {
      const s = W.chaseBase + g.pressIntensity * 0.15;
      cands.push({ action: 'ChaseBall', score: s, why: `assigned presser · pressIntensity ${g.pressIntensity.toFixed(2)}` });
    } else if (possession === -1) {
      // Loose ball: closest unassigned player may react a little. Radius
      // tightened in Phase 28 — a wide net pulled extra bodies into every
      // scramble and open play collapsed into rolling six-player scrums.
      const d = dist(p.pos, ball.pos);
      if (d < 8) cands.push({ action: 'ChaseBall', score: 0.4 * (1 - d / 8), why: 'loose ball nearby' });
    }
    const mark = team.marks.get(p.index);
    if (mark !== undefined) {
      markTarget = mark;
      cands.push({
        action: 'MarkOpponent',
        score: W.markBase + g.markingAggression * 0.15,
        why: `mark ${opp.players[mark].name} · aggression ${g.markingAggression.toFixed(2)}`,
      });
    } else if (ball.owner && ball.owner.side !== team.side && !team.chasers.has(p.index)) {
      // Contain (Phase 29.1): the carrier bears down on ME and I'm already
      // goal-side — jockey them (goal-side stance on the carrier) instead of
      // jogging away to a formation spot. The reported bug: a set defender
      // suddenly ran upfield as the striker arrived, because his mark
      // assignment vanished the moment that striker became the carrier
      // (marks exclude the carrier — the chaser presses the ball, but the
      // chaser can be someone else entirely).
      const carrier = ball.owner;
      const dC = dist(p.pos, carrier.pos);
      const ownGoal = team.ownGoal();
      const carrierGoalD = dist(carrier.pos, ownGoal);
      // Defensive-territory only (< 35m out): containing a deep build-up
      // carrier 70m from goal would just add one more body to the press.
      // ONE container only — the closest unassigned goal-side defender;
      // everyone eligible jockeying at once re-created the pile-up AND
      // strangled the game to 2.0 goals.
      let closest = true;
      if (dC < 8 && carrierGoalD < 35 && dist(p.pos, ownGoal) < carrierGoalD) {
        for (const q of team.players) {
          if (q === p || q.role === 'GK' || q.sentOff) continue;
          if (team.chasers.has(q.index) || team.marks.has(q.index)) continue;
          if (dist(q.pos, ownGoal) >= carrierGoalD) continue; // not goal-side
          if (dist(q.pos, carrier.pos) < dC) {
            closest = false;
            break;
          }
        }
        if (closest) {
          markTarget = carrier.index;
          cands.push({
            action: 'MarkOpponent',
            score: 0.66 + clamp01(1 - dC / 10) * 0.18,
            why: `contain ${carrier.name} — hold goal-side`,
          });
        }
      }
    }
    cands.push({
      action: 'MoveToFormationSpot',
      score: 0.42 + g.defensiveCompactness * 0.08,
      why: `hold block · compactness ${g.defensiveCompactness.toFixed(2)}`,
    });
  }

  cands.sort((a, b) => b.score - a.score);
  const top = cands[0];
  p.action = {
    type: top.action,
    targetIdx: top.action === 'MarkOpponent' ? markTarget : receiveFlag ? p.gid : undefined,
    scores: cands.slice(0, 4),
  };
  // ⭐⭐ RC T0b §FIX (ruling #379 item 5) — THE OVERLAY, AND THE WHOLE OF WHAT THE BRAIN
  // RECORDS. The menu above ran exactly as it does shut — same candidates, same shipped sort,
  // same `top`, same displayed `scores`, character for character — because facing is not a
  // movement and never entered it. The two fields below are the trade's INPUTS: who he would
  // open up toward, and how much he believes it is worth. The DECISION is taken by
  // `actionExecutor`, which prices the turn against this frame's own intended direction.
  //
  // Shut (and armed with nothing to believe), `rcReadyCarrierGid` is still −1: the branch is
  // one comparison and NEITHER field is ever written, so the record is byte-identical.
  if (rcReadyCarrierGid >= 0) {
    p.action.readyFaceGid = rcReadyCarrierGid;
    p.action.readyBenefit = rcReadyBenefit;
  }
}
