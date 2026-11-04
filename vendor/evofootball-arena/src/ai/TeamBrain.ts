import { dist, len } from '../utils/vec';
import { BOX_DEPTH, BOX_WIDTH, HALF_L } from '../sim/constants';
import { MARK_SAG_MAX } from '../evolution/genome';
import { markSagMetres } from './actionExecutor';
import { arrivalGroup } from './defenceBook';
import { cornerKeyZone, formationSpot } from './formations';
import { ballLanding } from './perception';
import { aerialSense } from '../sim/mechanics';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { Team } from '../sim/Team';
import type { CornerRoutine, RestartState, Role, TeamMode } from '../sim/types';

/**
 * TeamBrain — picks one tactical mode for the whole team and hands out
 * coordination assignments (who presses, who marks whom) so that players
 * don't all chase the ball. Runs every TEAM_AI_INTERVAL and immediately
 * after possession changes.
 *
 * Mode logic (genes in brackets):
 *  - we have the ball, just won it, ball deep       -> CounterAttack [counterAttackBias]
 *  - we have the ball in their half                 -> Attack
 *  - we have the ball in our half                   -> BuildUp
 *  - they have the ball, we want it back NOW        -> Press [pressIntensity]
 *  - they have the ball, we hold shape              -> Defend
 *  - dead ball / kickoff                            -> ResetShape
 */
/**
 * ⭐⭐ DF T2 — THE DEFENSIVE DECISION SURFACE (docs/world-model/DF-T2-DECISION-SURFACE.md;
 * contract DF-DEFENSIVE-BRAIN-CONTRACT.md §2 M-DF.1/M-DF.2/M-DF.3/M-DF.4; ruling #325 item 5).
 * THE OPTION ORDER OF RECORD, and the whole vocabulary the seat can express:
 *
 *   0 `press` — leave my man and go at the CARRIER (the ledger write is the ABSENCE of an
 *               assignment; the shipped contain branch in `PlayerBrain` then licenses at most
 *               one container, exactly as it does today)
 *   1 `hold`  — keep the man I already have (DF-T0's persistence law is this option's
 *               substrate — composed, never duplicated)
 *   2 `jump`  — take a man the L3 access-time account says I reach BEFORE the ball can
 *               (slack > 0: the READING half of the mandate's reading-vs-contact axis)
 *   3 `take`  — take a man the ball beats me to (slack = 0: the CONTACT half)
 *
 * ⚠ THE FOURTH DOCTRINE OPTION, 「drop to cover」, IS NAMED OUT, NOT FAKED (DF-C0 §R3: a
 * targeted cover rotation has NO action primitive — "there is no 'take that zone' for a
 * chooser to price" — and the only cover-FACT producer in the tree,
 * `src/ai/defensiveCoordination.ts`, is snapshot-shaped and belongs to the coordination
 * cluster, which M-DF.4 puts OUT of this slice). It is therefore neither priced nor
 * counted here. See the stage doc §P2(a).
 */
export const DF_SURFACE_OPTIONS = ['press', 'hold', 'jump', 'take'] as const;
/** DF T2: the option indices, in the order above. */
const DF_OPT_PRESS = 0;
const DF_OPT_HOLD = 1;
const DF_OPT_JUMP = 2;
const DF_OPT_TAKE = 3;
/**
 * ⭐ DF T2 — ANCHORED EXTRACTION (canon VERBATIM: "a src-extracted constant pins its
 * extraction to the NAMED call site — anchored match + line receipt — never
 * first-occurrence", home BK-C0 §CORR item 1). THE NAMED CALL SITE, quoted verbatim from
 * `src/ai/PlayerBrain.ts` (the Phase-29.1 CONTAIN branch — the shipped, live executable form
 * of 「press the carrier」 for a body who holds no mark):
 *
 *   `      if (dC < 8 && carrierGoalD < 35 && dist(p.pos, ownGoal) < carrierGoalD) {`
 *
 * The LINE NUMBER is reported by the probe artifact, never asserted here — it is the thing
 * that drifts. Both values are the shipped branch's own; no new magnitude is invented, and
 * the branch itself is untouched.
 */
const CONTAIN_RADIUS_M = 8;
const CONTAIN_TERRITORY_M = 35;
/**
 * ⭐ DF T2 — ANCHORED EXTRACTION, second: the shipped mark CREATION range, quoted verbatim
 * from the greedy below (the census's `markRange22` rule):
 *
 *   `      if (d < 22 && (best === null || d < best.d)) best = { idx: p.index, d };`
 *
 * The press election compares against the best marking option INSIDE that same range, so the
 * surface can never consider a pairing the shipped greedy could not have made.
 */
const MARK_RANGE_M = 22;

export function updateTeamBrain(team: Team, match: Match): void {
  // Restarts are live for coordination: defenders keep marks and pressers
  // crowd the edge of the clearance circle while the taker walks over.
  if (match.phase !== 'playing' && match.phase !== 'restart') {
    team.mode = 'ResetShape';
    team.chasers.clear();
    team.marks.clear();
    team.runners.clear();
    team.arriver = null;
    team.keeperUp = false;
    return;
  }

  // 门将上前 (Phase 35): trailing in the dying minutes, our own attacking
  // corner — the keeper abandons his goal for the box. The license lives
  // exactly as long as the corner does (setup, hand-off, flight — the
  // 31.9 lesson via team.cornerCrash); the moment it dies he sprints home.
  team.keeperUp =
    team.mentality.urgency > 0.5 &&
    match.half === 2 &&
    match.minute() >= 89 &&
    ((match.phase === 'restart' && match.restart?.kind === 'corner' && match.restart.side === team.side) ||
      (team.cornerCrash !== null && match.simTime < team.cornerCrash.until));
  if (team.keeperUp && !team.keeperUpAnnounced) {
    team.keeperUpAnnounced = true;
    match.pushEvent('info', team.side, `🧤 ${team.goalkeeper.name} is UP for the corner!`);
  }

  const g = team.genome;
  const ball = match.ball;
  const possession = match.possessionSide; // -1 while the ball is loose
  const prevMode = team.mode;

  let mode: TeamMode;
  if (possession === team.side) {
    const sinceWin = match.simTime - team.possessionGainedAt;
    const ballLocalX = team.localX(ball.pos.x);
    if (sinceWin < 3.0 && g.counterAttackBias > 0.35 && ballLocalX < 18) {
      mode = 'CounterAttack';
    } else if (ballLocalX > 4) {
      mode = 'Attack';
    } else {
      mode = 'BuildUp';
    }
  } else if (possession === 1 - team.side) {
    // Press appetite: gene + where the ball is (pressing high is more attractive)
    // + hysteresis so the mode doesn't flicker.
    const ballLocalX = team.localX(ball.pos.x);
    // The captain steadies the switch (Phase 39): with the cool head on
    // the pitch, hysteresis is stronger — the team commits to its mode.
    const steady =
      team.captain >= 0 && !team.players[team.captain].sentOff ? 0.04 : 0;
    // THE TRANSITION WINDOW (Phase 112): the 3 seconds after LOSING the
    // ball — the mirror of CounterAttack on the same possession clock.
    // A gegenpress side flips into Press the instant it loses possession;
    // a drop-and-recover side refuses the window and falls into Defend
    // even if its steady-state press would fire. 0.5 = no term at all.
    const sinceLoss = match.simTime - match.teams[1 - team.side].possessionGainedAt;
    const tp = ((g.transitionPress ?? 0.5) - 0.5) * 2;
    const pressScore =
      g.pressIntensity +
      (ballLocalX > 0 ? 0.18 : -0.1) +
      (prevMode === 'Press' ? 0.08 + steady : prevMode === 'Defend' ? -steady : 0) +
      (match.derby ? 0.04 : 0) + // derbies bite (Phase 40)
      (sinceLoss < 3.0 ? tp * 0.22 : 0);
    mode = pressScore > 0.62 ? 'Press' : 'Defend';
  } else {
    // Loose ball: keep the previous shape decision (brief window anyway).
    mode = prevMode === 'ResetShape' ? 'Defend' : prevMode;
  }

  team.modeTime = mode === prevMode ? team.modeTime : 0;
  team.mode = mode;

  assignChasers(team, match);
  assignMarks(team, match);
  assignRunners(team, match);
}

