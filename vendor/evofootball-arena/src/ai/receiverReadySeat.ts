// RC T0b — THE READY DORMANT SEAM (docs/world-model/RC-T0B-READY-SEAM.md).
// Contracts: RC-RECEIVER-COOPERATION-CONTRACT.md §2 M-RC.1 (THE CHANNEL IS OUTWARD-ONLY),
// M-RC.2 (THE BELIEF IS MEASURED, NEVER WEIGHTED), M-RC.4 (THE GENE), M-RC.5 (ROAD B) and
// §2-AMENDMENT M-RC.3b (THE READY LIMB); BF-BODY-FACING-CONTRACT.md M-BF.4 (the coupling —
// with the facing price armed the turn COSTS drift speed, which is what gives the choice a
// trade). Census: RC-C0B-DETECTOR-CENSUS.md §P.A / §P.B (the cell) and §R1 (the counts), read
// WITH its §COMMANDER CORRECTIONS. Ruling #378 item 6.
//
// 「看见自己人拿球正转向我,先把身子打开对着他」 — a receiver who can SEE that a same-side
// carrier is holding the ball and swinging his shoulders round toward him may open his body
// toward that carrier BEFORE the ball is struck, keeping exactly the movement he was already
// making. RC-C0b measured how often such a moment really IS a wind-up aimed at him.
//
// ⭐ EPISTEMIC HONESTY, CLOSED AT THE IMPORT LIST (the receiverAnticipationSeat.ts /
// bodyFacing.ts form): this module imports RC-T0's OWN cue function and the engine's tick
// length, and NOTHING else. It cannot name the match, a body class, the team layer, the
// passer's private commitment, the post-strike truth object, a facing target, a designation
// (runners / arriver / overlapper / wallRun), an rng or another body's genome. Everything it
// is told arrives as PRIMITIVE NUMBERS from its caller — the one off-ball menu read in
// PlayerBrain, whose LIVE argument list the pin suite pins as the read set.
//
// ⭐ NO NEW CONSTANT (#200). The three bin edge lists are RC-C0b's own (§P.B, frozen before
// its battery); the 240 integers below are RC-C0b's own stored counts, re-derived BIT-EXACTLY
// off its artifact by a pin (G-TABLE); the score anchor is ReceivePass's own literal, read at
// its own site in PlayerBrain.ts; the weight is the born-absent gene `rcAnticipationWeight`
// (genome.ts) — the SAME gene as RC-T0's 3a limb (M-RC.4: one gene = how much a receiver
// trusts a body cue). ⛔ NO minimum-count floor, no threshold, no smoothing, no per-role
// constant.
//
// Dormant: `rcReady` is a hard `false` in every production path and no world, preset, env or
// bundle names it, so nothing in this file is reached in the shipped game.
import { DT } from '../sim/constants';
import { alignmentRank, type RcMateBearing } from './receiverAnticipationSeat';

/**
 * ⭐⭐ THE RANK IS RC-T0's OWN FUNCTION OBJECT, RE-EXPORTED, NEVER RE-IMPLEMENTED.
 *
 * `alignmentRank` is RC-C0 §P.A's cue byte for byte and its ONE home is
 * `src/ai/receiverAnticipationSeat.ts`. RC-C0b's rank axis is that same cue extended from the
 * argmin to the whole vector, so 3b reads the cue through 3a's function — the pin suite
 * asserts the IDENTITY (same object), not merely equal behaviour (G-RANK).
 */
export { alignmentRank };
export type { RcMateBearing };

/* ========================================================================== */
/* §1 THE CELL — RC-C0b §P.B, BYTE FOR BYTE, ON SCALARS                        */
/* ========================================================================== */

/**
 * RC-C0b §P.B's own edge-list bin: index i = [edges[i−1], edges[i]); the LAST index is the
 * open top. The census's `edgeBinOf`, re-implemented on the same scalars because this module
 * may not import a probe.
 */
