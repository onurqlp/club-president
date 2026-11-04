import { clamp } from '../utils/math';
import { v2, type V2 } from '../utils/vec';
import { BOX_DEPTH, CORNER_CLEARANCE, FIELD_SCALE, GOAL_WIDTH, HALF_L, HALF_W } from '../sim/constants';
import type { Ball } from '../sim/Ball';
import type { Player } from '../sim/Player';
import type { Team } from '../sim/Team';
import {
  ctbSupportDepthWeight, ctbSupportWidthWeight, pmLaneConvergenceK,
} from '../evolution/genome';
import type { ObmPlane } from './offballEyes';
import type {
  AttackFormationId, CornerRoutine, DefendFormationId, TeamMode,
} from '../sim/types';

/**
 * Formation spot tables (Phase 30) in team-local coordinates: +x = our
 * attacking direction, x=-45 is our goal line. One V2 per SLOT in order
 * [GK, DF, MF, WGL, WGR, ST]; every team owns one attacking and one
 * defending table (its identity, `team.style`). The whole block still
 * slides with the ball, the tactical mode, and three genes (formationDepth,
 * attackingWidth, defensiveCompactness) exactly as it did on the old single
 * BASE_SPOTS. Formation names count outfield lines back→front.
 *
 * Lanes are deliberately separated (Phase 27.1): stacked spines collapse
 * open play into one central corridor. Back-line height is the goals lever
 * (Phase 29/30: higher line = compressed game, space in behind for runs).
 */
export const ATTACK_FORMATIONS: Record<AttackFormationId, V2[]> = {
  // Double base, a linking striker, both wingers HIGH and WIDE (两翼齐飞).
  'wide-212': [v2(-41, 0), v2(-16, -6), v2(-12, 7), v2(8, -19), v2(8, 19), v2(4, 0)],
  // One anchor, the left winger tucks in, an inside-right pair — at the
  // HALF-SPACES (8/11 → 12/15, Phase 31.8): with both wide slots inside
  // y≤11, a narrow-vs-narrow derby had no relief valve at all — both
  // attacks mirrored into one central corridor and the top-5 most chaotic
  // matches in the league (t+i 85–123, zero goals) were ALL this fixture.
  // Still clearly narrower than wide-212's ±19: inside-forwards, not
  // wingers.
  'narrow-122': [v2(-41, 0), v2(-19, 0), v2(-9, -7), v2(-6, 12), v2(6, 15), v2(7, -3)],
  // NOVEL (Phase 67, N5 — mutation-discovered only). TWIN STRIKERS: the
  // right winger becomes a second 9 — a high pair splitting the center
  // backs, one true wide feeder on the left, two at the base. The twins
  // sit a touch higher than wide-212's wingers: a spearhead, not a line.
  'twin-st': [v2(-41, 0), v2(-16, -4), v2(-11, 5), v2(2, -17), v2(10, 6), v2(10, -6)],
  // NOVEL. The FALSE NINE: the striker DROPS between the lines (-2, the
  // hole) to link and drag the last defender out; both wingers push very
  // high and very wide — the runners the false nine releases into the
  // space he vacated.
  'false-nine': [v2(-41, 0), v2(-17, -5), v2(-12, 5), v2(12, -18), v2(12, 18), v2(-2, 0)],
  // NOVEL (Phase 107, N5 — mutation-discovered only). The OVERLOAD: the
  // library's first ASYMMETRIC shape — a three-man left-flank triangle
  // (MF half-space, WGL wide, ST shading in) with the right winger ALONE
  // at maximum width as the isolation outlet (overload to isolate: the
  // switch finds him 1v1). The anchor shades right-center to cover the
  // side the triangle vacates.
  'overload': [v2(-41, 0), v2(-17, 3), v2(-7, -9), v2(9, -17), v2(8, 17), v2(5, -7)],
  // NOVEL. The TARGET MAN (the user's N1.5 reference point — 埃弗顿高塔):
  // the lone tower stands HIGHEST of any shape (+9) as the long ball's
  // destination — the Phase-63 aerial channel finally gets a shape built
  // around it (strength/aerialSense own the descent) — with both wingers
  // at mid-height arriving onto the knock-down, staggered double base
  // behind (no stacked central spine, the 27.1 lesson).
  'target-man': [v2(-41, 0), v2(-18, -4), v2(-10, 5), v2(0, -14), v2(0, 14), v2(9, 0)],
};

