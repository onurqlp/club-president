import { PLAYER_MIN_DIST } from '../sim/constants';

/**
 * Body-contact cues (Track F, F-Q 2026-09-15) — the PURE half. Render-only.
 *
 * The sim's overlap solver keeps player centres `PLAYER_MIN_DIST` apart and
 * (since M1) removes the closing velocity along the contact normal. What the
 * viewer saw of that was NOTHING: two bodies glide into the shell, stop dead
 * or slide, and glide on — the user's 「不真实碰撞」. This module finds the
 * moment a pair ENTERS the shell with real closing speed — a bump — from two
 * consecutive render frames, and the renderer answers with a brace/recoil
 * pose and a puff of dust at the contact point.
 *
 * ⚠ The gate is CLOSING SPEED, never proximity. Every marking pair on the
 * pitch sits at exactly the shell distance (Phase 38 measured 185–286 such
 * "contacts" a match); a proximity trigger would have the whole defence
 * flinching all match. A pair that drifts into the shell at a walk gets
 * nothing; a pair that arrives at speed gets one bump, and no more until
 * they have separated again.
 */

export interface ContactBody { gid: number; x: number; z: number }

export interface Bump {
  a: number;
  b: number;
  /** Contact point (midpoint of the pair), pitch metres. */
  x: number;
  z: number;
  /** Unit normal from `a` toward `b`. */
  nx: number;
  nz: number;
  /** Relative closing speed along the normal at entry (m/s). */
  closing: number;
}

/** Entering closer than this × shell = contact. Slightly outside the shell
 * so a frame that lands exactly on the solver's boundary still counts. */
export const CONTACT_ENTER = 1.04;
/** Leaving further than this × shell re-arms the pair. */
export const CONTACT_LEAVE = 1.25;
/** Minimum closing speed for a bump (m/s). A jog into someone; measured 2026-09-15: at 1.4 the
 * follow camera saw ~21 bumps per sim-minute, at 2.0 the count is the shoulder-charges only. */
export const BUMP_MIN_CLOSING = 2.0;

export class ContactTracker {
  private prev = new Map<number, { x: number; z: number }>();
  private inContact = new Set<number>();
  private prevT = NaN;

  /** Forget everything — a camera cut, a replay jump, a new match. */
  reset(): void {
    this.prev.clear();
    this.inContact.clear();
    this.prevT = NaN;
  }

  /**
   * Feed one render frame. `t` is the sim time of the frame; a non-advancing
   * or backwards `t` (pause, replay scrub) resets the velocity baseline
   * instead of inventing motion from a teleport.
   */
  update(bodies: ReadonlyArray<ContactBody>, t: number, shell = PLAYER_MIN_DIST): Bump[] {
    const out: Bump[] = [];
    const dt = t - this.prevT;
    const usable = Number.isFinite(dt) && dt > 1e-6 && dt < 0.5;
    const enter = shell * CONTACT_ENTER;
    const leave = shell * CONTACT_LEAVE;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      const pa = this.prev.get(a.gid);
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const key = pairKey(a.gid, b.gid);
        if (d > leave) {
          this.inContact.delete(key);
          continue;
        }
        if (d > enter || this.inContact.has(key)) continue;
        // Entering the shell this frame. Mark it whatever the speed, so a
        // slow drift never later fires as a bump once it happens to speed up.
        this.inContact.add(key);
        const pb = this.prev.get(b.gid);
        if (!usable || !pa || !pb || d < 1e-6) continue;
        const nx = dx / d;
        const nz = dz / d;
        const vax = (a.x - pa.x) / dt;
        const vaz = (a.z - pa.z) / dt;
        const vbx = (b.x - pb.x) / dt;
        const vbz = (b.z - pb.z) / dt;
        // Closing = the pair's relative velocity projected onto the line
        // between them, positive when the gap is shrinking.
        const closing = (vax - vbx) * nx + (vaz - vbz) * nz;
        if (closing < BUMP_MIN_CLOSING) continue;
        out.push({ a: a.gid, b: b.gid, x: a.x + dx / 2, z: a.z + dz / 2, nx, nz, closing });
      }
    }
    this.prev.clear();
    for (const b of bodies) this.prev.set(b.gid, { x: b.x, z: b.z });
    this.prevT = t;
    return out;
  }
}

const pairKey = (a: number, b: number): number => (a < b ? a * 4096 + b : b * 4096 + a);
