import type { Franchise } from '../evolution/franchise';
import { CUP_ROUND_NAMES, type CupRecord } from './cup';
import type { SeasonRecord } from './League';

/**
 * Record mining over season history — pure functions so the hall of fame and
 * season-report narratives are unit-testable. Slots are stable franchise
 * identities across the whole timeline (divisions change, slots don't), so
 * long-run stories are computed per slot and NAMED from the era they
 * happened in (records store names as they were at the time).
 */

/** Which division a slot played in during a recorded season (default 0 for the single-division era). */
export function divisionIn(rec: SeasonRecord, slot: number): 0 | 1 {
  return (rec.table.find((r) => r.slot === slot)?.division ?? 0) as 0 | 1;
}

/** Premier titles by team name (a renamed/reborn franchise is a new team). */
export function premierTitles(history: SeasonRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of history) out.set(r.championName, (out.get(r.championName) ?? 0) + 1);
  return out;
}

/** Challenger titles by team name. */
export function challengerTitles(history: SeasonRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of history) {
    if (r.d2Champion) out.set(r.d2Champion, (out.get(r.d2Champion) ?? 0) + 1);
  }
  return out;
}

/** Evo Cup titles by team name (pre-cup-era records simply have no cup). */
export function cupTitles(history: SeasonRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of history) {
    if (r.cup) out.set(r.cup.winnerName, (out.get(r.cup.winnerName) ?? 0) + 1);
  }
  return out;
}

/** Cup final appearances (winner + runner-up) by team name. */
export function cupFinalAppearances(history: SeasonRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of history) {
    if (!r.cup) continue;
    for (const name of [r.cup.winnerName, r.cup.runnerUpName]) {
      out.set(name, (out.get(name) ?? 0) + 1);
    }
  }
  return out;
}

/** Domestic doubles: Premier title + Evo Cup in the same season. */
export function domesticDoubles(history: SeasonRecord[]): Array<{ name: string; generation: number }> {
  return history
    .filter((r) => r.cup && r.cup.winnerSlot === r.championSlot && r.cup.winnerName === r.championName)
    .map((r) => ({ name: r.championName, generation: r.generation }));
}

