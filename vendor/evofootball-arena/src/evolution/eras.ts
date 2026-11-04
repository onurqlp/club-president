import type { SeasonRecord } from '../sim/League';
import { STYLE_DIMS, dimStats, nameplateFor } from './styleSpace';

/**
 * ERAS (Phase 52 — Stage 3 W4): the chronicle's chapters grouped into named
 * ages, DISCOVERED from the records per the emergence meta-rule — never
 * preset. Two data signals, hand-built grammar only:
 *
 *   1. BOUNDARIES come from change-point segmentation on the population's
 *      style centroid (the per-season mean of every club's styleMatrix
 *      vector): a new era opens when the league's centre of tactical mass
 *      has drifted far enough from the running centre of the current era.
 *   2. NAMES are earned, in precedence order: a club that owned the era's
 *      titles makes it a DYNASTY; else the era centroid's most extreme
 *      nameable deviation from ALL season centroids (the same z-score →
 *      vocabulary grammar as club nameplates, applied across TIME instead
 *      of across clubs) makes it a STYLE age; else it stays CONTESTED —
 *      like 'Balanced' on a nameplate, the null is the earned default.
 *
 * A corollary worth keeping: a history that never changed character is ONE
 * era, and one era can never be style-named (its centroid IS the all-time
 * mean) — an age only gets a tactical name relative to other ages.
 *
 * Everything is pure over SeasonRecord[]; nothing feeds back into the sim.
 */

export type EraLabel =
  | { kind: 'dynasty'; club: string }
  | { kind: 'style'; word: string }
  | { kind: 'contested' };

export interface Era {
  /** Generation range covered, inclusive. */
  start: number;
  end: number;
  /** Recorded seasons inside the era. */
  seasons: number;
  label: EraLabel;
  /** Title tally inside the era, best first (the header's honours line). */
  honours: Array<{ name: string; titles: number }>;
}

/** An era must run at least this many seasons before a split is allowed
 * (the still-open tail era may be shorter). Grammar, like nameplate minZ. */
export const MIN_ERA_SEASONS = 3;
/** Scale-normalized mean per-dim distance from the era's running centroid
 * that opens a new era. Calibrated by probe (scripts/probes/chronicle-demo.ts)
 * so a 30–40 generation league reads as a handful of ages, not confetti. */
export const ERA_SPLIT_DRIFT = 0.045;
/** z threshold for style-naming an era. Deliberately below 1.0: a history
 * split into two clean equal ages puts every moved dim at EXACTLY z = ±1
 * (two symmetric clusters), and an epochal shift that clear must be
 * nameable, not lost to float jitter on the boundary. */
export const ERA_NAME_MIN_Z = 0.9;

/** Population style centroid of one season, or null when the record predates
 * styleMatrix (or was written under a different dim set). */
function centroidOf(rec: SeasonRecord): number[] | null {
  const m = rec.styleMatrix;
  if (!m || m.length === 0 || m.some((row) => row.values.length !== STYLE_DIMS.length)) return null;
  const out = new Array<number>(STYLE_DIMS.length).fill(0);
  for (const row of m) for (let i = 0; i < out.length; i++) out[i] += row.values[i];
  return out.map((v) => v / m.length);
}

function centroidDrift(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < STYLE_DIMS.length; i++) s += Math.abs(a[i] - b[i]) / STYLE_DIMS[i].scale;
  return s / STYLE_DIMS.length;
}

function labelFor(
  segment: SeasonRecord[],
  segmentCentroids: Array<number[] | null>,
  allCentroids: number[][],
): EraLabel {
  // Dynasty: one club (by name — a reborn franchise is a new team) owning
  // at least half the era's titles, and at least two of them.
  const counts = new Map<string, number>();
  for (const rec of segment) counts.set(rec.championName, (counts.get(rec.championName) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (top && top[1] >= Math.max(2, Math.ceil(segment.length / 2))) {
    return { kind: 'dynasty', club: top[0] };
  }

  // Style: the era's centroid z-scored against every season centroid on
  // record — needs other ages to deviate FROM.
  const own = segmentCentroids.filter((c): c is number[] => c !== null);
  if (own.length > 0 && allCentroids.length > own.length) {
    const eraCentroid = own[0].map((_, i) => own.reduce((a, c) => a + c[i], 0) / own.length);
    const words = nameplateFor(eraCentroid, dimStats(allCentroids), ERA_NAME_MIN_Z);
    if (words[0] !== 'Balanced') return { kind: 'style', word: words[0] };
  }
  return { kind: 'contested' };
}

/** Segment + name the recorded history. Oldest era first. */
export function detectEras(history: SeasonRecord[]): Era[] {
  if (history.length === 0) return [];
  const centroids = history.map(centroidOf);
  const allCentroids = centroids.filter((c): c is number[] => c !== null);

  // Index segments [from, to] into history.
  const segments: Array<[number, number]> = [];
  const firstStyled = centroids.findIndex((c) => c !== null);
  if (firstStyled === -1) {
    segments.push([0, history.length - 1]);
  } else {
    // The pre-styleMatrix prefix (old saves) is one age of its own.
    if (firstStyled > 0) segments.push([0, firstStyled - 1]);
    let from = firstStyled;
    let mean = centroids[firstStyled]!.slice();
    let n = 1;
    for (let i = firstStyled + 1; i < history.length; i++) {
      const c = centroids[i] ?? mean;
      if (i - from >= MIN_ERA_SEASONS && centroidDrift(c, mean) > ERA_SPLIT_DRIFT) {
        segments.push([from, i - 1]);
        from = i;
        mean = c.slice();
        n = 1;
      } else {
        n++;
        for (let k = 0; k < mean.length; k++) mean[k] += (c[k] - mean[k]) / n;
      }
    }
    segments.push([from, history.length - 1]);
  }

  return segments.map(([from, to]) => {
    const segment = history.slice(from, to + 1);
    const counts = new Map<string, number>();
    for (const rec of segment) counts.set(rec.championName, (counts.get(rec.championName) ?? 0) + 1);
    return {
      start: segment[0].generation,
      end: segment[segment.length - 1].generation,
      seasons: segment.length,
      label: labelFor(segment, centroids.slice(from, to + 1), allCentroids),
      honours: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, titles]) => ({ name, titles })),
    };
  });
}