const edgeBin = (v: number, edges: readonly number[]): number => {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i;
  return edges.length;
};

/** RC-C0 §P.A's degeneracy cut, the same 1e-6 the cue itself uses. */
const CUE_DEGENERATE_LEN = 1e-6;

/**
 * THE SPEED AXIS — RC-C0b §P.B: `|carrier.vel|` in m/s, bins [0,1) · [1,2) · [2,3.5) ·
 * [3.5,5) · [5,∞). The edges are anchored to the shipped `BASE_SPEED` table × the pace span
 * and the pure `topSpeed` getter, which cap any body under 8.9 m/s.
 */
export const RC_READY_SPEED_EDGES: readonly number[] = Object.freeze([1, 2, 3.5, 5]);
/**
 * THE ANGULAR-SPEED AXIS — RC-C0b §P.B: the angle between the carrier's heading at this tick
 * and at the previous tick, divided by `DT`, in rad/s; bins [0,0.5) · [0.5,2) · [2,4) ·
 * [4, TURN_RATE]. The top edge is a fraction of the engine's own turn cap, so the last bin is
 * "turning at 60 %+ of the fastest a body in this engine can turn".
 */
export const RC_READY_ANG_EDGES: readonly number[] = Object.freeze([0.5, 2, 4]);
/** 5 speed bins × 4 angular-speed bins × 6 rank slots. */
export const RC_READY_N_SPEED = RC_READY_SPEED_EDGES.length + 1;
export const RC_READY_N_ANG = RC_READY_ANG_EDGES.length + 1;
export const RC_READY_N_RANK = 6;
export const RC_READY_N_CELL = RC_READY_N_SPEED * RC_READY_N_ANG * RC_READY_N_RANK;

/** The carrier's speed bin. PURE. */
export function rcSpeedBin(speed: number): number {
  return edgeBin(speed, RC_READY_SPEED_EDGES);
}

/**
 * The carrier's heading ANGULAR-SPEED bin, from the two consecutive headings themselves
 * (RC-C0b's `angSpeedOf`: the unsigned angle between them, over `DT`).
 *
 * ⭐ THE DEGENERATE RULE, RC-C0b §P.B verbatim: "A tick whose angular speed is not finite (a
 * degenerate heading) enters NO cell" — so a zero-length heading on either side returns
 * **−1**, "no bin", and `rcCellIndex` then returns −1, "no cell". ⚠ This is NOT `edgeBin`'s
 * job: `edgeBin(NaN, …)` would fall through to the TOP bin, which is why the finiteness test
 * lives here, exactly as the census's live path tests it before binning.
 */
export function rcAngSpeedBin(
  prevHx: number, prevHy: number, hx: number, hy: number,
): number {
  const l0 = Math.sqrt(prevHx * prevHx + prevHy * prevHy);
  const l1 = Math.sqrt(hx * hx + hy * hy);
  if (!(l0 > CUE_DEGENERATE_LEN) || !(l1 > CUE_DEGENERATE_LEN)) return -1;
  const c = (prevHx * hx + prevHy * hy) / (l0 * l1);
  const a = Math.acos(c < -1 ? -1 : c > 1 ? 1 : c) / DT;
  if (!Number.isFinite(a)) return -1;
  return edgeBin(a, RC_READY_ANG_EDGES);
}

/**
 * The rank SLOT: ranks 1..5 take slots 0..4 and rank ≥ 6 takes the sixth slot (RC-C0b §P.B's
 * `RI_OF`). **Rank 0 — "no rank, no cue" (`alignmentRank`'s own no-cue return) — takes NO
 * slot** and returns −1, so a body the cue cannot see gets no cell and hence no belief.
 * PURE.
 */
export function rcRankSlot(rank: number): number {
  if (!Number.isInteger(rank) || rank < 1) return -1;
  return rank > RC_READY_N_RANK ? RC_READY_N_RANK - 1 : rank - 1;
}

