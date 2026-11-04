import { clamp } from '../utils/math';
import { hashSeed, Rng } from '../utils/rng';
import {
  CUP_ROUND_SHORT, CUP_SEED_TAG, CUP_SHOOTOUT_TAG, buildCup, buildCupRecord, cupRoundComplete,
  fillCupRound, resolveCupTie, shootoutLineup, type CupDrawMode, type CupRecord, type CupState,
  type ShootoutSquad,
} from './cup';
import {
  developPlayer, emptyCareer, retireChance, rookieAge, veteranAge,
  type LegendEntry, type PlayerCareer,
} from '../evolution/careers';
import {
  coachRetireChance, createCoach, rookieCoachAge,
  type Coach, type CoachLegend, type PoolEntry,
} from '../evolution/coach';
import {
  evolveGroup, type EvolutionEntry, type EvolutionReport, type EvolvePlan,
} from '../evolution/evolve';
import { computeFitness, type FitnessBreakdown } from '../evolution/fitness';
import {
  createFranchise, emptyAggregates, type Franchise, type SeasonAggregates,
} from '../evolution/franchise';
import { GENE_KEYS, mutateGenome, type GeneKey, type TacticalGenome } from '../evolution/genome';
import { newgenName } from '../evolution/names';
import {
  ATTR_KEYS, SQUAD_BUDGET, SQUAD_ROLES, countsForBudget, enforceBudget, newgenFromBloodline,
  randomPlayer, randomSquad, squadSummary, squadTotal, type AttrKey,
} from '../evolution/playerGenome';
import {
  FREE_AGENT_MAX_AGE, agentTotal, trimPool, type FreeAgent,
} from '../evolution/freeAgents';
import {
  applyPlayerStyle, neutralSquadStyles, styleFromBloodline,
  styleFit,
} from '../evolution/playerStyle';
import { defaultPolicyGenes, mutatePolicyGenes, type PolicyGenes } from '../evolution/policyGenome';
import { styleValues } from '../evolution/styleSpace';
import { DeliveryAccountBook } from '../ai/deliveryAccountBook';
import { HoldAccountBook } from '../ai/holdAccountBook';
import { DefenceAccountBook } from '../ai/defenceBook';
// ⭐ PC T0 §SEAM: the season's recognition books. Dormant — `pcReactionLatency` is hard false
// in every production path, so an unarmed League allocates none of these.
import { PcRecognitionBook } from '../ai/pcLatency';
import { MATCH_DURATION } from './constants';
import { Match, type MatchConfig } from './Match';
import {
  GOAL_CHANNELS, ROLES, ROSTER_ROLES, ROSTER_SIZE, TEAM_SIZE, deriveTeamStyle, emptyChannels,
  emptyPlayerStats,
  type GoalChannel, type MatchResult, type PlayerMatchStats, type TeamInfo, type TeamStyle,
} from './types';

/** Raw pre-v15 franchise shape inside the migration chain: the philosophy
 * fields still sit loose on the club until the v14→v15 step wraps them into
 * the coach (Phase 53). Franchises minted mid-chain by CURRENT-shape
 * creators (v3→v4 newcomers) already carry `coach` — handlers skip those. */
interface LegacyFranchise {
  slot: number;
  genome?: TacticalGenome;
  policy?: Partial<PolicyGenes>;
  style?: TeamStyle;
  coach?: Coach;
}

export type Division = 0 | 1;
export const DIVISION_NAMES = ['Premier Division', 'Challenger Division'] as const;
export const DIVISION_SHORT = ['Premier', 'Challenger'] as const;

/* ---- Discipline (Phase 62 — CARDS THAT BIND) ---- */
/** Every Nth league booking of a season costs the man one match. */
export const SUSPENSION_YELLOWS = 3;
/** Matches banned per sending-off (any fixture kind). */
export const RED_BAN = 1;

export type PromotionMode = 'auto' | 'playoff';

export interface Fixture {
  round: number;
  /** Match index within the division's round (0-3). */
  index: number;
  division: Division;
  /** Franchise slots. */
  home: number;
  away: number;
  played: boolean;
  scoreH?: number;
  scoreA?: number;
  /** Promotion playoff decider (home = Premier 7th, away = Challenger 2nd). */
  playoff?: boolean;
  /** Evo Cup tie: round/index address the bracket; standalone like the playoff. */
  cup?: boolean;
}

export interface TableRow {
  slot: number;
  played: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  pts: number;
}

/** A named player's season line, resolved at record time (players change on rebirth). */
export interface PlayerSeasonLine extends PlayerMatchStats {
  slot: number;
  name: string;
  team: string;
  role: string;
  /** Season average of the 6.0–10.0 match ratings (Phase 33). */
  avgRating: number;
}

export interface SeasonAwards {
  topScorers: PlayerSeasonLine[];
  topAssists: PlayerSeasonLine[];
  topKeeper: PlayerSeasonLine | null;
  /** Most cards this season (reds weighted double); absent pre-Phase-25. */
  dirtiest?: { slot: number; name: string; yellows: number; reds: number } | null;
  /** Season MVP — best average match rating (Phase 33); absent on old records. */
  mvp?: PlayerSeasonLine | null;
}

/** A season-end retirement, remembered in the season report (Phase 26). */
export interface RetirementEntry {
  name: string;
  team: string;
  role: string;
  age: number;
  seasons: number;
  goals: number;
  saves: number;
}

export interface SeasonRecord {
  generation: number;
  championSlot: number;
  championName: string;
  d2Champion?: string;
  promoted?: Array<{ slot: number; name: string }>;
  relegated?: Array<{ slot: number; name: string }>;
  table: Array<{
    slot: number; name: string; pts: number; w: number; d: number; l: number;
    gf: number; ga: number; elo?: number; division?: Division;
    /** Goals for/against by channel (Phase 113) — absent on old records. */
    ch?: { f: Record<GoalChannel, number>; a: Record<GoalChannel, number> };
  }>;
  fitness: Array<FitnessBreakdown & { name: string }>;
  evolution: EvolutionReport;
  /** Playoff decider result, when promotion mode is 'playoff'. */
  playoff?: {
    homeName: string;
    awayName: string;
    /** Slots (Phase 40, optional — absent on older records): rivalry fuel. */
    homeSlot?: number;
    awaySlot?: number;
    score: [number, number];
    winnerName: string;
  };
  /** The season's Evo Cup (absent on pre-cup-era records from old saves). */
  cup?: CupRecord;
  /** Post-season additions (optional: absent on records from old saves). */
  awards?: SeasonAwards;
  /** Challenger Division top scorers (top 3). */
  awardsD2?: SeasonAwards;
  /** League-average gene values of the population that PLAYED this season. */
  geneMeans?: Record<GeneKey, number>;
  attrMeans?: Record<AttrKey, number>;
  /** Per-club style vectors in STYLE_DIMS order (Phase 49), snapshotted
   * BEFORE evolution — the style-space map's trails and the divergence
   * curve read these. Optional: old records lack it. */
  styleMatrix?: Array<{
    slot: number;
    values: number[];
    /** The DISCRETE formation identity that season (Phase 116, save v29) —
     * the continuous vector can't say which SHAPE a club ran. Absent on
     * pre-v29 records; the timeline grows as seasons play. */
    style?: TeamStyle;
    /** Squad attribute means in ATTR_KEYS order (Phase 118.5, save v31) —
     * the budget-allocation heatmap joins the generation scrubber. Absent
     * on pre-v31 records. */
    attrs?: number[];
  }>;
  /** Formation-identity counts of the population that PLAYED this season (Phase 31). */
  styleShares?: { atk: Record<string, number>; def: Record<string, number>; scheme: Record<string, number> };
  /** Longest completed-pass chain of the season (Phase 33 — the tiki-taka record). */
  longestChain?: { team: string; length: number };
  /** Players who hung up their boots at season end (Phase 26). */
  retirements?: RetirementEntry[];
  /** Cumulative points per slot after each round (slot-indexed, 7 rounds). */
  pointsTimeline?: number[][];
  /** Fire-sale signings of the season (Phase 55) — free agents landing at
   * a retirement vacancy, career intact. The chronicle mines these. */
  signings?: Array<{ club: string; player: string; from: string; age: number }>;
  /** Dugout events of the season (Phase 53) — the chronicle mines these. */
  coaching?: Array<{
    event: 'sacked' | 'hired' | 'retired' | 'succeeded';
    club: string;
    coach: string;
    note?: string;
    /** Retired: titles + cups won — the chronicle only eulogizes winners. */
    honours?: number;
  }>;
}

export const SAVE_VERSION = 33;
const TEAMS_PER_DIVISION = 8;
const TOTAL_TEAMS = 16;

/**
 * Evo Cup rounds unlock after this many PLAYED league fixtures — i.e. after
 * league rounds 2 / 4 / 6 / 7 — so the cup weaves through the season and the
 * final lands after the last league round (before any promotion playoff).
 */
const CUP_GATES = [16, 32, 48, 56];

/**
 * The autonomous football pyramid: 16 evolving franchises in two divisions of
 * eight, each playing a single round-robin per season (7 rounds × 4 matches
 * per division, 56 matches total).
 *
 * End of season, in this order:
 *   1. Division fitness + season record (as played).
 *   2. Evolution per division — D1: 2 elite / 6 mutated (its strugglers get
 *      relegated, not killed); D2: promoted pair protected as elite, 3
 *      mutated, bottom-3 REBORN from D1's elite parent pool.
 *   3. Promotion/relegation by TABLE position (sporting merit, not fitness):
 *      bottom-2 of D1 swap with top-2 of D2.
 *
 * Randomness stays fully derived — every match seed is
 * hash(leagueSeed, generation, round, division*4+index) — so saves replay
 * identically after load.
 */
