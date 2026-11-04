import type { Player } from '../sim/Player';
import type { V2 } from '../utils/vec';
import { laneOpenness } from './perception';

/**
 * ⭐⭐ LN T0 — THE OWN-LANE READ (docs/world-model/LN-T0-OWN-LANE-PRICE.md; contract
 * LN-OWN-LANE-CONTRACT.md §2 M-LN.1/M-LN.2; COMMANDER RULING #393 item 5).
 *
 * 「让传球者看见自己人」 — five census stages (LN-C0 → LN-T1 → LN-C1 → LN-C2 → LN-C3) ended on
 * ONE mechanism: **the passer's pricers do not see his own men**. The lane argmax sees them
 * only inside a 0.635 m BINARY shell, the perceived chooser reads the corridor for opponents
 * and not for us, and the kick-off play-back scorer reads no line at all. This module is the
 * GRADED read the three pricers were missing, and nothing else.
 *
 * ⭐ NO NEW PERCEPTION GEOMETRY (M-GC.3's "no new channel" precedent). `ownLaneOpenness` is
 * the SHIPPED `laneOpenness` CALLED — the same closest-point-on-segment law, the same 1.5 m
 * clear-the-kicker guard, the same 4 m normaliser, character for character — over LN-C1's own
 * reconstruction population: **own outfield bodies − the passer − the target**. It reads only
 * the positions it is HANDED; it never touches `Match`, a roster, a percept store or rng.
 *
 * ⚠ THE POPULATION TYPE IS STRUCTURAL, because the perceived chooser's bodies are
 * PERCEPTION SNAPSHOT ENTRIES (`ObservedPlayer`) and not `Player`s. `OwnLaneBody` is the
 * narrowest shape both satisfy: `gid` and `pos` are REQUIRED and are the only fields the
 * geometry consumes; `sentOff` and `role` are OPTIONAL identity fields used by the FILTER
 * alone — a snapshot entry carries neither, which is why the perceived call site hands in a
 * body set that is ALREADY own-outfield-and-not-sent-off (the scope it built). The pin
 * `ownLaneOpenness === laneOpenness(from, aim, <the filtered Players>)` is what makes the two
 * populations the same law rather than two drifting copies.
 */
export interface OwnLaneBody {
  readonly gid: number;
  readonly pos: Readonly<V2>;
  /** Identity, read by the FILTER only. Absent on a perception snapshot entry. */
  readonly sentOff?: boolean;
  /** Identity, read by the FILTER only. Absent on a perception snapshot entry. */
  readonly role?: string;
}

/**
 * LN-C1's reconstruction, byte for byte: how clean the passer's OWN lane from `from` to `aim`
 * is (1 = no man of ours anywhere near it, 0 = one of ours standing on it), over own OUTFIELD
 * bodies minus the passer and minus the intended target.
 *
 * The geometry is not restated here: the filtered set is handed to the SHIPPED
 * `laneOpenness`, whose signature is `Player[]` because every shipped caller passes a roster.
 * The cast is the population widening and nothing else — `laneOpenness` reads `pos` and
 * `sentOff` and no other field of what it is given (the `dvDeliveryValue.test.ts` cast idiom).
 * PURE: no rng, no `Match`, no mutation of its inputs.
 */
export function ownLaneOpenness(
  from: Readonly<V2>,
  aim: Readonly<V2>,
  ownBodies: readonly OwnLaneBody[],
  passerGid: number,
  targetGid: number,
): number {
  const kept: OwnLaneBody[] = [];
  for (const body of ownBodies) {
    if (body.gid === passerGid || body.gid === targetGid) continue;
    if (body.sentOff === true) continue;
    if (body.role === 'GK') continue;
    kept.push(body);
  }
  return laneOpenness(from, aim, kept as unknown as Player[]);
}

/**
 * M-LN.2 THE PRICE, and the SINGLE owner of its arithmetic: `w · (1 − ownLaneOpenness)`.
 *
 * ⭐ Named so the three sites cannot each grow their own copy of the expression, and so the
 * exactness pins can compare the engine's own double against this function rather than
 * against a re-typed formula. Born-absent gene ⇒ `w = 0` ⇒ the price is exactly `+0`, so the
 * subtraction at the two score sites and the `(1 − price)` factor at the perceived site are
 * IEEE-exact identities. PURE, no rng.
 */
export function ownLanePrice(w: number, openness: number): number {
  return w * (1 - openness);
}

/**
 * M-LN.3(c1): the own gids the passer must PERCEIVE for the perceived chooser to price his
 * own lane — own outfield, not sent off, not the passer himself. Built ONLY when the seat
 * exists; with the flag off no scope statement runs at all, so the snapshot is byte-identical
 * and therefore so is the world.
 */
export function ownLaneScopeGids(
  passerGid: number,
  mates: readonly OwnLaneBody[],
): number[] {
  const gids: number[] = [];
  for (const mate of mates) {
    if (mate.gid === passerGid || mate.sentOff === true || mate.role === 'GK') continue;
    gids.push(mate.gid);
  }
  return gids;
}
