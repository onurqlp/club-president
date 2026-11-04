// RC T0 — THE PRE-CUE DORMANT SEAM (docs/world-model/RC-T0-PRECUE-SEAM.md).
// Contracts: RC-RECEIVER-COOPERATION-CONTRACT.md §2 M-RC.1 (THE CHANNEL IS OUTWARD-ONLY),
// M-RC.2 (THE BELIEF IS MEASURED, NEVER WEIGHTED), M-RC.4 (THE GENE), M-RC.5 (ROAD B) and
// §2-AMENDMENT M-RC.3a (THE PRE-CUE ROUTE); PC-PERCEPTION-CONTRACT.md §2-AMENDMENT M-PC.1b
// (A PRE-CUED EVENT IS A PARTIAL SURPRISE). Census: RC-C0-COOPERATION-CENSUS.md §P.A (the
// cue) and §R1 (the numbers), read WITH its §COMMANDER CORRECTIONS. Ruling #369 item 6.
//
// 「看见他正对着我起腿的人,球出脚时反应得快」 — a receiver who could SEE that the passer's
// BODY was squared up to him meets the release as a PRE-CUED stimulus rather than a full
// surprise. RC-C0 measured both halves of that sentence:
//   • the cue is HONEST — the best-aligned same-side mate IS the target on 0.681429 of
//     wind-ups at the last pre-release tick, against a uniform prior of 0.200336 (Δ +0.481093,
//     111.080 half-widths ⇒ LICENSED, §R1);
//   • the waste is POST-STRIKE — of the meetable receiver's 0.470961 s of dead time, the
//     start delay is 0.379124 s, the PC `passRelease` hold at the CHOICE tier (#367 item 4c).
//
// ⭐ EPISTEMIC HONESTY, CLOSED AT THE IMPORT LIST (the `pcLatency.ts` / `defenceBook.ts`
// form): this module imports the two CERTIFIED PC tier constants and NOTHING else. It cannot
// name `Match`, `Player`, `TeamBrain`, `pendingPassWindup`, `faceTarget`, `pendingPass`, a
// designation (`runners` · `arriver` · `overlapper` · `wallRun`), an rng or `info.genome`.
// Everything it is told arrives as PRIMITIVE NUMBERS from its caller — the one arm-loop read
// in `Match.pcLatencyObserve`, whose LIVE argument list the pin suite pins as the read set
// (RC-C0 §COMMANDER CORRECTIONS item 4: a wrapper fixture alone is not enough for a SEAT).
//
// ⭐ NO NEW CONSTANT (#200). The two endpoints are PC's own certified tiers, IMPORTED; the
// belief is RC-C0's own measurement, re-derived from its artifact by a pin (G-TABLE); the
// weight is a born-absent gene (`rcAnticipationWeight`, `genome.ts`). Nothing else enters.
//
// Dormant: `rcAnticipate` is a hard `false` in every production path and no world, preset,
// env or bundle names it, so nothing in this file is reached in the shipped game.
import {
  PC_TIER_CHOICE_TICKS, PC_TIER_SIMPLE_TICKS, preCueTicks,
} from './pcLatency';

/**
 * ⭐⭐ THE HOLD LAW LIVES AT THE TIERS' OWN HOME AND IS RE-EXPORTED HERE, NOT COPIED.
 *
 * `preCueTicks(simple, choice, w, belief)` is PC-contract M-PC.1b's own arithmetic and its ONE
 * home is `src/ai/pcLatency.ts` — beside the two certified tier constants it interpolates and
 * inside the module whose `arm()` applies it. It is re-exported here so RC's seat module
 * presents the whole of M-RC.3a's law (rank → table → hold) at one address, WITHOUT the
 * import cycle that a second definition — or a definition here that `pcLatency` imported back —
 * would create. Same function object, one home; the pin suite asserts the identity.
 */
export { preCueTicks };

/* ========================================================================== */
/* §1 THE CUE — RC-C0 §P.A, BYTE FOR BYTE, ON SCALARS                          */
/* ========================================================================== */

