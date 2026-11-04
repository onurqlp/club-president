import { Container, Graphics } from 'pixi.js';
import type { OverlayState } from '../render3d/RenderStateAdapter';
import type { OverlayFlags } from '../ui/actions';
import { toPx } from './transform';

/**
 * Dev overlays for understanding the AI: formation targets, in-flight pass
 * lanes, shot vectors, marking assignments, press assignments. Consumes the
 * same OverlayState the 3D view uses (built by buildOverlays — the single
 * source of the overlay geometry), so the two views can never drift.
 */
export class DebugOverlay {
  readonly container = new Container();
  private g = new Graphics();

  constructor() {
    this.container.addChild(this.g);
  }

  update(overlays: OverlayState | null, flags: OverlayFlags, teamColors: readonly [number, number]): void {
    const g = this.g;
    g.clear();
    if (!overlays) return;

    if (flags.formation) {
      for (const f of overlays.formation) {
        const color = teamColors[f.side];
        const spot = toPx({ x: f.x, y: f.z });
        const pp = toPx({ x: f.px, y: f.pz });
        g.moveTo(spot.x - 4, spot.y - 4).lineTo(spot.x + 4, spot.y + 4).stroke({ width: 1, color, alpha: 0.55 });
        g.moveTo(spot.x - 4, spot.y + 4).lineTo(spot.x + 4, spot.y - 4).stroke({ width: 1, color, alpha: 0.55 });
        g.moveTo(pp.x, pp.y).lineTo(spot.x, spot.y).stroke({ width: 1, color, alpha: 0.15 });
      }
    }

    if (flags.passLines && overlays.passLine) {
      const from = toPx({ x: overlays.passLine.x1, y: overlays.passLine.z1 });
      const to = toPx({ x: overlays.passLine.x2, y: overlays.passLine.z2 });
      g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 2, color: 0xfde047, alpha: 0.7 });
      g.circle(to.x, to.y, 8).stroke({ width: 1.5, color: 0xfde047, alpha: 0.7 });
    }

    if (flags.shotVector && overlays.shotLine) {
      const from = toPx({ x: overlays.shotLine.x1, y: overlays.shotLine.z1 });
      const to = toPx({ x: overlays.shotLine.x2, y: overlays.shotLine.z2 });
      g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 2.5, color: 0xef4444, alpha: 0.85 });
    }

    if (flags.marking) {
      for (const m of overlays.markLines) {
        const a = toPx({ x: m.x1, y: m.z1 });
        const b = toPx({ x: m.x2, y: m.z2 });
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: 0x22d3ee, alpha: 0.45 });
      }
    }

    if (flags.chasers) {
      for (const c of overlays.chasers) {
        const pp = toPx({ x: c.x, y: c.z });
        g.circle(pp.x, pp.y, 12).stroke({ width: 1.5, color: 0xf97316, alpha: 0.8 });
      }
    }
  }
}
