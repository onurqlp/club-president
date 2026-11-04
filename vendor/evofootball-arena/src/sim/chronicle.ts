import { CUP_NAME, CUP_ROUND_NAMES } from './cup';
import type { SeasonRecord } from './League';
import { ordinal, seasonStories } from './records';

/**
 * The SEASON CHRONICLE (Phase 52 — Stage 3 W4). Pure derivation over the
 * recorded history: every chapter is mined from what the SeasonRecords
 * already hold (points timeline, cup bracket, awards, evolution entries) —
 * nothing here is stored, invented, or fed back into the sim. English
 * source strings like the rest of sim/ (the UI localizes only its chrome).
 */

/** How the Premier title race actually unfolded, read off the points timeline. */
export interface TitleRace {
  totalRounds: number;
  /** 1-indexed round after which no rival could catch the champion
   * (equal to totalRounds = it went to the final day). */
  decidedRound: number;
  /** The champion and runner-up finished level — goal difference decided it. */
  byGoalDifference: boolean;
  /** Earliest round from which the champion was never headed (1 = wire-to-wire). */
  ledFrom: number;
  /** The champion's league position at the halfway round. */
  halfwayRank: number;
  /** Final points margin over the runner-up. */
  margin: number;
  runnerUp: string;
}

export function titleRace(rec: SeasonRecord): TitleRace | null {
  const tl = rec.pointsTimeline;
  const champPts = tl?.[rec.championSlot];
  if (!tl || !champPts || champPts.length === 0) return null;
  const R = champPts.length;
  const rivals = rec.table.filter(
    (r) => (r.division ?? 0) === 0 && r.slot !== rec.championSlot && (tl[r.slot]?.length ?? 0) >= R,
  );
  if (rivals.length === 0) return null;
  const bestRivalAt = (r: number) => Math.max(...rivals.map((row) => tl[row.slot][r]));

  // Decided: even a rival winning every remaining match can no longer pass
  // the champion on points (a mere tie on points is NOT decided — GD looms).
  let decidedRound = R;
  for (let r = 0; r < R; r++) {
    if (champPts[r] - bestRivalAt(r) > 3 * (R - 1 - r)) {
      decidedRound = r + 1;
      break;
    }
  }
  let ledFrom = R;
  for (let r = R - 1; r >= 0; r--) {
    if (champPts[r] >= bestRivalAt(r)) ledFrom = r + 1;
    else break;
  }
  const half = Math.ceil(R / 2) - 1;
  const halfwayRank = 1 + rivals.filter((row) => tl[row.slot][half] > champPts[half]).length;
  const byPts = [...rivals].sort(
    (a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || a.slot - b.slot,
  );
  const runnerUp = byPts[0];
  return {
    totalRounds: R,
    decidedRound,
    byGoalDifference: champPts[R - 1] === runnerUp.pts,
    ledFrom,
    halfwayRank,
    margin: champPts[R - 1] - runnerUp.pts,
    runnerUp: runnerUp.name,
  };
}

export interface ChronicleLine {
  icon: string;
  text: string;
}

export interface ChronicleChapter {
  generation: number;
  championName: string;
  cupWinnerName?: string;
  d2Champion?: string;
  race: TitleRace | null;
  /** The title sentence — coronation flavor + how the race was won. */
  headline: string;
  lines: ChronicleLine[];
}

/** Decider-meeting counts (cup finals + promotion playoffs) BEFORE season `index` —
 * the chronicle's rivalry state as of that moment, slot-keyed like League.rivalryMeetings. */
function meetingsBefore(history: SeasonRecord[], index: number): Map<string, number> {
  const meetings = new Map<string, number>();
  const add = (a?: number, b?: number): void => {
    if (a === undefined || b === undefined || a < 0 || b < 0) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    meetings.set(key, (meetings.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < index; i++) {
    const rec = history[i];
    const finalTie = rec.cup?.ties.find((t) => t.round === 3 && t.played);
    if (finalTie) add(finalTie.home, finalTie.away);
    add(rec.playoff?.homeSlot, rec.playoff?.awaySlot);
  }
  return meetings;
}

function headlineFor(history: SeasonRecord[], index: number, race: TitleRace | null): string {
  const rec = history[index];
  const prev = index > 0 ? history[index - 1] : undefined;
  const name = rec.championName;

  // Coronation flavor: retained (with streak), first-ever crown, or taken.
  let opening: string;
  if (prev && prev.championSlot === rec.championSlot && prev.championName === name) {
    let streak = 1;
    for (let i = index - 1; i >= 0; i--) {
      if (history[i].championSlot === rec.championSlot && history[i].championName === name) streak++;
      else break;
    }
    opening = streak >= 3 ? `${name} made it ${streak} titles in a row` : `${name} retained the title`;
  } else if (!prev) {
    opening = `${name} won the inaugural Premier title`;
  } else if (!history.some((r, i) => i < index && r.championSlot === rec.championSlot && r.championName === name)) {
    opening = `${name} won their first Premier crown`;
  } else {
    opening = `${name} took the title back from ${prev.championName}`;
  }

  if (!race) return `${opening}.`;
  const pts = `${race.margin} ${race.margin === 1 ? 'pt' : 'pts'}`;
  const clauses: string[] = [];
  if (race.byGoalDifference) {
    clauses.push(`on goal difference, level with ${race.runnerUp}`);
  } else if (race.decidedRound >= race.totalRounds) {
    clauses.push(`on the final day, ${pts} ahead of ${race.runnerUp}`);
  } else {
    clauses.push(`sealed in round ${race.decidedRound}/${race.totalRounds} (+${race.margin} over ${race.runnerUp})`);
  }
  if (race.ledFrom === 1 && race.decidedRound < race.totalRounds) clauses.push('led wire-to-wire');
  if (race.halfwayRank >= 4) clauses.push(`${ordinal(race.halfwayRank)} at the halfway mark`);
  return `${opening} — ${clauses.join(', ')}.`;
}

/** Records broken THIS season vs everything before it. Needs a few prior
 * seasons on the books (an early-history "record" every year is noise). */
const RECORD_MIN_PRIOR = 3;

function recordLines(history: SeasonRecord[], index: number): ChronicleLine[] {
  if (index < RECORD_MIN_PRIOR) return [];
  const rec = history[index];
  const prior = history.slice(0, index);
  const out: ChronicleLine[] = [];

  const d1Top = (r: SeasonRecord): number =>
    Math.max(...r.table.filter((row) => (row.division ?? 0) === 0).map((row) => row.pts));
  const pts = d1Top(rec);
  if (pts > Math.max(...prior.map(d1Top))) {
    out.push({ icon: '📈', text: `${rec.championName}'s ${pts} pts — an all-time Premier record.` });
  }

  const boot = rec.awards?.topScorers[0];
  const priorBoots = prior.map((r) => r.awards?.topScorers[0]?.goals ?? 0);
  if (boot && priorBoots.length > 0 && boot.goals > Math.max(...priorBoots)) {
    out.push({ icon: '⚽', text: `${boot.name} (${boot.team}) scored ${boot.goals} — the most ever in one season.` });
  }

  const chain = rec.longestChain;
  const priorChains = prior.map((r) => r.longestChain?.length ?? 0);
  if (chain && priorChains.length > 0 && chain.length > Math.max(...priorChains)) {
    out.push({ icon: '🎼', text: `${chain.team} strung ${chain.length} passes together — a new record move.` });
  }
  return out;
}

/**
 * One chapter per recorded season, oldest first. Reuses the mined
 * seasonStories per season (its first fragment — the plain title line — is
 * replaced by the race-flavored headline).
 */
export function chronicleChapters(history: SeasonRecord[]): ChronicleChapter[] {
  return history.map((rec, index) => {
    const race = titleRace(rec);
    const lines: ChronicleLine[] = [];

    // The cup final, with the derby flag when the pairing was already a feud.
    if (rec.cup) {
      const finalTie = rec.cup.ties.find((t) => t.round === 3 && t.played);
      if (finalTie) {
        const meetings = meetingsBefore(history, index);
        const key = finalTie.home < finalTie.away ? `${finalTie.home}-${finalTie.away}` : `${finalTie.away}-${finalTie.home}`;
        const met = meetings.get(key) ?? 0;
        // Winner-first score orientation — "beat X 3–3 (5–4 on penalties)"
        // must read from the winner's side, whichever end they played.
        const flip = finalTie.winner === finalTie.away;
        const score = flip ? `${finalTie.scoreA}–${finalTie.scoreH}` : `${finalTie.scoreH}–${finalTie.scoreA}`;
        const so = finalTie.shootout;
        const notes = [
          finalTie.byDrawRule ? 'level — underdog rule' : '',
          so ? `${flip ? `${so.scoreA}–${so.scoreH}` : `${so.scoreH}–${so.scoreA}`} on penalties` : '',
        ].filter(Boolean).join('; ');
        lines.push({
          icon: '🏅',
          text: `${CUP_NAME}: ${rec.cup.winnerName} beat ${rec.cup.runnerUpName} ` +
            `${score} in the final${notes ? ` (${notes})` : ''}.`,
        });
        if (met >= 2) {
          lines.push({ icon: '🔥', text: `A derby final — their ${ordinal(met + 1)} meeting in a decider.` });
        }
      }
      // R16 giant killings are ~5 a season (every tie is cross-division) —
      // chronicle-worthy upsets start at the quarter-finals.
      for (const u of rec.cup.upsets.filter((x) => x.round >= 1)) {
        lines.push({
          icon: '⚡',
          text: `${u.winnerName} knocked out ${u.loserName} ${u.score[0]}–${u.score[1]} ` +
            `(${CUP_ROUND_NAMES[u.round].toLowerCase()}).`,
        });
      }
    }

    if (rec.playoff) {
      lines.push({
        icon: '⚔',
        text: `Playoff: ${rec.playoff.homeName} ${rec.playoff.score[0]}–${rec.playoff.score[1]} ` +
          `${rec.playoff.awayName} — ${rec.playoff.winnerName} took the last Premier spot.`,
      });
    }
    if (rec.promoted?.length || rec.relegated?.length) {
      const up = rec.promoted?.map((p) => p.name).join(', ');
      const down = rec.relegated?.map((p) => p.name).join(', ');
      lines.push({ icon: '🔁', text: [up && `Up: ${up}`, down && `Down: ${down}`].filter(Boolean).join(' · ') });
    }

    // Mined narrative fragments; [0] is the plain title line the headline replaces.
    for (const s of seasonStories(history, index).slice(1)) {
      lines.push({ icon: '📖', text: s });
    }

    // Funerals — the evolution entries already snapshot them. The pyramid
    // turns over three clubs EVERY season, so routine deaths compact to one
    // line; a club that once lifted silverware gets its own epitaph (the
    // fallen giant is the story, the churn is the weather).
    // The honours scan INCLUDES this season: a club that lifts the cup and
    // folds the same summer is the chronicle's best tragedy, not churn.
    const funerals = rec.evolution.entries.filter((e) => e.kind === 'reborn' && e.oldName);
    const giants: typeof funerals = [];
    const routine: typeof funerals = [];
    for (const e of funerals) {
      const honours = history.filter(
        (r, i) => i <= index && (r.championName === e.oldName || r.cup?.winnerName === e.oldName),
      ).length;
      (honours > 0 ? giants : routine).push(e);
    }
    for (const e of giants) {
      const titles = history.filter((r, i) => i <= index && r.championName === e.oldName).length;
      const cups = history.filter((r, i) => i <= index && r.cup?.winnerName === e.oldName).length;
      const honours = [titles > 0 ? `${titles}×🏆` : '', cups > 0 ? `${cups}×🏅` : ''].filter(Boolean).join(' ');
      lines.push({
        icon: '🏚',
        text: `Fallen giants: ${e.oldName} (${honours}) folded — ${e.name} rose from the ashes.`,
      });
    }
    if (routine.length > 0) {
      lines.push({
        icon: '💀',
        text: `${routine.map((e) => e.oldName).join(', ')} folded; ` +
          `${routine.map((e) => e.name).join(', ')} entered the pyramid.`,
      });
    }

    // Fire-sale signings (Phase 55): a career continuing at a new club after
    // the old one folded is exactly the chronicle's kind of story.
    for (const s of rec.signings ?? []) {
      lines.push({
        icon: '✍',
        text: `${s.club} signed ${s.player} (${s.age}) from the ashes of ${s.from}.`,
      });
    }

    // Dugout drama (Phase 53): sackings and arrivals are always chapter-worthy
    // (the fuse makes them rare); retirements only when the man won something.
    // Successions live in the record/lineage — the chronicle stays selective.
    for (const ev of rec.coaching ?? []) {
      if (ev.event === 'sacked') {
        lines.push({ icon: '🪓', text: `${ev.club} sacked ${ev.coach}.` });
      } else if (ev.event === 'hired') {
        lines.push({ icon: '🤝', text: `${ev.club} hired ${ev.coach}${ev.note ? ` (${ev.note})` : ''}.` });
      } else if (ev.event === 'retired' && (ev.honours ?? 0) > 0) {
        lines.push({ icon: '🎓', text: `${ev.coach} retired from ${ev.club}${ev.note ? ` — ${ev.note}` : ''}.` });
      }
    }

    lines.push(...recordLines(history, index));

    const mvp = rec.awards?.mvp;
    if (mvp) {
      lines.push({ icon: '🌟', text: `MVP: ${mvp.name} (${mvp.team}) — rating ${mvp.avgRating.toFixed(2)}.` });
    }

    return {
      generation: rec.generation,
      championName: rec.championName,
      cupWinnerName: rec.cup?.winnerName,
      d2Champion: rec.d2Champion,
      race,
      headline: headlineFor(history, index, race),
      lines,
    };
  });
}
