import type { AttackFormationId, TeamStyle } from '../sim/types';
import type { Rng } from '../utils/rng';
import { emptyCareer, rookieAge } from './careers';
import { createCoach, rookieCoachAge, type Coach } from './coach';
import { crossoverGenomes, geneDistance, mutateGenome, type TacticalGenome } from './genome';
import type { Franchise } from './franchise';
import { generatePlayerNames, shortName, uniqueTeamName } from './names';
import { crossoverSquads, enforceBudget } from './playerGenome';
import { crossoverSquadStyles } from './playerStyle';
import { crossoverPolicyGenes, mutatePolicyGenes } from './policyGenome';

/**
 * End-of-season evolution, generalized for the two-division era. A group
 * (one division) is ranked by fitness and split into bands:
 *
 *   top eliteN            ELITE    — genome untouched; proven tactics survive
 *   middle                MUTATED  — small gaussian tweaks
 *   bottom rebornN        REBORN   — crossover child of two parents sampled
 *                                    from `parentPool` (defaults to the
 *                                    group's own top-4), heavier mutation,
 *                                    new name; the slot/kit survives.
 *
 * Division 1 runs with rebornN=0 (its bottom two relegate instead of dying);
 * Division 2 rebirths its bottom three from DIVISION 1's elite pool, so new
 * blood always enters the ecosystem at the bottom of the pyramid.
 */
export interface EvolutionEntry {
  slot: number;
  name: string;
  kind: 'elite' | 'mutated' | 'reborn';
  parents?: string[];
  fitness: number;
  /** Gene-space distance moved this generation (0 for elites). */
  drift: number;
  /** Style-switch lineage note for mutated clubs (e.g. "🔧 switched to low-32"). */
  note?: string;
  // Rebirth snapshots (Phase 32.5): the ceremony replays the moment of
  // evolution from the record alone — parents' genomes are copied HERE
  // because the living parents keep evolving after this generation.
  /** Reborn: the club that died to make room. */
  oldName?: string;
  /** Reborn: the crossover inputs, dominant parent first. */
  parentGenomes?: [TacticalGenome, TacticalGenome];
  /** Reborn: the newborn genome (crossover + heavy mutation). */
  childGenome?: TacticalGenome;
  /** Reborn: tactical identity inherited from the dominant parent. */
  inheritedStyle?: TeamStyle;
  /** Reborn: the newgen coach hired to carry the new philosophy (Phase 53). */
  coach?: string;
}

export interface EvolutionReport {
  generation: number;
  entries: EvolutionEntry[];
}

export interface EvolvePlan {
  eliteN: number;
  rebornN: number;
  /** Parent candidates for reborn slots, strongest first (weights 4/3/2/1). */
  parentPool?: Franchise[];
  /**
   * Shared zonal budget (Phase 31): how many MORE clubs may become zonal
   * this evolution pass, across both divisions. Zonal out-defends man
   * structurally (failure mode 18) and inheritance lets selection compound
   * it — without an ecological cap a lucky lineage turned the league 10/16
   * zonal in ten seasons and scoring sank with it. The League computes
   * room = max(0, 4 − current zonal count) and passes ONE mutable object
   * to both division passes.
   */
  zonal?: { room: number };
  /** Sink for the dying clubs' managers (Phase 53) — the League routes them
   * into its unemployed pool, where the sack/hire channel can rehire them. */
  firedCoaches?: Coach[];
  /** Sink for the dying clubs' SQUADS (Phase 55) — the fire-sale: player
   * genes hit the free-agent market instead of vanishing with the club. */
  firedSquads?: Array<{
    club: string;
    names: string[];
    squad: Franchise['squad'];
    styles: Franchise['squadStyles'];
    ages: number[];
    careers: Franchise['careers'];
  }>;
}

/**
 * Rare, single-component style mutation (Phase 31, ~0.08/season): the club
 * switches ONE of attack formation / defend formation / marking scheme to
 * its alternative. Returns the lineage note when a switch happened. Zonal
 * entry is extra-guarded (×0.3) so the league never drifts zonal-heavy.
 */
