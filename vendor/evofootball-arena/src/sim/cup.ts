import type { Franchise } from '../evolution/franchise';
import type { PlayerAttributes } from '../evolution/playerGenome';
import { hashSeed, Rng } from '../utils/rng';
import type { Division } from './League';
import { ROSTER_SIZE } from './types';

/**
 * The Evo Cup: a deterministic single-elimination knockout across both
 * divisions, woven between league rounds. Pure bracket logic lives here so
 * it is unit-testable; the League owns the state and the fixture scheduling.
 *
 * Rules (all deterministic, no live RNG state):
 *  - 16 entrants (all of Premier + Challenger), seeded 1–16 at draw time:
 *    Premier 1–8 by Elo, Challenger 9–16 by Elo. Higher number = underdog.
 *  - The R16 draw pairs every Premier side against a Challenger side
 *    (hash-shuffled), with Premier seeds placed so top seeds meet late.
 *  - The underdog hosts every tie — the cup loves an upset.
 *  - A DRAWN tie is decided by the league's cup draw mode (Phase 22):
 *    'shootout' (new-league default) runs a deterministic seeded penalty
 *    shootout — kicker finishing vs keeper reflexes, best-of-5 then sudden
 *    death — recorded on the tie as `shootout`; 'underdog' (and the
 *    shootout's 15-round failsafe) sends the LOWER-DIVISION (else
 *    lower-seeded) team through, surfaced via `byDrawRule`. No extra time
 *    either way — the match engine stays untouched.
 *  - Cup ties are standalone: no league table/Elo/season-stat/fitness
 *    bookkeeping (same pattern as the promotion playoff decider).
 */

export const CUP_NAME = 'Evo Cup';
export const CUP_ROUNDS = 4;
export const CUP_ROUND_NAMES = ['Round of 16', 'Quarter-final', 'Semi-final', 'Final'] as const;
export const CUP_ROUND_SHORT = ['R16', 'QF', 'SF', 'Final'] as const;
/** Seed-derivation tag: cup match seed = hash(leagueSeed, generation, 0xC0 + round, index). */
export const CUP_SEED_TAG = 0xc0;
/** The R16 draw shuffle uses hash(leagueSeed, generation, 0xC5). */
export const CUP_DRAW_TAG = 0xc5;
/** Shootout rng seed = hash(leagueSeed, generation, 0xB0 + round, index). */
export const CUP_SHOOTOUT_TAG = 0xb0;

/** How drawn cup ties are decided (league-screen setting, persisted). */
export type CupDrawMode = 'shootout' | 'underdog';

export interface CupEntrant {
  slot: number;
  /** Name at draw time — history views stay honest across later renames. */
  name: string;
  division: Division;
  /** 1–16; Premier 1–8, Challenger 9–16, by Elo at draw time. Higher = underdog. */
  seed: number;
  /** Elo at draw time (rounded), for bracket display. */
  elo: number;
}

export interface CupTie {
  round: number; // 0 = R16, 1 = QF, 2 = SF, 3 = Final
  index: number; // within the round
  /** Franchise slots; -1 until the feeder ties resolve. The underdog hosts. */
  home: number;
  away: number;
  played: boolean;
  scoreH?: number;
  scoreA?: number;
  winner?: number; // slot
  /** Giant killing: the lower-division side knocked out a higher-division side. */
  upset?: boolean;
  /** The tie ended level and the draw rule (underdog advances) decided it. */
  byDrawRule?: boolean;
  /** The tie ended level and a penalty shootout decided it (Phase 22). */
  shootout?: ShootoutResult;
}

export interface CupState {
  entrants: CupEntrant[]; // 16
  /** 15 ties in bracket order: R16 0–7, QF 0–3, SF 0–1, Final 0. */
  ties: CupTie[];
  /** Cup goals per [slot][playerIndex] — cup-only, never enters fitness. */
  playerGoals: number[][];
}

/** SeasonRecord entry: the completed bracket plus mined story data. */
export interface CupRecord {
  winnerSlot: number;
  winnerName: string;
  runnerUpName: string;
  entrants: CupEntrant[];
  ties: CupTie[];
  /** Giant killings, in bracket order. */
  upsets: Array<{ round: number; winnerName: string; loserName: string; score: [number, number] }>;
  topScorer: { name: string; team: string; goals: number } | null;
}

/** Bracket placement of Premier seeds 1..8 so 1 and 2 can only meet in the final. */
const PREMIER_BRACKET_ORDER = [0, 7, 3, 4, 1, 6, 2, 5];

/**
 * Draw the cup at season start. Seeding uses Elo as of the draw (ties broken
 * by slot); the Challenger opponents are shuffled with a hashed seed so every
 * league/generation gets its own draw.
 */
