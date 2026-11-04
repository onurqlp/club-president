import { League } from './League';

/**
 * Headless fast-sim core — the exact loop the sim worker executes, kept as a
 * pure sim-side function so vitest can prove it equivalent to simulating on
 * the League directly (same seed ⇒ byte-identical save JSON).
 *
 * Ownership note: the caller owns cloning. `League.fromJSON` adopts the data
 * object's arrays by reference, so pass a copy (postMessage's structured
 * clone provides one for free in the worker path).
 */

export type SimRequest =
  /** Simulate until the league reaches this generation (season/10-seasons). */
  | { kind: 'toGeneration'; target: number }
  /** Simulate to the end of the current league/cup round (or the playoff). */
  | { kind: 'round' };

export interface SimProgress {
  matches: number;
  generation: number;
  /** Set on season boundaries so the UI can narrate long runs. */
  seasonFinished?: boolean;
}

export interface SimOutcome {
  /** League save data (v-current) after the run — feed to League.fromJSON. */
  league: Record<string, unknown>;
  matches: number;
  seasonsCompleted: number;
}

export function runHeadless(
  data: Record<string, unknown>,
  req: SimRequest,
  onProgress?: (p: SimProgress) => void,
  progressEvery = 8,
): SimOutcome {
  const league = League.fromJSON(data);
  let matches = 0;
  let seasonsCompleted = 0;

  // Round runs stop when the round context changes — same grouping rule as
  // GameApp.simRound (generation, displayed round, league-vs-cup block).
  const gen0 = league.generation;
  const round0 = league.currentRound();
  const cup0 = league.nextFixture()?.cup ?? false;
  const done = (): boolean =>
    req.kind === 'toGeneration'
      ? league.generation >= req.target
      : league.generation !== gen0 ||
        league.currentRound() !== round0 ||
        (league.nextFixture()?.cup ?? false) !== cup0;

  while (!done()) {
    const f = league.nextFixture();
    if (!f) break; // defensive: a saved league is never parked on seasonDone
    league.applyResult(f, league.createMatch(f).runToCompletion());
    matches++;
    if (league.seasonDone) {
      league.finishSeason();
      seasonsCompleted++;
      onProgress?.({ matches, generation: league.generation, seasonFinished: true });
    } else if (matches % progressEvery === 0) {
      onProgress?.({ matches, generation: league.generation });
    }
  }

  return { league: league.toJSON() as Record<string, unknown>, matches, seasonsCompleted };
}