/**
 * ⭐ THE DEGENERACY CUT — RC-C0 §P.A verbatim: "a bearing of length ≤ 1e-6 (mate standing ON
 * the passer) or a heading of length ≤ 1e-6 names no angle ⇒ NaN, and that mate is EXCLUDED
 * from the tick's vector". The census's own `cueAngle` guard, re-implemented on the same
 * scalars because this module may not import the probe.
 */
const CUE_DEGENERATE_LEN = 1e-6;

/**
 * θ between the passer's OUTWARD heading and the passer→mate bearing, in RADIANS — RC-C0
 * §P.A's `cueAngle`, byte for byte (the heading is NOT required to be unit; the census's own
 * `cue.headingNotUnit` fixture pins that). `NaN` for a degenerate heading or bearing.
 *
 * PURE, six scalars in, one number out: nothing private can enter this function.
 */
const cueAngle = (
  passerX: number, passerY: number, headX: number, headY: number,
  mateX: number, mateY: number,
): number => {
  const hl = Math.sqrt(headX * headX + headY * headY);
  const dx = mateX - passerX;
  const dy = mateY - passerY;
  const dl = Math.sqrt(dx * dx + dy * dy);
  if (!(hl > CUE_DEGENERATE_LEN) || !(dl > CUE_DEGENERATE_LEN)) return Number.NaN;
  const c = (headX * dx + headY * dy) / (hl * dl);
  return Math.acos(c < -1 ? -1 : c > 1 ? 1 : c);
};

/** One body of the mate population, as EXTERNAL fields only. The caller passes nothing else. */
export interface RcMateBearing {
  readonly gid: number;
  readonly x: number;
  readonly y: number;
}

/**
 * ⭐⭐ THE ALIGNMENT RANK — RC-C0 §P.A's cue, as the SEAT reads it.
 *
 * `mates` is the passer's own mate population as the census froze it: every same-side body
 * that is NOT the passer and is on the pitch (`sentOff === false`), **the KEEPER INCLUDED**,
 * in gid order — built by the caller from `pos` / `gid` / `side` / `sentOff` and NOTHING else.
 *
 * Returns the 1-BASED rank of `myGid` by θ among the FINITE-θ mates:
 *   rank = 1 + #{i : θ_i < θ_me} + #{i : θ_i === θ_me ∧ gid_i < myGid}
 * which is exactly the census's `argminFinite` order (strict argmin, **ties break to the
 * LOWEST gid**) extended from the winner to every position. Rank 1 is the best-aligned mate.
 *
 * Returns **0** — "no rank, no cue" — when MY OWN bearing is degenerate or I am not in the
 * population at all. `rcBeliefForRank(0)` is 0, so a body with no rank is a body with no
 * pre-cue and pays the choice tier exactly (the identity, by construction).
 *
 * ⚠ RC-C0 §COMMANDER CORRECTIONS item 1 applies here too: rank-1-ness and "ambiguity 0"
 * coincide in that battery but not BY DEFINITION — an exact float tie won on gid order is a
 * rank-1 hit that scored ambiguity 1. The rank is what this function computes; the table
 * below is keyed by it, and the honest limit is stated in the stage doc.
 *
 * PURE: scalars and a read-only array in, one integer out. No rng, no writes.
 */
export function alignmentRank(
  passerX: number, passerY: number, headX: number, headY: number,
  mates: readonly RcMateBearing[], myGid: number,
): number {
  let mine = Number.NaN;
  let found = false;
  for (const m of mates) {
    if (m.gid !== myGid) continue;
    mine = cueAngle(passerX, passerY, headX, headY, m.x, m.y);
    found = true;
    break;
  }
  if (!found || !Number.isFinite(mine)) return 0;
  let rank = 1;
  for (const m of mates) {
    if (m.gid === myGid) continue;
    const v = cueAngle(passerX, passerY, headX, headY, m.x, m.y);
    if (!Number.isFinite(v)) continue;
    if (v < mine || (v === mine && m.gid < myGid)) rank += 1;
  }
  return rank;
}

/* ========================================================================== */
/* §2 THE BELIEF — RC-C0's OWN MEASUREMENT, NOT A WEIGHT (M-RC.2)              */
/* ========================================================================== */

