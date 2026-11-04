import { ROSTER_SIZE } from '../sim/types';
import type { Rng } from '../utils/rng';

const PREFIXES = [
  'Crimson', 'Azure', 'Neon', 'Iron', 'Golden', 'Shadow', 'Solar', 'Arctic',
  'Velvet', 'Turbo', 'Quantum', 'Royal', 'Ember', 'Static', 'Feral', 'Cosmic',
  'Obsidian', 'Rustic', 'Electric', 'Phantom',
];

const NOUNS = [
  'Wolves', 'Falcons', 'Comets', 'Titans', 'Sparks', 'Serpents', 'Mariners',
  'Foxes', 'Ravens', 'Pumas', 'Dynamo', 'Orbit', 'Locusts', 'Herons',
  'Badgers', 'Cyclones', 'Otters', 'Jackals', 'Pilots', 'Nomads',
];

const SURNAMES = [
  'Adler', 'Boro', 'Cato', 'Dree', 'Eska', 'Ferro', 'Guss', 'Halo', 'Ivek',
  'Jarra', 'Kade', 'Lumo', 'Mirek', 'Nolo', 'Ovie', 'Pika', 'Quill', 'Rasco',
  'Soto', 'Tarn', 'Ulmo', 'Vesk', 'Wren', 'Xylo', 'Yano', 'Zubat', 'Ando',
  'Brix', 'Corda', 'Dova', 'Enzo', 'Frey', 'Gale', 'Hosk', 'Iber', 'Jett',
];

/** Distinct kit palettes per league slot (green avoided — the pitch is green).
 * 16 slots for the two-division era; per-match clashes are additionally
 * handled by the renderer's inverted-kit swap. */
export const KIT_COLORS: Array<{ primary: number; secondary: number }> = [
  { primary: 0xd64550, secondary: 0xffffff }, // red
  { primary: 0x3b82f6, secondary: 0xfde047 }, // blue
  { primary: 0x9b5cf6, secondary: 0xf1f5f9 }, // purple
  { primary: 0xf97316, secondary: 0x1e293b }, // orange
  { primary: 0x22d3ee, secondary: 0x0f172a }, // cyan
  { primary: 0xec4899, secondary: 0xfefce8 }, // pink
  { primary: 0xfacc15, secondary: 0x111827 }, // yellow
  { primary: 0x94a3b8, secondary: 0x111111 }, // steel
  { primary: 0xf8fafc, secondary: 0xb91c1c }, // white
  { primary: 0x1f2937, secondary: 0xf59e0b }, // charcoal
  { primary: 0x9f1239, secondary: 0xfbcfe8 }, // maroon
  { primary: 0x1e40af, secondary: 0xf8fafc }, // navy
  { primary: 0xb45309, secondary: 0xfef3c7 }, // bronze
  { primary: 0xc4b5fd, secondary: 0x312e81 }, // lavender
  { primary: 0xfb7185, secondary: 0x111827 }, // coral
  { primary: 0x7dd3fc, secondary: 0x0c4a6e }, // sky
];

export function uniqueTeamName(rng: Rng, taken: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const name = `${rng.pick(PREFIXES)} ${rng.pick(NOUNS)}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  // Pathological fallback — still deterministic.
  const name = `Club ${taken.size + 1}`;
  taken.add(name);
  return name;
}

export function shortName(name: string): string {
  return name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
}

/** Roster surnames, slot order = [GK, DF, MF, WGL, WGR, ST, bench×3]. */
export function generatePlayerNames(rng: Rng, count = ROSTER_SIZE): string[] {
  const pool = [...SURNAMES];
  rng.shuffle(pool);
  return pool.slice(0, count);
}

/** One newgen surname, avoiding the current squad's names (Phase 26). */
export function newgenName(rng: Rng, taken: string[]): string {
  for (let i = 0; i < 20; i++) {
    const name = rng.pick(SURNAMES);
    if (!taken.includes(name)) return name;
  }
  return rng.pick(SURNAMES); // pathological pool exhaustion — accept a repeat
}

/** Coach forenames (Phase 53) — full names distinguish the person on the
 * touchline from the surnames-only players on the pitch. */
const FORENAMES = [
  'Marco', 'Sven', 'Diego', 'Anton', 'Rui', 'Kenji', 'Bora', 'Luka',
  'Ottmar', 'Cesar', 'Ivo', 'Nils', 'Ramon', 'Tomas', 'Ede', 'Viktor',
];

/** A coach's full name — deterministic, collisions allowed (people do
 * share names; the 16×36 pool makes them rare enough to be a story). */
export function coachName(rng: Rng): string {
  return `${rng.pick(FORENAMES)} ${rng.pick(SURNAMES)}`;
}