/**
 * ⭐⭐ THE CELL INDEX — RC-C0b's OWN ORDERING, read off its probe's `CELL_OF`
 * (`scripts/probes/rc-c0b-detector-census.ts`) and stored in the artifact's own
 * `cellDefinition.cellIndex` field VERBATIM:
 *
 *   "(speedBin · NANG + angBin) · NRANK + (rank − 1), clamped at rank ≥ 6 into the ..."
 *
 * ⚠ NEVER GUESSED: the pin reproduces `familyF.cells` = [18, 42, 66, 90, 114] (the top
 * angular-speed bin ∧ rank 1 across the five speed bins) from this formula, which fixes the
 * ordering of the two inner axes beyond doubt.
 *
 * Any component < 0 ("no bin", "no slot") ⇒ **−1, no cell**. PURE.
 */
export function rcCellIndex(speedBin: number, angBin: number, rankSlot: number): number {
  if (speedBin < 0 || angBin < 0 || rankSlot < 0) return -1;
  return (speedBin * RC_READY_N_ANG + angBin) * RC_READY_N_RANK + rankSlot;
}

/**
 * The whole cell in one call, from EXTERNAL scalars only: the carrier's speed, his heading at
 * this tick and at the previous tick, and my alignment rank among his same-side mates.
 * Returns −1 when any axis is degenerate. PURE — six numbers in, one integer out.
 */
export function rcReadyCell(
  carrierSpeed: number,
  prevHx: number, prevHy: number, hx: number, hy: number,
  rank: number,
): number {
  return rcCellIndex(
    rcSpeedBin(carrierSpeed), rcAngSpeedBin(prevHx, prevHy, hx, hy), rcRankSlot(rank),
  );
}

/* ========================================================================== */
/* §2 THE BELIEF — RC-C0b's OWN MEASUREMENT, NOT A WEIGHT (M-RC.2)             */
/* ========================================================================== */

/**
 * ⭐⭐ THE TABLE'S DERIVATION, IN FULL — the numbers are RC-C0b's, read off its artifact.
 *
 *   ARTIFACT  `docs/world-model/data/rc-c0b-detector-census.json`
 *   BYTE-HASH `a07d5692879f98173b7b470ed47b704525dd5236ec6573026b8f334d95bd0f83`
 *             (sha256 of the FILE, the hash of record at ruling #378 item 6)
 *   BODY-HASH `37cdff0b108e24ea0517882e089387c0a4e2124b221c0984c0b7d96606edf41b`
 *             (the artifact's own `hashedBodySha256`, the NON-body receipt form)
 *   FIELDS    `bins.cellTicks.E[cell]`            — the denominators below
 *             `bins.cellWindupTargetMe.E[cell]`   — the numerators below
 *
 * THE ARM IS **E**, the EMPTY-BOOK arm — RC-C0b's licence arm (#373 item 2), the form in
 * which the detector was licensed. The DOSED arm's own 120 quotients are published beside in
 * the stage doc as the book-independence check and are re-derived off the same artifact by
 * the pin suite; they are NOT in this module and the seat never reads them.
 *
 * ⭐⭐ WHAT THE QUOTIENT IS. Ruling #373's status line carries TWO measured tables —
 * P(a wind-up is live | cell) and P(the target is me | a wind-up is live, cell) — and their
 * PRODUCT over a SHARED cell is the stored joint:
 *
 *   belief(cell) = P(wind-up ∧ target = me | cell)
 *                = [cellWindup[cell] / cellTicks[cell]] × [cellWindupTargetMe[cell] / cellWindup[cell]]
 *                = cellWindupTargetMe[cell] / cellTicks[cell]
 *
 * so the seat stores the two ends and never the middle — one division, no rounding, and the
 * `cellWindup` arm cancels exactly.
 *
 * ⭐ THE ONE WRITTEN RULE: **`cellTicks[cell] === 0` ⇒ belief 0** — no measurement, no belief.
 * It exists only to give the zero denominator a value; it is NOT a count floor and NOT a
 * threshold (⛔ ruling #378 item 6(ii): sparse cells are an HONEST LIMIT with their counts
 * published, never a suppression rule). In this battery the only empty cells are the twenty
 * rank ≥ 6 slots, which 6v6 can never fill.
 *
 * ⭐ STORED AS TWO INTEGER ARRAYS, NEVER AS ROUNDED DECIMALS, so G-TABLE can re-derive all
 * 120 quotients from the artifact ON DISK and compare them BIT-EXACTLY (`toBe`). The
 * transcription below is the artifact's own integers; the pin is what proves it.
 */