export class League {
  seed: number;
  generation = 1;
  matchDuration: number;
  /**
   * 'auto' (default): Premier bottom-2 swap with Challenger top-2.
   * 'playoff': Premier 8th down, Challenger 1st up, and Premier 7th hosts
   * Challenger 2nd in a one-match decider (a DRAW keeps the Premier side up).
   */
  promotionMode: PromotionMode = 'auto';
  /**
   * How drawn cup ties resolve: 'shootout' (new-league default — seeded
   * penalties, finishing vs reflexes) or 'underdog' (the classic draw rule;
   * also what pre-Phase-22 saves load as).
   */
  cupDrawMode: CupDrawMode = 'shootout';
  franchises: Franchise[] = [];
  fixtures: Fixture[] = [];
  /** Index of the next unplayed fixture. */
  cursor = 0;
  table: TableRow[] = [];
  agg: SeasonAggregates[] = [];
  /** Per-player season totals: [slot][playerIndex 0..TEAM_SIZE-1]. */
  playerAgg: PlayerMatchStats[][] = [];
  history: SeasonRecord[] = [];
  /** This season's Evo Cup; null on migrated saves until the next season starts. */
  cup: CupState | null = null;
  /** All-time greats, recorded at retirement (top 20 by career goals; Phase 26). */
  legends: LegendEntry[] = [];
  /** Out-of-work coaches (Phase 53): dead clubs' ex-managers + sacked bosses —
   * the sack/hire channel's market. Philosophies survive their clubs here. */
  coachPool: PoolEntry[] = [];
  /** The dugout hall of fame: retired coaches, best first (top 12). */
  coachLegends: CoachLegend[] = [];
  /** Consecutive bottom-third-fitness seasons per slot — the sacking fuse. */
  misery: number[] = [];
  /** The fire-sale market (Phase 55): dead clubs' players, genes intact. */
  freeAgents: FreeAgent[] = [];
  /** Probe surface (not serialized): the coach-mobility A/B gate flips this
   * off to isolate the sack/hire channel's effect on style diversity. */
  sackingEnabled = true;
  /**
   * Probe surface (not serialized): EDS E3 arms the dormant bundle for one
   * audit arm without every fixture learning about it. Empty in production, so
   * `createMatch` builds exactly the shipped match (X1's fingerprint gate).
   *
   * A4 (ruling #155) widens the KEY SET only: the play-test entry arms the
   * enriched census substrate (`A4_WORLD_FLAGS`), which needs the C-family
   * seams too. Still empty in production — an unarmed league builds the
   * identical shipped match, and the widening changes no default.
   */
  matchFlags: Partial<Pick<MatchConfig,
    'edsTouchCost' | 'edsPerceivedDefence' | 'edsPerceivedChoice' | 'edsValueAxis'
    | 'edsAwareness' | 'traceChoice'
    | 'c5Hold' | 'c5TouchFork' | 'c6Carry' | 'c7Windup' | 'o1PassWindup' | 'o2Look'
    | 'pmLaneConvergence' | 'mtMarkSag' | 'ctbSupportPlane' | 'obmMovement'
    | 'ptpPassLead' | 'dlcDeliveryChoice' | 'dlcStrikePlane' | 'dvDeliveryValue'
    | 'dvLearnedMap' | 'ekHoldLearn' | 'ekHoldVeto'
    | 'l3DefenceLearn' | 'l3DefenceVeto'
    | 'cbCommitPhysics' | 'cbTouchPast' | 'cbChoiceSeat'
    | 'pcReactionLatency' | 'pcNCover'
    | 'bkFacingLaw' | 'bkContactLaw' | 'bkCorridorPrice' | 'bkGroundCorridor'
    | 'bfFacingCost'
    | 'bqCushion'
    | 'lnOwnLanePrice'
    | 'gkDiveBody'
    | 'dsOwnRun' | 'dsHatsOff' | 'dsCoopHatsOff'
    | 'ifFlightRun'
    | 'opFrontMan'
    | 'opFrontChooser'
    | 'dxWindupAim' | 'raAccessPrice' | 'rcAnticipate' | 'rcReady'
    | 'dfAssignPersist' | 'dfSurface' | 'dfCapOff'
    | 'inSnapshotLaw' | 'inSnapshotField' | 'inLookAct'
  >> = {};

  /**
   * ⭐ PC T0 §SEAM — THE SEASON'S RECOGNITION BOOKS (contract §2 M-PC.3: born absent, own
   * exposures only, SEASON RESET, no franchise writes). One per franchise slot, created ONLY
   * when the `pcReactionLatency` door is armed and `null` in every production path, so an
   * unarmed League allocates nothing and builds the identical shipped match.
   */
  private pcBooks: PcRecognitionBook[] | null = null;

  /**
   * ⭐ DV T2-T0 §SEAM — THE SEASON'S BOOKS (contract §2 M-DV2.2: *"one season's book,
   * reset at the season boundary"*). One per franchise slot, created ONLY when the
   * `dvLearnedMap` door is armed and `null` in every production path, so an unarmed
   * League allocates nothing and builds the identical shipped match.
   */
  private dvBooks: DeliveryAccountBook[] | null = null;

  /**
   * ⭐ EK T0 §SEAM — THE SEASON'S HOLD BOOKS (contract §2 M-EK.2: one season's book, reset
   * at the season boundary). One per franchise slot, created ONLY when the `ekHoldLearn`
   * door is armed and `null` in every production path, so an unarmed League allocates
   * nothing and builds the identical shipped match.
   */
  private ekHoldBooks: HoldAccountBook[] | null = null;

  /**
   * ⭐ L3 T0 §SEAM — THE SEASON'S DEFENCE BOOKS (contract §2 M-L3.2: one season's book, reset
   * at the season boundary). One per franchise slot, created ONLY when the `l3DefenceLearn`
   * door is armed and `null` in every production path, so an unarmed League allocates nothing
   * and builds the identical shipped match.
   */
  private l3DefenceBooks: DefenceAccountBook[] | null = null;

  constructor(cfg: { seed: number; matchDuration?: number }) {
    this.seed = cfg.seed >>> 0;
    this.matchDuration = cfg.matchDuration ?? MATCH_DURATION;
    const rng = new Rng(hashSeed(this.seed, 0xf0));
    const taken = new Set<string>();
    this.franchises = Array.from({ length: TOTAL_TEAMS }, (_, i) =>
      createFranchise(i, rng, taken, i < TEAMS_PER_DIVISION ? 0 : 1),
    );
    this.misery = this.franchises.map(() => 0);
    this.startSeason();
  }

  division(d: Division): Franchise[] {
    return this.franchises.filter((f) => f.division === d);
  }

  private startSeason(): void {
    this.fixtures = [];
    // Interleave rounds so watching the league alternates divisions naturally.
    const perDiv = ([0, 1] as Division[]).map((d) =>
      buildDivisionFixtures(this.division(d).map((f) => f.slot), d),
    );
    for (let r = 0; r < TEAMS_PER_DIVISION - 1; r++) {
      for (const list of perDiv) this.fixtures.push(...list.filter((f) => f.round === r));
    }
    this.cursor = 0;
    this.table = this.franchises.map((f) => ({
      slot: f.slot, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0,
    }));
    this.agg = this.franchises.map(() => emptyAggregates());
    this.playerAgg = this.franchises.map(() => ROSTER_ROLES.map(() => emptyPlayerStats()));
    this.cup = buildCup(this.franchises, this.seed, this.generation);
    // DV T2-T0: THE SEASON BOUNDARY (M-DV2.2). Structural, not tuned — the whole book is
    // wiped, there is no decay and no window. No-op unless the learning door is armed.
    if (this.dvBooks !== null && this.dvBooks !== undefined) {
      for (const b of this.dvBooks) b.reset();
    }
    // EK T0: THE SAME SEASON BOUNDARY for the hold books (M-EK.2), same terms.
    if (this.ekHoldBooks !== null && this.ekHoldBooks !== undefined) {
      for (const b of this.ekHoldBooks) b.reset();
    }
    // L3 T0: THE SAME SEASON BOUNDARY for the defence books (M-L3.2), same terms.
    if (this.l3DefenceBooks !== null && this.l3DefenceBooks !== undefined) {
      for (const b of this.l3DefenceBooks) b.reset();
    }
    // ⭐ PC T0: THE SAME SEASON BOUNDARY for the recognition books (M-PC.3), same terms —
    // structural, no decay and no window. No-op unless the latency door is armed.
    if (this.pcBooks !== null && this.pcBooks !== undefined) {
      for (const b of this.pcBooks) b.reset();
    }
  }

  /**
   * The two books a fixture learns into, allocated on first use. Reached ONLY from the
   * single `matchFlags.dvLearnedMap` fork in `createMatch`.
   */
  private dvBooksFor(home: number, away: number): readonly [DeliveryAccountBook, DeliveryAccountBook] {
    // Same `fromJSON` caveat: the field can be undefined, not null.
    if (this.dvBooks === null || this.dvBooks === undefined) {
      this.dvBooks = this.franchises.map(() => new DeliveryAccountBook());
    }
    return [this.dvBooks[home], this.dvBooks[away]];
  }

  /** DV T2-T0: read-only view of the season's books (instruments only; null when off). */
  get deliveryBooks(): readonly DeliveryAccountBook[] | null { return this.dvBooks ?? null; }

  /**
   * The two hold books a fixture learns into, allocated on first use. Reached ONLY from
   * the single `matchFlags.ekHoldLearn` fork in `createMatch`.
   */
  private ekBooksFor(home: number, away: number): readonly [HoldAccountBook, HoldAccountBook] {
    // Same `fromJSON` caveat: the field can be undefined, not null.
    if (this.ekHoldBooks === null || this.ekHoldBooks === undefined) {
      this.ekHoldBooks = this.franchises.map(() => new HoldAccountBook());
    }
    return [this.ekHoldBooks[home], this.ekHoldBooks[away]];
  }

  /** EK T0: read-only view of the season's hold books (instruments only; null when off). */
  get holdBooks(): readonly HoldAccountBook[] | null { return this.ekHoldBooks ?? null; }

  /**
   * The two defence books a fixture learns into, allocated on first use. Reached ONLY from
   * the single `matchFlags.l3DefenceLearn` fork in `createMatch`.
   */
  private l3BooksFor(home: number, away: number): readonly [DefenceAccountBook, DefenceAccountBook] {
    // Same `fromJSON` caveat: the field can be undefined, not null.
    if (this.l3DefenceBooks === null || this.l3DefenceBooks === undefined) {
      this.l3DefenceBooks = this.franchises.map(() => new DefenceAccountBook());
    }
    return [this.l3DefenceBooks[home], this.l3DefenceBooks[away]];
  }

  /** L3 T0: read-only view of the season's defence books (instruments only; null when off). */
  get defenceBooks(): readonly DefenceAccountBook[] | null { return this.l3DefenceBooks ?? null; }

  /**
   * The two recognition books a fixture learns into, allocated on first use. Reached ONLY from
   * the single `matchFlags.pcReactionLatency` fork in `createMatch`.
   */
  private pcBooksFor(home: number, away: number): readonly [PcRecognitionBook, PcRecognitionBook] {
    // Same `fromJSON` caveat: the field can be undefined, not null.
    if (this.pcBooks === null || this.pcBooks === undefined) {
      this.pcBooks = this.franchises.map(() => new PcRecognitionBook());
    }
    return [this.pcBooks[home], this.pcBooks[away]];
  }

  /** PC T0: read-only view of the season's recognition books (instruments only; null off). */
  get recognitionBooks(): readonly PcRecognitionBook[] | null { return this.pcBooks ?? null; }

  get seasonDone(): boolean {
    this.ensureCupFixtures();
    this.ensurePlayoffFixture();
    return this.cursor >= this.fixtures.length;
  }

  nextFixture(): Fixture | null {
    return this.seasonDone ? null : this.fixtures[this.cursor];
  }