// Defend tables keep the STRIKER HIGH on purpose (30.4). The first cut
// parked all five outfielders goal-side and league scoring collapsed to
// ~1.1: a high body PINS an opposing defender (offence by presence) and
// gives every turnover a launch point — 29.x, whose single spot table left
// the ST at +5 even out of possession, scored fine for exactly this
// reason. Identity lives in the BACK of the shape instead: low-32 drops
// both wingers as wide backs; press-23 pushes them onto the build-up.
export const DEFEND_FORMATIONS: Record<DefendFormationId, V2[]> = {
  // Back THREE (wingers drop as wide backs), MF screens, ST stays HIGH.
  'low-32': [v2(-41, 0), v2(-20, 0), v2(-9, -4), v2(-16, -11), v2(-16, 11), v2(5, 2)],
  // Back two, wingers at halfway, ST hunting the opponent back line.
  'press-23': [v2(-41, 0), v2(-18, -5), v2(-13, 5), v2(0, -15), v2(0, 15), v2(7, 0)],
  // N5b (phase-79): the menu was BINARY (deep bus / front press) and world
  // 991 fixed 16/0 on low-32 — selection had nothing structurally new to
  // try. Two additions, mutation-only (founders still derive the classics):
  // mid-41 = the midfield WALL, striker drops onto the pivot lane
  // ("defend from the front" without pressing);
  'mid-41': [v2(-41, 0), v2(-22, 0), v2(-10, 0), v2(-12, -13), v2(-12, 13), v2(-3, 0)],
  // high-line = squeeze the pitch with the back line, no front press —
  // lives or dies by the offside trap (phase-71's law made it honest).
  'high-line': [v2(-41, 0), v2(-14, -3), v2(-9, 3), v2(-13, -12), v2(-13, 12), v2(6, 0)],
};

// Density相变 (2026-07-20): the fixed tables above were tuned in ABSOLUTE
// metres for the 90×58 pitch, so on a shrunk pitch (FIELD_SCALE<1) they fall
// out of bounds. Scale them to stay proportional + in-bounds. The DEFAULT path
// is emergentStation (fractional, already fits); this keeps the legacy fixed
// path + the pre-match shape diagrams valid when the field is scaled.
if (FIELD_SCALE !== 1) {
  for (const table of [ATTACK_FORMATIONS, DEFEND_FORMATIONS] as Record<string, V2[]>[]) {
    for (const key of Object.keys(table)) {
      table[key] = table[key].map((p) => v2(p.x * FIELD_SCALE, p.y * FIELD_SCALE));
    }
  }
}

// EMERGENT POSITIONING FIELD (Phase B → DEFAULT 2026-07-20, the coordinated
// density相变). Positions grow from role + genes + live state, not a fixed
// formation menu — VISION §1's #1 violation retired. It is REQUIRED on the
// shrunk pitch (FIELD_SCALE<1): emergent stations are fractional and auto-fit,
// the fixed tables use absolute coords and would fall off a smaller pitch.
// The UI toggle (settings → experimental) can still turn it OFF for A/B, and
// probes can force-OFF with EMERGENT_POS=0.
let _emergentPos: boolean | null = null; // null = use the default (ON)
export function setEmergentPos(on: boolean): void {
  _emergentPos = on;
}
export function emergentPosOn(): boolean {
  if (_emergentPos !== null) return _emergentPos; // explicit UI / probe override
  // typeof guard: `process` is undefined in the browser bundle — never throw.
  if (typeof process !== 'undefined' && process.env && process.env.EMERGENT_POS === '0') return false;
  return true; // DEFAULT ON
}

/** How far up/down the pitch each tactical mode pushes the block. */
const MODE_SHIFT: Record<TeamMode, number> = {
  Attack: 10,
  BuildUp: 4,
  CounterAttack: 8,
  Press: 6,
  Defend: -8,
  ResetShape: 0,
};

/**
 * World-space formation target for a player. `hasBall` decides whether width
 * (attackingWidth) or compactness (defensiveCompactness) shapes the block.
 */