/**
 * Runners: 1–2 attackers licensed to sprint in behind the defensive line
 * while we have the ball — the off-ball movement that makes through balls
 * possible. Capped like chasers so the team never dissolves into everyone
 * running; the carrier and keeper are never runners.
 */
/**
 * ⭐⭐ DS T0 — EXPORTED, NOT RE-TYPED (docs/world-model/DS-T0-OWN-RUN-SEAM.md §LAW; contract
 * DS-DESIGNATION-CONTRACT.md §2 M-DS.2; ruling #405 item 3(ii)). This object IS the coach's
 * own ranking of who should run; DS-T0's player-side prior is that same ranking moved to the
 * player. EXPORTED so `PlayerBrain` reads the SAME numbers — the CTB-T0 `SUPPORT_LAT_PULL`
 * precedent (the same numbers, given a home). ⛔ They are never re-typed anywhere; a source
 * pin in `tests/dsOwnRun.test.ts` kills the mutant that types `2.2`.
 */
export const RUN_ROLE_W: Record<Role, number> = { GK: 0, DF: 0.4, MF: 1.2, WG: 1.8, ST: 2.2 };
/**
 * ⭐ DS T0 — THE DESIGNATION'S OWN DEPTH DIVISOR, given a home (M-DS.2). The `/ 45` in the
 * runner-scoring expression below is the coach's own conversion from metres of local X into
 * role-weight units, and DS-T0's prior uses the SAME divisor. NO NEW NUMBER: the shipped
 * expression's bytes are untouched, and a source pin asserts its literal still equals this.
 */
export const RUN_DEPTH_DIV = 45;
/**
 * ⭐⭐ DS T0 — THE PRIOR'S MAXIMUM, DERIVED IN CODE (#202: no new constant). It is
 * `max(RUN_ROLE_W) + HALF_L / RUN_DEPTH_DIV`: the value the coach's own ranking expression
 * takes for the highest-weighted role standing on the OPPONENT'S GOAL LINE. The maximum is
 * read OFF THE OBJECT with `Math.max`, never typed. Dividing the ranking by this makes the
 * prior a [0,1] quantity whose 1 is a REAL, REACHABLE state of the pitch, not a chosen scale.
 */
export const RUN_PRIOR_MAX = Math.max(...Object.values(RUN_ROLE_W)) + HALF_L / RUN_DEPTH_DIV;

/**
 * ⭐⭐⭐ DS T0c §LAW-C — THE COACH'S OWN RANKING, CODE-MOVED (docs/world-model/DS-T0-OWN-RUN-SEAM.md
 * §LAW-C; contract DS-DESIGNATION-CONTRACT.md §2 M-DS.6″(a); ruling #409 item 4(i)).
 *
 * ⭐ THE SAME EXPRESSION, IN ONE PLACE. `assignRunners`' runner scoring below used to carry
 * `RUN_ROLE_W[p.role] + team.localX(p.pos.x) / 45` inline; that `.map` now CALLS this function,
 * so the coach's ranking expression — and the `/ 45` DS-T0 gave a home to — exists exactly ONCE
 * in `src/**`. The arithmetic is identical (`RUN_DEPTH_DIV` IS 45), which G-OFF measures byte
 * for byte, and DS-T0's two-copy drift pin retires POSITIVELY (§DEVIATIONS-C).
 *
 * ⛔ NO NEW NUMBER: the role weights are `RUN_ROLE_W`'s own bytes and the divisor is
 * `RUN_DEPTH_DIV`'s. It is the ranking the coach SORTS by, and DS-T0c's player-side
 * `rankAbove` is that same ranking read over the mates his own eyes hold.
 *
 * PURE: a function of (role, local X) and nothing else. It reads no `match`, no board, no
 * percept — the caller supplies the local X, so `team.attackDir` stays the caller's read.
 */
export function runRank(role: Role, localX: number): number {
  return RUN_ROLE_W[role] + localX / RUN_DEPTH_DIV;
}

/**
 * ⭐⭐⭐ DS T0b §LAW-B — THE COACH'S COUNT, CODE-MOVED (docs/world-model/DS-T0-OWN-RUN-SEAM.md
 * §LAW-B; contract DS-DESIGNATION-CONTRACT.md §2 M-DS.6(a); ruling #407 item 5(i)).
 *
 * ⭐ THE SAME EXPRESSION, NEVER RE-TYPED. This function's `return` carries `assignRunners`'
 * OWN count expression byte-for-byte with its receiver prefixes (`team.` / `team.genome.` /
 * `team.mentality.`) stripped — the ONLY transformation, and a source pin in
 * `tests/dsOwnRun.test.ts` applies exactly that strip to the expression RECORDED at the
 * dispatch head `b05d3d9` and asserts the two agree. The shipped call site below now CALLS
 * this function; nothing else about the designation moves.
 *
 * WHY IT MOVES: DS-T1 measured the flood (`r1.runsPerInPossessionTick` 0.584786 → 1.832816
 * with the coach's hats off) and ruling #407 item 4 read the cause at source — the restraint
 * on HOW MANY go was this count, and the player-side law had none. Moving it makes it the
 * player's **共同 prior** on how many should go (VISION §1), exactly as `RUN_ROLE_W` became his
 * prior on WHO should go. ⛔ NO NEW NUMBER: 0.65, 0.65, the 2/1 and the 1/0 are the coach's
 * own hand-written literals, moved, and they are DECLARED as such (the `RUN_ROLE_W`
 * precedent). Its inner comparisons are the coach's expression moved whole — they are not a
 * new predicate on a football quantity (#200), and the seam doc says so in the same words.
 *
 * PURE: a function of (team mode, genome tempo, mentality urgency) and nothing else. It reads
 * no `match`, no board, no percept.
 */
