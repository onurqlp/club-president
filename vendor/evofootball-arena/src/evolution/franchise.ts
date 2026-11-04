import { deriveTeamStyle, emptyChannels, type GoalChannel } from '../sim/types';
import type { Rng } from '../utils/rng';
import { emptyCareer, veteranAge, type PlayerCareer } from './careers';
import { createCoach, type Coach } from './coach';
import { randomGenome } from './genome';
import { KIT_COLORS, generatePlayerNames, shortName, uniqueTeamName } from './names';
import { ROSTER_ROLES, enforceBudget, randomSquad, type PlayerAttributes } from './playerGenome';
import { neutralSquadStyles, type PlayerStyle } from './playerStyle';
import { defaultPolicyGenes } from './policyGenome';

/** One historical entry in a franchise's evolutionary lineage. */
export interface LineageEntry {
  generation: number;
  event: 'founded' | 'elite' | 'mutated' | 'reborn' | 'promoted' | 'relegated'
    | 'sacked' | 'hired' | 'coach-retired';
  /** Parent team names for 'reborn' (crossover) entries. */
  parents?: string[];
  fitness?: number;
  note?: string;
}

/**
 * A league slot that persists across seasons. Elite franchises keep their
 * coach's philosophy; weak ones are reborn from crossover — the slot (and
 * kit color) stays, so you can follow a lane through history.
 *
 * Phase 53: the tactical genome / policy genes / formation identity moved
 * INTO `coach` — a named, aging person the philosophy is embodied in. The
 * club keeps the structural assets: squad, academy bloodline, budget,
 * colors, division, lineage, Elo (and prestige/rivalries, derived).
 */
export interface Franchise {
  slot: number;
  id: string;
  name: string;
  short: string;
  colors: { primary: number; secondary: number };
  playerNames: string[];
  /** The philosophy, embodied (Phase 53): genome + policy + style live here. */
  coach: Coach;
  /** Per-player attribute genes, roster order [GK, DF, MF, WGL, WGR, ST,
   * bench DF, bench MF, bench ST] (Phase 61: the bench joins the roster). */
  squad: PlayerAttributes[];
  /** Per-player decision-style multipliers (Phase 54) — personal appetites
   * on the coach's policy, inherited through the academy bloodline. */
  squadStyles: PlayerStyle[];
  /** Player ages in slot order (Phase 26) — drive development & retirement. */
  ages: number[];
  /** Career ledgers in slot order — accumulated season stats + seasons. */
  careers: PlayerCareer[];
  /**
   * Matches of suspension remaining per roster row (Phase 62 — CARDS THAT
   * BIND): a red card (any fixture) or every SUSPENSION_YELLOWS-th league
   * booking costs the MAN the club's next match — his slot is covered by
   * the like-for-like bench body. Served on any fixture played; cleared at
   * season end (rows change people through retirement/rebirth).
   */
  suspensions: number[];
  /** Matches of INJURY absence remaining per roster row (Phase 118) —
   * the suspension seam's twin: same decrement, same lineup exclusion,
   * cleared at season end. Banked from MatchResult.injuries. */
  injuries: number[];
  elo: number;
  /**
   * TEAM MORALE (Phase 111, Stage 4): rolling confidence in [0.1, 0.9],
   * neutral 0.5 — wins lift it, losses sink it, and it mean-reverts every
   * round (streaks fade). What morale DOES to the football is priced by
   * the moraleSensitivity gene: the steady pros ignore it, the confidence
   * team rides highs and crumbles in slumps. Persisted (save v26).
   */
  morale: number;
  /** 0 = top flight, 1 = second division. Changes via promotion/relegation. */
  division: 0 | 1;
  lineage: LineageEntry[];
}

export function createFranchise(
  slot: number,
  rng: Rng,
  takenNames: Set<string>,
  division: 0 | 1 = 0,
  generation = 1,
): Franchise {
  const name = uniqueTeamName(rng, takenNames);
  const genome = randomGenome(rng);
  return {
    slot,
    id: `T${slot}-g${generation}`,
    name,
    short: shortName(name),
    colors: KIT_COLORS[slot % KIT_COLORS.length],
    playerNames: generatePlayerNames(rng),
    coach: createCoach(rng, genome, defaultPolicyGenes(), deriveTeamStyle(genome)),
    squad: enforceBudget(randomSquad(rng)),
    // Everyone is born playing the coach's way (×1.0) — personal style is
    // EARNED through bloodline inheritance + selection, never seeded.
    squadStyles: neutralSquadStyles(ROSTER_ROLES.length),
    ages: ROSTER_ROLES.map(() => veteranAge(rng)),
    careers: ROSTER_ROLES.map(() => emptyCareer()),
    suspensions: ROSTER_ROLES.map(() => 0),
    injuries: ROSTER_ROLES.map(() => 0),
    elo: 1500,
    morale: 0.5,
    division,
    lineage: [{ generation, event: 'founded' }],
  };
}

/** Season totals per franchise, accumulated by the League — input to fitness. */
export interface SeasonAggregates {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  gf: number;
  ga: number;
  pts: number;
  shots: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  recoveries: number;
  staminaSpent: number;
  distance: number;
  /** Cards picked up over the season (Phase 25) — feeds the dirtiest-team award. */
  yellows: number;
  reds: number;
  /** Longest completed-pass chain in one move this season (Phase 33). */
  longestChain: number;
  /** Goals scored/conceded by channel (Phase 113) — the 进球管道 ledgers.
   * Passive: displayed, never read by fitness. */
  chFor: Record<GoalChannel, number>;
  chAgainst: Record<GoalChannel, number>;
  /** Per-match style samples for consistency scoring. */
  styleSamples: Array<{ passVol: number; pressVol: number }>;
}

export const emptyAggregates = (): SeasonAggregates => ({
  played: 0,
  wins: 0,
  draws: 0,
  losses: 0,
  gf: 0,
  ga: 0,
  pts: 0,
  shots: 0,
  xg: 0,
  passes: 0,
  passesCompleted: 0,
  recoveries: 0,
  staminaSpent: 0,
  distance: 0,
  yellows: 0,
  reds: 0,
  longestChain: 0,
  chFor: emptyChannels(),
  chAgainst: emptyChannels(),
  styleSamples: [],
});
