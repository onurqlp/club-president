import { clamp } from '../utils/math';
import { add, dist, norm, scale, sub, v2, type V2 } from '../utils/vec';
import {
  AI_INTERVAL, BOX_DEPTH, BOX_WIDTH, CONTROL_MAX_HEIGHT, CORNER_CLEARANCE, DT, GOAL_WIDTH, HALF_L,
  HALF_W, SHIELD_STAMINA_DRAIN,
} from '../sim/constants';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import { TEAM_SIZE, type Role } from '../sim/types';
import {
  EYE_LATTICE, EYE_W_S, STATION_FAMILY, backHomeRegionBias, goingBits, goingContributors, homeMapBias,
  homePriorStrength,
  localXBand, perceivedContext, perceivedContextV2, priceApproaches, priceApproachesV2, priceApproachesV3,
  priceApproachesV3Partial, type EyeCandidate, type PerceivedContext, type TeammateMotionId,
} from './stationEye';
import {
  beyondLineBit, evaluateInSupport, perceivedOffsideLine, widthHeldBit, type BitValue,
} from './eyeContextBitsV4';
import {
  MARK_SAG_BALL_SPEED, MARK_SAG_MAX, effectiveHomePriorObedience, markSagWeight,
} from '../evolution/genome';
import { pressureAt } from './perception';
import {
  ATTACK_FORMATIONS, cornerCrashSpots, cornerKeyZone, fkWallSlots, formationSpot, offsideLineLocalX,
  runTarget, supportSpot, supportSpotOnObmPlane,
} from './formations';
import { ballLanding, escapeCarry, interceptBall } from './perception';
import { arrive, avoidOpponents, separation } from './steering';
// ⭐⭐ RC T0b §FIX (ruling #379 item 5) — BF's OWN facing law, IMPORTED: the READY trade
// prices the turn with the very functions `Player.physicsStep` prices it with, so neither
// formula is re-typed anywhere (contract BF §2 M-BF.1; RC §2-AMENDMENT M-RC.3b).
import { facingCosine, facingFactor } from '../sim/bodyFacing';

/** Pure coordinate transform for the dormant moving-reference primitive. */
export function relativePointTarget(
  reference: Readonly<V2>,
  attackDir: 1 | -1,
  offset: Readonly<V2>,
): V2 | null {
  if (![
    reference.x, reference.y, offset.x, offset.y,
  ].every(Number.isFinite)) return null;
  return {
    x: reference.x + attackDir * offset.x,
    y: reference.y + offset.y,
  };
}

/**
 * MT-T0 (MARK-TIGHTNESS-CONTRACT §2 M-MT.1/M-MT.2, ruling #201.4) — THE ACCESS-TIME
 * ACCOUNT, as a PURE function so the MT instruments can read the same arithmetic the
 * stance runs (no probe-only engine surface, the #196-D6 discipline).
 *
 *   t_ball = dist(ball, mark) / MARK_SAG_BALL_SPEED     (the engine's own pass
 *                                                        flight-time constant, 16)
 *   t_self = dist(marker, mark) / max(topSpeed, 0.1)    (the TeamBrain.ts:427
 *                                                        arrival-time form — re-pointed
 *                                                        by ruling #323 §CORR 2; the rule
 *                                                        text is byte-unmoved:
 *                                                        `const t = dist(p.pos, land) / Math.max(p.topSpeed, 0.1);`)
 *   slack  = t_ball − t_self
 *   sagOf  = slack ≤ 0 ? 0 : min(slack · max(topSpeed, 0.1), MARK_SAG_MAX)
 *
 * The metre value of the sag is the distance the marker can RECOVER in his spare
 * time — so the shape introduces no conversion constant of its own: it is monotone
 * increasing in positive slack, exactly 0 at zero/negative slack, and hard-capped at
 * the frozen 9 m ceiling. Equivalently `sagOf = min(t_ball·v − d, 9)`.
 *
 * ⚠ It is a TIGHTNESS number, never a switch: there is no decline/release predicate
 * here or anywhere downstream (the #200 red line). A ball 1–2 s from the man — every
 * cross into the box — gives `slack ≤ 0` and therefore ZERO sag, so the box prices
 * tight marking by itself with no carve-out. M-MT.5: straight-line proxy, geometry
 * only (no carrier release-ability term in slice one). PURE, no rng, no mutation.
 */
export function markSagMetres(
  ballPos: Readonly<V2>, markPos: Readonly<V2>, markerPos: Readonly<V2>, topSpeed: number,
): number {
  const v = Math.max(topSpeed, 0.1);
  const tBall = dist(ballPos, markPos) / MARK_SAG_BALL_SPEED;
  const tSelf = dist(markerPos, markPos) / v;
  const slack = tBall - tSelf;
  if (!Number.isFinite(slack) || slack <= 0) return 0;
  return Math.min(slack * v, MARK_SAG_MAX);
}

/** P2 §2.2: the commitment window, in ticks. */
const EYE_W_TICKS = Math.round(EYE_W_S / DT);
/**
 * V2-P2R §1.2: the abort re-read cadence, `AI_INTERVAL = 0.15 s` = 9 ticks (the
 * body's own decision cadence; #48.4 pins it, the stop-rule forbids re-cutting it).
 * A live deviation window re-reads its OWN percept at commit+9, +18, … < untilTick.
 */
const EYE_ABORT_INTERVAL_TICKS = Math.round(AI_INTERVAL / DT);

/**
 * P2 §2.5's ORACLE-CTX arm and the M-CTX mediator: the context as the WORLD
 * has it. Probe-only — the ordinary arms never call this, and the eye is null
 * in production. Mirrors the P1R census's own context definition exactly.
 */
function trueContext(p: Player, match: Match): PerceivedContext | null {
  const owner = match.ball.owner;
  if (owner === null) return null;
  const team = match.teams[p.side];
  const face = owner.side === p.side ? 'ours' : 'theirs';
  let near = 0;
  for (const q of team.players) {
    if (q === p || q.role === 'GK' || q.sentOff) continue;
    if (Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y) <= 9) near += 1;
  }
  const threat = localXBand(team.localX(match.ball.pos.x));
  const crowded = near >= 2;
  return {
    key: `${face}|${threat}|${crowded ? 'crowded' : 'sparse'}`,
    face, threat, crowded, ballX: match.ball.pos.x,
  };
}

/**
 * Turns the player's current (discrete) action into a desired velocity every
 * frame. Dynamic targets — moving balls, moving opponents, sliding formation
 * spots — are recomputed here each frame so actions never chase stale data.
 */