export const RC_READY_TICKS_E: readonly number[] = Object.freeze([
  863874, 863874, 863874, 863868, 850968, 0,
  6493, 6493, 6493, 6493, 6431, 0,
  6931, 6931, 6931, 6931, 6872, 0,
  191229, 191229, 191229, 191229, 189414, 0,
  151196, 151196, 151196, 151193, 148499, 0,
  29729, 29729, 29729, 29729, 29276, 0,
  28437, 28437, 28437, 28437, 28115, 0,
  238667, 238667, 238667, 238667, 236471, 0,
  156455, 156455, 156455, 156455, 154074, 0,
  81824, 81824, 81824, 81824, 80965, 0,
  98923, 98923, 98923, 98923, 97918, 0,
  284022, 284022, 284022, 284022, 281161, 0,
  172366, 172366, 172366, 172366, 170129, 0,
  135855, 135855, 135855, 135855, 134488, 0,
  189062, 189062, 189062, 189062, 187313, 0,
  134660, 134660, 134660, 134660, 133440, 0,
  596106, 596106, 596106, 596106, 588525, 0,
  426759, 426759, 426759, 426759, 422650, 0,
  290027, 290027, 290027, 290027, 286837, 0,
  99247, 99247, 99247, 99247, 98404, 0,
]);
/** `bins.cellWindupTargetMe.E` — the wind-up ∧ target = me counts, per cell (RC-C0b §R1). */
export const RC_READY_WINDUP_TARGET_ME_E: readonly number[] = Object.freeze([
  5050, 652, 762, 3695, 2584, 0,
  245, 3, 0, 0, 0, 0,
  383, 4, 0, 0, 0, 0,
  34123, 25766, 21105, 13333, 6762, 0,
  5733, 148, 23, 49, 58, 0,
  424, 9, 0, 0, 0, 0,
  548, 5, 0, 0, 0, 0,
  21746, 16682, 13027, 7830, 4342, 0,
  7553, 140, 64, 136, 130, 0,
  661, 4, 1, 0, 0, 0,
  834, 6, 1, 0, 0, 0,
  32462, 21989, 16189, 9403, 4656, 0,
  7715, 148, 36, 64, 54, 0,
  657, 8, 0, 0, 0, 0,
  768, 16, 2, 0, 0, 0,
  32231, 19873, 13506, 6835, 2820, 0,
  4104, 36, 1, 0, 0, 0,
  489, 2, 1, 0, 0, 0,
  565, 3, 0, 0, 0, 0,
  23168, 16222, 9061, 3794, 1573, 0,
]);
/**
 * ⭐⭐ THE BELIEF TABLE — P(a wind-up is live ∧ its target is me | this cell), for all 120
 * cells, DERIVED from the two arrays above rather than typed as decimals.
 */
export const RC_READY_BELIEF_E: readonly number[] = Object.freeze(
  RC_READY_TICKS_E.map((n, i) => (n === 0 ? 0 : RC_READY_WINDUP_TARGET_ME_E[i] / n)),
);

/**
 * The belief a cell buys. **0 for cell < 0** (no cell — a degenerate heading, no rank, or a
 * carrier the cue cannot see) and 0 outside the table. PURE.
 */
export function rcReadyBelief(cell: number): number {
  if (!Number.isInteger(cell) || cell < 0 || cell >= RC_READY_BELIEF_E.length) return 0;
  return RC_READY_BELIEF_E[cell];
}
