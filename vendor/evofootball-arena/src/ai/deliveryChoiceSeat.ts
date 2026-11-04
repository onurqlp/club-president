// DLC T0 — THE DELIVERY-CONTEST SEAM (docs/world-model/DLC-T0-DORMANT-SEAM.md).
// Contract: docs/world-model/DELIVERY-CHOICE-CONTRACT.md §2 M-DLC.1–4. Rulings #235/#236.
//
// 出球的选择权: the carrier does not carry a LEAD DIAL — he CHOOSES the delivery.
// Armed, the ordinary pass loop prices TWO candidates for the same support-mode mate:
//
//   (a) TO FEET — `aim = mate.pos`, the incumbent arithmetic, byte for byte;
//   (b) LED     — `aim = mate.pos + passLeadOffset(...)`, the BANKED PTP-T0 projection,
//                 reused VERBATIM (this module imports it; it does not re-derive it).
//
// Both enter the SAME `bestPass` argmax in `PlayerBrain.decideOnBall`, and the winner is
// struck at ITS OWN aim through the existing led-strike machinery. There is NO new
// comparison logic, NO threshold and NO taste multiplier (#236 amendment 1): the argmax
// IS the choice, so a led ball is struck exactly when it prices better than the ball to
// feet. A mate with ~zero projected displacement degenerates to his to-feet candidate BY
// ARITHMETIC — the led aim's coordinates are then his feet's, the two scores are equal,
// and the strict `>` of the argmax keeps the incumbent.
//
// ⭐ THE GENE IS TASTE, NOT DOSE. `passLeadSupport` is REINTERPRETED (its PTP exam-dose
// reading retires): it scales HOW FAR AHEAD this team imagines a runner — the magnitude
// of the projection this chooser is willing to price — with the candidate free to LOSE.
// BORN ABSENT ⇒ this seat is `null` ⇒ the led candidate never forms ⇒ the pass loop's
// arithmetic is byte-identical (G-BORN).
//
// ⭐ INFORMATION HONESTY IS INHERITED, NOT RE-OPENED. The motion source, the percept
// rules and the projection constants are the banked PTP-T0 seat's, untouched: this file
// adds no channel, no constant and no read of its own. `match` is named here for exactly
// one reason — to hand it to `passLeadSeatOf`, which pulls this body's own snapshot.
//
// Dormant: `dlcDeliveryChoice` is a hard `false` in every production path, so nothing in
// this file is reached in the shipped game.
import type { V2 } from '../utils/vec';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import type { TacticalGenome } from '../evolution/genome';
import { passLeadOffset, passLeadSeatOf, type PassLeadSeat } from './passLeadSeat';

/**
 * ⭐ THE ARMING RULE (contract M-DLC.4), in ONE place: the contest forms candidates only
 * when the flag's door is open (the caller's fork) AND the gene is NON-ABSENT.
 *
 * Returning `null` for an absent gene is the BORN-ABSENT IDENTITY made structural rather
 * than arithmetic: with no seat there is no second candidate, no second scoring pass and
 * no second aim object — the loop runs the shipped statements alone. (The gene has NO
 * zero-dose semantics under this contract: present at ANY value, including 0, the
 * candidate FORMS and competes; at 0 it simply degenerates onto the feet candidate and
 * loses the tie. That identity is measured, not assumed — see G-ZERO in the stage doc.)
 *
 * PURE apart from the one percept pull inside `passLeadSeatOf`, which draws no rng.
 */
export function deliveryChoiceSeatOf(
  p: Player, match: Match, g: TacticalGenome, perceivedWorld: boolean,
): PassLeadSeat | null {
  if (g.passLeadSupport === undefined) return null;
  return passLeadSeatOf(p, match, g, perceivedWorld);
}

/**
 * THE LED CANDIDATE'S DELIVERY: the banked projection, and the aim it composes.
 *
 * `lead` is `passLeadOffset`'s own output — the PTP-T0 law verbatim, G-TRACE-pinned:
 * `gene · motion · (dist/PTP_FLIGHT_SPEED) · PTP_LEAD_FLIGHT_MUL`, zero for a mate who
 * is not in support mode and zero for a mate this body has no motion for. `aim` is the
 * SAME composition the banked seam uses (`mate.pos + lead`), so the led candidate is
 * priced and struck against exactly the point PTP-T0 priced and struck against — the
 * difference is that here it must WIN a contest first.
 *
 * PURE: no rng, no writes, no truth in a percept world.
 */
export function ledDelivery(
  seat: PassLeadSeat, from: Readonly<V2>, mate: Player,
): { readonly lead: Readonly<V2>; readonly aim: Readonly<V2> } {
  const lead = passLeadOffset(seat, from, mate);
  return { lead, aim: { x: mate.pos.x + lead.x, y: mate.pos.y + lead.y } };
}