/** Giant killings by the giant-killer's name, across all recorded cups. */
export function giantKillingCounts(history: SeasonRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of history) {
    for (const u of r.cup?.upsets ?? []) {
      out.set(u.winnerName, (out.get(u.winnerName) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Challenger sides that reached at least the cup semi-final in a season.
 * roundReached: 2 = semi-final, 3 = final; wonCup marks a full triumph.
 */
export function challengerCupRuns(cup: CupRecord): Array<{ name: string; roundReached: number; wonCup: boolean }> {
  const out: Array<{ name: string; roundReached: number; wonCup: boolean }> = [];
  for (const e of cup.entrants) {
    if (e.division !== 1) continue;
    let reached = -1;
    for (const t of cup.ties) {
      if (t.home === e.slot || t.away === e.slot) reached = Math.max(reached, t.round);
    }
    if (reached >= 2) out.push({ name: e.name, roundReached: reached, wonCup: cup.winnerSlot === e.slot });
  }
  return out.sort((a, b) => Number(b.wonCup) - Number(a.wonCup) || b.roundReached - a.roundReached);
}

/** Deepest cup run by a Challenger side across all history. */
export function bestChallengerCupRun(
  history: SeasonRecord[],
): { name: string; generation: number; roundReached: number; wonCup: boolean } | null {
  let best: { name: string; generation: number; roundReached: number; wonCup: boolean } | null = null;
  for (const r of history) {
    if (!r.cup) continue;
    for (const run of challengerCupRuns(r.cup)) {
      const depth = run.roundReached + (run.wonCup ? 1 : 0);
      if (!best || depth > best.roundReached + (best.wonCup ? 1 : 0)) {
        best = { ...run, generation: r.generation };
      }
    }
  }
  return best;
}

/** Most cup goals by one player in a single season. */
export function mostCupGoals(
  history: SeasonRecord[],
): { name: string; team: string; goals: number; generation: number } | null {
  let best: { name: string; team: string; goals: number; generation: number } | null = null;
  for (const r of history) {
    const s = r.cup?.topScorer;
    if (s && (!best || s.goals > best.goals)) best = { ...s, generation: r.generation };
  }
  return best;
}

/**
 * Revenge ties in one season's cup (default: the last): the winner had been
 * knocked out of a previous season's cup by that same opponent (matched by
 * name — a renamed or reborn franchise is a different team, so no fabricated
 * grudges).
 */
export function cupRevenges(
  history: SeasonRecord[],
  index = history.length - 1,
): Array<{ winnerName: string; loserName: string; round: number; prevGeneration: number }> {
  const rec = history[index];
  if (!rec?.cup) return [];
  const nameOf = (cup: CupRecord, slot: number) => cup.entrants.find((e) => e.slot === slot)?.name ?? '?';
  const out: Array<{ winnerName: string; loserName: string; round: number; prevGeneration: number }> = [];
  for (const tie of rec.cup.ties) {
    if (tie.winner === undefined) continue;
    const winnerName = nameOf(rec.cup, tie.winner);
    const loserName = nameOf(rec.cup, tie.winner === tie.home ? tie.away : tie.home);
    for (let i = index - 1; i >= 0; i--) {
      const prev = history[i];
      if (!prev.cup) continue;
      const grudge = prev.cup.ties.some((t) => {
        if (t.winner === undefined) return false;
        const w = nameOf(prev.cup!, t.winner);
        const l = nameOf(prev.cup!, t.winner === t.home ? t.away : t.home);
        return w === loserName && l === winnerName;
      });
      if (grudge) {
        out.push({ winnerName, loserName, round: tie.round, prevGeneration: prev.generation });
        break;
      }
    }
  }
  return out;
}

/** Promotion/relegation counts per franchise (lineage-based, survives renames). */
export function movementCounts(franchises: Franchise[]): Array<{
  name: string;
  promotions: number;
  relegations: number;
}> {
  return franchises.map((f) => ({
    name: f.name,
    promotions: f.lineage.filter((l) => l.event === 'promoted').length,
    relegations: f.lineage.filter((l) => l.event === 'relegated').length,
  }));
}

/** Longest unbroken run of Premier seasons, per slot; returns the best. */
export function longestPremierStreak(
  history: SeasonRecord[],
  franchises: Franchise[],
): { slot: number; name: string; length: number } | null {
  if (history.length === 0) return null;
  let best: { slot: number; name: string; length: number } | null = null;
  for (const f of franchises) {
    let run = 0;
    let bestRun = 0;
    for (const rec of history) {
      if (divisionIn(rec, f.slot) === 0) {
        run++;
        bestRun = Math.max(bestRun, run);
      } else {
        run = 0;
      }
    }
    // The streak may still be alive: count the current division too.
    if (f.division === 0 && divisionIn(history[history.length - 1], f.slot) === 0) {
      bestRun = Math.max(bestRun, run + 1);
    }
    if (bestRun > 0 && (!best || bestRun > best.length)) {
      best = { slot: f.slot, name: f.name, length: bestRun };
    }
  }
  return best;
}

/**
 * Greatest comeback: a slot that was relegated and LATER won the Premier
 * title. Returns the tightest such arc (fewest seasons from fall to crown).
 */
export function greatestComeback(
  history: SeasonRecord[],
): { name: string; fellSeason: number; wonSeason: number } | null {
  let best: { name: string; fellSeason: number; wonSeason: number } | null = null;
  for (const fall of history) {
    for (const rel of fall.relegated ?? []) {
      for (const later of history) {
        if (later.generation <= fall.generation) continue;
        if (later.championSlot === rel.slot) {
          const arc = {
            name: later.championName,
            fellSeason: fall.generation,
            wonSeason: later.generation,
          };
          if (!best || arc.wonSeason - arc.fellSeason < best.wonSeason - best.fellSeason) best = arc;
          break; // first title after this fall is the comeback
        }
      }
    }
  }
  return best;
}

/**
 * Season-narrative helpers: compare one season (default: the last) against
 * the previous one. Returns human-readable story fragments (empty when
 * nothing notable). The FIRST fragment is always the title line — the
 * chronicle relies on that to swap it for its own race-flavored headline.
 */
export function seasonStories(history: SeasonRecord[], index = history.length - 1): string[] {
  const rec = history[index];
  if (!rec) return [];
  const prev = index > 0 ? history[index - 1] : undefined;
  const out: string[] = [];

  // Title retained / first-time champion.
  if (prev && prev.championSlot === rec.championSlot && prev.championName === rec.championName) {
    out.push(`${rec.championName} retained the Premier title.`);
  } else if (prev) {
    out.push(`${rec.championName} took the Premier title from ${prev.championName}.`);
  } else {
    out.push(`${rec.championName} won the inaugural Premier title.`);
  }

  // Promoted-team performance this season (they came up LAST season).
  if (prev?.promoted?.length) {
    const d1Rows = rec.table.filter((r) => (r.division ?? 0) === 0);
    for (const p of prev.promoted) {
      const pos = d1Rows.findIndex((r) => r.slot === p.slot);
      if (pos === -1) continue;
      const row = d1Rows[pos];
      if (row.slot === rec.championSlot) {
        out.push(`Promoted ${row.name} won the Premier title in their first season up — a fairytale.`);
      } else if (pos < 4) {
        out.push(`Promoted ${row.name} overachieved, finishing ${ordinal(pos + 1)} in the Premier.`);
      } else if (rec.relegated?.some((x) => x.slot === p.slot)) {
        out.push(`${row.name} bounced straight back down after one Premier season.`);
      }
    }
  }

  // Fallen champion: a relegated team that once won the Premier.
  for (const relTeam of rec.relegated ?? []) {
    const wasChampion = history.some(
      (r) => r.generation < rec.generation && r.championSlot === relTeam.slot && r.championName === relTeam.name,
    );
    const row = rec.table.find((r) => r.slot === relTeam.slot);
    if (wasChampion) {
      out.push(`Former champions ${relTeam.name} fell to the Challenger Division${row ? ` with ${row.pts} points` : ''}.`);
    }
  }

  // Biggest collapse / overachiever by points swing vs last season (same team, same division both years).
  if (prev) {
    let bestUp: { name: string; d: number } | null = null;
    let bestDown: { name: string; d: number } | null = null;
    for (const row of rec.table) {
      const before = prev.table.find(
        (r) => r.slot === row.slot && r.name === row.name && (r.division ?? 0) === (row.division ?? 0),
      );
      if (!before) continue;
      const d = row.pts - before.pts;
      if (!bestUp || d > bestUp.d) bestUp = { name: row.name, d };
      if (!bestDown || d < bestDown.d) bestDown = { name: row.name, d };
    }
    if (bestUp && bestUp.d >= 6) out.push(`Overachievers: ${bestUp.name} (+${bestUp.d} pts on last season).`);
    if (bestDown && bestDown.d <= -6) out.push(`Collapse of the season: ${bestDown.name} (${bestDown.d} pts on last season).`);
  }

  // ---- Evo Cup stories (mined from the recorded bracket, never invented). ----
  if (rec.cup) {
    const cup = rec.cup;
    const winnerDivision = cup.entrants.find((e) => e.slot === cup.winnerSlot)?.division ?? 0;
    if (cup.winnerSlot === rec.championSlot && cup.winnerName === rec.championName) {
      out.push(`DOUBLE: ${cup.winnerName} won the Premier title and the Evo Cup.`);
    }
    if (winnerDivision === 1) {
      out.push(`GIANT SLAIN: Challenger side ${cup.winnerName} won the Evo Cup outright.`);
    }
    for (const run of challengerCupRuns(cup)) {
      if (run.wonCup) continue; // already told above
      out.push(`CUP RUN: ${run.name} reached the ${CUP_ROUND_NAMES[run.roundReached].toLowerCase()} from the Challenger Division.`);
    }
    for (const rev of cupRevenges(history, index)) {
      out.push(`REVENGE: ${rev.winnerName} knocked out ${rev.loserName}, who had ended their cup run in Season ${rev.prevGeneration}.`);
    }
  }

  return out;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