export function executeAction(p: Player, match: Match, dt: number): void {
  const team = match.teams[p.side];
  const opp = match.teams[1 - p.side];
  const g = team.genome;
  const ball = match.ball;
  const hasBall = match.possessionSide === team.side;

  // staminaConservation is a real trade-off: misers jog slower AND press with
  // less sprint (weaker pressing, fresher legs late in the match).
  const conserve = g.staminaConservation;
  const jog = 0.78 - conserve * 0.25;
  const sprint = 1 - conserve * 0.12;
  // A4-P1b (#133): side-scoped rest-defence abandonment (probe-only; null in
  // production ⇒ false ⇒ formationSpot is bit-for-bit HEAD). Threads the second
  // (formations clamp) face into every in-possession formation-spot call below.
  const abandonRest = match.abandonRestDesignation === team.side;
  // PM T0 — THE M-PM.2 PHASE GATE, evaluated ONCE here and nowhere else: LIVE OPEN
  // PLAY only (`phase === 'playing'`), and the seam itself is out-of-possession
  // only (`!hasBall`, enforced inside `emergentStation`). Restart-pending and
  // frozen phases therefore keep the UNMODULATED station, so `shapeReady`, the
  // onside clamp and the restart gates keep waiting for bodies near stations the
  // walkers really do walk to — the stall trap the contract prices at T0 by trace.
  // This boolean is passed ONLY to the two BODY-MOVEMENT reads below (M-PM.3,
  // #35.3): the walk target and the marker's no-target fallback.
  const pmMover = match.pmLaneConvergence && match.phase === 'playing';
  // MT T0 — THE M-MT.1 PHASE GATE, evaluated ONCE here and nowhere else: LIVE OPEN
  // PLAY only (`phase === 'playing'`), and the sag itself is out-of-possession only
  // (`!hasBall`, enforced at the term inside the MarkOpponent stance). Every restart
  // phase — `kickoff`, `restart` (goal kicks, throw-ins, free kicks, corners),
  // `goalPause`, `halftime`, `fulltime` — therefore keeps the UNMODULATED stance, so
  // the Phase 31.6 goal-kick half of the distribution stand-off is unreachable by
  // construction (that branch only fires while `match.restart.kind === 'goalKick'`,
  // i.e. while `phase === 'restart'`).
  const mtSag = match.mtMarkSag && match.phase === 'playing';
  let target: V2 | null = null;
  let speedF = jog;
  p.faceTarget = null; // per-frame; only keeper cases set it (backpedal, 27.5)
  p.c4Trace = null; // per-frame probe observability (C4 T2-ARRIVAL §4.3)
  p.clampTrace = null; // per-frame probe observability (Stage III P2, #43.3)
  if (p.action.type !== 'MarkOpponent' && p.markAnchor) {
    p.markAnchor = null; // a stale anchor must not survive an action change
    p.markAnchorAge = 0;
  }

  switch (p.action.type) {
    case 'MoveToPoint': {
      // Generic S6 primitive: the chooser supplies only a world coordinate.
      // Existing common post-switch rules still own onside discipline,
      // steering, collision avoidance, pitch limits and physical integration.
      target = p.action.targetPos ?? p.pos;
      speedF = 1;
      break;
    }
    case 'TrackRelativePoint': {
      // Generic S6 relation primitive: a fixed attack-frame offset follows
      // any moving physical player. The action does not decide which relation
      // is useful; missing/invalid references honestly reduce to holding here.
      const refGid = p.action.relativeToGid;
      const ref = refGid === undefined ? null : match.allPlayers[refGid] ?? null;
      const offset = p.action.relativeOffset;
      const derived = ref !== null && offset !== undefined
        ? relativePointTarget(ref.pos, team.attackDir, offset)
        : null;
      const valid = ref !== null
        && ref !== p
        && !ref.sentOff
        && derived !== null;
      target = valid ? derived : p.pos;
      speedF = 1;
      break;
    }
    case 'MoveToFormationSpot':
    case 'HoldPosition': {
      // PM T0 (M-PM.3 MOVER READ #1): the walk target — a BODY-MOVEMENT read.
      target = formationSpot(p, team, ball, hasBall, opp, abandonRest, pmMover);
      // Hurry back if badly out of position. (A phase-106 "hurry when
      // beaten" trigger was built and MEASURED OUT here: during walk-in
      // breakaways the beaten men are 60-88% in MarkOpponent/ChaseBall —
      // this branch owns only ~12-18% of their frames — and 24-gen warming
      // totals didn't move. final15-anatomy.ts carries the evidence.)
      if (dist(p.pos, target) > 14) speedF = 0.95 - conserve * 0.2;
      // THE RETREAT SCHOOL (Phase 112, drop-and-recover): for 3s after
      // losing the ball the spot-holders RUN home instead of jogging —
      // getting the shape set before the counter launches IS the school
      // (the 106 hurry trigger failed because it fired on "beaten", not
      // on the transition; this fires on the loss clock, for the gene
      // that pays for it). tp ≥ 0 is exactly today's speeds.
      if (!hasBall && match.phase === 'playing') {
        const tp = ((g.transitionPress ?? 0.5) - 0.5) * 2;
        if (tp < 0 && match.simTime - opp.possessionGainedAt < 3.0) {
          speedF = Math.max(speedF, jog + -tp * (0.95 - conserve * 0.2 - jog));
        }
      }
      break;
    }
    case 'ChaseBall': {
      // THE JOCKEY (Phase 87, the Van Dijk school): against a CARRIER, a
      // jockeying team's chaser takes the carrier-goal line at standoff
      // distance instead of diving at the ball. Positioning IS the
      // mechanism: a body goal-side is exactly what kills the composed
      // 1v1 (performShot checks it), and the overlap resolver + slalom
      // make the contained carrier go AROUND — chase time, blunted drive.
      const carrier = ball.owner;
      const jockey = team.genome.jockeyBias ?? 0.5;
      // Phase 92 (the A/B verdict): ONLY the goal-side man jockeys — a
      // pursuer from behind detouring to the standoff point was a free
      // escort downfield (the mispricing that made 0.9-jockey LOSE the
      // head-to-head). Behind the carrier = chase the ball, old-style.
      // Phase 101: with HYSTERESIS — the razor-edge −0.2 test flipped the
      // target 66-70×/match for a chaser dancing on the boundary
      // (hold-jitter.ts). Enter containment only clearly goal-side
      // (gap > 0.6), hold it until clearly not (gap < 0.1).
      const gap = carrier !== null
        ? team.localX(carrier.pos.x) - team.localX(p.pos.x)
        : -Infinity;
      const goalSideOfCarrier = p.containing ? gap > 0.1 : gap > 0.6;
      // Phase 92 second cut: standoff at TACKLE-RANGE EDGE (2.1m parked the
      // contain man permanently outside the 1.15m challenge radius — the
      // collapse could never convert), and NO jockeying in the danger zone:
      // inside ~28m of the own goal, real defenders engage.
      const dangerZone = carrier !== null && team.localX(carrier.pos.x) < -17;
      if (carrier && carrier.side !== p.side && jockey > 0.25 && goalSideOfCarrier && !dangerZone) {
        p.containing = true;
        const toGoal = norm(sub(team.ownGoal(), carrier.pos));
        const standoff = 0.9 + jockey * 0.5;
        target = add(carrier.pos, scale(toGoal, standoff));
        speedF = sprint;
        break;
      }
      p.containing = false;
      const sol = interceptBall(p, ball);
      target = sol.point;
      speedF = sprint;
      break;
    }
    case 'ReceivePass':
    case 'InterceptPass': {
      // Attack the DESCENT, not the drop (Phase 63 — the 31.9 corner
      // principle in open play): a lofted delivery is headable only in its
      // last ~2.6m of flight, so the intercept solution parked the receiver
      // ON the landing — where the ball arrives at his FEET, in the
      // goal-side defenders' laps (probed: attacker headers 1-10% of
      // crosses, 45% of deliveries eaten on the ground by the defence).
      // While the delivery flies ABOVE control height, the intended
      // receiver routes 2.5m upstream along the flight line and meets the
      // band; once it drops low the normal intercept chase resumes.
      if (
        p.action.type === 'ReceivePass' &&
        ball.owner === null &&
        ball.z > CONTROL_MAX_HEIGHT
      ) {
        const { x: lx, y: ly } = ballLanding(ball);
        const vl = Math.hypot(ball.vel.x, ball.vel.y) || 1;
        target = { x: lx - (ball.vel.x / vl) * 2.5, y: ly - (ball.vel.y / vl) * 2.5 };
      } else {
        const sol = interceptBall(p, ball);
        target = sol.point;
      }
      speedF = sprint;
      break;
    }
    case 'MarkOpponent': {
      const markIdx = p.action.targetIdx;
      const mark = markIdx !== undefined ? opp.players[markIdx] : null;
      if (mark) {
        // Goal-side AND ball-side (Phase 27): the stance blends "between my
        // man and our goal" with "between my man and the ball", so markers
        // shadow the passing lane and anticipated balls can be cut out.
        // Containing the CARRIER (29.1) stands off at 2.6m — jockey and
        // delay; closing to tackle range turned every contain into a bonus
        // tackler and strangled scoring (tackles +3/match).
        // Stance floor 0.8 → 1.2m (Phase 30.5): the tightest markers parked
        // INSIDE tackle radius (1.15m), so every marked reception was a
        // snap dispossession — receivers never survived their settle touch
        // and possession chains died at the first marked man. Kept at 1.2
        // (not 1.6): halving the slope entirely inverted the
        // markingAggression gene's recover-more edge (genes.test) — the
        // stance IS that gene's main payoff channel (failure mode 3).
        let markDist = ball.owner === mark ? 2.6 : 2.6 - g.markingAggression * 1.4;
        // Distribution stand-off (Phase 31.6, user report "开门球挤着对面
        // 队员"): while the mark's keeper stands over a goal kick or holds
        // the ball, markers COVER the lane from 2.0–2.6m instead of body-
        // gluing the receiver — real defenders show the pass and jump it
        // at the kick; the glued stance turned every keeper wait into a
        // box wrestling match (and the goal-kick box clamp only moves
        // opponents in x, so they camped ON the edge millimetres away).
        // Aggression still SCALES the stand-off (2.0 pushy .. 2.6 passive):
        // a flat floor erased the markingAggression payoff channel again
        // (the 30.5 stance-floor lesson, second edition — failure mode 3).
        const oppGk = opp.goalkeeper;
        if (
          (match.restart?.kind === 'goalKick' && match.restart.side === mark.side) ||
          ((oppGk.gkHoldTimer > 0 || oppGk.gkDistributing) && ball.owner === oppGk)
        ) {
          markDist = Math.max(markDist, 2.6 - g.markingAggression * 0.6);
        }
        // MT T0 (M-MT.2, the ACCESS-TIME SAG — dormant behind `mtMarkSag` + the gene,
        // both born off): `markDist′ = markDist + g_MT · sagOf(t_ball − t_self)`. It
        // is the ONLY write of this slice, it only ever ADDS distance on top of
        // whatever the two floors above produced (Phase 30.5's stance floor and Phase
        // 31.6's stand-off), and it NEVER tightens — so both prior stance reverts hold
        // by construction. Everything below is untouched: the (mark→goal, mark→ball)
        // direction blend, `laneW`, `markingAggression`, and mark ASSIGNMENT.
        // The contain case prices ITSELF: `ball.owner === mark` ⇒ the ball is at his
        // feet ⇒ t_ball ≈ 0 ⇒ slack < 0 ⇒ zero sag ⇒ the 29.1 jockey stand-off is
        // exactly today's. Same for every box delivery (M-MT.4: no carve-out, no
        // predicate). Gene BORN ABSENT ⇒ weight 0 ⇒ this line is a no-op ⇒ the world
        // is byte-identical (that is what the MT-T0 identity gates prove).
        if (mtSag && !hasBall) {
          const w = markSagWeight(g);
          if (w > 0) markDist += w * markSagMetres(ball.pos, mark.pos, p.pos, p.topSpeed);
        }
        const goal = team.ownGoal();
        const gx = goal.x - mark.pos.x;
        const gy = goal.y - mark.pos.y;
        const gl = Math.sqrt(gx * gx + gy * gy);
        const nx = gl < 1e-8 ? 0 : gx / gl;
        const ny = gl < 1e-8 ? 0 : gy / gl;
        const bx = ball.pos.x - mark.pos.x;
        const by = ball.pos.y - mark.pos.y;
        const bl = Math.sqrt(bx * bx + by * by);
        // Kept moderate (Phase 27.1): a stronger ball-side pull dragged every
        // marker into the central corridor and fed the crowding complaint.
        const laneW = 0.22 + g.markingAggression * 0.22;
        const mx = nx + (bl < 1e-8 ? 0 : (bx / bl) * laneW);
        const my = ny + (bl < 1e-8 ? 0 : (by / bl) * laneW);
        const ml = Math.sqrt(mx * mx + my * my);
        const dx = ml < 1e-8 ? nx : mx / ml;
        const dy = ml < 1e-8 ? ny : my / ml;
        target = { x: mark.pos.x + dx * markDist, y: mark.pos.y + dy * markDist };
        // THE OFFSIDE TRAP (Phase 109, defensive school #3 — the 21st
        // gene): a high-trap marker REFUSES to be dragged deeper than his
        // SHAPE by an off-ball runner — depth (x) holds at the formation
        // line while y keeps sliding with the man, and the phase-71
        // offside law flags whoever the ball is played to beyond the held
        // line. Low trap (≤0.5) = today's tracking exactly. The price is
        // physical, not scripted: a runner ONSIDE at the kick is clean
        // through, and a libero (coverBias) below the line plays everyone
        // onside. The carrier cannot be trapped (no offside on the ball)
        // — the contain/jockey machinery owns him.
        // The trap is sprung BEFORE the ball goes over the top (football
        // law): once the ball is deep in our territory the line is beaten
        // and EVERYONE tracks. The first build held unconditionally — deep
        // runners stood unmarked in the box, trapBias railed to 0.08 under
        // selection and one warming world hit 8.5 goals/match. Same -17
        // danger-zone boundary as the jockey (Phase 92).
        const trapHold = ((g.trapBias ?? 0.5) - 0.5) * 2;
        const ballDeep = team.localX(ball.pos.x) < -17;
        if (trapHold > 0 && !ballDeep && ball.owner && ball.owner.side !== p.side && ball.owner !== mark) {
          const spot = formationSpot(p, team, ball, hasBall, opp, abandonRest);
          if (team.localX(target.x) < team.localX(spot.x)) {
            target = { x: target.x + (spot.x - target.x) * trapHold, y: target.y };
          }
        }
        // Marker REACTION LAG (Phase 31.9, the headed-game pass): a marker
        // tracking a SPRINTING mark near our goal re-reads the stance
        // target on his reaction cadence (0.2–0.45s by defending), not
        // per-frame. Frame-perfect shadowing meant the goal-side man met
        // every delivery first (HEADER_RADIUS is 1.35m — a crash that
        // earns more separation than that heads UNCONTESTED) and the
        // attacking header had gone extinct at ~0.33 shots/match. A
        // standing striker stays tight: he barely moves between refreshes.
        const markSpeed = Math.hypot(mark.vel.x, mark.vel.y);
        if (ball.owner !== mark && markSpeed > 4.5 && dist(mark.pos, team.ownGoal()) < 26) {
          p.markAnchorAge += dt;
          const lag = 0.45 - p.attrs.defending * 0.25;
          if (!p.markAnchor || p.markAnchorIdx !== markIdx || p.markAnchorAge >= lag) {
            p.markAnchor = { x: target.x, y: target.y };
            p.markAnchorIdx = markIdx ?? null;
            p.markAnchorAge = 0;
          }
          target = p.markAnchor;
        } else {
          p.markAnchor = null;
          p.markAnchorAge = 0;
        }
        speedF = 0.85 + g.markingAggression * 0.15;
      } else {
        // PM T0 (M-PM.3 MOVER READ #2): the marker's no-target fallback — the
        // other BODY-MOVEMENT read. The trap hold-line reference above
        // deliberately keeps the UNMODULATED station (it is a GATE read).
        target = formationSpot(p, team, ball, hasBall, opp, abandonRest, pmMover);
      }
      break;
    }
    case 'SupportBallCarrier': {
      // CTB T0 (#223, M-CTB.4): the seam's ONLY consumer. The flag rides in as the
      // `ctbPlane` argument; the fork itself lives inside `supportSpot`. Flag off ⇒
      // the incumbent expression, byte for byte. WHO supports (TeamBrain assignment),
      // pass selection and `speedF` below are untouched.
      target = supportSpot(p, team, ball, match.ctbSupportPlane);
      // OBM T0 (#227, M-OBM.3) — THE PLANE READ FORK (read site 1 of 2). The policy
      // was computed by the BRAIN at THIS body's own decision cadence; the executor
      // only re-uses it (`obmPlaneFor` caps its age at `OBM_POLICY_TTL_TICKS`), so
      // nothing here pulls a percept per tick. Flag off ⇒ `null` ⇒ this statement is
      // skipped entirely and the incumbent line above stands byte for byte — which is
      // also why the incumbent call is left untouched rather than given an argument
      // (`tests/ctbSupportPlane.test.ts` pins it verbatim).
      // ⭐ THE TWO DOORS ARE INDEPENDENT (the OBM-T0 verify catch). The plane handed
      // in already carries the CTB gate INSIDE it: with `ctbSupportPlane` OFF this is
      // the DYNAMIC-ONLY plane, whose zero-point is the incumbent line above, so
      // arming THIS seat alone never delivers the banked static CTB plane; with it ON
      // this is intercept + slopes and it supersedes the static line above. Each seam
      // therefore expresses only what its own flag opened.
      const obmPlane = match.obmMovement ? match.obmPlaneFor(p) : null;
      if (obmPlane !== null) target = supportSpotOnObmPlane(p, team, ball, obmPlane);
      speedF = (team.mode === 'CounterAttack' ? 1 : 0.9) - conserve * 0.15;
      break;
    }
    case 'MakeRun': {
      // Attacking run in behind — a full sprint, recomputed each frame so
      // the run bends with the defensive line. Corner setups (Phase 31)
      // route the licensed bodies instead: crashers attack the ROUTINE's
      // crash spots (primary/secondary/rebound by stable rank), the extra
      // license (team.arriver) goes to the routine's key zone. In open
      // play the arriver attacks the edge-of-box arc — the late body a
      // byline cutback finds.
      // 门将上前 (Phase 35): the licensed keeper attacks the penalty-spot
      // area — an extra unmarked body the defense never accounted for.
      if (p.role === 'GK' && team.keeperUp) {
        target = v2(team.attackDir * (HALF_L - 9), clamp(p.pos.y * 0.2, -4, 4));
        speedF = sprint;
        break;
      }
      const r = match.restart;
      const cc = team.cornerCrash;
      const liveCorner = r?.kind === 'corner' && r.side === p.side;
      // The crash keeps running through the hand-off + flight (31.9).
      const crash = liveCorner
        ? { routine: r!.routine, y: r!.pos.y, burst: r!.timer >= 1.7 }
        : cc !== null && match.simTime < cc.until
          ? { routine: cc.routine as typeof cc.routine | undefined, y: cc.y, burst: true }
          : null;
      // C4 T2-ARRIVAL: is THIS body the licensed one closest to an open-play
      // cross's landing? Pure observable physics — `ballLanding` is the shared
      // exact projector, and the flight is in the air for anyone to read. The
      // closest-body scan mirrors the corner branch's below, including its
      // stable index order.
      const cf = match.c4ArrivalReroute ? team.crossFlight : null;
      let crossMeet: V2 | null = null;
      if (
        cf !== null && match.simTime < cf.until && !crash
        && ball.owner === null && ball.z > CONTROL_MAX_HEIGHT
      ) {
        const licensed = cf.arriver !== null && !cf.runners.includes(cf.arriver)
          ? [...cf.runners, cf.arriver] : [...cf.runners];
        licensed.sort((a, b) => a - b);
        const { x: landX, y: landY } = ballLanding(ball);
        let closest = -1;
        let bd = Infinity;
        for (const idx of licensed) {
          const q = team.players[idx];
          if (q.sentOff) continue;
          const d = Math.hypot(q.pos.x - landX, q.pos.y - landY);
          if (d < bd) {
            bd = d;
            closest = idx;
          }
        }
        if (closest === p.index) {
          const vl = Math.hypot(ball.vel.x, ball.vel.y) || 1;
          crossMeet = v2(landX - (ball.vel.x / vl) * 2.5, landY - (ball.vel.y / vl) * 2.5);
        }
      }
      if (crash && team.runners.has(p.index)) {
        const ranked = [...team.runners].sort((a, b) => a - b);
        const spots = cornerCrashSpots(crash.routine, team.attackDir, crash.y);
        const spot = spots[ranked.indexOf(p.index) % 3];
        // Attack the MEET point, not the landing (31.9): the delivery
        // crosses the header band (z 2.5→1.35) in its last ~2.6m of flight,
        // so a crasher standing ON the landing watches the ball sail past
        // his face 3m short — shift the attack 2.5m flag-side along the
        // flight line and the run meets the descent in the band.
        let fx = spot.x - team.attackDir * HALF_L;
        let fy = spot.y - crash.y;
        let fl = Math.hypot(fx, fy) || 1;
        let meet = v2(spot.x - (fx / fl) * 2.5, spot.y - (fy / fl) * 2.5);
        // The delivery is UP: real crashers adjust to the actual flight.
        // Corner noise scatters the landing ~2.6m σ laterally — a crasher
        // pinned to the table spot watches half the deliveries drop out of
        // HEADER_RADIUS (1.35m). The closest licensed crasher re-routes to
        // the true descent (friction-free parabola, exact); the others keep
        // their structure spots for the knockdown and the rebound.
        if (!r && ball.owner === null && (ball.z > 0 || ball.vz !== 0)) {
          const { x: landX, y: landY } = ballLanding(ball);
          let closest = -1;
          let bd = Infinity;
          for (const idx of ranked) {
            const q = team.players[idx];
            if (q.sentOff) continue;
            const d = Math.hypot(q.pos.x - landX, q.pos.y - landY);
            if (d < bd) {
              bd = d;
              closest = idx;
            }
          }
          if (closest === p.index) {
            fx = ball.vel.x;
            fy = ball.vel.y;
            fl = Math.hypot(fx, fy) || 1;
            meet = v2(landX - (fx / fl) * 2.5, landY - (fy / fl) * 2.5);
          }
        }
        // The TIMED crash (Phase 31.9, the headed-game pass): during setup a
        // crasher HOLDS 4.5m off his spot (still inside the taker's 7m wait
        // gate) and only bursts through it as the taker steps up (corner
        // minSetup is 2.0s). Pre-positioned crashers stood ON the landing
        // waiting — a static box the set marker always won; the delivery
        // aims at the routine's key zone, and the marker reaction lag above
        // needs an actual sprint to fall behind. Separation is born here.
        target = crash.burst ? meet : v2(meet.x - team.attackDir * 4.5, meet.y);
      } else if (crossMeet !== null) {
        // C4 T2-ARRIVAL: the closest licensed body attacks the DESCENT of an
        // open-play cross — the same `landing − flightDir·2.5` the intended
        // receiver has had since Phase 63 (`ReceivePass`, above) and the
        // corner crash since 31.9. Nothing else about him changes, and the
        // other licensed bodies keep their existing routing, exactly as the
        // corner branch leaves its non-closest crashers on their structure
        // spots for the knockdown.
        target = crossMeet;
        p.c4Trace = { meet: crossMeet, applied: crossMeet };
      } else if (team.arriver === p.index) {
        target =
          crash && (crash.routine === 'short' || crash.routine === 'arcCutback')
            ? cornerKeyZone(crash.routine, team.attackDir, crash.y)
            : v2((HALF_L - 16) * team.attackDir, clamp(p.pos.y * 0.3, -7, 7));
      } else if (team.overlapper === p.index && ball.owner && ball.owner.side === p.side) {
        // 套边 (Phase 34): around the OUTSIDE of the wide carrier, hugging
        // the touchline past him — the lane the release ball is led into.
        const c = ball.owner;
        target = v2(
          clamp(c.pos.x + team.attackDir * 13, -HALF_L + 2, HALF_L - 2),
          Math.sign(c.pos.y || 1) * (HALF_W - 2.5),
        );
      } else {
        target = runTarget(p, team, opp.players);
      }
      speedF = sprint;
      break;
    }
    case 'Dribble': {
      target = dribbleTarget(p, match);
      // Dribbling is slower than free running; close control (technique)
      // lets a carrier keep more of their pace (Phase 27).
      speedF = 0.84 + p.attrs.dribbling * 0.1;
      break;
    }
    case 'Pass':
    case 'LoftedPass':
    case 'ThroughBall':
    case 'Cross':
    case 'Shoot':
    case 'ClearBall': {
      // Kick already happened at decision time — brief follow-through.
      target = null;
      break;
    }
    case 'ShieldHold': {
      // C5 T0: the shield is a BODY POSITION, not a drift. The heading turns
      // so the ball — glued at `pos + heading·0.85` (`Match.ts:1276-1283`) —
      // sits on the far side of this body from the nearest threat. That is the
      // whole mechanism, and it works because the tackle search measures
      // `dist(o.pos, ball.pos)`, not the man (`mechanics.ts:1726`): the
      // existing attack surface already prices a ball it cannot reach.
      //
      // De-gluing is C6's slice and is deliberately NOT touched here.
      //
      // C5 re-census repair (iii, #36.1 / ruling #61.2): the threat READ is
      // the holder's OWN percept, not opponent truth. The omniscient
      // `opp.players` scan (the omniscient auto-shield the cross-AI audit
      // caught) is REPLACED here — not duplicated — by the nearest perceived
      // opponent in `match.perceivedSnapshot(p)`, the E3R2 pull over this
      // body's own scan frames (perception is PULL, ruling #13.3). A stale
      // read points the shield at where the defender WAS seen — the honest
      // capability. This branch is reachable only through `forcedHold &&
      // c5Hold` (`PlayerBrain.ts:169-170`), null in every production path, so
      // the pull is probe-only and the fingerprint is unchanged. When nothing
      // is perceived the holder shields BLIND (the existing `else`), rather
      // than snapping onto a truth he cannot see. The stamina drain
      // (`pressureAt` over `opp.players`) and the walking-pace carry below are
      // unchanged; only the threat-direction READ becomes perceived.
      let nearPos: Readonly<V2> | null = null;
      let nearD = Infinity;
      const perceived = match.perceivedSnapshot(p);
      if (perceived !== null) {
        for (const o of perceived.players) {
          if (o.side === p.side) continue;
          const d = dist(o.pos, p.pos);
          if (d < nearD) {
            nearD = d;
            nearPos = o.pos;
          }
        }
      }
      if (nearPos && nearD > 1e-6) {
        // Face AWAY from the threat: the body goes between him and the ball.
        p.faceTarget = {
          x: p.pos.x + (p.pos.x - nearPos.x) / nearD * 10,
          y: p.pos.y + (p.pos.y - nearPos.y) / nearD * 10,
        };
        // The protective carry: walking pace, away from the threat. Slow
        // enough that `stepBall`'s push gate (v > 2.5) never fires, so the
        // hold stays a hold and never turns into a drive.
        target = { x: p.pos.x + (p.pos.x - nearPos.x) / nearD * 1.2, y: p.pos.y + (p.pos.y - nearPos.y) / nearD * 1.2 };
      } else {
        p.faceTarget = team.oppGoal();
        target = p.pos;
      }
      speedF = 0.22; // walking pace — well under stepBall's v > 2.5 push gate
      // NO FREE TIME (design contract §4 Q6 / I1). Standing still recovers
      // stamina under `Player.tick`'s effort gate, so holding under pressure
      // would otherwise be free legs as well as a free ball. The drain is
      // shaped like the existing one — pressure-scaled, tamed by the stamina
      // attribute — and it is the ONLY cost T0 adds, because the Phase-0 map
      // found every other one already present.
      const squeeze = pressureAt(p.pos, opp.players);
      p.stamina = Math.max(
        0.05,
        p.stamina - SHIELD_STAMINA_DRAIN * (0.35 + squeeze) * dt * (1.24 - p.attrs.stamina * 0.6),
      );
      break;
    }
    case 'HoldUp': {
      // Pivot shield (Phase 28): keep the body between ball and defender —
      // a slow drift away from the nearest opponent, chest toward our own
      // half so the lay-off is played with the facing, not against it.
      let near: Player | null = null;
      let nearD = Infinity;
      for (const o of opp.players) {
        if (o.sentOff) continue;
        const d = dist(o.pos, p.pos);
        if (d < nearD) {
          nearD = d;
          near = o;
        }
      }
      if (near && nearD > 1e-6) {
        const ax = (p.pos.x - near.pos.x) / nearD;
        const ay = (p.pos.y - near.pos.y) / nearD;
        target = { x: p.pos.x + ax * 1.4, y: p.pos.y + ay * 1.4 };
      } else {
        target = p.pos;
      }
      speedF = 0.35;
      p.faceTarget = team.ownGoal();
      break;
    }
    case 'GoalkeeperSave': {
      const sol = interceptBall(p, ball);
      // Never leave the goal area chasing a shot.
      target = clampToBox(sol.point, team.attackDir);
      speedF = 1;
      p.faceTarget = ball.pos;
      break;
    }
    case 'GoalkeeperRush': {
      // 1v1 (Phase 27.5): charge the ball at full sprint — deliberately NOT
      // clamped to the box; an aggressive keeper sweeps outside it.
      target = ball.pos;
      speedF = 1;
      p.faceTarget = ball.pos;
      break;
    }
    case 'GoalkeeperPosition': {
      p.faceTarget = ball.pos; // backpedal facing the play (27.5)
      // 追分清道夫 (Phase 35): from the 89th minute a trailing keeper
      // supports a sustained attack from around HALFWAY — his goal stands
      // empty (the chase's price), and the corner license (keeperUp) only
      // has to carry him the last 45m instead of the full pitch.
      if (
        team.mentality.urgency > 0.5 &&
        match.half === 2 &&
        match.minute() >= 89 &&
        match.possessionSide === p.side &&
        team.localX(ball.pos.x) > 10
      ) {
        target = v2(-team.attackDir * 2, clamp(ball.pos.y * 0.3, -10, 10));
        speedF = 1;
        break;
      }
      // Flat form of add(goal, scale(sub(ball.pos, goal), k)) — every frame for keepers.
      const goal = team.ownGoal();
      const out = 2.5 + g.keeperAggression * 7;
      const tbx = ball.pos.x - goal.x;
      const tby = ball.pos.y - goal.y;
      const d = Math.max(Math.sqrt(tbx * tbx + tby * tby), 0.1);
      // Stand your ground (Phase 28.4): never backpedal INTO the goalmouth —
      // hold ~2m off the line so the 1v1 duel happens out here, not with the
      // carrier's studs on the keeper's chest at the post.
      const k = Math.max(Math.min(out, d * 0.5), Math.min(2.0, d * 0.9)) / d;
      target = clampToBox({ x: goal.x + tbx * k, y: goal.y + tby * k }, team.attackDir);
      // Free-kick stance (Phase 32): the wall covers one side of the goal,
      // the keeper cheats a step toward the NEAR post to own the other.
      if (match.fkWall && match.fkWall.side === p.side) {
        target = {
          x: target.x,
          y: clamp(target.y + Math.sign(match.fkWall.pos.y || 1) * 1.0, -GOAL_WIDTH / 2 + 0.5, GOAL_WIDTH / 2 - 0.5),
        };
      }
      speedF = 0.9;
      break;
    }
  }

  // ⭐⭐ GK T0b §M-GK.2′ — THE BODY FOLLOWS THE HANDS, EVERY TICK
  // (docs/world-model/GK-T0-DIVE-LAW.md; contract GK-KEEPER-BODY-CONTRACT.md §2 M-GK.2′;
  // ruling #399 item 3(i)). THE ONE steering override this seam owns. It sits HERE,
  // immediately after the switch, because that is the single point AFTER every keeper case
  // has computed its own target — including `GoalkeeperPosition`'s early-`break` 追分清道夫
  // branch, which an override written inside the case would never reach.
  //
  // ⭐⭐ THE GATE IS THE FIELD ITSELF, NOT AN ACTION-TYPE LIST. GK-T0 enumerated three
  // keeper cases and the law never fired where it mattered: after a CATCH the keeper OWNS
  // the ball, `decidePlayer` routes him into `decideCarrier` (#398 item 1(ii)) and he holds
  // `MoveToFormationSpot` / `HoldPosition` — 0 of 42 window ticks covered on the ruling's
  // own fixture (#399 item 1(i)). The KEEPER IS THE ONLY BODY THAT EVER CARRIES A CONTACT
  // (the two writes are both inside `tryKeeperSave`, both on `gk`), so `saveContact !== null`
  // IS the keeper scope — pinned as such, on every body of every tick of armed matches.
  //
  // ⭐⭐ …AND IT IS NOT GATED ON `saveAnimTimer` EITHER: the sprite's 0.7 s window and the
  // law's window are different things (#399 item 2's lesson of record). The contact is
  // released by the PHYSICAL event the law names — the body's arrival, or the loss of
  // ownership — and the steering runs for exactly as long as the contact does.
  //
  // ⭐ THE CLAMP IS THE KEEPER CASE'S OWN: `GoalkeeperSave` and `GoalkeeperPosition` clamp
  // their target with `clampToBox`, so the contact point gets the SAME clamp;
  // `GoalkeeperRush` is deliberately un-clamped (a sweeper leaves his box), so the contact
  // point is taken raw there. A clamp that BITES is published (doc §4), never hidden.
  //
  // NO NEW CONSTANT (#384 item 5): the speed is `speedF = 1` against the body's own
  // `topSpeed`, and `physicsStep` — the only position integrator — does the travelling. The
  // body is never written.
  //
  // Flag off ⇒ the conjunction dies on `match.gkDiveBody` and not one statement runs.
  if (match.gkDiveBody && p.saveContact !== null) {
    target = p.action.type === 'GoalkeeperRush'
      ? { x: p.saveContact.x, y: p.saveContact.y }
      : clampToBox(p.saveContact, team.attackDir);
    speedF = 1;
    p.faceTarget = ball.pos;
  }

  // Free-kick WALL (Phase 32): the assigned bodies stand ON the ball–goal
  // line at the clearance edge and brace, facing the ball. Their slot IS
  // their steering target — the clearance clamps never fight them (the
  // wall IS the clearance for a close FK), and the teammate-separation
  // push is skipped below (a wall packs tighter than the anti-stack radius).
  let inWall = false;
  const wall = match.fkWall;
  if (wall && p.side === wall.side) {
    const slot = wall.gids.indexOf(p.gid);
    if (slot >= 0) {
      inWall = true;
      target = fkWallSlots(wall.pos, team.ownGoal(), wall.gids.length)[slot];
      speedF = 0.95;
      p.faceTarget = wall.pos;
    }
  }

  // C4 O2's station force (docs/world-model/C4-O2-SECOND-BODY-FORK.md).
  // Deliberately placed HERE — after the switch, before the onside and
  // barred-box clamps — so a forced body is steered like any other off-ball
  // body and gets no privilege the world does not have. Null in production.
  const fs = match.forcedStation;
  if (
    fs !== null && fs.gid === p.gid && match.simTick < fs.untilTick
    && p.role !== 'GK' && ball.owner !== p
  ) {
    target = fs.target;
    // Probe observability only, reusing C4 T2's field exactly as documented:
    // the post-switch line below rewrites `applied` with whatever survived the
    // clamps, which is what O2's X6 measures per record.
    p.c4Trace = { meet: fs.target, applied: fs.target };
  }

  // Stage III P1's station POLICY (docs/world-model/STAGE3-P1-STATION-CENSUS.md
  // §2.1): a ball-local offset re-evaluated every tick — a station is a
  // relation to the ball, not a point. Same read point, same clamps after it.
  const fsp = match.forcedStationPolicy;
  if (
    fsp !== null && fsp.gid === p.gid && match.simTick < fsp.untilTick
    && p.role !== 'GK' && ball.owner !== p
  ) {
    const want = v2(ball.pos.x + team.attackDir * fsp.offset.dx, ball.pos.y + fsp.offset.dy);
    target = want;
    p.c4Trace = { meet: want, applied: want };
  }

  // Stage III P2's DORMANT EYE (docs/world-model/STAGE3-P2-DORMANT-EYE.md
  // §2.1-§2.4). Same read point as the P1R census seam above and the same
  // clamps after it, so the eye consuming candidate x receives exactly the
  // treatment the census priced as x (#43.3). Null in production.
  const eye = match.stationEye;
  if (eye !== null && p.role !== 'GK' && !p.sentOff && ball.owner !== p
    && (eye.scope.kind === 'both'
      || (eye.scope.kind === 'team' && eye.scope.side === p.side)
      || (eye.scope.kind === 'body' && eye.scope.gid === p.gid))
  ) {
    const isStation = STATION_FAMILY.has(p.action.type);
    let state = match.stationEyeState.get(p.gid);
    if (state !== undefined && match.simTick >= state.untilTick) {
      match.stationEyeState.delete(p.gid);
      state = undefined;
    }
    // D2, the one material-change break rule (§2.2): the body's own perceived
    // ball is maintained on HIS decision clock, so reading it costs nothing
    // and smuggles in no truth. A possession flip is a step change in the
    // world's own station function (P0 I2).
    if (state !== undefined) {
      const seen = match.perceivedBalls.get(p.gid);
      const ownerGid = seen ? seen.ownerGid : null;
      if (ownerGid !== null) {
        const face = Math.floor(ownerGid / TEAM_SIZE) === p.side ? 'ours' : 'theirs';
        if (face !== state.faceAtDecision) {
          match.stationEyeState.delete(p.gid);
          state = undefined;
        }
      }
    }
    // D3-DUPLICATE (STAGE3-V2-P2R-ABORTABLE.md §1.2): the abortable approach. At the
    // body's OWN decision cadence during a LIVE DEVIATION window, re-pull the OWN
    // percept and recompute the going-contributor set G_mid for the committed region
    // (o* fixed, the region tracking the CURRENT ball). If a teammate NOT in the
    // commit-time set G_commit is now going into it — a duplicate FORMING mid-window —
    // the override LAPSES to incumbent-hold retaining the SAME untilTick (the clock is
    // never reset; the ticks already spent are the unrefunded price #73.2(i)). Armed
    // on the eye's v2 arms only (CONTROL carries no eye state); percept-honest (no
    // truth, no channel — a body that never looks never aborts, #73.2(ii)); the
    // ORACLE-CTX arm re-reads TRUE motion. Dormant in production (eye null).
    // Ruling #75.2: the abort (and its G_commit capture below) is an EXPLICIT
    // opt-in. Absent ⇒ this whole path is inert and the old V2-P2 experiment
    // reproduces byte-for-byte; the gate `eye.v2 !== undefined` alone was the
    // reproducibility break (it fires inside the old probe too).
    const abortEnabled = eye.v2?.abortEnabled === true;
    if (
      abortEnabled && state !== undefined && state.offset !== null
      && state.candidateId !== 'control' && isStation
    ) {
      const elapsed = match.simTick - (state.untilTick - EYE_W_TICKS);
      if (elapsed > 0 && elapsed % EYE_ABORT_INTERVAL_TICKS === 0) {
        const oracle = eye.arm === 'oracleCtx';
        const teammates: TeammateMotionId[] = [];
        if (oracle) {
          for (const q of team.players) {
            if (q === p || q.role === 'GK' || q.sentOff) continue;
            teammates.push({ gid: q.gid, px: q.pos.x, py: q.pos.y, vx: q.vel.x, vy: q.vel.y });
          }
        } else {
          const snap = match.perceivedSnapshot(p);
          if (snap !== null) {
            for (const o of snap.players) {
              if (o.side !== p.side || o.gid === p.gid || o.gid % TEAM_SIZE === 0) continue;
              teammates.push({ gid: o.gid, px: o.pos.x, py: o.pos.y, vx: o.vel.x, vy: o.vel.y });
            }
          }
        }
        const gMid = goingContributors(ball.pos.x, ball.pos.y, team.attackDir, state.offset, teammates);
        const gCommit = state.committedGoingContributors;
        const newContributors: number[] = [];
        for (const j of gMid) if (!gCommit.has(j)) newContributors.push(j);
        if (newContributors.length > 0) {
          // ABORT: rewrite to incumbent-hold, SAME untilTick. No re-decide, no refund.
          const tr = eye.trace;
          if (tr !== undefined) {
            tr.abort += 1;
            tr.abortTicks.set(elapsed, (tr.abortTicks.get(elapsed) ?? 0) + 1);
            tr.abortWastedTicks += elapsed;
            tr.abortGCommit += gCommit.size;
            tr.abortGMid += gMid.size;
            tr.abortNewContributors += newContributors.length;
            for (const j of newContributors) tr.abortDrivers.set(j, (tr.abortDrivers.get(j) ?? 0) + 1);
          }
          state.offset = null;
          state.candidateId = 'control';
          state.committedGoingContributors = new Set();
        }
      }
    }
    // D1: decide on the first eligible tick with no live commitment, then once
    // per window. EVERY decision commits for W — including the ones that
    // choose the incumbent — so the percept is pulled once per body per
    // window and a tie is a choice rather than a re-ask at 60 Hz.
    if (state === undefined && isStation) {
      const trace = eye.trace;
      if (trace !== undefined) trace.decisions += 1;
      const oracle = eye.arm === 'oracleCtx';
      const snap = oracle ? null : match.perceivedSnapshot(p);
      // V2-P2 §2.3 repair 1: retain the last-perceived owner (the in-flight FACE
      // ledger); update it whenever a live perceived owner is present.
      let context: PerceivedContext | null;
      if ((eye.v2 !== undefined || eye.v3 !== undefined) && !oracle) {
        // V2-P2 §2.3 / V3-P2 §3.3: the in-flight FACE repair is carried verbatim by
        // both consumers (v3 reuses the same three context features; it only drops
        // the going-bit). The ORACLE arm still reads TRUE context below.
        const retained = match.stationEyeOwnerLedger.get(p.gid) ?? null;
        const liveOwner = snap?.ball?.ownerGid ?? null;
        if (liveOwner !== null) match.stationEyeOwnerLedger.set(p.gid, liveOwner);
        context = perceivedContextV2(snap, p.gid, p.side, p.pos, (x) => team.localX(x), retained);
      } else {
        context = oracle
          ? trueContext(p, match)
          : perceivedContext(snap, p.gid, p.side, p.pos, (x) => team.localX(x));
      }
      if (trace !== undefined && context !== null) {
        // M-CTX (probe-only truth read, contract §3.5): what he believed
        // against what was true, per feature.
        const truth = trueContext(p, match);
        if (truth !== null) {
          trace.ctxSeen += 1;
          if (truth.key === context.key) trace.ctxAgree += 1;
          if (truth.face === context.face) trace.ctxAgreeFace += 1;
          if (truth.threat === context.threat) trace.ctxAgreeThreat += 1;
          if (truth.crowded === context.crowded) trace.ctxAgreeDensity += 1;
        }
      }
      // A decision with no priceable context still COMMITS the window to the
      // incumbent (offset null): he has no basis to act on and re-asking every
      // tick would be a 60 Hz percept pull, not a commitment window.
      const holdIncumbent = (): void => {
        state = {
          offset: null,
          candidateId: 'control',
          untilTick: match.simTick + EYE_W_TICKS,
          faceAtDecision: context?.face ?? 'ours',
          committedGoingContributors: new Set(),   // §1.1: empty for incumbent windows
        };
        match.stationEyeState.set(p.gid, state);
      };
      // V4-P3-PARTIAL §2 (P3p-0, ruling #110/#111): the IN-SUPPORT LAW. When the
      // `inSupportLaw` flag is armed, the eye is consulted ONLY at a decision
      // moment satisfying the V3-P1 support predicate — evaluated PERCEPT-HONESTLY
      // on THIS body's own snapshot (the FRESH LIVE perceived owner, not the
      // retained ledger) plus the public `match.phase` whistle read (#8(l)). Every
      // out-of-support moment is a named holdIncumbent (the incumbent machinery
      // governs, #110.2(i)), classified into the four E-OOS counters. Absent (or
      // false) ⇒ `support` is 'IN_SUPPORT' and this whole gate is inert: the branch
      // below is byte-identical to the v3 eye (X-OFF-IDENT).
      const support = eye.v4?.inSupportLaw === true
        ? evaluateInSupport(snap, match.phase === 'playing')
        : 'IN_SUPPORT';
      if (support !== 'IN_SUPPORT') {
        if (trace !== undefined) {
          if (support === 'E-OOS-PHASE') trace.v4OosPhase += 1;
          else if (support === 'E-OOS-UNSEEN') trace.v4OosUnseen += 1;
          else if (support === 'E-OOS-INFLIGHT') trace.v4OosInflight += 1;
          else trace.v4OosStale += 1;
        }
        holdIncumbent();
      } else if (context === null) {
        if (trace !== undefined) {
          if (oracle) trace.abstainNoOwner += 1;
          else if (snap === null) trace.abstainNoSnapshot += 1;
          else if (snap.ball === null) trace.abstainNoBall += 1;
          else trace.abstainNoOwner += 1;
        }
        holdIncumbent();
      } else {
        if (trace !== undefined && eye.v4?.inSupportLaw === true) trace.v4InSupport += 1;
        // V4-P3p-2a §2.2 (rulings #116.4/#117): the TWO S BITS, computed
        // PERCEPT-HONESTLY from THIS body's own snapshot when their flag is armed.
        // LOAD-BEARING now (lifted out of the old trace-guard): the extended-key
        // lookup below CONSUMES them. Flag-off ⇒ NOT computed — the family never
        // consults a child, so the consumption path stays byte-identical to the v3
        // eye (X-OFF-IDENT). Still tallied to the trace when present; a UNKNOWN
        // abstention is counted, never a silent 0. widthHeld is one MOMENT value;
        // the offside line is read once, beyondLine resolved per candidate below.
        const deliveryOn = eye.v4?.deliveryBit === true;
        const offsideOn = eye.v4?.offsideBit === true;
        let widthHeld: BitValue | undefined;
        if (deliveryOn) {
          widthHeld = widthHeldBit(snap, p.gid, p.side, (x) => team.localX(x));
          if (trace !== undefined) {
            if (widthHeld === 1) trace.v4WidthHeld1 += 1;
            else if (widthHeld === 0) trace.v4WidthHeld0 += 1;
            else trace.v4WidthHeldUnknown += 1;
          }
        }
        let offsideLine: number | null = null;
        let offsideBallLocalX = 0;
        if (offsideOn) {
          offsideLine = perceivedOffsideLine(snap, p.side, (x) => team.localX(x));
          offsideBallLocalX = snap?.ball ? team.localX(snap.ball.pos.x) : team.localX(ball.pos.x);
          if (trace !== undefined) {
            for (const cand of EYE_LATTICE) {
              const bl = beyondLineBit(offsideLine, offsideBallLocalX, cand.dx);
              if (bl === 1) trace.v4BeyondLine1 += 1;
              else if (bl === 0) trace.v4BeyondLine0 += 1;
              else trace.v4BeyondLineUnknown += 1;
            }
          }
        }
        // A4-P1c (#137): the DORMANT back-home-region GRANT. `homeRegionGrant` is
        // null in every production path ⇒ `granted` is false ⇒ `homeBias` is
        // undefined ⇒ the v3 consumer below is bit-for-bit HEAD (the grant lives
        // ONLY at this established consumption point — no new decision moment).
        // Body- and side-scoped; a probe sets it on a forked clone. The bias is
        // distance-decayed toward the back home region in the eye's own units.
        const grant = match.homeRegionGrant;
        const singleGrant = (grant !== null && !('obedienceByIndex' in grant)) ? grant : null;
        let homeBias: ((cand: EyeCandidate) => number) | undefined =
          (singleGrant !== null && singleGrant.side === p.side
            && p.index === singleGrant.bodyIndex && singleGrant.strength !== 0)
            ? (cand: EyeCandidate) => backHomeRegionBias(
              singleGrant.strength, team.localX(ball.pos.x + team.attackDir * cand.dx),
            )
            : undefined;
        // A4 SLICE 2, S2-P1 (#158): the PER-BODY OBEDIENCE VECTOR form of the same
        // dormant seam. `homeRegionGrant` is null in every production path ⇒ this
        // branch never runs ⇒ bit-for-bit HEAD (I-A7). When the VECTOR member is set
        // on a forked clone, each side-`side` outfield body reads HIS OWN obedience
        // and prices HIS OWN ATTACK_FORMATIONS home through the SHIPPED-FORM
        // strength map + the SAME homeMapBias closure the eye.v4.homePrior branch
        // builds — so a uniform 0.5 vector IS the slice-1 certified PRIOR content on
        // that side. Vectors are instrument forks, never shipped content (§3 BIRTH
        // NEUTRALITY): no role-derived default lives in src/**.
        if (homeBias === undefined && grant !== null && 'obedienceByIndex' in grant
          && grant.side === p.side) {
          const s = homePriorStrength(grant.obedienceByIndex[p.index] ?? 0);
          if (s !== 0) {
            const home = ATTACK_FORMATIONS[team.style.formationAtk][p.index];
            if (home !== undefined) {
              const hx = home.x;
              const hy = home.y;
              homeBias = (cand: EyeCandidate) => homeMapBias(
                s, team.localX(ball.pos.x + team.attackDir * cand.dx), ball.pos.y + cand.dy, hx, hy,
              );
            }
          }
        }
        // A4-P1d (#143): the DORMANT HOME-MAP GRANT (parallel to the P1c single-body
        // flag above, which stays banked untouched). `homeMapGrant` is null in every
        // production path ⇒ this closure is never built ⇒ bit-for-bit HEAD. When set on
        // a forked clone, EVERY side-d OUTFIELD body (index-1..5, GK excluded) gets his
        // OWN 2D home bias centred on HIS ATTACK_FORMATIONS base spot (the world's own
        // per-body variable), priced at this SAME v3 consumption point. The single-body
        // grant, if also set for this body, takes precedence (independence).
        const mapGrant = match.homeMapGrant;
        // (p.role is already narrowed to non-GK at this consumption point; GK never
        // reaches the v3 station eye, so the map grant covers exactly the outfielders.)
        if (homeBias === undefined && mapGrant !== null && mapGrant.side === p.side
          && mapGrant.strength !== 0) {
          const home = ATTACK_FORMATIONS[team.style.formationAtk][p.index];
          if (home !== undefined) {
            const hx = home.x;
            const hy = home.y;
            const s = mapGrant.strength;
            homeBias = (cand: EyeCandidate) => homeMapBias(
              s, team.localX(ball.pos.x + team.attackDir * cand.dx), ball.pos.y + cand.dy, hx, hy,
            );
          }
        }
        // A4-P2 (#148): the SHIPPED-FORM home-prior MASTER flag. Dormant unless
        // `eye.v4.homePrior === true` — absent in every production path AND every
        // banked instrument ⇒ this block never runs ⇒ bit-for-bit HEAD (I-A7). When
        // ON, this side derives its OWN home-map strength from ITS genome's
        // `homePriorObedience` gene (born 0/absent ⇒ strength 0 ⇒ inert ⇒ still
        // byte-identical until the gene evolves), applied to the SAME per-body home
        // (HIS ATTACK_FORMATIONS base spot) at the SAME v3 consumption point — both
        // teams, each from its own agreement. The probe `homeMapGrant` takes
        // precedence for any side it targets: this branch fires only when no probe
        // grant covers p.side (independence, the P1c/P1d idiom).
        if (homeBias === undefined && eye.v4?.homePrior === true
          && (mapGrant === null || mapGrant.side !== p.side)) {
          // A4 S2-P2 (contract M-S2.2, ruling #164.3): the strength is read from THIS
          // BODY's EFFECTIVE obedience = clamp01(team obedience + HIS slot offset) —
          // the SAME homePriorStrength map, the SAME closure, the SAME consumption
          // moment. NO new consumer mechanism and no clamp beyond the gene's own
          // domain. The offset family is BORN ABSENT everywhere (contract §3 BIRTH
          // NEUTRALITY), so `effectiveHomePriorObedience` returns clamp01(obedience),
          // which homePriorStrength maps IDENTICALLY to the raw gene it read before
          // (its own domain clamp) ⇒ offsets-absent is bit-for-bit the uniform
          // whisper (proven in tests/a4S2P2PerBodyOffsetGene.test.ts).
          const s = homePriorStrength(effectiveHomePriorObedience(team.genome, p.index));
          if (s !== 0) {
            const home = ATTACK_FORMATIONS[team.style.formationAtk][p.index];
            if (home !== undefined) {
              const hx = home.x;
              const hy = home.y;
              homeBias = (cand: EyeCandidate) => homeMapBias(
                s, team.localX(ball.pos.x + team.attackDir * cand.dx), ball.pos.y + cand.dy, hx, hy,
              );
            }
          }
        }
        let outcome;
        // §1.1: G_commit for a v2 deviation, empty otherwise (v1 arm / v3 / incumbent).
        let v2rCommitContributors: Set<number> = new Set();
        if (eye.v3 !== undefined) {
          // V4-P3p-2a §2.2/§2.3: the EXTENDED-KEY consumer. When the merged children
          // are INJECTED and at least one bit flag is armed, price each candidate
          // through the frozen child-or-base fallback order against the SAME v3
          // control (the control is NOT bit-split, #117.3). Otherwise the plain
          // V3-P2 role consumer runs UNCHANGED — flags absent / no children ⇒
          // byte-identical to the v3 eye (X-OFF-IDENT).
          if (eye.v3.children !== undefined && (deliveryOn || offsideOn)) {
            const res = priceApproachesV3Partial(
              eye.v3.roleTable, eye.v3.control, eye.v3.children, context.key, p.role, eye.arm, g,
              { deliveryOn, offsideOn, widthHeld, offsideLine, ballLocalX: offsideBallLocalX },
              homeBias,
            );
            outcome = res.outcome;
            if (trace !== undefined) {
              trace.v4DeliveryChild += res.deliveryChild;
              trace.v4DeliveryBase += res.deliveryBase;
              trace.v4OffsideChild += res.offsideChild;
              trace.v4OffsideBase += res.offsideBase;
            }
          } else {
            // V3-P2 §3.4: the role-conditioned consumer. Each body reads HIS OWN role's
            // column (own-state, no percept) and argmaxes the value advantage vs the
            // control recovered for that same (context × role). NO going-bit (#77.2(ii)).
            outcome = priceApproachesV3(
              eye.v3.roleTable, eye.v3.control, context.key, p.role, eye.arm, g, homeBias,
            );
          }
        } else if (eye.v2 !== undefined) {
          // V2-P2 §2.2/§2.4: the going-conditioned consumer. Compute the PERCEIVED
          // going-bit per candidate from the body's OWN teammate motion (TRUE for
          // the ORACLE-CTX arm), then price each candidate through its
          // (context × going-bit) cell against the control in the same bit.
          const teammates: TeammateMotionId[] = [];
          if (oracle) {
            for (const q of team.players) {
              if (q === p || q.role === 'GK' || q.sentOff) continue;
              teammates.push({ gid: q.gid, px: q.pos.x, py: q.pos.y, vx: q.vel.x, vy: q.vel.y });
            }
          } else if (snap !== null) {
            for (const o of snap.players) {
              if (o.side !== p.side || o.gid === p.gid || o.gid % TEAM_SIZE === 0) continue;
              teammates.push({ gid: o.gid, px: o.pos.x, py: o.pos.y, vx: o.vel.x, vy: o.vel.y });
            }
          }
          const bits = goingBits(ball.pos.x, ball.pos.y, team.attackDir, teammates);
          outcome = priceApproachesV2(eye.v2.goingTable, eye.v2.control, context.key, eye.arm, g, bits);
          // V2-P2R §1.1: record G_commit for the chosen region (the abort's baseline).
          // Computed here, on the SAME percept the going-bit was read from, so the
          // set-difference at the mid-window re-read is faithful. Ruling #75.2:
          // captured ONLY when the abort is armed — else the old experiment reproduces.
          if (abortEnabled && outcome.kind === 'deviate') {
            v2rCommitContributors = goingContributors(
              ball.pos.x, ball.pos.y, team.attackDir, outcome.candidate, teammates,
            );
          }
        } else {
          outcome = priceApproaches(eye.table, context.key, eye.arm, g);
        }
        if (outcome.kind === 'deviate') {
          state = {
            offset: { dx: outcome.candidate.dx, dy: outcome.candidate.dy },
            candidateId: outcome.candidate.id,
            untilTick: match.simTick + EYE_W_TICKS,
            faceAtDecision: context.face,
            committedGoingContributors: v2rCommitContributors,   // §1.1: G_commit
          };
          match.stationEyeState.set(p.gid, state);
          if (trace !== undefined) {
            trace.deviate += 1;
            trace.byCandidate.set(
              outcome.candidate.id, (trace.byCandidate.get(outcome.candidate.id) ?? 0) + 1,
            );
            trace.byContext.set(context.key, (trace.byContext.get(context.key) ?? 0) + 1);
          }
        } else {
          if (trace !== undefined) {
            if (outcome.kind === 'noCell') trace.noCell += 1; else trace.tie += 1;
          }
          holdIncumbent();
        }
      }
    }
    if (state !== undefined && state.offset !== null) {
      if (isStation) {
        const want = v2(
          ball.pos.x + team.attackDir * state.offset.dx, ball.pos.y + state.offset.dy,
        );
        target = want;
        p.c4Trace = { meet: want, applied: want };
        if (eye.trace !== undefined) eye.trace.overrideTicks += 1;
      } else if (eye.trace !== undefined) {
        // E-NONSTATION: the commitment lapses for these ticks and the clock
        // keeps running (§2.2). Never override a ball-directed job.
        eye.trace.nonStationTicks += 1;
      }
    }
  }

  // C7 T1 (docs/world-model/C7-T1-PENDINGKICK.md §SEAM): a body winding up a shot
  // PLANTS and turns toward the aim. The executor's "kick already happened →
  // brief follow-through" (the Shoot case above) does NOT apply during the window
  // — the kick has NOT happened yet — so the movement target is held on the body's
  // own spot (it does not dribble the ball out of range: the P-DRIFT pathology the
  // doc pre-lays) and faceTarget is driven to the aim so the heading integrator
  // composes the strike. Dormant in production (c7Windup OFF ⇒ pendingKick null).
  const pk = match.pendingKick;
  if (pk !== null && match.c7Windup && pk.gid === p.gid && ball.owner === p) {
    target = { x: p.pos.x, y: p.pos.y };
    speedF = 0.22; // walking pace — well under stepBall's push gate (Dribble-only anyway)
    p.faceTarget = { x: pk.aim.x, y: pk.aim.y };
  }

  // O1 T1 (docs/world-model/O1-T1-PASS-WINDUP.md §SEAM): the same plant, for a body
  // winding up a shortPass. The executor's "kick already happened → brief
  // follow-through" (`case 'Pass'` above) does NOT apply during the window — the
  // kick has NOT happened yet — so the movement target is held on the body's own
  // spot (it does not dribble the ball out of range) and faceTarget is driven to the
  // aim so the heading integrator composes the release. Dormant in production
  // (o1PassWindup OFF ⇒ pendingPassWindup null).
  const pp = match.pendingPassWindup;
  if (pp !== null && match.o1PassWindup && pp.gid === p.gid && ball.owner === p) {
    target = { x: p.pos.x, y: p.pos.y };
    speedF = 0.22; // walking pace, the C7 plant's value
    p.faceTarget = { x: pp.aim.x, y: pp.aim.y };
  }

  // O2 T0 (docs/world-model/O2-T0-DORMANT-SEAM.md §SEAM): the SAME plant, for a
  // body who is LOOKING. His carry slows to the plant's walking pace on his own
  // spot — the price is the ticks he is not going anywhere with the ball while
  // pressure closes (M-O2.2). Two things are deliberately NOT done here:
  //   • `faceTarget` is NOT written. The C7/O1 plants aim at a committed target;
  //     a LOOK has no target, and CHOOSING where to look would be a new lever
  //     (and, unearned, a new information channel). He scans what his CURRENT
  //     heading covers — what is behind him stays behind him unless he turns.
  //   • the ball is NOT touched: the seam never writes `ball.owner` and never
  //     plants the ball into flight; it stays owned at his carry offset.
  // Dormant in production (o2Look OFF ⇒ o2LookWindow null).
  const lw = match.o2LookWindow;
  if (lw !== null && match.o2Look && lw.gid === p.gid && ball.owner === p) {
    target = { x: p.pos.x, y: p.pos.y };
    speedF = 0.22; // walking pace, the C7 plant's value
  }

  // Stay onside (Phase 29): while a TEAMMATE is carrying the ball, off-ball
  // attackers never target a spot beyond the offside line — runs hold at the
  // second-last defender's shoulder and break the instant the kick is struck
  // (a ball in flight has no owner, so the hold releases by itself). This is
  // also how attackers stranded beyond the line drift back onside. The hold
  // depth is LAYERED by role (29.1): one shared depth parked every attacker
  // on the same flat strip, their markers interleaved on it, and the band
  // read as a single blob — the striker toes the line, wingers and mids
  // stagger behind like a real attacking shape.
  const carrier = ball.owner;
  if (target && carrier && carrier !== p && carrier.side === p.side && p.role !== 'GK') {
    // (Phase 109 note: a lagged line-read for runners was built and
    // MEASURED OUT here — with it the trap gene's offside yield DROPPED
    // 1.68→1.38/match, because a stale read of a RISING line makes the
    // runner hold conservatively. Frame-perfect onside discipline turned
    // out not to block the trap at all — the passer's decision cadence is
    // misjudgment enough. trap-ab.ts carries the numbers.)
    const holdX =
      offsideLineLocalX(team, opp.players, team.localX(ball.pos.x)) - HOLD_DEPTH[p.role];
    if (team.localX(target.x) > holdX) {
      target = { x: holdX * team.attackDir, y: target.y };
      p.clampTrace = 'onside';
    }
  }

  // Barred-box discipline (Phase 31.9, user report "门球时盯人球员往禁区里
  // 挤,抽搐"): while a goal kick or a keeper hold bars this player from the
  // opposing box, STEER to the box edge instead of into it. Match's hard
  // clamp (the rule) still exists, but a target inside the box made steering
  // fight it — drive in, get teleported out, every frame: the twitch. The
  // steering target rides 0.4m outside the clamp line so it never triggers.
  const restart = match.restart;
  const barred =
    (restart?.kind === 'goalKick' && restart.side !== p.side) ||
    ((opp.goalkeeper.gkHoldTimer > 0 || opp.goalkeeper.gkDistributing) && ball.owner === opp.goalkeeper);
  const oppGoalX = opp.attackDir < 0 ? HALF_L : -HALF_L; // opp defends this line
  const edgeX = oppGoalX - Math.sign(oppGoalX) * (BOX_DEPTH + 0.8);
  if (target && barred && p.role !== 'GK' && Math.abs(target.y) < BOX_WIDTH / 2 + 0.5) {
    if (oppGoalX > 0 ? target.x > edgeX : target.x < edgeX) {
      target = { x: edgeX, y: target.y };
      p.clampTrace = 'barred';
    }
  }

  // ⭐⭐ PC T0 (docs/world-model/PC-T0-LATENCY-SEAM.md; contract §2 M-PC.2, ruling #297 item 5)
  // — THE ONE PER-BODY LATENCY GATE, and the whole of this seam's steering surface. It sits
  // HERE, after every case and after both clamps, because that is the single point through
  // which the FULL per-tick steering set passes: interceptSolution · jockeyStandoff ·
  // mark.stance · mark.trapHold · receive.descentReroute · formationSpot · support · gk.position
  // · gk.rush · GoalkeeperSave · MakeRun (PC-C0's map plus the two channels its
  // §COMMANDER CORRECTIONS 1 amended in). One gate covers them all because every one of them is
  // evaluated inside this body's own executor call.
  //
  //   • HELD ⇒ the STALE plan continues (M-PC.2: stale plan, not blindness) — the target and
  //     facing his executor applied on the tick BEFORE the event was observable. Wrongness
  //     during processing is FREE and EMERGENT.
  //   • NOT HELD ⇒ he REMEMBERS what he just applied, which is what a later surprise freezes.
  //
  // ⭐⭐ COPIED, NEVER ALIASED — the starred hazard. `p.faceTarget = ball.pos` in
  // `GoalkeeperPosition`, `GoalkeeperRush` and `GoalkeeperSave` hands out a LIVE REFERENCE to
  // the ball's own vector; freezing that reference would freeze nothing and leave the keeper
  // omniscient through his own hold. `remember` copies on the way in and this gate copies on
  // the way out.
  //
  // ⚠ SCOPE, stated: the two facing writes BELOW this gate (a keeper holding the ball, a
  // restart taker standing over it) are DEAD-BALL states — a body who owns the ball or is
  // taking a restart, never a surprised body in live play — and they are deliberately left
  // outside the gate rather than duplicating it.
  //
  // Dormant: `pcLatency` is null in every production path, so neither branch is reachable and
  // the statement below is skipped entirely.
  // ⭐⭐ RC T0b §FIX (docs/world-model/RC-T0B-READY-SEAM.md; ruling #379 items 3 and 5; contract
  // RC §2-AMENDMENT M-RC.3b) — ⭐ THE TRADE IS THE DECISION, and the ONLY thing armed adds to
  // a body.
  //
  // 「转不转身,不该和"跑不跑"抢同一个名额;该和"转过去会慢多少"比」. The brain recorded the
  // BENEFIT of opening up (`w · belief · s_receive`, at his own decision cadence); the COST is
  // resolved HERE, every frame, because it depends on the direction the plan is actually
  // driving him THIS frame:
  //
  //     COST = (1 − f(φ)) · S_move
  //
  // — the fraction of the movement's speed the body would FORFEIT by facing off its line
  // (`f` = BF's own `facingFactor` at the body's OWN `facingDepth`, at φ = the angle between
  // the intended direction `target − p.pos` after both clamps and the bearing to the carrier)
  // times `S_move`, the movement plan's OWN priority — `p.action.scores[0].score`, the menu
  // winner's score, already on the record. He faces iff BENEFIT > COST, STRICTLY. ⛔ NO NEW
  // CONSTANT: every factor is an existing quantity of this engine. With the BF price SHUT
  // `facingDepth` is 0 ⇒ `f` is 1 ⇒ COST is 0 ⇒ the turn is FREE and he faces whenever he
  // believes at all; a standing body (`speedF` 0) or a degenerate intent pays nothing either.
  // ⛔ BOTH FORMULAE ARE IMPORTED from `../sim/bodyFacing` — neither is re-typed here.
  //
  // ⛔ MOVEMENT IS UNTOUCHED: `target` and `speedF` are READ and never written, the menu the
  // brain sorted never carried a facing candidate, and no heading law is added — the shipped
  // `Player.physicsStep` integrator rotates toward `faceTarget` at `TURN_RATE` exactly as it
  // does for a backpedalling marker or a keeper facing the ball, and prices that rotation
  // through the same BF law the cost was quoted from (M-BF.4).
  //
  // It sits HERE, after every case and both clamps and IMMEDIATELY ABOVE the PC latency gate,
  // for two reasons that are the same reason: (1) a LIVE PC HOLD must override the face
  // exactly as it overrides the target — a body still processing a surprise does not turn
  // either — and the gate below rewrites `p.faceTarget` unconditionally when it holds;
  // (2) when he is NOT held, `pcSeat.remember` must record the face the body actually
  // executes, so the plan a later surprise freezes is the one he was really running.
  //
  // ⭐⭐ COPIED, NEVER ALIASED — the starred hazard above: handing out a live reference to the
  // carrier's own position vector would make this body's face follow him for free through
  // anything that freezes it. The carrier is re-read from the ball THIS frame, so a body whose
  // decision is stale about who is carrying simply does not turn.
  //
  // Dormant: `readyFaceGid` is written by NO shipped path (`rcReady` is false everywhere), so
  // the property is always `undefined` and this statement is one comparison.
  const readyFaceGid = p.action.readyFaceGid;
  const readyBenefit = p.action.readyBenefit;
  if (readyFaceGid !== undefined && readyBenefit !== undefined) {
    const carrier = ball.owner;
    if (carrier !== null && carrier.gid === readyFaceGid) {
      const dirX = target === null ? 0 : target.x - p.pos.x;
      const dirY = target === null ? 0 : target.y - p.pos.y;
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
      const bearX = carrier.pos.x - p.pos.x;
      const bearY = carrier.pos.y - p.pos.y;
      const bearLen = Math.sqrt(bearX * bearX + bearY * bearY);
      // A body who is not moving, or whose intent or bearing names no direction, forfeits
      // nothing by turning: the degenerate guard is the family's own 1e-6 (`physicsStep`'s
      // face-target guard, `facingCosine`'s own identity).
      let cost = 0;
      if (speedF > 0 && dirLen > 1e-6 && bearLen > 1e-6) {
        const cosPhi = facingCosine(dirX / dirLen, dirY / dirLen, bearX / bearLen, bearY / bearLen);
        cost = (1 - facingFactor(cosPhi, p.facingDepth)) * p.action.scores[0].score;
      }
      if (readyBenefit > cost) {
        p.faceTarget = { x: carrier.pos.x, y: carrier.pos.y };
      }
    }
  }

  const pcSeat = match.pcLatency;
  if (pcSeat !== null) {
    const hold = pcSeat.holdFor(p.gid, match.simTick);
    if (hold !== null) {
      target = hold.target === null ? null : { x: hold.target.x, y: hold.target.y };
      p.faceTarget = hold.face === null ? null : { x: hold.face.x, y: hold.face.y };
      pcSeat.ledger.heldExecutorTicks++;
      // ⭐ H3's own receipt: the team layer rewrote his job mid-hold and his legs did not care.
      if (p.action.type !== hold.actionAtArm) pcSeat.ledger.heldThroughReassignment++;
    } else {
      pcSeat.remember(p.gid, target, p.faceTarget, p.action.type);
    }
  }

  // C4 T2-ARRIVAL, probe observability: the target that SURVIVED the clamps
  // above, so F2 can name which clamp rewrote a re-route instead of guessing.
  if (p.c4Trace !== null && target) p.c4Trace = { meet: p.c4Trace.meet, applied: target };

  // arrive/scale return fresh vectors, so accumulating into `desired` in place
  // is alias-free — same additions in the same order, two fewer allocations
  // per player per frame.
  const desired = target ? arrive(p, target, p.topSpeed * speedF, 2.2) : scale(p.vel, 0.4);

  // Steering blend: hard anti-stacking vs teammates + soft path avoidance.
  // Wall members skip it — shoulder-to-shoulder IS the assignment.
  if (!inWall) {
    const sep = separation(p, team.players, 2.4, 2.5);
    desired.x += sep.x;
    desired.y += sep.y;
  }
  if (
    p.action.type === 'MoveToPoint' ||
    p.action.type === 'TrackRelativePoint' ||
    p.action.type === 'MoveToFormationSpot' ||
    p.action.type === 'SupportBallCarrier'
  ) {
    const av = avoidOpponents(p, desired, opp.players);
    desired.x += av.x;
    desired.y += av.y;
  }

  // Barred-box backstop, velocity level: separation between two markers
  // standing shoulder-to-shoulder ON the edge line can still shove one of
  // them inward past the target clamp above — kill the into-box component
  // for anyone already at the line, whatever pushed them.
  if (barred && p.role !== 'GK' && Math.abs(p.pos.y) < BOX_WIDTH / 2 + 0.5) {
    const inward = Math.sign(oppGoalX - edgeX);
    if ((p.pos.x - edgeX) * inward > -0.3 && desired.x * inward > 0) desired.x = 0;
  }

  // Facing polish (Phase 51.2, user report): a keeper HOLDING the ball
  // squares up toward the opponent goal — he surveys the pitch, and the
  // held ball (glued 0.3m along his heading) comes around with him instead
  // of pointing at the net he just saved. Same for a restart TAKER standing
  // over the ball (free kick / corner / kick-in / goal kick): once he has
  // arrived at the spot he faces the play, not the walk-up direction.
  // Post-switch on purpose: these states override any case's facing.
  if (p.role === 'GK' && ball.owner === p && (p.gkHoldTimer > 0 || p.gkDistributing)) {
    p.faceTarget = team.oppGoal();
  } else if (
    match.restart !== null &&
    match.restart.takerGid === p.gid &&
    dist(p.pos, match.restart.pos) < 2.5
  ) {
    p.faceTarget = team.oppGoal();
  }

  p.desiredVel = desired;
}