  /**
   * Schedule the next unlocked cup round by splicing its ties in at the
   * cursor (i.e. right after the league round that unlocked it). Idempotent
   * and save-safe: the bracket lives in `this.cup`; fixtures only mirror it.
   */
  private ensureCupFixtures(): void {
    if (!this.cup) return; // migrated mid-season save: cup starts next season
    const leaguePlayed = this.fixtures.reduce(
      (n, f) => n + (!f.cup && !f.playoff && f.played ? 1 : 0), 0,
    );
    for (let round = 0; round < CUP_GATES.length; round++) {
      if (this.fixtures.some((f) => f.cup && f.round === round)) continue; // scheduled
      if (leaguePlayed < CUP_GATES[round]) return;
      if (round > 0 && !cupRoundComplete(this.cup, round - 1)) return;
      const ties = round === 0
        ? this.cup.ties.filter((t) => t.round === 0)
        : fillCupRound(this.cup, round);
      this.fixtures.splice(this.cursor, 0, ...ties.map((t) => ({
        round: t.round, index: t.index, division: 0 as Division,
        home: t.home, away: t.away, played: false, cup: true,
      })));
      return;
    }
  }

  /** In playoff mode, append the decider once the regular season is complete. */
  private ensurePlayoffFixture(): void {
    if (this.promotionMode !== 'playoff') return;
    if (this.fixtures.some((f) => f.playoff)) return;
    if (this.cursor < this.fixtures.length) return;
    const seventh = this.standings(0)[6];
    const second = this.standings(1)[1];
    this.fixtures.push({
      round: TEAMS_PER_DIVISION - 1, // "round 8": seed hash stays unique
      index: 0,
      division: 0,
      home: seventh.slot,
      away: second.slot,
      played: false,
      playoff: true,
    });
  }

  currentRound(): number {
    return this.seasonDone ? TEAMS_PER_DIVISION - 1 : this.fixtures[this.cursor].round + 1;
  }

  /** Human label for the upcoming fixture: league round, cup round or playoff. */
  roundLabel(): string {
    const f = this.nextFixture();
    if (f?.cup) return `Cup ${CUP_ROUND_SHORT[f.round]}`;
    if (f?.playoff) return 'Playoff';
    return `Round ${this.currentRound()}/${TEAMS_PER_DIVISION - 1}`;
  }

  franchise(slot: number): Franchise {
    return this.franchises.find((f) => f.slot === slot)!;
  }

  /**
   * Rivalries (Phase 40) — DERIVED from history, never stored: every cup
   * FINAL and promotion-playoff decider is a "meeting in a decider" for
   * that slot pair; two meetings arm a rivalry forever (the slot — the
   * CLUB — survives rebirths, so the feud outlives the people). Pure and
   * deterministic; cheap enough to recompute on demand.
   */
  rivalryMeetings(): Map<string, number> {
    const meetings = new Map<string, number>();
    const add = (a: number, b: number): void => {
      if (a < 0 || b < 0) return;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      meetings.set(key, (meetings.get(key) ?? 0) + 1);
    };
    for (const rec of this.history) {
      const finalTie = rec.cup?.ties.find((t) => t.round === 3 && t.played);
      if (finalTie) add(finalTie.home, finalTie.away);
      const po = rec.playoff;
      if (po && po.homeSlot !== undefined && po.awaySlot !== undefined) add(po.homeSlot, po.awaySlot);
    }
    return meetings;
  }

  /** Is this pairing an ARMED rivalry (≥2 decider meetings)? */
  isDerby(a: number, b: number): boolean {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    return (this.rivalryMeetings().get(key) ?? 0) >= 2;
  }

  /**
   * Prestige (Phase 40): age-decayed trophy weight per slot — titles 1.0,
   * cups 0.6, decayed ×0.85 per season of age (only slot-unambiguous
   * honors count). Pure over history; biases rebirth parent ranking
   * (CAPPED — see finishSeason).
   */
  prestigeOf(slot: number): number {
    let p = 0;
    for (const rec of this.history) {
      const age = this.generation - rec.generation;
      const w = Math.pow(0.85, Math.max(0, age));
      if (rec.championSlot === slot) p += w;
      if (rec.cup && rec.cup.winnerSlot === slot) p += 0.6 * w;
    }
    return p;
  }

  teamInfo(slot: number): TeamInfo {
    const f = this.franchise(slot);
    return {
      id: f.id, name: f.name, short: f.short, colors: f.colors,
      playerNames: f.playerNames, genome: f.coach.genome, squad: f.squad,
      ages: f.ages, style: f.coach.style, policy: f.coach.policy,
      coachName: f.coach.name, // feed attribution + the touchline figure (Phase 66)
      elo: f.elo, // the underdog shift's strength reading (Phase 64)
      morale: f.morale, // confidence carried into the match (Phase 111)
      // The personal-style wire (Phase 54): each slot's brain runs the
      // coach's policy through the player's own appetites.
      rolePolicies: f.squadStyles?.map((s) => applyPlayerStyle(f.coach.policy, s)),
      lineup: this.buildLineup(f),
    };
  }

  /**
   * Match-day availability (Phase 62): banned starters are covered by the
   * like-for-like bench body — the ordering of AVAILABLE roster rows, XI
   * first (slot order), then the remaining bench. Undefined when nobody is
   * suspended (the common case — Team's default is bit-identical). Pure:
   * suspension state only changes in applyResult/finishSeason.
   */
  private buildLineup(f: Franchise): number[] | undefined {
    const susp = f.suspensions;
    const inj = f.injuries;
    const out = (i: number): number => (susp?.[i] ?? 0) + (inj?.[i] ?? 0);
    if (!susp?.some((s) => s > 0) && !inj?.some((s) => s > 0)) return undefined;
    const n = f.squad.length;
    const banned = new Set<number>();
    // Slot 0 is exempt by construction: keepers are never carded (Match
    // rule), never seriously injured (Phase 118, same premise), and the
    // bench carries no reserve keeper.
    for (let i = 1; i < n; i++) if (out(i) > 0) banned.add(i);
    if (banned.size === 0) return undefined;
    const benchPool: number[] = [];
    for (let i = TEAM_SIZE; i < n; i++) if (!banned.has(i)) benchPool.push(i);
    const xi: number[] = [];
    for (let slotIdx = 0; slotIdx < TEAM_SIZE; slotIdx++) {
      if (!banned.has(slotIdx)) {
        xi.push(slotIdx);
        continue;
      }
      let pick = benchPool.findIndex((ri) => ROSTER_ROLES[ri] === ROLES[slotIdx]);
      if (pick < 0 && benchPool.length > 0) pick = 0;
      if (pick >= 0) {
        xi.push(benchPool[pick]);
        benchPool.splice(pick, 1);
      } else {
        // Congestion valve (4+ banned at once — practically unreachable):
        // the shortest remaining ban plays through it; the ban still ticks.
        let best = -1;
        for (const ri of banned) {
          if (xi.includes(ri)) continue;
          if (best < 0 || out(ri) < out(best)) best = ri;
        }
        xi.push(best >= 0 ? best : slotIdx);
      }
    }
    return [...xi, ...benchPool];
  }

  /** Build the deterministic Match for a fixture (same seed => same game). */
  createMatch(f: Fixture): Match {
    return new Match({
      seed: f.cup
        ? hashSeed(this.seed, this.generation, CUP_SEED_TAG + f.round, f.index)
        : hashSeed(this.seed, this.generation, f.round, f.division * 4 + f.index),
      teamA: this.teamInfo(f.home),
      teamB: this.teamInfo(f.away),
      duration: this.matchDuration,
      derby: this.isDerby(f.home, f.away),
      ...this.matchFlags,
      // ⚠ `matchFlags` is undefined on a `fromJSON` league (Object.create — no field
      // initializer ran), which is why the read is optional: the spread above tolerates
      // undefined, a property read would not.
      ...(this.matchFlags?.dvLearnedMap === true
        ? { dvLearnedBooks: this.dvBooksFor(f.home, f.away) }
        : {}),
      ...(this.matchFlags?.ekHoldLearn === true
        ? { ekHoldBooks: this.ekBooksFor(f.home, f.away) }
        : {}),
      ...(this.matchFlags?.l3DefenceLearn === true
        ? { l3DefenceBooks: this.l3BooksFor(f.home, f.away) }
        : {}),
      ...(this.matchFlags?.pcReactionLatency === true
        ? { pcRecognitionBooks: this.pcBooksFor(f.home, f.away) }
        : {}),
    });
  }

  /**
   * The shootout inputs a drawn cup tie will resolve with (mode 'shootout'):
   * lineups from squad DNA and a fresh derived-seed Rng. Pure and stateless —
   * `applyResult` consumes it, and the presentation layer calls it again to
   * replay the identical kick sequence (same seed ⇒ same shootout).
   */
  shootoutContext(fixture: Fixture): { home: ShootoutSquad; away: ShootoutSquad; rng: Rng } | undefined {
    if (this.cupDrawMode !== 'shootout') return undefined;
    return {
      home: shootoutLineup(this.franchise(fixture.home).squad),
      away: shootoutLineup(this.franchise(fixture.away).squad),
      rng: new Rng(hashSeed(this.seed, this.generation, CUP_SHOOTOUT_TAG + fixture.round, fixture.index)),
    };
  }