export function runnerCount(mode: TeamMode, tempo: number, urgency: number): number {
  return (mode === 'CounterAttack' || tempo > 0.65 ? 2 : 1)
    + (urgency > 0.65 ? 1 : 0);
}

function assignRunners(team: Team, match: Match): void {
  team.runners.clear();
  team.arriver = null;
  // The overlap license survives its own release ball's FLIGHT (the corner
  // lesson, 31.9): the kick clears ball.owner, and a license torn up at
  // that instant strands the runner — and the arriving ball — mid-flight.
  const keepOverlap =
    team.overlapper !== null &&
    match.pendingPass !== null &&
    match.pendingPass.side === team.side &&
    match.pendingPass.targetGid === team.players[team.overlapper].gid;
  if (!keepOverlap) team.overlapper = null;
  if (match.possessionSide !== team.side) return;
  const carrier = match.ball.owner;
  // Corner (Phase 28): flood the box — the three best headers of the ball
  // (aerial sense lives with the DFs and the ST) attack the area while the
  // taker walks over, so the cross has someone to find. The licenses hold
  // THROUGH the hand-off and the flight (Phase 31.9, team.cornerCrash):
  // the restart clears before the kick, and re-licensing generically at
  // that instant pulled every crasher out of the box mid-delivery.
  const liveCorner = match.phase === 'restart' && match.restart?.kind === 'corner' && match.restart.side === team.side;
  const heldCrash = !liveCorner && team.cornerCrash !== null && match.simTime < team.cornerCrash.until;
  if (team.cornerCrash && match.simTime >= team.cornerCrash.until) team.cornerCrash = null;
  if (heldCrash) {
    // Personnel locked at hand-off (31.9): re-scoring here swapped crashers
    // for whoever happened to stand better mid-flight (once the weak-side
    // winger 27m away) and remapped every crash spot under their feet.
    for (const idx of team.cornerCrash!.runners) {
      if (!team.players[idx].sentOff && team.players[idx] !== carrier) team.runners.add(idx);
    }
    const arr = team.cornerCrash!.arriver;
    if (arr !== null && !team.players[arr].sentOff && team.players[arr] !== carrier) team.arriver = arr;
    return;
  }
  if (liveCorner) {
    // Aerial sense × REACHABILITY (Phase 31): the DF is the best header in
    // the game, but the rest-defence clamp parks him ~50m away — a licensed
    // crasher who cannot arrive leaves the primary zone empty (the trace
    // that cracked the 0%-duel-wins corner: the best spots had nobody).
    const flag = match.restart!.pos;
    const routine = match.restart!.routine;
    const takerGid = match.restart!.takerGid;
    // Short/arc routines trade a crasher for the receiver (Phase 31): on a
    // five-outfielder team, three crashers plus the taker leave exactly ONE
    // arriver candidate — usually the worst-placed body on the pitch, and
    // the routine's whole target zone went unattended (probed: the "short"
    // corner crossed 30/30 because the short receiver stood 40m away).
    const crashCount = routine === 'short' || routine === 'arcCutback' ? 2 : 3;
    const scored = team.players
      .filter((p) => p.role !== 'GK' && p.gid !== takerGid && p !== carrier && !p.sentOff)
      .map((p) => ({ p, s: aerialSense(p) - dist(p.pos, flag) / 45 }))
      .sort((a, b) => b.s - a.s || a.p.index - b.p.index);
    for (const { p } of scored.slice(0, crashCount)) team.runners.add(p.index);
    // Routine extra license (Phase 31): the SHORT receiver or the ARC
    // arriver — one more purposeful body, routed by the executor to the
    // routine's key zone. Crash spots for the runners come from the
    // routine's table (executor, cornerCrashSpots).
    if (routine === 'short' || routine === 'arcCutback') {
      const zone = cornerKeyZone(routine, team.attackDir, flag.y);
      let pick: Player | null = null;
      let bd = Infinity;
      for (const p of team.players) {
        if (p.role === 'GK' || p.sentOff || p.gid === takerGid || p === carrier) continue;
        if (team.runners.has(p.index)) continue;
        const d = dist(p.pos, zone);
        if (d < bd) {
          bd = d;
          pick = p;
        }
      }
      if (pick) team.arriver = pick.index;
    }
    return;
  }
  // C4 T2-ARRIVAL: the same hold, for an open-play cross in flight. Placed
  // AFTER the corner paths so a corner always wins its own personnel. The
  // licence is re-asserted from the kick's snapshot rather than re-scored, for
  // 31.9's reason verbatim — re-scoring mid-flight swaps bodies under the
  // delivery. The arriver is the one that matters: `assignRunners` clears him
  // every tick and re-licenses only while the ball is in the WIDE channel,
  // which a ball flying into the box has already left.
  const cf = team.crossFlight;
  if (cf !== null && match.simTime >= cf.until) team.crossFlight = null;
  else if (cf !== null && match.ball.owner === null) {
    for (const idx of cf.runners) {
      if (!team.players[idx].sentOff) team.runners.add(idx);
    }
    if (cf.arriver !== null && !team.players[cf.arriver].sentOff) team.arriver = cf.arriver;
    return;
  }

  // A second runner for fast/direct sides: counters and high-tempo teams.
  // The late chase (Phase 35) throws one MORE body forward — this is where
  // "everyone forward" physically lives, and where the counters it
  // concedes are born (the chase must cost).
  // ⭐⭐ DS T0 — THE HATS-OFF ARM, GATE 1 of 2 (docs/world-model/DS-T0-OWN-RUN-SEAM.md §SEAM;
  // contract §2 M-DS.4; ruling #405 item 3(iv)). DORMANT (Road B). The bypass is PURELY
  // ADDITIVE in the DF-T4 sense: the statements inside are never deleted, reordered or
  // reworded, and with `dsHatsOff` absent — which it is in EVERY production path — the gate
  // is `!false` and every one of them runs exactly as it shipped. Armed, the OPEN-PLAY
  // runner scoring does not run at all, so `team.runners` stays as `clear()` left it and the
  // 前插 licence is simply not issued. ⛔ SLICE ONE IS 前插 ONLY: the held corner crash, the
  // live corner and the cross-flight branches have already RETURNED above; the 套边 block
  // and the wall-pass trigger below are untouched committed licences (DS-T2).
  if (!match.dsHatsOff) {
    // ⭐⭐ DS T0b — THE CALL SITE OF THE CODE-MOVED COUNT (M-DS.6(a)). The expression that
    // stood here is now `runnerCount`'s own `return`, byte-for-byte with its receiver
    // prefixes stripped; the arithmetic is identical and G-OFF measures it.
    const count = runnerCount(team.mode, team.genome.tempo, team.mentality.urgency);
    const scored = team.players
      .filter((p) => p.role !== 'GK' && p !== carrier && !p.sentOff)
      // ⭐⭐ DS T0c — THE CALL SITE OF THE CODE-MOVED RANKING (M-DS.6″(a)). The expression
      // that stood here is now `runRank`'s own `return`; the arithmetic is identical
      // (`RUN_DEPTH_DIV` is the same 45) and G-OFF measures it.
      .map((p) => ({ p, s: runRank(p.role, team.localX(p.pos.x)) }))
      .sort((a, b) => b.s - a.s || a.p.index - b.p.index);
    for (const { p } of scored.slice(0, count)) team.runners.add(p.index);
  }

  // The ARRIVING runner (Phase 31): ball deep and wide in the attacking
  // third — license ONE late body onto the edge-of-box arc so the byline
  // cutback has someone to find. The MF is the natural arriver (the late
  // midfield run is football's canonical cutback target); the weak-side
  // winger stands in when the MF is the carrier, gone, or already running.
  // ⭐⭐ DS T0 — THE HATS-OFF ARM, GATE 2 of 2 (M-DS.4). Same law, same dormancy: armed, the
  // OPEN-PLAY arriver is never picked and `team.arriver` stays null. The corner paths' own
  // arriver picks are ABOVE and already returned; nothing here touches them.
  if (!match.dsHatsOff) {
    const ballPos = match.ball.pos;
    const ballLocalX = team.localX(ballPos.x);
    // Trigger EARLY (ball entering the wide attacking channel, not already at
    // the byline) so the arriver's late run is underway by the time the
    // carrier reaches the pull-back zone — an arriver licensed at the byline
    // arrives after the moment has gone (failure mode 14: check who's
    // attacking the delivery before tuning the delivery).
    if (ballLocalX > HALF_L - 21 && Math.abs(ballPos.y) > 10) {
      const eligible = (p: Player | undefined): p is Player =>
        p !== undefined && p !== carrier && !p.sentOff && !team.runners.has(p.index);
      const mf = team.players[2];
      const weakWG = ballPos.y > 0 ? team.players[3] : team.players[4];
      const pick = eligible(mf) ? mf : eligible(weakWG) ? weakWG : null;
      if (pick) team.arriver = pick.index;
    }
  }

  // ⭐⭐⭐ DS T0d — 「配合帽子 · 开关」 THE COOPERATION HATS' SWITCH, GATE 1 of 2
  // (docs/world-model/DS-T0-OWN-RUN-SEAM.md §SWITCH-D; contract DS-DESIGNATION-CONTRACT.md §2
  // M-DS.8; ruling #412 item 5(ii)). DORMANT (Road B) — armed by NO world and NO preset.
  // The bypass is PURELY ADDITIVE in the DF-T4 sense: not one shipped statement below is
  // deleted, reordered or reworded — they are RE-INDENTED by two spaces and nothing else
  // (§DEVIATIONS-D) — and with `dsCoopHatsOff` absent, which it is in EVERY production path,
  // the gate is `!false` and every one of them runs exactly as it shipped. Armed, the 套边
  // designation is never issued: `team.overlapper` is never set, so the player-side overlap
  // run and the passer's 套边 release bonus have no input to read. That unreachability is a
  // MEASURED consequence (the pins in `tests/dsCoopHatsOff.test.ts`), never an edit.
  // ⛔ The flight-preserving `keepOverlap` statement stays ABOVE this gate, byte-untouched —
  // with nothing ever set there is nothing for it to keep. The held corner crash, the live
  // corner and the cross-flight branches, and `dsHatsOff`'s two gates, are UNTOUCHED.
  if (!match.dsCoopHatsOff) {
    // 套边 (Phase 34): a WIDE carrier confronted in the attacking half pulls
    // one trailing teammate around the OUTSIDE. Wide-play genes look for it;
    // narrow sides leave the lane to the carrier's own drive.
    if (
      team.overlapper === null && // a flight-preserved license stands
      carrier &&
      carrier.role !== 'GK' &&
      Math.abs(carrier.pos.y) > 10 &&
      team.localX(carrier.pos.x) > 0 &&
      // Width gene × the evolved overlap appetite (Phase 45) crosses the gate.
      team.genome.attackingWidth * team.policy.overlapW > 0.3
    ) {
      const cLocal = team.localX(carrier.pos.x);
      const confronted = match.teams[1 - team.side].players.some(
        (o) =>
          !o.sentOff &&
          dist(o.pos, carrier.pos) < 5.5 &&
          match.teams[1 - team.side].localX(o.pos.x) < match.teams[1 - team.side].localX(carrier.pos.x) + 0.5,
      );
      if (confronted) {
        let pick: Player | null = null;
        let bd = Infinity;
        for (const p of team.players) {
          if (p.role === 'GK' || p === carrier || p.sentOff) continue;
          if (team.runners.has(p.index) || team.arriver === p.index || p.stamina < 0.3) continue;
          // Same wing (or central enough to swing out); trailing but reachable.
          if (Math.sign(p.pos.y) !== Math.sign(carrier.pos.y) && Math.abs(p.pos.y) > 8) continue;
          const behind = cLocal - team.localX(p.pos.x);
          if (behind < 1 || behind > 24) continue;
          const d = dist(p.pos, carrier.pos);
          if (d < bd) {
            bd = d;
            pick = p;
          }
        }
        if (pick) team.overlapper = pick.index;
      }
    }
  }
}