function mutateStyle(style: TeamStyle, rng: Rng, zonal?: { room: number }): string | undefined {
  if (!rng.chance(0.08)) return undefined;
  const component = rng.int(0, 2);
  if (component === 0) {
    // The shape LIBRARY (Phase 67, N5): switch to a weighted-random OTHER
    // shape. The classic pair carries full weight; the novel shapes enter
    // rare (×0.35 — the zonal entry pattern) so structure is DISCOVERED
    // under selection, never seeded. Leaving a novel shape is as easy as
    // any switch — reversibility is the ecology's safety valve.
    const menu: Array<{ id: AttackFormationId; w: number }> = [
      { id: 'wide-212', w: 1 }, { id: 'narrow-122', w: 1 },
      { id: 'twin-st', w: 0.35 }, { id: 'false-nine', w: 0.35 },
      // Phase 107 (N5 expansion): asymmetry and the aerial tower join the
      // discoverable library at the same rare entry weight.
      { id: 'overload', w: 0.35 }, { id: 'target-man', w: 0.35 },
    ];
    const options = menu.filter((o) => o.id !== style.formationAtk);
    let r = rng.next() * options.reduce((s, o) => s + o.w, 0);
    for (const o of options) {
      r -= o.w;
      if (r <= 0) {
        style.formationAtk = o.id;
        break;
      }
    }
    return `🔧 switched to ${style.formationAtk}`;
  }
  if (component === 1) {
    // N5b (phase-79): the binary toggle starved selection — a weighted menu
    // like the attack one; discoveries enter rare (0.35) and must EARN share.
    const defOptions = ([
      { id: 'low-32', w: 1 }, { id: 'press-23', w: 1 },
      { id: 'mid-41', w: 0.35 }, { id: 'high-line', w: 0.35 },
    ] as const).filter((o) => o.id !== style.formationDef);
    let rd = rng.next() * defOptions.reduce((s, o) => s + o.w, 0);
    for (const o of defOptions) {
      rd -= o.w;
      if (rd <= 0) {
        style.formationDef = o.id;
        break;
      }
    }
    return `🔧 switched to ${style.formationDef}`;
  }
  if (style.scheme === 'zonal') {
    style.scheme = 'man';
    if (zonal) zonal.room += 1;
    return '🔧 switched to man marking';
  }
  // Zonal stays the RARE identity: a second roll AND an open ecology slot.
  if (!rng.chance(0.3)) return undefined;
  if (!zonal || zonal.room <= 0) return undefined;
  zonal.room -= 1;
  style.scheme = 'zonal';
  return '🔧 switched to zonal marking';
}