  applyResult(fixture: Fixture, result: MatchResult): void {
    fixture.played = true;
    fixture.scoreH = result.score[0];
    fixture.scoreA = result.score[1];

    // Discipline (Phase 62) runs for EVERY fixture kind — league, cup,
    // playoff: whoever was banned served this one (decrement first, so a
    // red earned TODAY starts tomorrow), then today's sendings-off bank
    // their bans. Yellow ACCUMULATION is league-only (below, with the
    // playerAgg ledger) — competition-specific counts, like the real law.
    for (const [i, slot] of [fixture.home, fixture.away].entries()) {
      const f = this.franchise(slot);
      f.suspensions ??= f.squad.map(() => 0);
      f.injuries ??= f.squad.map(() => 0);
      for (let ri = 0; ri < f.suspensions.length; ri++) {
        if (f.suspensions[ri] > 0) f.suspensions[ri]--;
        if (f.injuries[ri] > 0) f.injuries[ri]--;
      }
      for (let ri = 0; ri < ROSTER_SIZE; ri++) {
        const s = result.playerStats[i * ROSTER_SIZE + ri];
        if (s && s.reds > 0) f.suspensions[ri] += s.reds * RED_BAN;
      }
      // Injuries bank AFTER the decrement, like reds (Phase 118). THE
      // 6-MAN FLOOR (user default #4): an absence that would leave the
      // club unable to field six is downgraded to a knock — he recovers
      // for next round instead of sitting out. Deterministic (ri order).
      for (let ri = 0; ri < ROSTER_SIZE; ri++) {
        const rounds = result.injuries?.[i * ROSTER_SIZE + ri] ?? 0;
        if (rounds <= 0) continue;
        let availableAfter = 0;
        for (let rj = 0; rj < f.squad.length; rj++) {
          const out = (f.suspensions[rj] ?? 0) > 0 || (f.injuries[rj] ?? 0) > 0 || rj === ri;
          if (!out) availableAfter++;
        }
        if (availableAfter >= TEAM_SIZE) f.injuries[ri] = Math.max(f.injuries[ri], rounds);
      }
    }

    // The playoff is a standalone decider: no table/stats/Elo bookkeeping.
    if (fixture.playoff) {
      this.cursor++;
      return;
    }

    // Cup ties are standalone too: resolve the bracket (draws send the
    // underdog through) and track cup-only scorer stats — nothing here may
    // touch the table, Elo, season aggregates or fitness.
    if (fixture.cup) {
      if (this.cup) {
        // Drawn ties: seeded shootout in 'shootout' mode (its own derived
        // seed — never the match's rng), underdog rule otherwise.
        resolveCupTie(this.cup, fixture.round, fixture.index, result.score[0], result.score[1], this.shootoutContext(fixture));
        // playerStats is ROSTER-indexed (Phase 61) — home roster first.
        for (let ri = 0; ri < result.playerStats.length; ri++) {
          const slot = ri < ROSTER_SIZE ? fixture.home : fixture.away;
          this.cup.playerGoals[slot][ri % ROSTER_SIZE] += result.playerStats[ri].goals;
        }
      }
      this.cursor++;
      return;
    }

    const rows = [this.table[fixture.home], this.table[fixture.away]];
    const [sh, sa] = result.score;
    for (const [i, row] of rows.entries()) {
      const gf = i === 0 ? sh : sa;
      const ga = i === 0 ? sa : sh;
      row.played++;
      row.gf += gf;
      row.ga += ga;
      if (gf > ga) {
        row.w++;
        row.pts += 3;
      } else if (gf === ga) {
        row.d++;
        row.pts += 1;
      } else {
        row.l++;
      }
    }

    // Season aggregates for fitness.
    const slots = [fixture.home, fixture.away];
    for (const [i, slot] of slots.entries()) {
      const s = result.stats[i as 0 | 1];
      const so = result.stats[(1 - i) as 0 | 1];
      const a = this.agg[slot];
      a.played++;
      const gf = i === 0 ? sh : sa;
      const ga = i === 0 ? sa : sh;
      a.gf += gf;
      a.ga += ga;
      if (gf > ga) {
        a.wins++;
        a.pts += 3;
      } else if (gf === ga) {
        a.draws++;
        a.pts += 1;
      } else a.losses++;
      a.shots += s.shots;
      a.xg += s.xg;
      a.passes += s.passes;
      a.passesCompleted += s.passesCompleted;
      a.recoveries += s.interceptions + s.tackles;
      a.staminaSpent += s.staminaSpent;
      a.distance += s.distance;
      a.yellows += s.yellows;
      a.reds += s.reds;
      if (s.bestPassChain > a.longestChain) a.longestChain = s.bestPassChain;
      for (const c of GOAL_CHANNELS) {
        a.chFor[c] += s.goalChannels[c];
        a.chAgainst[c] += so.goalChannels[c];
      }
      const possMin = Math.max(s.possessionTime / 60, 0.25);
      const oppPossMin = Math.max(so.possessionTime / 60, 0.25);
      a.styleSamples.push({
        passVol: s.passes / possMin,
        pressVol: (s.tackles + s.interceptions) / oppPossMin,
      });
    }

    // Per-player season totals (home roster first, then away — ROSTER_SIZE
    // each since Phase 61: substitutes' stats land on their own rows).
    for (let ri = 0; ri < result.playerStats.length; ri++) {
      const slot = ri < ROSTER_SIZE ? fixture.home : fixture.away;
      const acc = this.playerAgg[slot][ri % ROSTER_SIZE];
      const s = result.playerStats[ri];
      acc.apps += s.apps;
      // Yellow accumulation (Phase 62): every SUSPENSION_YELLOWS-th league
      // booking of the season costs the man the club's next match.
      const beforeY = acc.yellows;
      acc.yellows += s.yellows;
      if (Math.floor(acc.yellows / SUSPENSION_YELLOWS) > Math.floor(beforeY / SUSPENSION_YELLOWS)) {
        const f = this.franchise(slot);
        f.suspensions ??= f.squad.map(() => 0);
        f.suspensions[ri % ROSTER_SIZE]++;
      }
      acc.reds += s.reds;
      acc.goals += s.goals;
      acc.assists += s.assists;
      acc.shots += s.shots;
      acc.saves += s.saves;
      acc.recoveries += s.recoveries;
      acc.miscontrols += s.miscontrols;
      acc.rating += s.rating; // season SUM — playerLines divides by matches
    }

    // Elo (K=28) — a single ladder across both divisions.
    const fh = this.franchise(fixture.home);
    const fa = this.franchise(fixture.away);
    const expected = 1 / (1 + 10 ** ((fa.elo - fh.elo) / 400));
    const actual = sh > sa ? 1 : sh === sa ? 0.5 : 0;
    const delta = 28 * (actual - expected);
    fh.elo += delta;
    fa.elo -= delta;

    // MORALE (Phase 111): confidence follows results — mean-revert first
    // (streaks fade on their own), then the result moves it. An UPSET
    // moves morale harder (beating a stronger side lifts more; losing to
    // a weaker one stings more) — expected already encodes that.
    const swing = 0.14;
    fh.morale = clamp(0.5 + (fh.morale - 0.5) * 0.8 + (actual - expected) * swing, 0.1, 0.9);
    fa.morale = clamp(0.5 + (fa.morale - 0.5) * 0.8 + (expected - actual) * swing, 0.1, 0.9);

    this.cursor++;
  }

  standings(division: Division): Array<TableRow & { franchise: Franchise }> {
    return this.table
      .map((row) => ({ ...row, franchise: this.franchise(row.slot) }))
      .filter((r) => r.franchise.division === division)
      .sort(
        (a, b) =>
          b.pts - a.pts || b.gf - b.ga - (a.gf - a.ga) || b.gf - a.gf || a.slot - b.slot,
      );
  }