/**
 * Corner routine choice (Phase 31): once the defensive picture forms
 * (~0.6s into the setup), the taking side reads the openness of each
 * routine's KEY zone and commits. Deterministic — pure state, fixed
 * iteration order, strict improvement. The short option is discounted:
 * it's the pressure valve when the box is packed, not the default.
 */
export function pickCornerRoutine(match: Match, r: RestartState): CornerRoutine {
  const team = match.teams[r.side];
  const defenders = match.teams[1 - r.side].players;
  const order: CornerRoutine[] = ['farPost', 'nearPost', 'arcCutback', 'short'];
  let best: CornerRoutine = 'farPost';
  let bestScore = -Infinity;
  for (const routine of order) {
    const zone = cornerKeyZone(routine, team.attackDir, r.pos.y);
    let nearest = Infinity;
    for (const d of defenders) {
      if (d.sentOff || d.role === 'GK') continue;
      const dd = dist(d.pos, zone);
      if (dd < nearest) nearest = dd;
    }
    let score = Math.min(nearest, 10) / 10;
    if (routine === 'short') score *= 0.55;
    // The arc strike is the best-converting routine (probed: ~2× the post
    // deliveries) — when its zone is comparably open, take it.
    if (routine === 'arcCutback') score += 0.08;
    if (score > bestScore) {
      bestScore = score;
      best = routine;
    }
  }
  return best;
}