// `abandonRest` (A4-P1b, #133): when true THIS body's index-1 rest-defence
// in-possession clamp is REMOVED (the DESIGNATION POLICY's second face). Default
// false — every production caller omits it, so the spot is bit-for-bit HEAD. The
// probe threads `match.abandonRestDesignation === team.side` from the sim seam.
// `pmMover` (PM-T0, #195.2 — the M-PM.3 READ FORK, #35.3 "fork the read, never
// the function"): TRUE only for the two BODY-MOVEMENT reads (the
// MoveToFormationSpot/HoldPosition walk target and the marker's no-target
// fallback), and only when the caller has already checked the M-PM.2 phase gate
// (live open play). Default FALSE — every ASSIGNMENT / GATE / CLAMP / restart /
// render reader omits it, so their spot is bit-for-bit HEAD. See the read table in
// docs/world-model/PM-T0-DORMANT-SEAM.md.
export function formationSpot(
  p: Player, team: Team, ball: Ball, hasBall: boolean, opp?: Team, abandonRest = false,
  pmMover = false,
): V2 {
  // EMERGENT POSITIONING FIELD (Phase B1, toggle — the user's #1 emergence
  // ask: shape must grow from role + genes + live state, not a hand-authored
  // MENU). Behind a flag so it A/Bs cleanly against the fixed tables
  // (positioning-shape.ts) before it can replace them. OFF = today's behavior.
  // PM-T0 branch disclosure: the M-PM.1 seam lives in `emergentStation` ONLY (the
  // DEFAULT-ON path). The legacy table path below already carries a per-body
  // convergence of its own (`:209+`, weight `defensiveCompactness · 0.25`) — the
  // very constant family this slice's ceiling is traced from — so it is left
  // untouched and `pmMover` is inert there.
  if (emergentPosOn()) return emergentStation(p, team, ball, hasBall, opp, abandonRest, pmMover);
  const g = team.genome;
  const base = hasBall
    ? ATTACK_FORMATIONS[team.style.formationAtk][p.index]
    : DEFEND_FORMATIONS[team.style.formationDef][p.index];

  // Block slides toward the ball along x (local coords), capped at ±10m.
  const ballLocalX = team.localX(ball.pos.x);
  const slide = clamp(ballLocalX * 0.3, -10, 10);

  // formationDepth: 0 = sit 6m deeper, 1 = push 6m higher.
  const depth = (g.formationDepth - 0.5) * 12;

  // PRESSING BUYS ITS RISK (Phase 83, the goal-inflation fix): a pressing
  // side's defensive block steps UP with its press gene — outfielders only,
  // defending phase only. Before this, line height was formationDepth's
  // alone, so evolution could chase-press from a deep couch: turnovers with
  // ZERO space conceded behind — the free lunch that rode pressIntensity to
  // 0.88 and the league to 6-7 goals (phase-82 anatomy). Now the line you
  // press with is the line the through-ball/route-one/chip channels attack.
  const pressUp = hasBall || p.role === 'GK' ? 0 : (g.pressIntensity - 0.5) * 8;

  let x = base.x + slide + depth + pressUp + MODE_SHIFT[team.mode];

  // Rest defence (Phase 31): the DF slot NEVER joins the siege. With the
  // ball deep in the opponent half, slide (+10) + Attack shift (+10) used
  // to push even the last outfielder past halfway — the attacking team had
  // literally nobody covering, so every turnover was an uncontested
  // breakaway. That hole is what let a 5v6 side out-score its own
  // full-strength baseline once the open-run economy paid honestly
  // (counters were ALL open runs). One cover man keeps counters real —
  // beatable by pace or a dragged block, never free.
  // −12, not −5: a cover man AT halfway is already beaten by the time a
  // counter carrier enters the open-run zone (28m out) — he has to start
  // goal-side of the race, near his base spot, to ever contest it.
  if (p.index === 1 && p.role !== 'GK') {
    if (hasBall) {
      // Rest-defense depth is now the SWEEPER gene's possession face
      // (Phase 88): 0.5 = the old hardcoded −12 exactly; the full libero
      // (1) holds −16 even mid-siege, the bold stopper (0) dares −8.
      // A4-P1b (#133): the DESIGNATION POLICY's second face — abandoned ⇒ the
      // clamp is skipped and the body keeps its ordinary in-possession depth
      // (slide + depth + shifts), pushing up like any outfielder.
      if (!abandonRest) x = Math.min(x, -8 - (g.coverBias ?? 0.5) * 8);
    } else {
      // THE SWEEPER (Phase 88, school #2 — catenaccio): the DF slot sits
      // off his own line by the gene — behind it (libero: the man who
      // meets whatever beats the first wave, at the price of playing
      // everyone onside) or ahead of it (stopper: early interceptions,
      // gambling the space behind). 0.5 = today's flat line.
      x -= ((g.coverBias ?? 0.5) - 0.5) * 8;
    }
  }

  // Width: stretch when we have the ball, squeeze when we don't. The
  // in-possession floor is 1.0 (Phase 27.1) — an attacking shape should
  // never be narrower than its base lanes.
  let widthMul = hasBall
    ? 1.0 + g.attackingWidth * 0.55 // 1.0 .. 1.55
    : 1.15 - g.defensiveCompactness * 0.6; // 1.15 .. 0.55
  // Zonal shape stays HONEST-WIDE (Phase 30.4): a zone defence covers
  // width by definition — it may not also collapse into the central
  // corridor, or its parked bodies dead-lane the entire pitch (measured:
  // zonal sides conceded 3.6 shots/match vs man's 8 — the league's shot
  // volume collapsed with half the clubs zonal).
  if (!hasBall && team.style.scheme === 'zonal') widthMul = Math.max(widthMul, 0.95);
  let y = base.y * widthMul;

  // Compact teams also drag their block a little toward the ball's y.
  if (!hasBall) y += (ball.pos.y - y * team.attackDir) * team.attackDir * g.defensiveCompactness * 0.25;

  // Weak-side far-post pull (Phase 31): when the attack is deep AND wide,
  // the far winger leaves the touchline and attacks the back post — the
  // overload that punishes a ball-side defensive shift, and the second
  // body a cutback or deep cross finds. The strong-side winger keeps the
  // width; the pull releases as soon as the ball comes back central.
  if (
    hasBall && p.role === 'WG' && ballLocalX > HALF_L - 20 &&
    Math.abs(ball.pos.y) > 12 && Math.sign(y) !== Math.sign(ball.pos.y)
  ) {
    y *= 0.3;
  }

  if (p.role === 'GK') {
    // Keepers hold a narrow band in front of goal regardless of mode.
    x = clamp(base.x + (g.keeperAggression - 0.5) * 4, -HALF_L + 1, -HALF_L + 11);
    y = clamp(ball.pos.y * 0.25, -GOAL_WIDTH / 2, GOAL_WIDTH / 2);
    return v2(x * team.attackDir, y);
  }

  x = clamp(x, -HALF_L + 3, HALF_L - 7);
  y = clamp(y, -HALF_W + 2, HALF_W - 2);
  return v2(x * team.attackDir, y);
}