  /**
   * Close the season: record → evolve per division → promote/relegate.
   * The D1 champion and the promoted D2 pair are always protected as elite.
   */
  finishSeason(): SeasonRecord {
    const eps = 0.001;
    // Careers bank the season BEFORE evolution can rebirth a squad away
    // (a reborn club's players vanish with their ledgers — that's the point).
    for (const f of this.franchises) {
      this.playerAgg[f.slot].forEach((s, i) => {
        const c = f.careers[i];
        c.seasons++;
        c.goals += s.goals;
        c.assists += s.assists;
        c.saves += s.saves;
        c.recoveries += s.recoveries;
        // Career highlights (Phase 54): remember the best single season.
        if (s.goals > 0 && s.goals > (c.bestGoals ?? 0)) {
          c.bestGoals = s.goals;
          c.bestGoalsSeason = this.generation;
        }
        // Rating averages divide by APPS since the bench (Phase 61) — a
        // player no longer plays every fixture by construction.
        const avg = s.apps > 0 ? s.rating / s.apps : 0;
        if (avg > (c.bestRating ?? 0)) {
          c.bestRating = avg;
          c.bestRatingSeason = this.generation;
        }
      });
    }
    const standings1 = this.standings(0);
    const standings2 = this.standings(1);

    const fitnessFor = (d: Division) =>
      computeFitness(this.division(d).map((f) => ({ slot: f.slot, agg: this.agg[f.slot] })));
    const fit1 = fitnessFor(0);
    const fit2 = fitnessFor(1);
    const map1 = new Map(fit1.map((x) => [x.slot, x.total]));
    const map2 = new Map(fit2.map((x) => [x.slot, x.total]));

    // Who goes up and down. 'auto': straight top/bottom-2 swap. 'playoff':
    // 8th down + 1st up automatically, 7th-vs-2nd decider for the last spot
    // (a draw keeps the Premier side up).
    let promoted: typeof standings2;
    let relegated: typeof standings1;
    let playoffResult: SeasonRecord['playoff'];
    if (this.promotionMode === 'playoff') {
      const decider = this.fixtures.find((f) => f.playoff && f.played);
      relegated = [standings1[7]];
      promoted = [standings2[0]];
      if (decider && decider.scoreH !== undefined && decider.scoreA !== undefined) {
        const challengerWon = decider.scoreA > decider.scoreH;
        const homeF = this.franchise(decider.home);
        const awayF = this.franchise(decider.away);
        playoffResult = {
          homeName: homeF.name,
          awayName: awayF.name,
          // Slots too (Phase 40): rivalries live on the CLUB (the slot
          // survives rebirths), names don't. Optional — old records lack it.
          homeSlot: decider.home,
          awaySlot: decider.away,
          score: [decider.scoreH, decider.scoreA],
          winnerName: challengerWon ? awayF.name : homeF.name,
        };
        if (challengerWon) {
          relegated = [...relegated, standings1[6]];
          promoted = [...promoted, standings2[1]];
        }
      }
    } else {
      promoted = standings2.slice(0, 2);
      relegated = standings1.slice(-2);
    }

    // Protections: the champion, and the promoted team(s) (they earned it on
    // the pitch — evolution must not delete them on style grounds).
    map1.set(standings1[0].slot, Math.max(...map1.values()) + eps);
    for (const p of [...promoted].reverse()) {
      map2.set(p.slot, Math.max(...map2.values()) + eps);
    }

    const record: SeasonRecord = {
      generation: this.generation,
      championSlot: standings1[0].slot,
      championName: standings1[0].franchise.name,
      d2Champion: standings2[0].franchise.name,
      promoted: promoted.map((r) => ({ slot: r.slot, name: r.franchise.name })),
      relegated: relegated.map((r) => ({ slot: r.slot, name: r.franchise.name })),
      playoff: playoffResult,
      table: [...standings1, ...standings2].map((r) => ({
        slot: r.slot, name: r.franchise.name, pts: r.pts, w: r.w, d: r.d, l: r.l,
        gf: r.gf, ga: r.ga, elo: Math.round(r.franchise.elo),
        division: r.franchise.division,
        // Cloned — the live agg objects are replaced next season, but the
        // record must own its numbers either way.
        ch: { f: { ...this.agg[r.slot].chFor }, a: { ...this.agg[r.slot].chAgainst } },
      })),
      fitness: [...fit1, ...fit2]
        .map((x) => ({ ...x, name: this.franchise(x.slot).name }))
        .sort((a, b) => b.total - a.total),
      // Filled after the evolution pass below — the record must snapshot
      // geneMeans/attrMeans/styleShares BEFORE evolution mutates franchises,
      // so the entries cannot be computed at literal-build time.
      evolution: { generation: this.generation + 1, entries: [] },
      cup: this.cup && cupRoundComplete(this.cup, 3)
        ? buildCupRecord(this.cup, (slot, i) => this.franchise(slot).playerNames[i] ?? ROSTER_ROLES[i])
        : undefined,
      awards: this.buildAwards(0),
      awardsD2: this.buildAwards(1),
      geneMeans: this.geneMeans(),
      attrMeans: this.attrMeans(),
      styleShares: this.styleShares(),
      styleMatrix: this.franchises.map((f) => {
        const summary = squadSummary(f.squad);
        return {
          slot: f.slot,
          values: styleValues({ genome: f.coach.genome, policy: f.coach.policy }),
          style: { ...f.coach.style }, // the shape identity (Phase 116)
          attrs: ATTR_KEYS.map((k) => summary[k]), // the budget's shape (118.5)
        };
      }),
      longestChain: this.longestChainRecord(),
      pointsTimeline: this.buildPointsTimeline(),
    };

    // The dugout banks the season too (Phase 53) — BEFORE evolution can
    // replace a dying club's manager, exactly like the player careers above.
    for (const f of this.franchises) f.coach.career.seasons++;
    this.franchise(record.championSlot).coach.career.titles++;
    if (record.cup) this.franchise(record.cup.winnerSlot).coach.career.cups++;
    for (const p of promoted) this.franchise(p.slot).coach.career.promotions++;

    // Evolution per division. D2's reborn slots draw parents from D1's best.
    const evoRng = new Rng(hashSeed(this.seed, this.generation, 0xe0));
    const taken = new Set(this.franchises.map((f) => f.name));
    const d1 = this.division(0);
    const d2 = this.division(1);
    // Prestige bias (Phase 40): dynasties leave slightly bigger genetic
    // footprints — the D2 rebirth parent pool ranks by fitness PLUS an
    // age-decayed trophy weight, HARD-CAPPED at +0.06 (fitness totals run
    // ~0–1, so prestige can only flip near-ties; the positive-feedback
    // monoculture risk is the cap's whole reason — evolve-check gates it).
    const pKey = (f: Franchise): number =>
      (map1.get(f.slot) ?? 0) + Math.min(this.prestigeOf(f.slot), 2) * 0.03;
    const d1Ranked = [...d1].sort((a, b) => pKey(b) - pKey(a));
    // Zonal ecology budget (Phase 31): one shared counter for both division
    // passes — zonal stays the RARE identity (~4 of 16) no matter which
    // channel (mutation or rebirth inheritance) tries to spread it.
    const zonalCount = this.franchises.filter((f) => f.coach.style.scheme === 'zonal').length;
    const zonal = { room: Math.max(0, 4 - zonalCount) };
    const fired: Coach[] = [];
    const firedSquads: NonNullable<EvolvePlan['firedSquads']> = [];
    const entries = [
      ...evolveGroup(d1, map1, this.generation, evoRng,
        { eliteN: 2, rebornN: 0, zonal, firedCoaches: fired, firedSquads }, taken),
      ...evolveGroup(
        d2, map2, this.generation, evoRng,
        { eliteN: 2, rebornN: 3, parentPool: d1Ranked, zonal, firedCoaches: fired, firedSquads },
        taken,
      ),
    ];
    record.evolution = { generation: this.generation + 1, entries };

    // Dead clubs' managers hit the market (Phase 53) — same order as the
    // reborn entries, so each ex-boss carries his club's final fitness.
    const rebornEntries = entries.filter((e) => e.kind === 'reborn');
    fired.forEach((coach, i) => {
      this.coachPool.push({
        coach,
        sinceGen: this.generation,
        lastFitness: rebornEntries[i]?.fitness ?? 0,
        lastClub: rebornEntries[i]?.oldName ?? '?',
      });
    });

    record.coaching = this.coachingPass(record, promoted, entries, map1, map2);

    // The FIRE-SALE intake (Phase 55): the dead clubs' players hit the
    // market with their genes, styles, ages and careers intact.
    for (const dead of firedSquads) {
      dead.squad.forEach((attrs, i) => {
        this.freeAgents.push({
          name: dead.names[i] ?? ROSTER_ROLES[i],
          role: ROSTER_ROLES[i],
          attrs,
          style: dead.styles[i],
          age: dead.ages[i],
          career: dead.careers[i],
          lastClub: dead.club,
          sinceGen: this.generation,
        });
      });
    }
    this.freeAgents = trimPool(this.freeAgents);

    // Careers pass (Phase 26): everyone still at their club ages a year,
    // develops along the age curve, and may retire — replaced by a newgen.
    // Reborn squads are brand-new people and sit this generation out.
    const rebornSlots = new Set(entries.filter((e) => e.kind === 'reborn').map((e) => e.slot));
    const ageRng = new Rng(hashSeed(this.seed, this.generation, 0xa9));
    const retirements: RetirementEntry[] = [];
    const signings: NonNullable<SeasonRecord['signings']> = [];
    for (const f of this.franchises) {
      if (rebornSlots.has(f.slot)) continue;
      for (let i = 0; i < f.squad.length; i++) {
        f.ages[i]++;
        f.squad[i] = developPlayer(f.squad[i], f.ages[i], ageRng);
        if (ageRng.chance(retireChance(f.ages[i]))) {
          const career = f.careers[i];
          retirements.push({
            name: f.playerNames[i] ?? ROSTER_ROLES[i],
            team: f.name,
            role: ROSTER_ROLES[i],
            age: f.ages[i],
            seasons: career.seasons,
            goals: career.goals,
            saves: career.saves,
          });
          this.recordLegend(f, i, career);
          // The FIRE-SALE window (Phase 55): a retirement is the one natural
          // vacancy. The board signs the market's best like-for-like ONLY
          // when he clearly beats the academy option (the newgen would be
          // ≈ the retiree's profile) AND fits under the budget without
          // taxing the rest of the squad. Otherwise: academy as always.
          // Budget currency (Phase-120 position-aware): sum only the attrs that
          // cost budget for THIS slot (GK: not finishing/defending; outfield:
          // not reflexes) so headroom = cap − used + freed stays in squadTotal's
          // units.
          const retireeTotal = ATTR_KEYS.reduce(
            (a, k) => (countsForBudget(k, i === 0) ? a + f.squad[i][k] : a), 0,
          );
          const headroom = SQUAD_BUDGET - squadTotal(f.squad) + retireeTotal;
          // Style fit as a MARKET SIGNAL (Phase 80, N6): the board weighs a
          // candidate's appetites against the retiree's — the club's evolved
          // bloodline for the slot — by its OWN fitBias gene. Eligibility
          // (beats the academy, fits the budget) is unchanged; only the
          // ranking among eligibles moves. 1.2 = a perfect fit is worth up
          // to ~1.2 ability points to an all-in system board.
          const retireeStyle = { ...f.squadStyles[i] };
          const fitW = (f.coach.genome.fitBias ?? 0.5) * 1.2;
          const score = (x: FreeAgent): number => agentTotal(x) + fitW * styleFit(x.style, retireeStyle);
          const agent = this.freeAgents
            .filter((x) =>
              x.role === ROSTER_ROLES[i] && x.age <= FREE_AGENT_MAX_AGE &&
              // No two men on one sheet share a nameplate (latent Phase-55
              // bug surfaced by Phase 80's RNG shift): identity — bodies,
              // styles, careers — is name-keyed on the roster.
              !f.playerNames.includes(x.name) &&
              agentTotal(x) > retireeTotal + 0.2 && agentTotal(x) <= headroom + 1e-9)
            .sort((a, b) => score(b) - score(a) || a.age - b.age || a.name.localeCompare(b.name))[0];
          if (agent) {
            this.freeAgents = this.freeAgents.filter((x) => x !== agent);
            f.playerNames[i] = agent.name;
            f.squad[i] = { ...agent.attrs };
            f.squadStyles[i] = { ...agent.style };
            f.ages[i] = agent.age;
            f.careers[i] = { ...agent.career }; // the career CONTINUES
            signings.push({ club: f.name, player: agent.name, from: agent.lastClub, age: agent.age });
            continue;
          }
          f.playerNames[i] = newgenName(ageRng, f.playerNames);
          // Academy heredity (Phase 48): the successor is grown in the
          // club's image — the retiree's profile mutated, NOT a random
          // role-biased roll. What this slot's player IS is bloodline now —
          // and so is HOW he likes to play (Phase 54). The current coach's
          // philosophy steers the academy's axis (Phase 94): containment
          // schools raise defenders, dive-in schools raise runners.
          f.squad[i] = newgenFromBloodline(f.squad[i], ageRng, f.coach.genome.jockeyBias ?? 0.5);
          f.squadStyles[i] = styleFromBloodline(f.squadStyles[i], ageRng);
          f.ages[i] = rookieAge(ageRng);
          f.careers[i] = emptyCareer();
        }
      }
      // The wage cap (Phase 48): growth + intake settle onto the budget —
      // youth development is funded by shaving everyone proportionally.
      f.squad = enforceBudget(f.squad);
    }
    record.retirements = retirements;
    record.signings = signings;

    // The market ages with everyone else; veterans and the long-unsigned
    // drift into quiet retirement (their genes had their chance).
    this.freeAgents = this.freeAgents.filter((x) => {
      x.age++;
      return x.age <= FREE_AGENT_MAX_AGE + 2 && this.generation + 1 - x.sinceGen < 3;
    });

    // Promotion & relegation by table position.
    for (const r of relegated) {
      const f = this.franchise(r.slot);
      f.division = 1;
      f.lineage.push({ generation: this.generation + 1, event: 'relegated' });
    }
    for (const r of promoted) {
      const f = this.franchise(r.slot);
      f.division = 0;
      f.lineage.push({ generation: this.generation + 1, event: 'promoted' });
    }

    // Discipline slate wiped (Phase 62): suspensions don't cross seasons —
    // retirement/rebirth changes WHO occupies a row, and a ban is personal.
    for (const f of this.franchises) {
      f.suspensions = f.squad.map(() => 0);
      f.injuries = f.squad.map(() => 0); // the treatment table empties too (118)
    }

    this.history.push(record);
    this.generation++;
    this.startSeason();
    return record;
  }