/**
 * Chasers: outfield players allowed to hunt the ball. Everyone else keeps
 * shape/marks. Count scales with pressing: 1 base, +1 in Press mode, +1 for
 * extreme pressIntensity.
 */
function assignChasers(team: Team, match: Match): void {
  team.chasers.clear();
  const possession = match.possessionSide;
  const weOwn = possession === team.side;
  if (weOwn) {
    // No chasing our own CARRIER — but a LOOSE ball is ours to contest
    // too (36.2, user report "有人去抢球,其他人呆住了"): possession is
    // sticky, so after a squirt/miscontrol/knockdown the nominal owners
    // never sent a body and the 50/50 was a one-team race. One nearest
    // man goes; designed balls stay untouched (the dribble toucher
    // already chases his own push, a pass in flight belongs to its
    // receiver, restarts have a taker).
    if (
      match.ball.owner === null &&
      match.dribbleTouch === null &&
      !(match.pendingPass !== null && match.pendingPass.side === team.side) &&
      match.phase === 'playing'
    ) {
      let best: Player | null = null;
      let bd = Infinity;
      for (const p of team.players) {
        if (p.role === 'GK' || p.sentOff) continue;
        const d = dist(p.pos, match.ball.pos);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best) team.chasers.add(best.index);
    }
    return;
  }
  // The opposing keeper has it in their HANDS (Phase 28.1 → 29.1): they are
  // unchallengeable, so pressing is wasted legs. 28.1 kept ONE shadow at the
  // bubble's edge to cut the short outlet — live play read it as a man
  // camped in the keeper's face (reported twice), so now NOBODY presses a
  // held ball: everyone marks up for the distribution, like a goal kick.
  const owner = match.ball.owner;
  // gkDistributing too (31.9): the shape-wait's 0.25s re-arm quanta left
  // timer==0 gaps where a chaser got assigned, charged, and was expelled
  // when the hold re-armed — the "疯狂抽动逼抢" flicker.
  const gkHolding = owner !== null && owner.role === 'GK' && (owner.gkHoldTimer > 0 || owner.gkDistributing);

  let count = 1;
  if (gkHolding) {
    count = 0;
  } else {
    // One presser, two for a pressing side — NEVER three (Phase 31, user
    // report): real football sends one or two at the ball; everyone else
    // marks or holds the shape. The extreme-pressIntensity third chaser
    // stacked onto Press mode just re-created the swarm.
    if (team.mode === 'Press' || team.genome.pressIntensity > 0.78) count += 1;
    // ⭐⭐ DF T4 — THE CAP-OFF ARM (docs/world-model/DF-T4-CAP-OFF-TRIAL.md; contract
    // DF-DEFENSIVE-BRAIN-CONTRACT.md §2 M-DF.2 "the cap-off arm proves the surface alone
    // holds the band"; ruling #336 item 5). DORMANT (Road B). THE BYPASS IS PURELY
    // ADDITIVE: the shipped line above is never deleted, moved or reworded — with
    // `dfCapOff` off this statement is dead and the count is the Phase-31 count, byte for
    // byte. Armed, it restores the SHIPPED SCORING'S OWN ADDITIVE FORM — this function's
    // own docblock arithmetic, "1 base, +1 in Press mode, +1 for extreme pressIntensity"
    // — which the Phase-31 rule collapsed into an OR. So the extra body appears only
    // where the shipped scoring ALREADY wanted him and the cap alone said no.
    if (match.dfCapOff && team.mode === 'Press' && team.genome.pressIntensity > 0.78) count += 1;
    // Loose ball = a DUEL, not a scrum (Phase 30.5): one contester per team.
    // At 2 per team every midfield 50/50 pulled four sprinters plus the
    // support/marking crowd already there, and the won-tackle squirt re-fed
    // the same pile — the reported "乱成一锅粥" loop.
    if (possession === -1) count = Math.min(count, 1);
    // THE TRANSITION WINDOW (Phase 112): for 3s after losing the ball a
    // gegenpress side throws ONE extra body at it — a deliberate, window-
    // bounded exception to the phase-31 "never three" rule (the standing
    // swarm it banned was permanent; the counter-press IS the momentary
    // swarm, and it expires with the window). A drop-and-recover side
    // refuses even its steady-state second presser until the shape is
    // home. 0.5 leaves the phase-31 counts untouched.
    if (match.phase === 'playing') {
      const sinceLoss = match.simTime - match.teams[1 - team.side].possessionGainedAt;
      if (sinceLoss < 3.0) {
        const tp = ((team.genome.transitionPress ?? 0.5) - 0.5) * 2;
        // DF T4: a READ-ONLY capture of the pre-window count, so the bypass below can
        // re-add the window's body without the ceiling. It changes no behaviour.
        const beforeWindow = count;
        if (tp > 0.3) count = Math.min(count + 1, 3);
        else if (tp < -0.3) count = Math.min(count, 1);
        // ⭐⭐ DF T4 (dormant): the `Math.min(…, 3)` the line above applies IS the Phase-31
        // "never three" rule reasserted inside the window — this block's own comment says
        // so. With the cap retired in the arm the window's ONE extra body is added without
        // that ceiling; the shipped statements above stay exactly as they are, and with the
        // flag off this statement never runs.
        if (match.dfCapOff && tp > 0.3) count = beforeWindow + 1;
      }
    }
  }
  // Dead ball (Phase 28.3): you can't win a ball nobody may touch — ONE
  // player closes the taker down (blocking the short option, real-football
  // style); the old pack of 2–3 stood pinned at the corner-flag clearance
  // circle jogging on the spot. Goal kicks (Phase 29): ZERO — the taker is
  // the keeper deep in their own box; charging them is pure wasted legs,
  // so everyone marks up for the distribution instead.
  if (match.phase === 'restart') count = match.restart?.kind === 'goalKick' ? 0 : 1;

  const outfield = team.players.filter((p) => p.role !== 'GK' && !p.sentOff);
  // ATTACK THE DROP (Phase 32.1, user report "大脚高球也应该能被解围"): an
  // opponent's lofted delivery in flight is chased at its LANDING, by
  // whoever gets there fastest — long balls aim at open men by design, so
  // the by-current-ball-distance pick sent a presser who could never
  // arrive (probed: nearest defender averaged 7.6m off the descent, 5%
  // aerial contests, and the hoof was uncontestable in practice).
  // interceptBall already projects the parabola; the chaser just needed
  // to be the right man.
  const pass = match.pendingPass;
  const ball = match.ball;
  if (
    count > 0 && pass && pass.side !== team.side && ball.owner === null &&
    (ball.z > 0.5 || ball.vz > 2)
  ) {
    const land = ballLanding(ball);
    // LONG hoofs into open field only: an unscoped first cut attacked the
    // landing of every cross, corner and chip too — one extra converging
    // defender on every box delivery re-buried the 31.9 headed game and
    // cost 0.77 goals/match at n=568. Box landings belong to the marking
    // scheme; short chips to the through-ball economy.
    const flight = Math.hypot(ball.vel.x, ball.vel.y) * land.t;
    const inOurBox =
      Math.abs(land.y) < BOX_WIDTH / 2 && team.localX(land.x) < -(HALF_L - BOX_DEPTH);
    if (flight > 12 && !inOurBox) {
      let best: Player | null = null;
      let bestT = Infinity;
      for (const p of outfield) {
        const t = dist(p.pos, land) / Math.max(p.topSpeed, 0.1);
        if (t < bestT) {
          bestT = t;
          best = p;
        }
      }
      if (best) {
        team.chasers.add(best.index);
        return;
      }
    }
  }
  const byDist = [...outfield].sort(
    (a, b) => dist(a.pos, match.ball.pos) - dist(b.pos, match.ball.pos) || a.index - b.index,
  );
  for (const p of byDist.slice(0, count)) team.chasers.add(p.index);
}