export function evolveGroup(
  franchises: Franchise[],
  fitnessBySlot: Map<number, number>,
  generation: number,
  rng: Rng,
  plan: EvolvePlan,
  takenNames: Set<string>,
): EvolutionEntry[] {
  const ranked = [...franchises].sort(
    (a, b) => (fitnessBySlot.get(b.slot) ?? 0) - (fitnessBySlot.get(a.slot) ?? 0) || a.slot - b.slot,
  );
  const entries: EvolutionEntry[] = [];
  const nextGen = generation + 1;
  const rebornFrom = ranked.length - plan.rebornN;

  const pool = (plan.parentPool ?? ranked).slice(0, 4);
  const pickParent = (exclude?: Franchise): Franchise => {
    const cands = pool.filter((f) => f !== exclude);
    const weights = cands.map((f) => 4 - pool.indexOf(f));
    const totalW = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * totalW;
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  };

  ranked.forEach((f, rank) => {
    const fitness = fitnessBySlot.get(f.slot) ?? 0;
    if (rank < plan.eliteN) {
      f.lineage.push({ generation: nextGen, event: 'elite', fitness });
      entries.push({ slot: f.slot, name: f.name, kind: 'elite', fitness, drift: 0 });
    } else if (rank < rebornFrom) {
      const coach = f.coach;
      const before = coach.genome;
      // The coach's own ideas drift (Phase 53: mutation = the same person
      // rethinking, not a new person).
      coach.genome = mutateGenome(coach.genome, rng, { rate: 0.4, scale: 0.08 });
      // Attacking-style policy drifts too (Phase 42) — decision STYLE evolves.
      coach.policy = mutatePolicyGenes(coach.policy, rng);
      // Squads no longer take random mutation — since Phase 26 they change
      // through the careers pass instead (development, retirement, newgens).
      // Formations are the philosophy's shape (Phase 31→53): occasionally ONE
      // component switches to its alternative, logged as a lineage event.
      // Zonal is guarded (failure mode 18: the lattice out-defends man — a
      // zonal-heavy league stops scoring), so mutating INTO it needs a
      // second, rarer roll.
      const styleNote = mutateStyle(coach.style, rng, plan.zonal);
      f.lineage.push({ generation: nextGen, event: 'mutated', fitness, note: styleNote });
      entries.push({
        slot: f.slot, name: f.name, kind: 'mutated', fitness,
        drift: geneDistance(before, coach.genome), note: styleNote,
      });
    } else {
      const pa = pickParent();
      const pb = pickParent(pa);
      const before = f.coach.genome;
      // The dying club's manager is out of a job — the League routes him to
      // the unemployed pool (the memetic channel's supply side, Phase 53) —
      // and the squad hits the fire-sale (the player-gene channel, Phase 55).
      plan.firedCoaches?.push(f.coach);
      plan.firedSquads?.push({
        club: f.name,
        names: [...f.playerNames],
        squad: f.squad.map((p) => ({ ...p })),
        styles: f.squadStyles.map((s) => ({ ...s })),
        ages: [...f.ages],
        careers: f.careers.map((c) => ({ ...c })),
      });
      const genome = mutateGenome(
        crossoverGenomes(pa.coach.genome, pb.coach.genome, rng), rng, { rate: 0.5, scale: 0.15 },
      );
      // The new philosophy blends both parents' styles, then mutates harder
      // (Phase 42) — and it arrives EMBODIED (Phase 53): the reborn club
      // hires a newgen coach schooled by the dominant parent's manager (the
      // mentor tree).
      const policy = mutatePolicyGenes(
        crossoverPolicyGenes(pa.coach.policy, pb.coach.policy, rng), rng, { rate: 0.5, scale: 0.15 },
      );
      // Formations are the philosophy's shape (Phase 31): the newborn
      // philosophy INHERITS its tactical identity from the dominant parent —
      // the dynasty's shape survives the rebirth. The zonal budget applies
      // to inheritance too: this was THE compounding channel (zonal elite
      // win → parent the reborn → zonal multiplies).
      const wasZonal = f.coach.style.scheme === 'zonal';
      const style: TeamStyle = { ...pa.coach.style };
      if (style.scheme === 'zonal' && !wasZonal) {
        if (plan.zonal && plan.zonal.room > 0) plan.zonal.room -= 1;
        else style.scheme = 'man';
      } else if (wasZonal && style.scheme !== 'zonal' && plan.zonal) {
        plan.zonal.room += 1;
      }
      f.coach = createCoach(rng, genome, policy, style, {
        age: rookieCoachAge(rng),
        mentor: pa.coach.name,
      });
      // The academy intake: attributes cross over from both parents' squads,
      // but the players themselves are NEW — young, unnamed, blank careers.
      // Budget-enforced (Phase 48): two rich parents can't compound past the cap.
      f.squad = enforceBudget(crossoverSquads(pa.squad, pb.squad, rng));
      // Personal styles cross the same way (Phase 54) — the newborn academy
      // inherits both parents' decision temperaments, slot by slot.
      f.squadStyles = crossoverSquadStyles(pa.squadStyles, pb.squadStyles, rng);
      f.ages = f.squad.map(() => rookieAge(rng) + rng.int(0, 5)); // 17–24
      f.careers = f.squad.map(() => emptyCareer());
      const oldName = f.name;
      takenNames.delete(oldName);
      f.name = uniqueTeamName(rng, takenNames);
      f.short = shortName(f.name);
      f.playerNames = generatePlayerNames(rng);
      f.id = `T${f.slot}-g${nextGen}`;
      f.elo = 1500; // a new project starts from scratch
      f.lineage.push({
        generation: nextGen,
        event: 'reborn',
        parents: [pa.name, pb.name],
        fitness,
        note: `was ${oldName}`,
      });
      entries.push({
        slot: f.slot,
        name: f.name,
        kind: 'reborn',
        parents: [pa.name, pb.name],
        fitness,
        drift: geneDistance(before, f.coach.genome),
        oldName,
        coach: f.coach.name,
        parentGenomes: [{ ...pa.coach.genome }, { ...pb.coach.genome }],
        childGenome: { ...f.coach.genome },
        inheritedStyle: { ...f.coach.style },
      });
    }
  });

  return entries;
}