  /**
   * The dugout pass (Phase 53), after evolution: (1) the SACK/HIRE channel —
   * a club on a two-season bottom-third fuse fires its coach when the market
   * offers a better philosophy (tactics spread by MOVEMENT, not just death);
   * (2) coaches age; retirement hands the club a successor schooled by the
   * retiree (the mentor tree), and the pool ages out too. Returns the
   * season's dugout events for the record/chronicle.
   */
  private coachingPass(
    record: SeasonRecord,
    promoted: Array<{ slot: number }>,
    entries: EvolutionEntry[],
    map1: Map<number, number>,
    map2: Map<number, number>,
  ): NonNullable<SeasonRecord['coaching']> {
    const coaching: NonNullable<SeasonRecord['coaching']> = [];
    const nextGen = this.generation + 1;
    const rebornSlots = new Set(entries.filter((e) => e.kind === 'reborn').map((e) => e.slot));
    const safe = new Set([
      record.championSlot,
      ...(record.cup ? [record.cup.winnerSlot] : []),
      ...promoted.map((p) => p.slot),
    ]);

    // The misery fuse: consecutive bottom-third-fitness seasons per slot.
    for (const d of [0, 1] as Division[]) {
      const group = this.division(d);
      const fmap = d === 0 ? map1 : map2;
      const ranked = [...group].sort(
        (a, b) => (fmap.get(b.slot) ?? 0) - (fmap.get(a.slot) ?? 0) || a.slot - b.slot,
      );
      ranked.forEach((f, rank) => {
        if (rebornSlots.has(f.slot)) {
          this.misery[f.slot] = 0; // a fresh project starts with a clean slate
          return;
        }
        const bottomThird = rank >= group.length - 3;
        this.misery[f.slot] = bottomThird && !safe.has(f.slot) ? (this.misery[f.slot] ?? 0) + 1 : 0;
      });
    }

    // Sackings: the fuse burns at 2, and a board only acts when the market's
    // best available philosophy OUTSCORES the incumbent's season — selective
    // pressure, not churn. (Fitness across seasons is an approximate ruler;
    // that's what a hiring board sees too.)
    for (const f of this.franchises) {
      if (!this.sackingEnabled) break;
      if ((this.misery[f.slot] ?? 0) < 2 || this.coachPool.length === 0) continue;
      const own = (f.division === 0 ? map1 : map2).get(f.slot) ?? 0;
      const market = [...this.coachPool].sort(
        (a, b) => b.lastFitness - a.lastFitness || b.sinceGen - a.sinceGen ||
          a.coach.name.localeCompare(b.coach.name),
      );
      const pick = market[0];
      if (pick.lastFitness <= own) continue;
      const old = f.coach;
      old.career.sackings++;
      this.coachPool = this.coachPool.filter((p) => p !== pick);
      const hired = pick.coach;
      hired.career.clubs++;
      // The zonal ecology budget gates arrivals too (failure mode 18): an
      // incoming zonal philosophy needs room or the new boss adapts to man.
      if (hired.style.scheme === 'zonal') {
        const zCount = this.franchises
          .filter((x) => x.slot !== f.slot && x.coach.style.scheme === 'zonal').length;
        if (zCount >= 4) hired.style = { ...hired.style, scheme: 'man' };
      }
      f.coach = hired;
      this.coachPool.push({ coach: old, sinceGen: nextGen, lastFitness: own, lastClub: f.name });
      this.misery[f.slot] = 0;
      f.lineage.push({ generation: nextGen, event: 'sacked', note: `🪓 ${old.name}` });
      f.lineage.push({
        generation: nextGen, event: 'hired',
        note: `🤝 ${hired.name} (ex-${pick.lastClub})`,
      });
      coaching.push({ event: 'sacked', club: f.name, coach: old.name });
      coaching.push({ event: 'hired', club: f.name, coach: hired.name, note: `ex-${pick.lastClub}` });
    }

    // Aging + retirement + succession (the mentor tree).
    const coachRng = new Rng(hashSeed(this.seed, this.generation, 0xc2));
    for (const f of this.franchises) {
      const c = f.coach;
      c.age++;
      if (!coachRng.chance(coachRetireChance(c.age))) continue;
      this.recordCoachLegend(c, f.name);
      coaching.push({
        event: 'retired', club: f.name, coach: c.name,
        note: `${c.career.titles}×🏆 ${c.career.cups}×🏅 over ${c.career.seasons} seasons, age ${c.age}`,
        honours: c.career.titles + c.career.cups,
      });
      const successor = createCoach(
        coachRng,
        mutateGenome(c.genome, coachRng, { rate: 0.4, scale: 0.08 }),
        mutatePolicyGenes(c.policy, coachRng),
        { ...c.style },
        { age: rookieCoachAge(coachRng), mentor: c.name },
      );
      f.coach = successor;
      f.lineage.push({
        generation: nextGen, event: 'coach-retired', note: `🎓 ${c.name} → ${successor.name}`,
      });
      coaching.push({
        event: 'succeeded', club: f.name, coach: successor.name, note: `school of ${c.name}`,
      });
    }
    // The market ages too; nobody waits by the phone forever.
    for (const p of [...this.coachPool]) {
      p.coach.age++;
      if (coachRng.chance(coachRetireChance(p.coach.age)) || nextGen - p.sinceGen >= 3) {
        this.coachPool = this.coachPool.filter((x) => x !== p);
        this.recordCoachLegend(p.coach, p.lastClub);
      }
    }
    return coaching;
  }

  /** The dugout hall of fame: top 12 retired coaches by honours. Only careers
   * worth remembering enter — silverware, or real longevity in the dugout
   * (the churn retires plenty of two-season nobodies through the pool). */
  private recordCoachLegend(c: Coach, lastClub: string): void {
    if (c.career.titles + c.career.cups === 0 && c.career.seasons < 6) return;
    this.coachLegends.push({
      name: c.name, age: c.age, career: { ...c.career }, mentor: c.mentor, lastClub,
    });
    this.coachLegends.sort(
      (a, b) =>
        b.career.titles - a.career.titles ||
        b.career.cups - a.career.cups ||
        b.career.seasons - a.career.seasons ||
        a.name.localeCompare(b.name),
    );
    this.coachLegends = this.coachLegends.slice(0, 12);
  }

  /** Keep the best retirees forever: top 20 by career goals (saves, then seasons break ties). */
  private recordLegend(f: Franchise, i: number, career: PlayerCareer): void {
    this.legends.push({
      name: f.playerNames[i] ?? ROSTER_ROLES[i],
      team: f.name,
      role: ROSTER_ROLES[i],
      age: f.ages[i],
      career: { ...career },
    });
    this.legends.sort(
      (a, b) =>
        b.career.goals - a.career.goals ||
        b.career.saves - a.career.saves ||
        b.career.seasons - a.career.seasons ||
        a.name.localeCompare(b.name),
    );
    this.legends = this.legends.slice(0, 20);
  }

  /* ---------------- season report inputs ---------------- */

  /** Named player season lines, resolved against current rosters. */
  playerLines(division?: Division): PlayerSeasonLine[] {
    const lines: PlayerSeasonLine[] = [];
    for (const f of this.franchises) {
      if (division !== undefined && f.division !== division) continue;
      this.playerAgg[f.slot].forEach((s, i) => {
        lines.push({
          ...s,
          slot: f.slot,
          name: f.playerNames[i] ?? ROSTER_ROLES[i],
          team: f.name,
          role: ROSTER_ROLES[i],
          // Divide by APPS since the bench (Phase 61): a substitute's
          // average is over the matches he actually appeared in.
          avgRating: s.apps > 0 ? s.rating / s.apps : 0,
        });
      });
    }
    return lines;
  }