/**
 * Marks: each non-chasing outfielder picks the most dangerous unmarked
 * opponent (deepest into our half) within range. Greedy and deterministic.
 *
 * Marking SCHEME (Phase 30, `team.style.scheme`): 'man' marks every ranged
 * threat (the behavior every phase before 30 shipped with); 'zonal' marks a
 * threat only when it ENTERS A DEFENDER'S ZONE (near that defender's
 * defending spot) or our penalty box. Zone defenders otherwise hold the
 * sliding spots — and crucially, engaging a zone runner drags its defender
 * OFF the spot lattice, which is how attacks open a zone up (a first cut
 * that never engaged parked an impenetrable 5-body wall: 3 shots/match
 * conceded, and the league's shot volume collapsed).
 *
 * ⭐⭐ DF T0 — ASSIGNMENT PERSISTENCE (dormant behind `match.dfAssignPersist`; contract
 * DF-DEFENSIVE-BRAIN-CONTRACT.md §2 M-DF.1/M-DF.2, ruling #322 item 2). The clear-then-
 * re-greedy above is the MEASURED mechanism of 乱跑 (DF-C0 §R2: 16.1267 mark-switches per
 * defender-minute — a new man every ~3.7 s — 28.31 % accidental double-marking, 63.29 %
 * coverage, 1.0576 s re-target latency). With the door open the ledger SURVIVES the pass:
 * the greedy runs only for the men nobody holds, and 「change my man」 must OUTPRICE
 * 「keep my man」 on the L3 access-time slack the stance line already computes. Door SHUT
 * ⇒ `team.marks` is cleared exactly as before, `heldMen`/`heldTarget` stay empty and
 * `mayLeaveMark` is false for every body ⇒ this function is the shipped one, statement for
 * statement. `assignChasers` and the Phase-31 presser cap are NOT touched by this seam.
 */