/**
 * EMERGENT POSITIONING FIELD (Phase B1-a). Replaces the fixed formation TABLE
 * with a ROLE-anchored field: a role gives a coarse depth+lane TENDENCY (a
 * dimension, like an attribute — not a hand-drawn shape), and the actual
 * station grows from that + the live game state, weighted by GENES. So the
 * team's SHAPE and "style" emerge from gene weights, not from us picking
 * wide-212 vs low-32. B1-a lands the structural swap + a REAL, gene-weighted
 * strong/weak-side shift (the B0 probe found the old ~2m drag was token). The
 * anti-clump / space-value terms (kill the bus box-crowd, no clumping) are
 * B1-b. Opponent-relative positioning is B2. Same sensible modifiers as the
 * table path (slide/depth/press/rest-defence/width) so shape stays sane.
 */
// `abandonRest` (A4-P1b, #133): the LIVE realization of "the formations
// in-possession clamp" face (emergentPos defaults ON, so this — not the table
// path — is what runs in the census world). Default false ⇒ bit-for-bit HEAD.
function emergentStation(
  p: Player, team: Team, ball: Ball, hasBall: boolean, opp?: Team, abandonRest = false,
  pmMover = false,
): V2 {
  const g = team.genome;
  // Role → coarse (depth fraction of HALF_L, lane fraction of HALF_W). WGs take
  // a side from their slot (L=3, R=4); everyone else holds a central lane.
  const laneSign = p.index === 3 ? -1 : p.index === 4 ? 1 : 0;
  let depthFrac: number;
  let laneFrac: number;
  switch (p.role) {
    case 'GK': depthFrac = -0.91; laneFrac = 0; break;
    case 'DF': depthFrac = -0.45; laneFrac = 0; break;
    case 'MF': depthFrac = -0.12; laneFrac = laneSign * 0.12; break;
    case 'WG': depthFrac = 0.05; laneFrac = laneSign * 0.6; break;
    default: depthFrac = 0.12; laneFrac = 0; break; // ST
  }

  const ballLocalX = team.localX(ball.pos.x);
  const slide = clamp(ballLocalX * 0.3, -10, 10);
  const depth = (g.formationDepth - 0.5) * 12;
  const pressUp = hasBall || p.role === 'GK' ? 0 : (g.pressIntensity - 0.5) * 8;
  let x = depthFrac * HALF_L + slide + depth + pressUp + MODE_SHIFT[team.mode];

  // Rest defence — the DF slot never joins the siege (same as the table path).
  // A4-P1b (#133): abandoned ⇒ the in-possession clamp is skipped (the body
  // keeps his ordinary depth); the out-of-possession sweeper face is untouched.
  if (p.index === 1 && p.role !== 'GK') {
    if (hasBall) { if (!abandonRest) x = Math.min(x, -8 - (g.coverBias ?? 0.5) * 8); }
    else x -= ((g.coverBias ?? 0.5) - 0.5) * 8;
  }

  // Width: stretch in possession, squeeze out of it.
  let widthMul = hasBall ? 1.0 + g.attackingWidth * 0.55 : 1.15 - g.defensiveCompactness * 0.6;
  if (!hasBall && team.style.scheme === 'zonal') widthMul = Math.max(widthMul, 0.95);
  let y = laneFrac * HALF_W * widthMul;

  // ⭐ STRONG / WEAK SIDE (B1-a, the real thing): the block slides toward the
  // BALL'S y — overload the ball side in attack, protect it in defence —
  // weighted by width (attack) / compactness (defence). The B0 probe measured
  // the old drag at only ~2m and gene-flat; this is a genuine, selectable
  // ball-side shift, so a team that commits to it gets a real strong side and
  // leaves a weak side (which width/switches then punish — emergent).
  // TRANSLATE the block ball-side (add a common offset) — do NOT converge each
  // man onto ball.y (that collapses the lateral spread; the first B1-a cut did,
  // halving spreadY). The whole shape slides over, keeping its width.
  const ballSideShift = hasBall ? 0.18 + g.attackingWidth * 0.22 : 0.18 + g.defensiveCompactness * 0.25;
  y += ball.pos.y * ballSideShift;

  // ⭐ PM-T0, THE M-PM.1 SEAM (PHASE-MODULATION-CONTRACT §2, ruling #195.2) — the
  // DEFENSIVE LANE CONVERGENCE, dormant. The comment above froze "keep width, do
  // NOT converge" by HAND, for every team, forever; VISION §1 (位置是活的) says the
  // strength of that choice must be a gene axis, not an architect's constant. So:
  // out of possession, each body's lateral station converges toward the BALL'S
  // LANE by `k_PM` — composing AFTER the width and common-translation terms above
  // (it replaces NEITHER), before anti-clump and solidity, which are exactly the
  // guards that price whether the contraction collapses anything (the B1-a
  // failure this un-freezes). `k_PM < 1` is an affine contraction: lateral ORDER
  // is preserved, gaps shrink; 弱侧收窄 falls out of the geometry (a far body moves
  // more metres under the same contraction) with NO weak-side rule written down.
  //
  // BORN ABSENT ⇒ `pmLaneConvergenceK` is 0 ⇒ this line is a no-op ⇒ the world is
  // byte-identical. `pmMover` is the M-PM.3 read fork (mover reads only) and the
  // caller has already applied the M-PM.2 phase gate (live open play). NO role
  // gating (the GK's y is overwritten by his own band below, so he is inert by the
  // world's own geometry, not by a role rule), NO per-body offsets, NO scenario
  // triggers, and NO new perception channel — `ball.pos.y` is the very input the
  // line above already consumes (M-PM.4).
  if (pmMover && !hasBall) {
    const kPm = pmLaneConvergenceK(g);
    if (kPm > 0) y += (ball.pos.y - y) * kPm;
  }

  // ⭐ B2: the block tracks the OPPONENT's push, not just the ball (the user's
  // "阵型也不会随着对面的移动而移动"). The defensive spine (DF/MF) holds a line
  // just goal-side of the opponents' advanced players — step UP when they sit
  // deep, DROP when they push. A modest convergence, so the block MOVES WITH
  // the opponent line while keeping its own depth structure. Only when we have
  // an opponent reference (executor/marking path); attack + supportSpot skip it.
  if (!hasBall && opp && (p.role === 'DF' || p.role === 'MF')) {
    const adv = opp.players
      .filter((o) => o.role !== 'GK' && !o.sentOff)
      .map((o) => team.localX(o.pos.x))
      .sort((a, b) => a - b);
    if (adv.length >= 2) {
      const holdLine = adv[1] - 3; // goal-side of their 2nd-deepest attacker
      x += (holdLine - x) * 0.14;
    }
  }

  // ⭐ B1-b: ANTI-CLUMP + position by VALUE (the user's "一堆人挤自家禁区,防守
  // 帮助 0" / "别扎堆"). Stations REPEL each other, so bodies SPREAD to cover
  // space instead of piling into the same zone — the emergent alternative to a
  // fixed lattice AND to the bus box-crowd. Computed in the local-x / world-y
  // frame (x is local, y unflipped). Plus a box-crowd relief: with no ball
  // threat to our box, nobody buries INSIDE it — hold the useful edge.
  // Defensive THREAT = how close the ball is to OUR goal (0 at/above halfway,
  // ~1 deep in our third). Spread when there's no threat (cover space, no
  // bus-crowd); COMPACT the last line under threat (B-continued — the first
  // B1-b spread even the back line → clean chances → goals-warming inflated
  // to overperf 2.1×; solidity restored here).
  const threat = clamp((-team.localX(ball.pos.x) - 8) / 26, 0, 1);
  if (p.role !== 'GK') {
    let rx = 0;
    let ry = 0;
    for (const q of team.players) {
      if (q === p || q.role === 'GK' || q.sentOff) continue;
      const dxL = x - team.localX(q.pos.x);
      const dyL = y - q.pos.y;
      const d = Math.hypot(dxL, dyL);
      if (d < 9 && d > 1e-3) {
        const f = (9 - d) / 9;
        rx += (dxL / d) * f;
        ry += (dyL / d) * f;
      }
    }
    const spread = 2.6 * (1 - threat * 0.7); // don't spread the last line under threat
    x += clamp(rx * spread, -7, 7);
    y += clamp(ry * spread, -7, 7);
    // no useless burying in our own box when the ball isn't threatening it
    if (team.localX(ball.pos.x) > -20 && x < -HALF_L + BOX_DEPTH) x = -HALF_L + BOX_DEPTH + 2;
    // SOLIDITY under threat: the back/mid block collapses goal-ward + central
    // as the ball bears down, so the last line stays compact and denies the
    // clean chance (the ST stays high as the outlet).
    if (!hasBall && p.role !== 'ST' && threat > 0) {
      const kk = threat * (0.3 + g.defensiveCompactness * 0.5);
      x += (-HALF_L + 11 - x) * kk * 0.45;
      y += (0 - y) * kk * 0.3;
    }
  }

  if (p.role === 'GK') {
    x = clamp(-HALF_L + 4 + (g.keeperAggression - 0.5) * 4, -HALF_L + 1, -HALF_L + 11);
    y = clamp(ball.pos.y * 0.25, -GOAL_WIDTH / 2, GOAL_WIDTH / 2);
    return v2(x * team.attackDir, y);
  }
  x = clamp(x, -HALF_L + 3, HALF_L - 7);
  y = clamp(y, -HALF_W + 2, HALF_W - 2);
  return v2(x * team.attackDir, y);
}