  private buildAwards(division: Division): SeasonAwards {
    const lines = this.playerLines(division);
    const topScorers = [...lines]
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.slot - b.slot)
      .slice(0, 5)
      .filter((l) => l.goals > 0);
    const topAssists = [...lines]
      .sort((a, b) => b.assists - a.assists || b.goals - a.goals || a.slot - b.slot)
      .slice(0, 3)
      .filter((l) => l.assists > 0);
    const keepers = lines.filter((l) => l.role === 'GK').sort((a, b) => b.saves - a.saves || a.slot - b.slot);
    let dirtiest: SeasonAwards['dirtiest'] = null;
    for (const f of this.franchises) {
      if (f.division !== division) continue;
      const a = this.agg[f.slot];
      const score = a.yellows + a.reds * 2;
      if (score > 0 && (!dirtiest || score > dirtiest.yellows + dirtiest.reds * 2)) {
        dirtiest = { slot: f.slot, name: f.name, yellows: a.yellows, reds: a.reds };
      }
    }
    // MVP needs a body of work (Phase 61): half his club's fixtures. A
    // two-cameo 8.0 must not outrank a season-long 7.4.
    const playedOf = new Map(this.table.map((r) => [r.slot, r.played]));
    const rated = lines
      .filter((l) => l.apps * 2 >= (playedOf.get(l.slot) ?? 0))
      .sort((a, b) => b.avgRating - a.avgRating || b.goals - a.goals || a.slot - b.slot);
    return {
      topScorers,
      topAssists,
      topKeeper: keepers[0] && keepers[0].saves > 0 ? keepers[0] : null,
      dirtiest,
      mvp: rated[0] && rated[0].avgRating > 0 ? rated[0] : null,
    };
  }

  /** The season's tiki-taka crown: longest completed-pass chain (Phase 33). */
  private longestChainRecord(): { team: string; length: number } | undefined {
    let best: { team: string; length: number } | undefined;
    for (const f of this.franchises) {
      const n = this.agg[f.slot].longestChain;
      if (n > 0 && (!best || n > best.length)) best = { team: f.name, length: n };
    }
    return best;
  }

  private geneMeans(): Record<GeneKey, number> {
    const out = {} as Record<GeneKey, number>;
    for (const k of GENE_KEYS) {
      out[k] = this.franchises.reduce((a, f) => a + f.coach.genome[k], 0) / this.franchises.length;
    }
    return out;
  }

  /** Formation-identity counts across the 16 clubs (Phase 31 — the
   * Evolution tab's share strips read these per generation). */
  private styleShares(): { atk: Record<string, number>; def: Record<string, number>; scheme: Record<string, number> } {
    const atk: Record<string, number> = {};
    const def: Record<string, number> = {};
    const scheme: Record<string, number> = {};
    for (const f of this.franchises) {
      const s = f.coach.style;
      atk[s.formationAtk] = (atk[s.formationAtk] ?? 0) + 1;
      def[s.formationDef] = (def[s.formationDef] ?? 0) + 1;
      scheme[s.scheme] = (scheme[s.scheme] ?? 0) + 1;
    }
    return { atk, def, scheme };
  }

  private attrMeans(): Record<AttrKey, number> {
    const out = {} as Record<AttrKey, number>;
    for (const k of ATTR_KEYS) {
      let sum = 0;
      let n = 0;
      for (const f of this.franchises) {
        for (const p of f.squad) {
          sum += p[k];
          n++;
        }
      }
      out[k] = sum / Math.max(n, 1);
    }
    return out;
  }

  /** Cumulative points per slot after each round — derived from fixtures. */
  private buildPointsTimeline(): number[][] {
    const timeline: number[][] = this.franchises.map(() => []);
    const pts = this.franchises.map(() => 0);
    for (let r = 0; r < TEAMS_PER_DIVISION - 1; r++) {
      for (const f of this.fixtures) {
        // Cup ties reuse low round numbers and award no points — league only.
        if (f.cup || f.playoff) continue;
        if (f.round !== r || !f.played || f.scoreH === undefined || f.scoreA === undefined) continue;
        if (f.scoreH > f.scoreA) pts[f.home] += 3;
        else if (f.scoreH === f.scoreA) {
          pts[f.home] += 1;
          pts[f.away] += 1;
        } else pts[f.away] += 3;
      }
      for (let s = 0; s < pts.length; s++) timeline[s].push(pts[s]);
    }
    return timeline;
  }

  /* ---------------- persistence ---------------- */

  toJSON(): object {
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      generation: this.generation,
      matchDuration: this.matchDuration,
      promotionMode: this.promotionMode,
      cupDrawMode: this.cupDrawMode,
      franchises: this.franchises,
      fixtures: this.fixtures,
      cursor: this.cursor,
      table: this.table,
      agg: this.agg,
      playerAgg: this.playerAgg,
      history: this.history,
      cup: this.cup,
      legends: this.legends,
      coachPool: this.coachPool,
      coachLegends: this.coachLegends,
      misery: this.misery,
      freeAgents: this.freeAgents,
    };
  }

  static fromJSON(data: Record<string, unknown>): League {
    // POSITIONING backfill (Phase 119j) runs BEFORE the version chain: an
    // intermediate step (v17→v18) calls enforceBudget → squadTotal sums every
    // ATTR_KEY, so a pre-v32 squad missing `positioning` would poison the
    // rescale with NaN long before a v31→v32 block could fix it. Backfilling
    // the neutral 0.5 up front on any squad/free-agent that lacks it makes the
    // whole chain robust (no-op for v32+ saves; v≤13 squads that predate the
    // attr split re-assert it in the v13→v14 rebuilder below).
    const backfillPos = (a: Record<string, unknown> | undefined): void => {
      if (a && a.positioning === undefined) a.positioning = 0.5;
    };
    for (const f of (data.franchises as Array<Record<string, unknown>>) ?? []) {
      for (const p of (f.squad as Array<Record<string, unknown>>) ?? []) backfillPos(p);
    }
    for (const fa of (data.freeAgents as Array<Record<string, unknown>>) ?? []) {
      backfillPos(fa.attrs as Record<string, unknown> | undefined);
    }
    if (data.version === 1) {
      // v1 -> v2: squads didn't exist yet — deal every franchise a fresh,
      // seed-derived squad so old leagues keep their tactical history.
      for (const f of data.franchises as Franchise[]) {
        f.squad = randomSquad(new Rng(hashSeed(Number(data.seed), f.slot, 0xa7)));
      }
      data.version = 2;
    }
    if (data.version === 2) {
      // v2 -> v3: player season stats didn't exist — start the counters at zero.
      data.playerAgg = (data.franchises as Franchise[]).map(() => ROLES.map(() => emptyPlayerStats()));
      data.version = 3;
    }
    if (data.version === 3) {
      // v3 -> v4: the single 8-team division becomes Division 1, and a brand
      // new Division 2 spawns beneath it. The current season's D1 fixtures
      // (and results) are preserved; fresh D2 fixtures are appended.
      const franchises = data.franchises as Franchise[];
      for (const f of franchises) f.division = 0;
      const rng = new Rng(hashSeed(Number(data.seed), Number(data.generation), 0xd2));
      const taken = new Set(franchises.map((f) => f.name));
      const newcomers: Franchise[] = [];
      for (let slot = franchises.length; slot < TOTAL_TEAMS; slot++) {
        newcomers.push(createFranchise(slot, rng, taken, 1, Number(data.generation)));
      }
      data.franchises = [...franchises, ...newcomers];
      (data.table as TableRow[]).push(
        ...newcomers.map((f) => ({ slot: f.slot, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 })),
      );
      (data.agg as SeasonAggregates[]).push(...newcomers.map(() => emptyAggregates()));
      (data.playerAgg as PlayerMatchStats[][]).push(
        ...newcomers.map(() => ROLES.map(() => emptyPlayerStats())),
      );
      for (const f of data.fixtures as Fixture[]) f.division = 0;
      (data.fixtures as Fixture[]).push(
        ...buildDivisionFixtures(newcomers.map((f) => f.slot), 1),
      );
      data.version = 4;
    }
    if (data.version === 4) {
      // v4 -> v5: the Evo Cup arrives. The in-progress season has no cup
      // fixtures scheduled, so it finishes cup-less (pre-cup era); the next
      // startSeason draws the first bracket. Never fabricate old cup history.
      data.cup = null;
      data.version = 5;
    }
    if (data.version === 5) {
      // v5 -> v6: cards arrive (Phase 25). Season aggregates gain card
      // tallies — the in-progress season simply starts counting from here.
      for (const a of data.agg as Array<Record<string, unknown>>) {
        a.yellows ??= 0;
        a.reds ??= 0;
      }
      data.version = 6;
    }
    if (data.version === 6) {
      // v6 -> v7: player careers (Phase 26). Existing squads get seeded ages
      // spanning the career arc; ledgers start blank from here — never
      // fabricate career history that wasn't simulated.
      const rng = new Rng(hashSeed(Number(data.seed), 0xa9));
      for (const f of data.franchises as Franchise[]) {
        // Squad-length-driven, NOT SQUAD_ROLES-driven: this migration must
        // produce era-correct (5-slot) data even though the constant has
        // since grown to 6 (Phase 30) — v7→v8 is where the 6th slot appears.
        f.ages = f.squad.map(() => veteranAge(rng));
        f.careers = f.squad.map(() => emptyCareer());
      }
      data.legends = [];
      data.version = 7;
    }
    if (data.version === 7) {
      // v7 -> v8: 6v6 (Phase 30). Every club signs a second winger — a
      // generated WG newgen spliced in at slot 4 (between the old WG, now
      // WGL, and the striker, who moves to slot 5). Old saves keep playing;
      // their remaining fixtures are simply contested six-a-side. Every
      // splice is length-guarded: franchises minted by EARLIER migrations
      // (v1→v2 squads, v3→v4 Division 2 newcomers) already used today's
      // 6-slot generators and must not grow a 7th player.
      const rng = new Rng(hashSeed(Number(data.seed), 0xb8));
      for (const f of data.franchises as Franchise[]) {
        if (f.squad.length < TEAM_SIZE) f.squad.splice(4, 0, randomPlayer(rng, 'WG'));
        if (f.playerNames.length < TEAM_SIZE) f.playerNames.splice(4, 0, newgenName(rng, f.playerNames));
        if (f.ages.length < TEAM_SIZE) f.ages.splice(4, 0, rookieAge(rng));
        if (f.careers.length < TEAM_SIZE) f.careers.splice(4, 0, emptyCareer());
      }
      // Mid-season counters grow a sixth row; the newcomer starts at zero.
      for (const arr of data.playerAgg as PlayerMatchStats[][]) {
        if (arr.length < TEAM_SIZE) arr.splice(4, 0, emptyPlayerStats());
      }
      const cup = data.cup as CupState | null | undefined;
      if (cup) for (const goals of cup.playerGoals) {
        if (goals.length < TEAM_SIZE) goals.splice(4, 0, 0);
      }
      // The formation system arrives with 6v6: backfill every club's
      // tactical identity from its genome (the same derivation creation
      // uses, so a loaded club looks like a freshly created one). Guarded
      // off franchises minted by LATER-shape creators (v3→v4 newcomers
      // already carry a coach and have no loose genome, Phase 53).
      for (const f of data.franchises as LegacyFranchise[]) {
        if (!f.coach && f.genome) f.style ??= deriveTeamStyle(f.genome);
      }
      data.version = 8;
    }
    if (data.version === 8) {
      // v8 -> v9: ratings + pass chains (Phase 33). Pure counters — the
      // in-progress season starts counting from here, no history fabricated.
      for (const arr of data.playerAgg as Array<Array<Record<string, unknown>>>) {
        for (const s of arr) {
          s.miscontrols ??= 0;
          s.rating ??= 0;
        }
      }
      for (const a of data.agg as Array<Record<string, unknown>>) a.longestChain ??= 0;
      data.version = 9;
    }
    if (data.version === 9) {
      // v9 -> v10: attacking-style policy genes (Phase 42). Pre-42 clubs all
      // played the shared DEFAULT_POLICY — backfill that subset so a loaded
      // club is bit-identical to before; evolution diverges them from here.
      for (const f of data.franchises as LegacyFranchise[]) {
        if (!f.coach) f.policy ??= defaultPolicyGenes();
      }
      data.version = 10;
    }
    if (data.version === 10) {
      // v10 -> v11: defensive-style policy genes (Phase 43) join the attacking
      // set. Fill the NEW keys with their DEFAULT while keeping a phase-42
      // club's evolved attacking values, so evolution doesn't read undefined.
      for (const f of data.franchises as LegacyFranchise[]) {
        if (!f.coach) f.policy = { ...defaultPolicyGenes(), ...f.policy };
      }
      data.version = 11;
    }
    if (data.version === 11) {
      // v11 -> v12: build-up policy genes (Phase 44) join the set. Same backfill
      // — fill new keys with DEFAULT, keep evolved attacking/defensive values.
      for (const f of data.franchises as LegacyFranchise[]) {
        if (!f.coach) f.policy = { ...defaultPolicyGenes(), ...f.policy };
      }
      data.version = 12;
    }
    if (data.version === 12) {
      // v12 -> v13: combo policy genes (Phase 45). Same backfill — the new
      // 套路 appetites load at 1.0 (the Phase-34 constants), evolved values kept.
      for (const f of data.franchises as LegacyFranchise[]) {
        if (!f.coach) f.policy = { ...defaultPolicyGenes(), ...f.policy };
      }
      data.version = 13;
    }
    if (data.version === 13) {
      // v13 -> v14: the attribute split (Phase 47). passing/dribbling
      // inherit the old technique; strength/stamina start neutral at 0.4
      // (every new payoff term is centred there, so a migrated league's
      // balance doesn't move — the gradients are what's new).
      const up = (p: Record<string, number | undefined>): Record<string, number> => {
        const technique = p.technique ?? 0.5;
        return {
          pace: p.pace ?? 0.5,
          passing: p.passing ?? technique,
          dribbling: p.dribbling ?? technique,
          finishing: p.finishing ?? 0.5,
          defending: p.defending ?? 0.5,
          strength: p.strength ?? 0.4,
          stamina: p.stamina ?? 0.4,
          reflexes: p.reflexes ?? 0.5,
          // The rebuilder drops unlisted keys — carry positioning (Phase 119j;
          // the top-of-chain backfill added it) so the v17→v18 budget pass
          // downstream doesn't NaN on a missing 9th attr.
          positioning: p.positioning ?? 0.5,
        };
      };
      for (const f of data.franchises as unknown as Array<{ squad: Array<Record<string, number>> }>) {
        f.squad = f.squad.map(up);
      }
      for (const r of ((data.history ?? []) as Array<{ attrMeans?: Record<string, number> }>)) {
        if (r.attrMeans) r.attrMeans = up(r.attrMeans);
      }
      data.version = 14;
    }
    if (data.version === 14) {
      // v14 -> v15: THE COACH (Phase 53). The club's tactical genome, policy
      // genes and formation identity are wrapped into a named, aging coach —
      // the same values, now embodied (a loaded club plays bit-identically).
      // Careers start blank (no fabricated dugout history); ages are seeded.
      const rng = new Rng(hashSeed(Number(data.seed), 0xc0));
      for (const f of data.franchises as LegacyFranchise[]) {
        if (f.coach || !f.genome) continue;
        f.coach = createCoach(
          rng,
          f.genome,
          { ...defaultPolicyGenes(), ...f.policy },
          f.style ?? deriveTeamStyle(f.genome),
        );
        delete f.genome;
        delete f.policy;
        delete f.style;
      }
      data.version = 15;
    }
    if (data.version === 15) {
      // v15 -> v16: per-player decision styles (Phase 54). Everyone loads
      // NEUTRAL (×1.0 — the coach's policy verbatim, bit-identical play);
      // divergence is earned through the academy from here.
      for (const f of data.franchises as Array<{ squad: unknown[]; squadStyles?: unknown[] }>) {
        f.squadStyles ??= neutralSquadStyles(f.squad.length);
      }
      data.version = 16;
    }
    if (data.version === 16) {
      // v16 -> v17: the free-agent fire-sale (Phase 55). The market opens
      // EMPTY — no fabricated ex-players; the first club death fills it.
      data.freeAgents ??= [];
      data.version = 17;
    }
    if (data.version === 17) {
      // v17 -> v18: the BENCH (Phase 61, N2). Every club signs three
      // substitutes — role-biased veterans appended after the starting six,
      // exactly what founding rolls (length-guarded like v7→v8: franchises
      // minted mid-chain by current-shape creators already carry nine).
      // The rotation gene backfills NEUTRAL (0.5) everywhere a genome is
      // stored — live coaches, the unemployed pool, and history snapshots
      // (the ceremony radar and the gene sparklines read those).
      const rng = new Rng(hashSeed(Number(data.seed), 0xbe));
      for (const f of data.franchises as Franchise[]) {
        while (f.squad.length < ROSTER_SIZE) {
          f.squad.push(randomPlayer(rng, ROSTER_ROLES[f.squad.length]));
          f.playerNames.push(newgenName(rng, f.playerNames));
          f.ages.push(veteranAge(rng));
          f.careers.push(emptyCareer());
          f.squadStyles.push(...neutralSquadStyles(1));
        }
        // Budget headroom: the cap grew 24 → 36 with the roster (same
        // per-player density), so a migrated 24-cap squad plus three
        // founding-strength subs (~34) fits without a shave.
        f.squad = enforceBudget(f.squad);
      }
      const fixGenome = (g: TacticalGenome | undefined): void => {
        if (g) g.rotationBias ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixGenome(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixGenome(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).rotationBias ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixGenome(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixGenome);
        }
      }
      // Mid-season counters grow bench rows; apps backfill from the table —
      // before the bench, every rostered player played every fixture.
      const playedBySlot = new Map((data.table as TableRow[]).map((r) => [r.slot, r.played]));
      (data.playerAgg as Array<Array<PlayerMatchStats>>).forEach((arr, slot) => {
        for (const s of arr) s.apps ??= playedBySlot.get(slot) ?? 0;
        while (arr.length < ROSTER_SIZE) arr.push(emptyPlayerStats());
      });
      const cup17 = data.cup as CupState | null | undefined;
      if (cup17) for (const goals of cup17.playerGoals) {
        while (goals.length < ROSTER_SIZE) goals.push(0);
      }
      data.version = 18;
    }
    if (data.version === 18) {
      // v18 -> v19: CARDS THAT BIND (Phase 62). Personal card counters
      // start at zero (the season's earlier bookings predate attribution —
      // no fabricated discipline history) and every club loads with a
      // clean suspension slate.
      for (const f of data.franchises as Franchise[]) {
        f.suspensions ??= f.squad.map(() => 0);
      }
      for (const arr of data.playerAgg as Array<Array<Record<string, unknown>>>) {
        for (const s of arr) {
          s.yellows ??= 0;
          s.reds ??= 0;
        }
      }
      data.version = 19;
    }
    if (data.version === 19) {
      // v19 -> v20: the underdog shift (Phase 64). Backfilled at ZERO —
      // the purist — so a migrated club plays exactly as it always did
      // until evolution discovers pragmatism; history snapshots get the
      // key too (radar/sparkline safety).
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.underdogShift ??= 0;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).underdogShift ??= 0;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 20;
    }
    if (data.version === 20) {
      // v20 -> v21: tinkerBias (Phase 66, N3 — the coach's adjustment
      // personality). Backfilled at 0.5 — the exact Phase-35 mentality
      // curve — so a migrated club responds to score + clock precisely as
      // it always did until evolution moves the dial either way.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.tinkerBias ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).tinkerBias ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 21;
    }
    if (data.version === 21) {
      // v21 -> v22: fitBias (Phase 80, N6 — the board's recruitment
      // philosophy). Backfilled at 0.5: a migrated board half-weighs fit,
      // and evolution moves the dial from there.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.fitBias ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).fitBias ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 22;
    }
    if (data.version === 22) {
      // v22 -> v23: jockeyBias (Phase 87 — the defensive school's first
      // axis). Backfilled at 0.5: moderate containment, evolution moves it.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.jockeyBias ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).jockeyBias ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 23;
    }
    if (data.version === 23) {
      // v23 -> v24: coverBias (Phase 88 — the sweeper/stopper axis).
      // Backfilled at 0.5 = the flat line + the old rest-defense exactly.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.coverBias ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).coverBias ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 24;
    }
    if (data.version === 24) {
      // v24 -> v25: trapBias (Phase 109 — hold-the-line vs track-runner).
      // Backfilled at 0.5 = today's tracking exactly.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.trapBias ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).trapBias ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 25;
    }
    if (data.version === 25) {
      // v25 -> v26: morale (Phase 111 — Stage 4's first pull item) +
      // moraleSensitivity. Backfilled neutral: 0.5 = no streak, no effect.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.moraleSensitivity ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) {
        f.morale ??= 0.5;
        fixG(f.coach.genome);
      }
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).moraleSensitivity ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 26;
    }
    if (data.version === 26) {
      // v26 -> v27: transitionPress (Phase 112 — gegenpress vs
      // drop-and-recover). Backfilled at 0.5 = today's window exactly.
      const fixG = (g: TacticalGenome | undefined): void => {
        if (g) g.transitionPress ??= 0.5;
      };
      for (const f of data.franchises as Franchise[]) fixG(f.coach.genome);
      for (const e of (data.coachPool ?? []) as PoolEntry[]) fixG(e.coach.genome);
      for (const r of ((data.history ?? []) as SeasonRecord[])) {
        if (r.geneMeans) (r.geneMeans as Record<string, number>).transitionPress ??= 0.5;
        for (const e of r.evolution?.entries ?? []) {
          fixG(e.childGenome);
          if (e.parentGenomes) e.parentGenomes.forEach(fixG);
        }
      }
      data.version = 27;
    }
    if (data.version === 27) {
      // v27 -> v28: goal-channel ledgers (Phase 113). The in-progress season
      // simply starts counting from here; old history rows just lack `ch`.
      for (const a of data.agg as Array<Record<string, unknown>>) {
        a.chFor ??= emptyChannels();
        a.chAgainst ??= emptyChannels();
      }
      data.version = 28;
    }
    if (data.version === 28) {
      // v28 -> v29: per-season formation identity on styleMatrix rows
      // (Phase 116). Optional field, UI-guarded — old records simply lack
      // it; the timeline grows from here. Nothing to backfill.
      data.version = 29;
    }
    if (data.version === 29) {
      // v29 -> v30: injuries (Phase 118). Everyone starts fit.
      for (const f of data.franchises as Array<Record<string, unknown>>) {
        f.injuries ??= (f.squad as unknown[]).map(() => 0);
      }
      data.version = 30;
    }
    if (data.version === 30) {
      // v30 -> v31: budget-allocation snapshots on styleMatrix rows
      // (Phase 118.5). Optional, UI-guarded — nothing to backfill.
      data.version = 31;
    }
    if (data.version === 31) {
      // v31 -> v32: the POSITIONING attribute (Phase 119j). The squad/free-agent
      // backfill already ran at the TOP of the chain (it must precede the
      // v17→v18 budget pass); nothing left to do here but advance the version.
      data.version = 32;
    }
    if (data.version === 32) {
      // v32 -> v33 (Phase-120): the budget went POSITION-AWARE (reflexes
      // keeper-only, finishing/defending free for the keeper), so the cap moved
      // 40.5 → 35.5. Squads built under the old cap may sit off the new one, so
      // re-enforce the budget once on load; season-end (applyResult) does it
      // every year thereafter.
      for (const f of data.franchises as Franchise[]) f.squad = enforceBudget(f.squad);
      data.version = 33;
    }
    if (data.version !== SAVE_VERSION) throw new Error(`Unsupported save version: ${String(data.version)}`);
    const lg = Object.create(League.prototype) as League;
    Object.assign(lg, {
      seed: data.seed,
      generation: data.generation,
      matchDuration: data.matchDuration,
      promotionMode: data.promotionMode ?? 'auto',
      // Pre-Phase-22 saves keep the behavior they were built with.
      cupDrawMode: data.cupDrawMode ?? 'underdog',
      franchises: data.franchises,
      fixtures: data.fixtures,
      cursor: data.cursor,
      table: data.table,
      agg: data.agg,
      playerAgg: data.playerAgg,
      history: data.history,
      cup: data.cup ?? null,
      legends: data.legends ?? [],
      coachPool: data.coachPool ?? [],
      coachLegends: data.coachLegends ?? [],
      misery: data.misery ?? (data.franchises as unknown[]).map(() => 0),
      freeAgents: data.freeAgents ?? [],
      // fromJSON builds via Object.create — class-field initializers never
      // ran, so the probe flag must be set EXPLICITLY or loaded leagues
      // silently lose the sack/hire channel (falsy undefined).
      sackingEnabled: true,
    });
    return lg;
  }
}

/** Single round-robin via the circle method: n-1 rounds of n/2 pairings. */
export function buildRoundRobin(n: number): Array<{ round: number; index: number; home: number; away: number }> {
  const ids = Array.from({ length: n }, (_, i) => i);
  const out: Array<{ round: number; index: number; home: number; away: number }> = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      out.push({ round: r, index: i, home: r % 2 === 0 ? a : b, away: r % 2 === 0 ? b : a });
    }
    ids.splice(1, 0, ids.pop()!);
  }
  return out;
}

/** Map a division's member slots onto a round-robin schedule. */
export function buildDivisionFixtures(memberSlots: number[], division: Division): Fixture[] {
  return buildRoundRobin(memberSlots.length).map((p) => ({
    round: p.round,
    index: p.index,
    division,
    home: memberSlots[p.home],
    away: memberSlots[p.away],
    played: false,
  }));
}