function assignMarks(team: Team, match: Match): void {
  // DF T0 DEATH CONDITION (1) — POSSESSION: we have the ball, so nobody marks and every
  // assignment dies. (Door shut this is verbatim the shipped clear-then-return; the other
  // shipped clears — the non-playing phase at the top of `updateTeamBrain`, half-time /
  // kickoff in `Match.resetForKickoff`, and the send-off pruning in both directions — are
  // DEATH CONDITIONS (2) and (3) and are left exactly as they are.)
  if (match.possessionSide === team.side) {
    team.marks.clear();
    return;
  }
  if (!match.dfAssignPersist) team.marks.clear();

  const zonal = team.style.scheme === 'zonal';
  const opp = match.teams[1 - team.side];
  const carrier = match.ball.owner;
  // Sort by how deep they are in OUR half: smaller localX for them = deeper
  // for us. (A numerically identical pre-sort used to run first; this
  // comparator is a total order — index tiebreak — so one sort decides fully.)
  // The restart taker is not a threat (Phase 29.1): they're pinned to a dead
  // ball the clearance circle already guards, and the assigned chaser blocks
  // the short option — a marker sent there too made TWO men stand uselessly
  // at the corner flag while the box went a body short.
  const takerGid = match.restart?.takerGid;
  const inOurBox = (x: number, y: number): boolean =>
    team.localX(x) < -HALF_L + BOX_DEPTH && Math.abs(y) < BOX_WIDTH / 2;
  const threats = opp.players
    .filter((o) => o.role !== 'GK' && o !== carrier && !o.sentOff && o.gid !== takerGid)
    .sort((a, b) => opp.localX(b.pos.x) - opp.localX(a.pos.x) || a.index - b.index);

  const free = team.players.filter((p) => p.role !== 'GK' && !team.chasers.has(p.index) && !p.sentOff);
  // Zonal: each free defender's zone is centered on their DEFENDING spot.
  const zones = zonal ? new Map(free.map((p) => [p.index, formationSpot(p, team, match.ball, false, match.teams[1 - team.side])])) : null;
  const used = new Set<number>();
  /**
   * ⭐ THE ONE ACCOUNT CALL IN THIS FILE — the shipped L3 access-time account, invoked with
   * the stance line's OWN argument tuple. DF-T0 called it for the INCUMBENT man only; DF-T2
   * puts the SAME account on BOTH sides of the scale (incumbent and candidate), which is the
   * whole of the surface's pricing extension. Output: METRES OF RECOVERABLE SLACK, capped at
   * the account's own frozen ceiling (the λ_LIN idiom — the expressible region of the shipped
   * seam, capped at its edge, no new magnitude invented).
   */
  const slackMetres = (man: Player, p: Player): number => {
    const budget = markSagMetres(match.ball.pos, man.pos, p.pos, p.topSpeed);
    return budget;
  };
  // ── DF T0 §THE SURVIVOR PASS ────────────────────────────────────────────────────────
  // The assignments that live through this pass, re-seeded into the ledger in ASCENDING
  // MARKER INDEX (a total order, so the ledger's own iteration order is a function of state
  // alone). An assignment survives iff BOTH bodies are still eligible for this pass —
  // DEATH CONDITION (4): the marker is now a chaser or sent off (not in `free`);
  // DEATH CONDITION (5): the man is now the carrier, the restart taker, sent off or a
  // keeper (not in `threats`); DEATH CONDITION (6): a lower-index marker already holds
  // him (the aliasing guard — the ledger stays injective) — AND
  // DEATH CONDITION (7), THE ACCOUNT'S OWN CEILING: he is still within `MARK_SAG_MAX`
  // metres, which is the engine's own answer to how far off his man a marker may stand and
  // still be marking him (`src/evolution/genome.ts`: the traced zonal engagement radius,
  // the same 9 the `zonalEngageRadius9` rule below spends). No new constant, and strictly
  // tighter than the shipped 22 m creation range — so a survivor is never a pairing the
  // greedy could not have made on range grounds.
  const heldMen = new Set<number>();
  const heldTarget = new Map<number, number>();
  if (match.dfAssignPersist) {
    const eligible = new Set(free.map((p) => p.index));
    const alive = new Set(threats.map((o) => o.index));
    for (const ownIdx of [...team.marks.keys()].sort((a, b) => a - b)) {
      const tgtIdx = team.marks.get(ownIdx)!;
      const holder = team.players[ownIdx];
      const man = opp.players[tgtIdx];
      if (holder === undefined || man === undefined) continue;
      if (!eligible.has(ownIdx) || !alive.has(tgtIdx) || heldMen.has(tgtIdx)) continue;
      if (dist(holder.pos, man.pos) > MARK_SAG_MAX) continue;
      heldMen.add(tgtIdx);
      heldTarget.set(ownIdx, tgtIdx);
    }
    team.marks.clear();
    for (const [ownIdx, tgtIdx] of heldTarget) {
      team.marks.set(ownIdx, tgtIdx);
      used.add(ownIdx);
    }
  }
  /**
   * ⭐⭐ DF T0 §THE SWITCH PRICE — 「change my man」 vs 「keep my man」, DERIVED, never a
   * taste constant (M-DF.1, the #200 red line). A body that HOLDS a man leaves him only
   * when the new man is closer by MORE than the slack the SHIPPED L3 access-time account
   * already grants his current pairing:
   *
   *   leave  ⇔  dist(me, newMan) + markSagMetres(ball, myMan, me, topSpeed) < dist(me, myMan)
   *
   * `markSagMetres` is the account itself, called with the stance line's OWN argument
   * tuple — `markSagMetres(ball.pos, mark.pos, p.pos, p.topSpeed)` at
   * `src/ai/actionExecutor.ts` (the `l3SagSeam` rule). Its output is metres of RECOVERABLE
   * SLACK, so it prices metres of greed directly and inherits its own frozen ceiling
   * (`MARK_SAG_MAX`); the λ_LIN idiom, cap at the shipped region's edge. Where the ball is
   * arriving faster than the marker can reach his man (slack ≤ 0 — every cross into the
   * box) the budget is 0 and nearest-first decides exactly as it does today, so the tight
   * moments keep the shipped freedom and only the idle ones buy loyalty. The gene weight
   * `markSag` is deliberately NOT read here: the ASSIGNMENT price is the account's raw
   * geometry, while the STANCE keeps its own gene channel untouched.
   */
  const mayLeaveMark = (p: Player, threat: Player): boolean => {
    const cur = heldTarget.get(p.index);
    if (cur === undefined) return false; // a fresh pick never moves inside the same pass
    const man = opp.players[cur];
    if (man === undefined) return false;
    const budget = slackMetres(man, p);
    // ⭐⭐ DF T2 §COMPOSITION, EXACT: with the surface SHUT this is DF-T0's frozen predicate,
    // term for term. With the surface ARMED the candidate is priced on the SAME account the
    // incumbent is (`− slackMetres(threat, p)`), because the surface's whole claim is that a
    // man you can reach before the ball is worth more than a man you cannot — DF-T0 could
    // only price the incumbent's side of that scale.
    if (!match.dfSurface) return dist(p.pos, threat.pos) + budget < dist(p.pos, man.pos);
    return dist(p.pos, threat.pos) - slackMetres(threat, p) < dist(p.pos, man.pos) - budget;
  };
  /**
   * ⭐⭐ DF T2 §THE PRESS ELECTION — 「不盯自己的人去干持球人」, priced, in the ONE currency.
   *
   * Every option is priced in METRES OF NET ACCESS — the distance to the body I would take
   * responsibility for, MINUS the metres of recoverable slack the shipped L3 account grants
   * me on him. Lower is better; the argmin decides. PRESS's price is `dist(me, carrier)`
   * UNDISCOUNTED, and that is the account pricing itself, not a carve-out: the ball is AT the
   * carrier's feet, so `t_ball ≈ 0 ⇒ slack < 0 ⇒ zero sag` (the same self-pricing MT-T0's
   * contain case documents). Going at the ball buys you no head start; that is exactly what
   * makes it expensive.
   *
   * ⚠ HONEST OPTION SCOPE (M-DF.1 stated-not-hidden). The seat's whole vocabulary is the
   * mark ledger, so PRESS's EXECUTABLE form is the ABSENCE of an assignment: the surface
   * OFFERS the body to the shipped Phase-29.1 contain branch and to nothing else. It cannot
   * make him press — that branch's own gates (the goal-side test, the ONE-container rule)
   * are untouched and still decide — and when they refuse him he holds the shipped block.
   * `assignChasers` and the Phase-31 presser cap are never read, written or consulted here
   * (M-DF.2: two compensators never move in one slice).
   *
   * ⚠ THE BOOK'S VETO IS DECLINE-ONLY (M-L3.3's discipline, inherited verbatim): a team's own
   * defence book can REMOVE the press option for a body arriving in a group its own
   * experience says gets punished — it can never create one, and there is no branch on which
   * a belief makes pressing MORE likely. A wrong book therefore costs patience, never
   * recklessness. The book is READ, not consumed: `l3DefenceDeclines`'s veto counter is the
   * lunge seam's own receipt and is deliberately left alone.
   */
  const vacated = new Set<number>();
  if (match.dfSurface) {
    const ledger = match.dfSurfaceLedger;
    const book = match.l3Defence === null ? null : match.l3Defence.books[team.side];
    const ownGoal = team.ownGoal();
    const carrierGoalD = carrier === null ? Infinity : dist(carrier.pos, ownGoal);
    for (const p of free) {
      if (carrier === null) break;
      // the shipped contain branch's OWN geometric preconditions, by anchored extraction.
      // (Its 「closest unassigned goal-side defender」 clause depends on the ledger this pass
      // is still writing, so it is NOT re-implemented here — it stays where it lives and
      // still settles who actually contains.)
      if (dist(p.pos, carrier.pos) >= CONTAIN_RADIUS_M) continue;
      if (carrierGoalD >= CONTAIN_TERRITORY_M) continue;
      if (dist(p.pos, ownGoal) >= carrierGoalD) continue;
      ledger.pressOffered += 1;
      if (book !== null && book.declinesLunge(arrivalGroup(len(p.vel)))) {
        ledger.pressDeclinedByBook += 1;
        continue;
      }
      // his best MARKING price: the man he holds, or the best man he could legally take
      // inside the shipped creation range. ⚠ The two creation RULES (the Phase-28.4 WG width
      // discipline and the zonal zone gate) are deliberately NOT applied to this estimate —
      // omitting them can only make the marking side look CHEAPER, i.e. can only make
      // pressing LESS likely. Conservative by construction, and the rules themselves are
      // untouched and still govern every fresh pick below.
      let bestMarkPriceM = Infinity;
      const cur = heldTarget.get(p.index);
      const held = cur === undefined ? undefined : opp.players[cur];
      if (held !== undefined) bestMarkPriceM = dist(p.pos, held.pos) - slackMetres(held, p);
      for (const threat of threats) {
        if (heldMen.has(threat.index) && cur !== threat.index) continue;
        const d = dist(p.pos, threat.pos);
        if (d >= MARK_RANGE_M) continue;
        const priceM = d - slackMetres(threat, p);
        if (priceM < bestMarkPriceM) bestMarkPriceM = priceM;
      }
      if (dist(p.pos, carrier.pos) < bestMarkPriceM) vacated.add(p.index);
    }
    // ⭐ DF T2 DEATH CONDITION (8), the surface's own and the ONLY one it adds to DF-T0's
    // seven: his own price says the BALL is worth more than his man. It fires only with the
    // surface armed, and it is what makes 「leave your man」 a decision instead of an accident.
    for (const idx of vacated) {
      const left = heldTarget.get(idx);
      if (left !== undefined) {
        heldTarget.delete(idx);
        heldMen.delete(left);
      }
      team.marks.delete(idx);
      used.delete(idx);
    }
  }
  for (const threat of threats) {
    if (heldMen.has(threat.index)) continue; // DF T0: this man is already held — no re-scan
    const boxThreat = inOurBox(threat.pos.x, threat.pos.y);
    let best: { idx: number; d: number } | null = null;
    /** DF T2: the priced candidate, in METRES OF NET ACCESS (never a distance) */
    let bestPriced: { idx: number; priceM: number } | null = null;
    for (const p of free) {
      if (vacated.has(p.index)) continue; // DF T2: he elected the ball this pass
      // DF T0: door shut, `mayLeaveMark` is false for every body and this is the shipped
      // `if (used.has(p.index)) continue;`. Armed, a HOLDER stays a candidate only if the
      // switch price says the new man outprices his own.
      if (used.has(p.index) && !mayLeaveMark(p, threat)) continue;
      // Width discipline (Phase 28.4): a WIDE winger does not abandon the
      // flank to join a central pile-up — central threats belong to the
      // spine. This is the user-diagnosed collapse: turnover in midfield →
      // wingers tuck in → six bodies in one corridor → playground scramble.
      if (p.role === 'WG' && Math.abs(p.pos.y) > 12 && Math.abs(threat.pos.y) < 8) continue;
      // Zonal: outside our box, only the defender whose ZONE the threat
      // entered may engage — everyone else keeps the lattice.
      if (zones && !boxThreat && dist(zones.get(p.index)!, threat.pos) > 9) continue;
      const d = dist(p.pos, threat.pos);
      // ⭐⭐ DF T2 §THE PRICED GREEDY — the SAME threat-major scan, the SAME creation range and
      // the SAME strict-improvement tie discipline (first body in ascending index wins a
      // tie); only the CURRENCY changes, from raw distance to metres of NET access. A body
      // who reaches this man before the ball can (slack > 0) therefore outbids a body who is
      // merely nearer — 拦截线路 at assignment grain, on the shipped account, with no new
      // constant. Door shut, this branch does not exist and the shipped line below decides.
      if (match.dfSurface) {
        if (d < MARK_RANGE_M) {
          const priceM = d - slackMetres(threat, p);
          if (bestPriced === null || priceM < bestPriced.priceM) bestPriced = { idx: p.index, priceM };
        }
        continue;
      }
      if (d < 22 && (best === null || d < best.d)) best = { idx: p.index, d };
    }
    if (match.dfSurface) {
      best = bestPriced === null ? null
        : { idx: bestPriced.idx, d: dist(team.players[bestPriced.idx].pos, threat.pos) };
    }
    if (best) {
      used.add(best.idx);
      // DF T0: a switcher's old man is released here and his loyalty is spent for the pass
      // (the ledger stays injective, and nobody switches twice in one pass).
      const left = heldTarget.get(best.idx);
      if (left !== undefined) {
        heldTarget.delete(best.idx);
        heldMen.delete(left);
      }
      team.marks.set(best.idx, threat.index);
    }
  }
  /**
   * ⭐ DF T2 §THE USAGE LEDGER — PURE BOOKKEEPING, the stage's non-degeneracy receipt.
   * Nothing in the sim ever READS these counters, so they cannot influence a single tick, and
   * every one stays 0 unless `dfSurface` is armed. One row per DEFENDER per assignment pass
   * (the TEAM_AI_INTERVAL cadence — a DECISION distribution, not a tick distribution). The
   * per-body counts are keyed by `gid` and carry NO derived statistic: the instrument joins
   * them to attributes itself, so no tercile, threshold or taste constant enters `src/**`.
   */
  if (match.dfSurface) {
    const ledger = match.dfSurfaceLedger;
    const modeSlot = team.mode === 'Press' ? 1 : 0;
    for (const p of free) {
      let opt: number;
      if (vacated.has(p.index)) {
        opt = DF_OPT_PRESS;
      } else {
        const tgt = team.marks.get(p.index);
        if (tgt === undefined) {
          // no option was affordable OR LEGAL — the shipped spare-body state. ⚠ The branch
          // also absorbs the NOT-LEGAL exclusions (the Phase-28.4 WG width discipline and
          // the zonal zone gate above), not affordability alone (DF-T2 §CORR item 5, #327).
          ledger.idle += 1;
          continue;
        }
        const man = opp.players[tgt];
        if (man === undefined) continue;
        opt = heldTarget.get(p.index) === tgt ? DF_OPT_HOLD
          : slackMetres(man, p) > 0 ? DF_OPT_JUMP : DF_OPT_TAKE;
      }
      ledger.elections += 1;
      ledger.byOption[opt] += 1;
      ledger.byModeOption[modeSlot * DF_SURFACE_OPTIONS.length + opt] += 1;
      const perBody = ledger.byGid.get(p.gid) ?? new Array<number>(DF_SURFACE_OPTIONS.length).fill(0);
      perBody[opt] += 1;
      ledger.byGid.set(p.gid, perBody);
    }
  }
}