/**
 * Free-kick wall slots (Phase 32): shoulder-to-shoulder on the ball–goal
 * line at the law clearance (9.15m), 0.7m apart, centered. Shared by the
 * executor (routing), the referee's wall-wait gate and the flight solver —
 * one geometry, so nothing fights and nobody strikes past a half-built
 * wall standing in the climb's header band.
 */
export function fkWallSlots(from: V2, goal: V2, n: number): V2[] {
  const dx = goal.x - from.x;
  const dy = goal.y - from.y;
  const dl = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6);
  const ux = dx / dl;
  const uy = dy / dl;
  const cx = from.x + ux * (CORNER_CLEARANCE + 0.15);
  const cy = from.y + uy * (CORNER_CLEARANCE + 0.15);
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    // 1.1m spacing: anything under PLAYER_MIN_DIST (1.05) gets shoved
    // apart by resolveOverlaps every frame — the wall equilibrated 1.4m
    // OFF its slots, standing exactly in the climb's header band.
    const off = (i - (n - 1) / 2) * 1.1;
    out.push(v2(cx - uy * off, cy + ux * off));
  }
  return out;
}

/**
 * Corner routine geometry (Phase 31), in world coordinates for the taking
 * team. `attackDir` is the taker's attacking direction, `cornerY` the sign
 * of the corner flag's y. The KEY zone is what the routine's openness is
 * judged on; the CRASH spots are where the three licensed box-crashers
 * attack (primary / secondary / rebound), ordered by aerial rank.
 */