export function buildCup(franchises: Franchise[], leagueSeed: number, generation: number): CupState {
  const byElo = (d: Division) =>
    franchises
      .filter((f) => f.division === d)
      .sort((a, b) => b.elo - a.elo || a.slot - b.slot);
  const premier = byElo(0);
  const challenger = byElo(1);
  const entrants: CupEntrant[] = [...premier, ...challenger].map((f, i) => ({
    slot: f.slot,
    name: f.name,
    division: f.division,
    seed: i + 1,
    elo: Math.round(f.elo),
  }));

  const rng = new Rng(hashSeed(leagueSeed, generation, CUP_DRAW_TAG));
  const drawnChallengers = rng.shuffle([...challenger]);

  const ties: CupTie[] = [];
  for (let i = 0; i < 8; i++) {
    ties.push({
      round: 0,
      index: i,
      // Every R16 tie is Premier vs Challenger; the underdog (Challenger) hosts.
      home: drawnChallengers[i].slot,
      away: premier[PREMIER_BRACKET_ORDER[i]].slot,
      played: false,
    });
  }
  for (let round = 1; round < CUP_ROUNDS; round++) {
    for (let index = 0; index < 8 >> round; index++) {
      ties.push({ round, index, home: -1, away: -1, played: false });
    }
  }
  return {
    entrants,
    ties,
    playerGoals: franchises.map(() => Array.from({ length: ROSTER_SIZE }, () => 0)),
  };
}

export function cupTie(cup: CupState, round: number, index: number): CupTie {
  return cup.ties.find((t) => t.round === round && t.index === index)!;
}

export function cupEntrant(cup: CupState, slot: number): CupEntrant {
  return cup.entrants.find((e) => e.slot === slot)!;
}

/** The underdog of a pairing: higher seed number (lower division always is). */
export function cupUnderdog(cup: CupState, slotA: number, slotB: number): number {
  return cupEntrant(cup, slotA).seed > cupEntrant(cup, slotB).seed ? slotA : slotB;
}

/* ---------------- penalty shootout (Phase 22) ---------------- */

export interface ShootoutSquad {
  /** Kicker finishing in kick order: best outfield finishers first, keeper last. */
  kickers: number[];
  /** Player indices in the same kick order — presentation reads WHO kicks. */
  order: number[];
  gkReflexes: number;
}

export interface ShootoutResult {
  scoreH: number;
  scoreA: number;
  /** True when the best-of-5 stayed level and sudden death decided it. */
  sudden: boolean;
}

/** One kick of a shootout, for kick-by-kick presentation (Phase 24). */
export interface ShootoutKick {
  /** 0 = home kicks (hosts go first). */
  side: 0 | 1;
  /** Kicking player's index within their team. */
  kicker: number;
  scored: boolean;
  /** Running shootout score after this kick. */
  h: number;
  a: number;
  sudden: boolean;
}

/** Kick order from squad DNA: outfielders by finishing (index tiebreak), GK last. */
export function shootoutLineup(squad: PlayerAttributes[]): ShootoutSquad {
  // Starters only (Phase 61): the bench doesn't take shootout kicks — the
  // cup layer doesn't track who was on at FT, and the shootout theater
  // stages the starting cast (kicker indices must map onto pitch gids).
  const outfield = squad
    .slice(0, 6)
    .map((_, i) => i)
    .slice(1)
    .sort((i, j) => squad[j].finishing - squad[i].finishing || i - j);
  const order = [...outfield, 0];
  return {
    kickers: order.map((i) => squad[i].finishing),
    order,
    gkReflexes: squad[0].reflexes,
  };
}

/**
 * Deterministic penalty shootout. Each kick scores with probability
 * 0.74 + (finishing−0.5)·0.3 − (keeperReflexes−0.5)·0.3 (clamped 0.35–0.95;
 * ~74% baseline matches real-world conversion). Best-of-5 with kicks
 * alternating (hosts first) and stopping the moment the trailing side can't
 * catch up, then sudden-death pairs cycling the lineup. Returns null in the
 * astronomically unlikely event ten sudden-death rounds stay level — the
 * caller falls back to the underdog rule so resolution stays total.
 *
 * `kicks`, when given, records every kick in strike order for kick-by-kick
 * presentation. Recording changes NO rng draws — results are identical with
 * or without it (regression-tested), so persisted saves never shift.
 */