/**
 * ⭐⭐ THE TABLE'S DERIVATION, IN FULL — the numbers are RC-C0's, read off its artifact.
 *
 *   ARTIFACT  `docs/world-model/data/rc-c0-cooperation-census.json`
 *   BYTE-HASH `79ec2953761a2a7748eb77de9b3b64954601e0ecc3abc8506730549517c4a7b3`
 *             (sha256 of the file, the hash of record at ruling #367 item 1)
 *   FIELDS    numerators   = `bins.ambiguityAtLastTick.pooled`   (index r−1)
 *             denominator  = `licence.pLockLast.denominator`
 *
 * AMBIGUITY `a` at the last pre-release tick = the count of NON-target mates at least as well
 * aligned as the target (`ambiguityOf`, inclusive `θ_i ≤ θ_T`) ⇒ **the target sat at rank
 * a + 1**. So the pooled ambiguity bins ARE the rank histogram of the true target, and
 *
 *   RC_BELIEF_BY_RANK[r] = pooled[r − 1] / 42248 = P(the target sat at rank r)
 *
 * over the 42,248 wind-ups with a usable cue read (`cue.unusableFlightShare` = 0.000000, §R1).
 * The five values sum to 1 (the overflow bin is 0 — no wind-up ever put the target past rank
 * 5 in that battery), and rank 1 is `cue.pLockLast` **0.681429** itself.
 *
 * ⭐ STORED AS NUMERATOR / DENOMINATOR, NEVER AS ROUNDED DECIMALS, so the G-TABLE pin can
 * re-derive the quotients from the artifact ON DISK and compare them BIT-EXACTLY (`toBe`),
 * not to six decimal places. The transcription below is the artifact's own integers; the pin
 * is what proves the transcription.
 */
export const RC_BELIEF_NUMERATORS: readonly number[] =
  Object.freeze([28789, 7818, 2974, 1752, 915]);
/** `licence.pLockLast.denominator` — the wind-ups with a usable cue read (RC-C0 §R1). */
export const RC_BELIEF_DENOMINATOR = 42248;
/**
 * ⭐⭐ THE BELIEF TABLE — P(the ball is coming to me | I am the passer's rank-r mate), for
 * r = 1..5, DERIVED from the two fields above rather than typed as decimals.
 */
export const RC_BELIEF_BY_RANK: readonly number[] = Object.freeze(
  RC_BELIEF_NUMERATORS.map((n) => n / RC_BELIEF_DENOMINATOR),
);

/**
 * The belief a rank buys. **0 outside 1..5** — a rank the census never saw is a rank with no
 * measurement, hence NO pre-cue, hence (through `preCueTicks`) the CHOICE tier exactly: the
 * identity, by construction and not by a written rule. Rank 0 ("no cue") lands here too.
 *
 * PURE.
 */
export function rcBeliefForRank(rank: number): number {
  if (!Number.isInteger(rank) || rank < 1 || rank > RC_BELIEF_BY_RANK.length) return 0;
  return RC_BELIEF_BY_RANK[rank - 1];
}

/* ========================================================================== */
/* §3 THE CEILING, STATED — what the law can and cannot buy                    */
/* ========================================================================== */

/**
 * ⭐ THE HONEST CEILING (RC contract §2-AMENDMENT M-RC.3a; RC-C0 HONEST LIMITS 2–3), DERIVED
 * from the two certified tiers and the table so no prose number has a second home:
 * at `w = 1` and rank 1 the hold is `preCueTicks(12, 27, 1, TABLE[1])` = **17** applied ticks,
 * NOT 12 — the pre-cue buys ≈ 0.14 sim-s ≈ 1 m of RC-C0's measured 3.13 m arrival gap.
 * RC-T1a measures what that actually buys; this constant exists so the stage doc, the pin
 * suite and the module cannot print three different ceilings.
 */
export const RC_PRECUE_FLOOR_TICKS =
  preCueTicks(PC_TIER_SIMPLE_TICKS, PC_TIER_CHOICE_TICKS, 1, RC_BELIEF_BY_RANK[0]);