export function cornerKeyZone(routine: CornerRoutine, attackDir: 1 | -1, cornerY: number): V2 {
  const gx = attackDir * HALF_L;
  const s = cornerY >= 0 ? 1 : -1;
  switch (routine) {
    case 'nearPost':
      return v2(gx - attackDir * 4.5, s * 2.8);
    case 'farPost':
      return v2(gx - attackDir * 5.5, -s * 3.2);
    case 'short':
      return v2(gx - attackDir * 9, s * (HALF_W - 6));
    case 'arcCutback':
      return v2(gx - attackDir * 16, s * 3);
  }
}

export function cornerCrashSpots(
  routine: CornerRoutine | undefined, attackDir: 1 | -1, cornerY: number,
): [V2, V2, V2] {
  const gx = attackDir * HALF_L;
  const s = cornerY >= 0 ? 1 : -1;
  const b = (dx: number, y: number): V2 => v2(gx - attackDir * dx, y);
  switch (routine) {
    case 'nearPost':
      // Overload the front zone: the flick wins the race, the others eat
      // the flick-on and the spill.
      return [b(4.5, s * 2.8), b(7, -s * 1), b(11, s * 0.5)];
    case 'farPost':
      // The back-post crash: primary attacks the far stick with a run.
      return [b(5.5, -s * 3.2), b(6, s * 1.5), b(11, 0)];
    case 'arcCutback':
      // Crashers pin the box DEEP so the arc stays empty for the arriver.
      return [b(4.5, s * 2.5), b(5.5, -s * 2.5), b(7.5, 0)];
    case 'short':
    default:
      // Default milling (and the short routine's box picture): posts + spot.
      return [b(5, s * 2.5), b(6, -s * 2.5), b(11, 0)];
  }
}

/**
 * Is the team settled into its ATTACKING shape? (Phase 30 step 3 — the
 * keeper waits for this before releasing a goal kick or a held ball, so
 * distributions find SET receivers instead of gifting scrambles.) At least
 * three outfielders within `radius` of their attacking spots — or every
 * outfielder the team still has, when send-offs leave fewer than three.
 * Pure sim-state (invariant 3): positions vs spot tables, no clocks.
 */
export function shapeReady(team: Team, ball: Ball, radius = 6, abandonRest = false): boolean {
  let settled = 0;
  let outfield = 0;
  for (const p of team.players) {
    if (p.role === 'GK' || p.sentOff) continue;
    outfield++;
    // abandonRest: in an A4-P1b abandoned fork branch the readiness
    // reference must be the no-policy spot, or the unclamped DF reads as
    // permanently unsettled against a clamped reference he no longer serves.
    const spot = formationSpot(p, team, ball, true, undefined, abandonRest);
    const dx = p.pos.x - spot.x;
    const dy = p.pos.y - spot.y;
    if (dx * dx + dy * dy < radius * radius) settled++;
  }
  return settled >= Math.min(3, outfield);
}

/**
 * The opponents' last defensive line, in `team`-local x (bigger = deeper
 * toward their goal). GK excluded — beating the keeper is the striker's job.
 */
export function defenderLineLocalX(team: Team, opponents: Player[]): number {
  let line = -HALF_L;
  for (const o of opponents) {
    if (o.role === 'GK' || o.sentOff) continue;
    const lx = team.localX(o.pos.x);
    if (lx > line) line = lx;
  }
  return line;
}

/**
 * The OFFSIDE line in `team`-local x (Phase 29): the second-last opponent
 * COUNTING the keeper (the real law — usually the last outfield defender,
 * because the keeper is the last man), or the ball itself if it's deeper,
 * floored at halfway (you cannot be offside in your own half). An attacker
 * ahead of this line when a teammate strikes the ball is in an offside
 * position; level is onside (callers add their own epsilon).
 */
export function offsideLineLocalX(team: Team, opponents: Player[], ballLocalX: number): number {
  let last = -HALF_L;
  let secondLast = -HALF_L;
  for (const o of opponents) {
    if (o.sentOff) continue;
    const lx = team.localX(o.pos.x);
    if (lx > last) {
      secondLast = last;
      last = lx;
    } else if (lx > secondLast) {
      secondLast = lx;
    }
  }
  return Math.max(secondLast, ballLocalX, 0);
}