export function resolveShootout(
  home: ShootoutSquad,
  away: ShootoutSquad,
  rng: Rng,
  kicks?: ShootoutKick[],
): ShootoutResult | null {
  const kickP = (finishing: number, reflexes: number): number =>
    Math.min(0.95, Math.max(0.35, 0.74 + (finishing - 0.5) * 0.3 - (reflexes - 0.5) * 0.3));
  const BEST_OF = 5;
  let h = 0;
  let a = 0;
  let hTaken = 0;
  let aTaken = 0;
  const decided = (): boolean => h > a + (BEST_OF - aTaken) || a > h + (BEST_OF - hTaken);
  const record = (side: 0 | 1, lineup: number, scored: boolean, sudden: boolean): void => {
    kicks?.push({ side, kicker: (side === 0 ? home : away).order[lineup], scored, h, a, sudden });
  };

  for (let kick = 0; kick < BEST_OF * 2 && !decided(); kick++) {
    if (kick % 2 === 0) {
      const scored = rng.chance(kickP(home.kickers[hTaken], away.gkReflexes));
      if (scored) h++;
      record(0, hTaken, scored, false);
      hTaken++;
    } else {
      const scored = rng.chance(kickP(away.kickers[aTaken], home.gkReflexes));
      if (scored) a++;
      record(1, aTaken, scored, false);
      aTaken++;
    }
  }
  if (h !== a) return { scoreH: h, scoreA: a, sudden: false };

  for (let round = 0; round < 10; round++) {
    // Sudden death continues down the lineup (the 6th kicker is the keeper),
    // then cycles back to the best finisher.
    const kicker = (BEST_OF + round) % home.kickers.length;
    const hScores = rng.chance(kickP(home.kickers[kicker], away.gkReflexes));
    const aScores = rng.chance(kickP(away.kickers[kicker], home.gkReflexes));
    if (hScores) h++;
    record(0, kicker, hScores, true);
    if (aScores) a++;
    record(1, kicker, aScores, true);
    if (hScores !== aScores) return { scoreH: h, scoreA: a, sudden: true };
  }
  return null;
}

/**
 * Apply a tie's final score: pick the winner and flag giant killings.
 * A draw goes to the shootout when `shootout` context is provided (mode
 * 'shootout'); otherwise — or on the shootout failsafe — the underdog
 * advances. Returns the resolved tie.
 */
export function resolveCupTie(
  cup: CupState,
  round: number,
  index: number,
  scoreH: number,
  scoreA: number,
  shootout?: { home: ShootoutSquad; away: ShootoutSquad; rng: Rng },
): CupTie {
  const tie = cupTie(cup, round, index);
  tie.played = true;
  tie.scoreH = scoreH;
  tie.scoreA = scoreA;
  if (scoreH !== scoreA) {
    tie.winner = scoreH > scoreA ? tie.home : tie.away;
  } else {
    const pens = shootout ? resolveShootout(shootout.home, shootout.away, shootout.rng) : null;
    if (pens) {
      tie.shootout = pens;
      tie.winner = pens.scoreH > pens.scoreA ? tie.home : tie.away;
    } else {
      tie.byDrawRule = true;
      tie.winner = cupUnderdog(cup, tie.home, tie.away);
    }
  }
  const loser = tie.winner === tie.home ? tie.away : tie.home;
  tie.upset = cupEntrant(cup, tie.winner).division > cupEntrant(cup, loser).division;
  return tie;
}

/** True once every tie of `round` has been played. */
export function cupRoundComplete(cup: CupState, round: number): boolean {
  return cup.ties.filter((t) => t.round === round).every((t) => t.played);
}

/**
 * Fill the ties of `round` from the previous round's winners (bracket order:
 * tie i takes the winners of feeders 2i and 2i+1). The underdog hosts.
 */
export function fillCupRound(cup: CupState, round: number): CupTie[] {
  const ties = cup.ties.filter((t) => t.round === round);
  for (const tie of ties) {
    const w0 = cupTie(cup, round - 1, tie.index * 2).winner!;
    const w1 = cupTie(cup, round - 1, tie.index * 2 + 1).winner!;
    tie.home = cupUnderdog(cup, w0, w1);
    tie.away = tie.home === w0 ? w1 : w0;
  }
  return ties;
}

/** Snapshot the finished cup into a SeasonRecord entry (deep-copied). */
export function buildCupRecord(cup: CupState, playerNameOf: (slot: number, i: number) => string): CupRecord {
  const final = cupTie(cup, CUP_ROUNDS - 1, 0);
  const winner = cupEntrant(cup, final.winner!);
  const runnerUp = cupEntrant(cup, final.winner === final.home ? final.away : final.home);

  let topScorer: CupRecord['topScorer'] = null;
  cup.playerGoals.forEach((goals, slot) => {
    goals.forEach((g, i) => {
      if (g > 0 && (!topScorer || g > topScorer.goals)) {
        topScorer = { name: playerNameOf(slot, i), team: cupEntrant(cup, slot).name, goals: g };
      }
    });
  });

  return {
    winnerSlot: winner.slot,
    winnerName: winner.name,
    runnerUpName: runnerUp.name,
    entrants: cup.entrants.map((e) => ({ ...e })),
    ties: cup.ties.map((t) => ({ ...t })),
    upsets: cup.ties
      .filter((t) => t.upset)
      .map((t) => ({
        round: t.round,
        winnerName: cupEntrant(cup, t.winner!).name,
        loserName: cupEntrant(cup, t.winner === t.home ? t.away : t.home).name,
        score: [t.scoreH!, t.scoreA!] as [number, number],
      })),
    topScorer,
  };
}
