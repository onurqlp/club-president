import type { TeamStyle } from '../sim/types';
import type { Rng } from '../utils/rng';
import type { TacticalGenome } from './genome';
import { coachName } from './names';
import type { PolicyGenes } from './policyGenome';

/**
 * THE COACH (Phase 53 — Stage 3 W1). The tactical philosophy stops being an
 * anonymous property of the club and becomes a PERSON: the tactical genome,
 * the evolved policy genes and the formation identity live on a named, aging
 * coach. The club keeps what is structurally the club's — squad, academy,
 * budget, colors, prestige, rivalries, division, lineage.
 *
 * Why it matters for evolution: philosophies gain a second, MEMETIC channel.
 * Until now ideas spread only through death (rebirth crossover); with an
 * embodied coach they can also spread by MOVEMENT — a sacked or orphaned
 * coach carries his philosophy to a new club intact. Same genetic operators,
 * new transmission graph. ⚠ Mobility accelerates convergence — the
 * coach-mobility probe is a hard monoculture gate.
 */

export interface CoachCareer {
  seasons: number;
  /** Premier titles won from the dugout. */
  titles: number;
  cups: number;
  promotions: number;
  sackings: number;
  /** Clubs managed, this one included. */
  clubs: number;
}

export interface Coach {
  name: string;
  age: number;
  genome: TacticalGenome;
  policy: PolicyGenes;
  /** Formation identity — the philosophy's SHAPE travels with the person. */
  style: TeamStyle;
  career: CoachCareer;
  /** Whose retiring philosophy seeded this coach (the mentor tree). */
  mentor?: string;
}

/** A retired coach worth remembering — the dugout hall of fame keeps the best. */
export interface CoachLegend {
  name: string;
  age: number;
  career: CoachCareer;
  mentor?: string;
  lastClub: string;
}

/** An out-of-work coach: a dead club's ex-manager or a sacked boss. His
 * philosophy travels with him — the memetic channel's supply side. */
export interface PoolEntry {
  coach: Coach;
  /** Generation he entered the pool. */
  sinceGen: number;
  /** His club's fitness when the job ended — what a hiring board can see. */
  lastFitness: number;
  lastClub: string;
}

export const emptyCoachCareer = (): CoachCareer => ({
  seasons: 0,
  titles: 0,
  cups: 0,
  promotions: 0,
  sackings: 0,
  clubs: 1,
});

/** Founding-era coaches span mid-career (38–58). */
export function foundingCoachAge(rng: Rng): number {
  return 38 + rng.int(0, 20);
}

/** Newly minted coaches (successors, rebirth hires) start young (34–42). */
export function rookieCoachAge(rng: Rng): number {
  return 34 + rng.int(0, 8);
}

/** Retirement odds at season end: none before 62, certain by ~67. */
export function coachRetireChance(age: number): number {
  if (age < 62) return 0;
  return Math.min(1, 0.15 + (age - 62) * 0.18);
}

export function createCoach(
  rng: Rng,
  genome: TacticalGenome,
  policy: PolicyGenes,
  style: TeamStyle,
  opts: { age?: number; mentor?: string } = {},
): Coach {
  return {
    name: coachName(rng),
    age: opts.age ?? foundingCoachAge(rng),
    genome,
    policy,
    style,
    career: emptyCoachCareer(),
    mentor: opts.mentor,
  };
}