/**
 * Where an assigned runner sprints: past the last defender's shoulder,
 * angling into the channel toward goal. Clamped short of the keeper's box so
 * runs stretch the defence without parking on the goal line. The target aims
 * BEYOND the line on purpose — while a teammate still carries the ball the
 * executor holds the run at the offside line (Phase 29), and the instant the
 * kick is struck the clamp releases and this target is the burst in behind.
 */
export function runTarget(p: Player, team: Team, opponents: Player[]): V2 {
  const line = defenderLineLocalX(team, opponents);
  const myX = team.localX(p.pos.x);
  const targetLocalX = clamp(Math.max(line + 7, myX + 5), myX + 3, HALF_L - 9);
  // Narrow toward the goal mouth as the run goes deeper, keeping the lane.
  // The poacher (Phase 39) attacks the POST CHANNEL (|y|≈3.5, his wing's
  // post) — the tap-in zone. NOT the center: a first cut narrowed him to
  // ×0.35 and his runs ended on the keeper's chest (fm 21, the goal-pull
  // lesson — conversion went DOWN and the finishing invariant test flagged
  // it).
  const y = p.traits.includes('poacher')
    ? Math.sign(p.pos.y || 1) * 3.5
    : clamp(p.pos.y * 0.6, -HALF_W + 4, HALF_W - 4);
  return v2(targetLocalX * team.attackDir, y);
}

/**
 * Where a through ball should MEET a runner (Phase 29). A runner already in
 * stride is led by their velocity, like any pass. But a runner HELD at the
 * offside line hovers with near-zero velocity — leading by velocity would
 * put the ball at their feet ON the line, exactly the ball the line exists
 * to kill. The pass anticipates the break instead: it projects the burst
 * along the run target at the runner's top speed, and the runner breaks the
 * instant the kick releases the onside hold. Judgment stays honest — the
 * flag is judged on where the runner STANDS at the kick, not the aim point.
 */
export function runBurstPoint(p: Player, team: Team, opponents: Player[], flight: number): V2 {
  const speed = Math.hypot(p.vel.x, p.vel.y);
  if (speed > 3) {
    return v2(p.pos.x + p.vel.x * flight * 1.6, p.pos.y + p.vel.y * flight * 1.6);
  }
  const rt = runTarget(p, team, opponents);
  const dx = rt.x - p.pos.x;
  const dy = rt.y - p.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const burst = Math.min(d, p.topSpeed * flight * 1.1);
  return v2(p.pos.x + (dx / d) * burst, p.pos.y + (dy / d) * burst);
}

/**
 * ⭐ THE INCUMBENT LATERAL-FAN CONSTANTS (Phase 30.5), named here at their own use
 * site by CTB-T0 (#223). PURE CODE MOTION: `SUPPORT_LAT_PULL` is the `* 0.75`
 * lane-pull factor and `SUPPORT_LAT_CAP_FRAC` is the `* 0.9` radius cap that
 * `supportSpot` has always applied — the same two numbers, given names so the CTB
 * width axis can be written as a deformation OF them instead of as new literals.
 */
export const SUPPORT_LAT_PULL = 0.75;
export const SUPPORT_LAT_CAP_FRAC = 0.9;

/**
 * ⭐ THE FROZEN DEPTH SPAN (CTB-T0, contract §2 M-CTB.1: "gene-scaled with a bound
 * TRACED from the existing geometry family… never a typed literal", the #202 form).
 * `aheadBias′ = aheadBias + ctbSupportDepth · CTB_DEPTH_BIAS_SPAN`, i.e. the depth
 * axis reaches ± this much AHEAD-BIAS around the incumbent ternary.
 *
 * TRACED, NOT INVENTED, and DERIVED IN CODE: it IS `SUPPORT_LAT_CAP_FRAC`, the
 * seat's own lateral cap fraction — the engine's standing answer to "how far off the
 * ball, as a fraction of the support radius, may this seat sit". The depth axis is
 * that same question read on the other axis of the same plane, so the seat may
 * express EXACTLY as much reach front-to-back as it already expresses side-to-side,
 * and no more. It is a FRACTION OF THE SAME `radius = 10 + supportDistance·8` family
 * (the contract's named natural neighbour), so in metres the span is 9–16.2 m.
 *
 * The consequence that matters (contract §0.3): the incumbent attacking bias is
 * 0.75, so a full-negative dose reaches `0.75 − 0.9 = −0.15` — LEVEL WITH and BEHIND
 * the ball become expressible, in both modes (non-attacking: `0.35 − 0.9 = −0.55`).
 * Never re-cut: if CTB-T1 needs a different span that is a fork for the commander
 * WITH numbers, not a quiet re-freeze after sight.
 */
export const CTB_DEPTH_BIAS_SPAN = SUPPORT_LAT_CAP_FRAC;