/** Onside hold depth below the line, by role (29.1) — layers the shape.
 * Kept shallow: −2.6/−1.2 visibly staggered but cost too many arrivals. */
const HOLD_DEPTH: Record<Role, number> = { GK: 0, DF: 3.0, MF: 1.8, WG: 0.8, ST: 0.4 };

/** Dribble toward goal, bending away from the nearest defender ahead —
 * or DOWN THE LINE toward the byline when wide and advanced (Phase 31,
 * 下底): the same steering decideCarrier's wide-drive space check scored,
 * so the legs go where the utility looked. */
function dribbleTarget(p: Player, match: Match): V2 {
  const team = match.teams[p.side];
  const opp = match.teams[1 - p.side];
  const localX = team.localX(p.pos.x);
  // 脱压带球 (34.2): same predicate the scorer used — pressured, front door
  // closed, outside the final third ⇒ carry it AWAY from the press. Never
  // into the own box (the calm-reset family lives there). Same holding
  // flag as the scorer (Phase 35) so the utility and the legs agree.
  const esc = escapeCarry(p, team.attackDir, localX, opp.players, team.mentality.holding > 0.5);
  if (esc) {
    const t = add(p.pos, scale(esc.dir, 5));
    const minLocal = -(HALF_L - BOX_DEPTH) + 1;
    if (team.localX(t.x) < minLocal) t.x = minLocal * team.attackDir;
    t.y = clamp(t.y, -HALF_W + 1.5, HALF_W - 1.5);
    return t;
  }
  const wideDrive = Math.abs(p.pos.y) > 13 && localX > 20 && localX < HALF_L - 7;
  const goal = wideDrive
    ? v2((HALF_L - 8) * team.attackDir, Math.sign(p.pos.y) * (HALF_W - 12))
    : team.oppGoal();
  const toGoal = norm(sub(goal, p.pos));

  // Find the most obstructive opponent within 6m ahead.
  let block: Player | null = null;
  let blockD = Infinity;
  for (const o of opp.players) {
    if (o.sentOff) continue;
    const to = sub(o.pos, p.pos);
    const ahead = to.x * toGoal.x + to.y * toGoal.y;
    if (ahead > 0 && ahead < 6) {
      const d = dist(o.pos, p.pos);
      if (d < blockD) {
        blockD = d;
        block = o;
      }
    }
  }

  let dir = toGoal;
  if (block) {
    // Slalom: steer perpendicular, away from the blocker's side — and
    // COMMIT to it (Phase 41.2, user report "带球转一大圈然后突然丢球"):
    // a blocker shadowing the carrier right on the goal axis flipped the
    // cross-product sign every few ticks, the steering flip-flopped ±68°,
    // and the body turn-rate cap integrated that into a full pirouette at
    // walking pace — momentum dead, no pace protection, tackle inevitable.
    // A real dribbler picks a shoulder and goes: the side holds 0.6s, and
    // a re-pick at expiry is HYSTERETIC — a shadow sitting ON the axis
    // (|cross| small) keeps the committed shoulder (the first cut re-read
    // the instantaneous sign at every expiry, which against a mirroring
    // defender was a coin flip per 0.6s: the same pirouette, slower).
    // Only a blocker decisively parked off-axis flips it — a real cut.
    let side: 1 | -1;
    if (match.simTime < p.slalomUntil) {
      side = p.slalomSide;
    } else {
      const cross = (block.pos.x - p.pos.x) * toGoal.y - (block.pos.y - p.pos.y) * toGoal.x;
      side = Math.abs(cross) > blockD * 0.3 ? (cross > 0 ? -1 : 1) : p.slalomSide;
      p.slalomSide = side;
      p.slalomUntil = match.simTime + 0.6;
    }
    const perp = v2(-toGoal.y * side, toGoal.x * side);
    // Perp cap 1 → 0.72 (Phase 67 temper): with the 41.2 commitment the
    // full-weight cut rounded engaged defenders so cleanly that penetration
    // depth — not duel survival — ran the league ~+0.6 goals hot (the
    // drive-protection knob measured SATURATED: 0.16→0.14 moved nothing).
    // Capping the blend keeps the committed slalom but leaves the defender
    // a play at close quarters.
    const w = clamp(1 - blockD / 6, 0, 0.72);
    dir = norm(add(scale(toGoal, 1 - w * 0.8), scale(perp, w)));
  }

  const t = add(p.pos, scale(dir, 6));
  t.x = clamp(t.x, -HALF_L + 1.5, HALF_L - 1.5);
  t.y = clamp(t.y, -HALF_W + 1.5, HALF_W - 1.5);
  return t;
}

/** Keep goalkeeper targets inside a sane area in front of their own goal. */
function clampToBox(pt: V2, attackDir: 1 | -1): V2 {
  const gx = -attackDir * HALF_L; // own goal line x
  const minX = Math.min(gx, gx + attackDir * 14);
  const maxX = Math.max(gx, gx + attackDir * 14);
  return v2(clamp(pt.x, minX, maxX), clamp(pt.y, -GOAL_WIDTH / 2 - 4, GOAL_WIDTH / 2 + 4));
}