/**
 * Where an off-ball player supports the carrier: ahead of the ball for
 * attacking modes, pulled laterally TOWARD the supporter's own formation
 * lane, at a radius set by the supportDistance gene.
 *
 * Lane-pulled but radius-bounded (Phase 30.5): the old sign()-based nudge
 * kept every supporter within ~5m of the ball's y, so all three off-ball
 * attackers formed one narrow column ahead of the carrier — dragging their
 * markers into the same corridor, walling off every forward lane
 * (interceptions ran 33/match) and pulling wingers off the flank. Pulling
 * y toward the lane spreads support into a fan: near-central options stay
 * short, the ball-side winger becomes a REAL wide outlet. The lateral pull
 * is capped at ~0.9× the support radius on purpose — a first cut anchored
 * y fully to the lane, which parked "support" 30m from the carrier: no
 * short options left, neutral-genome attacks starved (mirror goals 1.47 →
 * 0.93), and the 5v6 sanity invariant inverted (probe-shorthand).
 *
 * CTB-T0 (#223): the seat gained a DORMANT 2D deformation plane behind
 * `ctbSupportPlane` — see `CTB_DEPTH_BIAS_SPAN` below and the fork in the body.
 * Born absent, flag hard-false: the paragraphs above still describe the shipped
 * world exactly.
 */
export function supportSpot(p: Player, team: Team, ball: Ball, ctbPlane = false): V2 {
  // ⭐ CTB-T0 (#223, contract §2 M-CTB.1) — THE SUPPORT-PLANE SEAM: the ONE read
  // fork of `ctbSupportPlane` in src/**. Unconditional geometry, no predicate
  // (#200): when the seam is armed, the two signed genes deform this expression on
  // EVERY support tick; nothing here reads pressure, state or mode beyond the
  // incumbent ternary, and nothing decides anything. Flag off OR genes absent ⇒
  // `depthShift = 0` and `widthScale = 1` ⇒ `x + 0` and `× 1` are EXACT in IEEE-754
  // ⇒ the incumbent expression evaluates byte-identically (G-BORN / G-ZERO).
  let depthShift = 0;
  let widthScale = 1;
  if (ctbPlane) {
    depthShift = ctbSupportDepthWeight(team.genome) * CTB_DEPTH_BIAS_SPAN;
    widthScale = 1 + ctbSupportWidthWeight(team.genome);
  }
  return supportSpotDeformed(p, team, ball, depthShift, widthScale);
}

/**
 * ⭐ OBM-T0 (#227, contract §2 M-OBM.3) — THE PLANE READ SITE: the off-ball eyes
 * seat's DYNAMIC position on the SAME banked limb, and the seat's only geometry.
 *
 * `plane` is the already-COMPOSED, already-clamped pair
 * `clamp(staticCtbGene + dynamicPolicyOutput)` that the seat computed at the body's
 * own decision cadence (`src/ai/offballEyes.ts`) — the static CTB genes are the
 * policy's INTERCEPT, so this says exactly what the `ctbPlane` branch above says
 * whenever the dynamic term is zero. Nothing is deformed twice and no new geometry
 * is invented: the axis spans are the banked limb's own (`CTB_DEPTH_BIAS_SPAN` and
 * the two incumbent fan constants).
 *
 * ⚠ Deliberately a SECOND ENTRY POINT rather than a fifth parameter on
 * `supportSpot`: `tests/ctbSupportPlane.test.ts` pins that function's signature and
 * its executor call site VERBATIM, and contract §4 forbids re-cutting the banked
 * seam. The shared arithmetic lives in `supportSpotDeformed`, so nothing is
 * duplicated and no incumbent line moved.
 */
export function supportSpotOnObmPlane(
  p: Player, team: Team, ball: Ball, plane: ObmPlane,
): V2 {
  return supportSpotDeformed(
    p, team, ball, plane.depth * CTB_DEPTH_BIAS_SPAN, 1 + plane.width,
  );
}

/**
 * The support geometry itself, deformed by an ALREADY-RESOLVED (depthShift,
 * widthScale) pair. Pure code motion out of `supportSpot` by OBM-T0: every line
 * below, and the order it evaluates in, is the incumbent expression's own — at
 * `(0, 1)` it is the Phase 30.5 fan byte for byte.
 */
function supportSpotDeformed(
  p: Player, team: Team, ball: Ball, depthShift: number, widthScale: number,
): V2 {
  const g = team.genome;
  // 10..18m: close enough for a give-and-go, far enough that the carrier
  // isn't mobbed by their own teammates (Phase 19 spacing pass, widened in
  // Phase 27.1 — the crowd complaint was real).
  const radius = 10 + g.supportDistance * 8;
  const aheadBias = team.mode === 'CounterAttack' || team.mode === 'Attack' ? 0.75 : 0.35;

  const lane = formationSpot(p, team, ball, true);
  const maxLat = radius * SUPPORT_LAT_CAP_FRAC * widthScale;
  const latPull = clamp((lane.y - ball.pos.y) * SUPPORT_LAT_PULL * widthScale, -maxLat, maxLat);
  return v2(
    clamp(ball.pos.x + team.attackDir * radius * (aheadBias + depthShift), -HALF_L + 2, HALF_L - 2),
    clamp(ball.pos.y + latPull, -HALF_W + 2, HALF_W - 2),
  );
}
