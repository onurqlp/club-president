import { Circle, Container, Graphics, Text } from 'pixi.js';
import type { Match } from '../sim/Match';
import type { Player } from '../sim/Player';
import { BALL_RADIUS, HALF_L, HALF_W, PITCH_LENGTH, PITCH_WIDTH } from '../sim/constants';
import { BALL_VISUAL_SCALE } from '../render3d/ballPresentation';
import type { UiFlags } from '../ui/actions';
import { ACTION_SHORT } from './actionLabels';
import { CbVisibility, type CbBodyFrame } from './cbVisibility';
import { CANVAS_H, CANVAS_W, MARGIN, SCALE, toPx, toPxX, toPxY } from './transform';

interface PlayerSprite {
  root: Container;
  body: Graphics;
  label: Text;
  actionLabel: Text;
  staminaBar: Graphics;
  selectRing: Graphics;
  lastAction: string;
  /** Dive direction frozen at dive start (29.1) — tracking the moving ball
   * per frame spun the body as the shot crossed the keeper (the "twitch"). */
  diveDir: number;
  lastSaveT: number;
}

/** The 2D-renderer subset of UiFlags — derived so the two can't drift. */
export type RenderFlags = Pick<UiFlags, 'actionLabels' | 'heatmap'>;

/* ---- ⭐ CB (M-CB.3) presentation constants — appearance only (stage doc §PRESENTATION).
   They are the 3D layer's palette in this view's units: the same three colours, and radii in
   PIXELS because this view is a plan drawing, not a world. No duration lives here. ---- */
const CB_KNOCK_COLOR = 0xfacc15;
const CB_CARRY_THROUGH_COLOR = 0xfb923c;
const CB_BEATEN_COLOR = 0xef4444;
const CB_KNOCK_ALPHA = 0.75;
const CB_RING_ALPHA = 0.9;
/** The release ring's radius, px (≈0.5 m at SCALE = 10). */
const CB_ORIGIN_PX = 5;
/** The beaten ring's radius, px (≈1.0 m — just outside the 6.5 px body). */
const CB_RING_PX = 10;

/**
 * Draws the dynamic match state: players, ball + trail, goal FX, heatmap.
 * Renderers only read Match state — they never touch simulation data.
 */
export class MatchRenderer {
  readonly container = new Container();
  private heatLayer = new Graphics();
  private trailG = new Graphics();
  private playersLayer = new Container();
  private ballG = new Graphics();
  private fxLayer = new Container();
  /**
   * ⭐ CB (M-CB.3): the same affordances as the 3D view, from the same derivation — the tactical
   * view must not tell a different story about the same match. `cbBodies` is a pool filled in
   * place each frame so the read costs no allocation.
   */
  private cbG = new Graphics();
  private cbVis = new CbVisibility();
  /** The feed record, MUTATED in place each frame — this view allocates nothing to draw CB. */
  private cbFeed = { knocks: 0, touch: null as { gid: number; until: number } | null };
  private cbTouch = { gid: -1, until: 0 };
  private cbBodies: Array<{ gid: number; x: number; z: number; cbRecover: number; cbCarryThrough: number }> = [];

  private sprites = new Map<number, PlayerSprite>();
  private trail: Array<{ x: number; y: number }> = [];
  private eventCursor = 0;

  // Heatmap grid of ball positions (cols x rows over the pitch).
  private heatCols = 30;
  private heatRows = 20;
  private heat = new Float32Array(this.heatCols * this.heatRows);
  private heatDirty = 0;

  private goalText: Text;
  private flash: Graphics;
  private fxTime = -1;
  private match: Match | null = null;

  onSelectPlayer: ((gid: number) => void) | null = null;

  constructor() {
    this.container.addChild(this.heatLayer, this.trailG, this.cbG, this.playersLayer, this.ballG, this.fxLayer);

    this.flash = new Graphics();
    this.flash.rect(0, 0, CANVAS_W, CANVAS_H).fill(0xffffff);
    this.flash.alpha = 0;
    this.goalText = new Text({
      text: 'GOAL!',
      style: { fontFamily: 'Arial Black, sans-serif', fontSize: 64, fontWeight: '900', fill: 0xffffff, stroke: { color: 0x000000, width: 6 } },
    });
    this.goalText.anchor.set(0.5);
    this.goalText.position.set(CANVAS_W / 2, CANVAS_H / 2);
    this.goalText.alpha = 0;
    this.fxLayer.addChild(this.flash, this.goalText);
  }

  /** Rebuild sprites for a new match. */
  attach(match: Match): void {
    this.match = match;
    // destroy() the old containers (Text objects own GPU textures that GC
    // alone does not reliably free in Pixi v8) — removeChildren only detaches.
    for (const child of this.playersLayer.removeChildren()) {
      child.destroy({ children: true });
    }
    this.sprites.clear();
    this.trail = [];
    this.cbVis.reset();
    this.cbG.clear();
    this.cbBodies = match.allPlayers.map((p) => ({
      gid: p.gid, x: 0, z: 0, cbRecover: 0, cbCarryThrough: 0,
    }));
    this.heat.fill(0);
    this.heatLayer.clear();
    this.eventCursor = match.events.length;
    this.fxTime = -1;
    this.goalText.alpha = 0;
    this.flash.alpha = 0;

    for (const p of match.allPlayers) {
      const team = match.teams[p.side];
      const root = new Container();
      const selectRing = new Graphics();
      selectRing.circle(0, 0, 10).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      selectRing.visible = false;

      const body = new Graphics();
      const isGK = p.role === 'GK';
      const fill = isGK ? team.info.colors.secondary : team.info.colors.primary;
      const edge = isGK ? team.info.colors.primary : team.info.colors.secondary;
      body.circle(0, 0, 6.5).fill(fill).stroke({ width: 2, color: edge });

      const label = new Text({
        text: p.role[0],
        style: { fontFamily: 'monospace', fontSize: 9, fontWeight: '700', fill: isGK ? team.info.colors.primary : team.info.colors.secondary },
      });
      label.anchor.set(0.5);

      const actionLabel = new Text({
        text: '',
        style: { fontFamily: 'monospace', fontSize: 10, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      });
      actionLabel.anchor.set(0.5, 1);
      actionLabel.position.set(0, -10);

      const staminaBar = new Graphics();

      root.addChild(selectRing, body, label, staminaBar, actionLabel);
      root.eventMode = 'static';
      root.cursor = 'pointer';
      root.hitArea = new Circle(0, 0, 12);
      root.on('pointerdown', () => this.onSelectPlayer?.(p.gid));

      this.playersLayer.addChild(root);
      this.sprites.set(p.gid, {
        root, body, label, actionLabel, staminaBar, selectRing,
        lastAction: '', diveDir: 0, lastSaveT: 0,
      });
    }
  }

  /** @param stepsThisFrame how many sim steps ran — weights heatmap sampling. */
  update(dtReal: number, flags: RenderFlags, selectedGid: number | null, stepsThisFrame: number): void {
    const match = this.match;
    if (!match) return;

    for (const p of match.allPlayers) {
      const s = this.sprites.get(p.gid);
      if (!s) continue;
      const px = toPx(p.pos);
      s.root.position.set(px.x, px.y);
      s.selectRing.visible = selectedGid === p.gid;

      const short = ACTION_SHORT[p.action.type];
      s.actionLabel.visible = flags.actionLabels;
      if (flags.actionLabels && s.lastAction !== short) {
        s.actionLabel.text = short;
        s.lastAction = short;
      }

      s.staminaBar.clear();
      const w = 14 * p.stamina;
      const color = p.stamina > 0.5 ? 0x4ade80 : p.stamina > 0.25 ? 0xfacc15 : 0xef4444;
      s.staminaBar.rect(-7, 9, w, 2).fill({ color, alpha: 0.9 });

      // Keeper dive (27.4) / tackle lunge / recovery stumble (Phase 27): the
      // dive stretches the body toward the ball, the lunge along the heading;
      // a stunned player wobbles and dims.
      if (p.saveAnimTimer > 0) {
        const k = p.saveAnimTimer / 0.7;
        // Direction frozen at dive start (29.1): rising timer = new dive.
        if (p.saveAnimTimer > s.lastSaveT) {
          s.diveDir = Math.atan2(match.ball.pos.y - p.pos.y, match.ball.pos.x - p.pos.x);
        }
        s.body.rotation = s.diveDir;
        s.body.scale.set(1 + 0.7 * k, 1 - 0.35 * k);
        s.body.alpha = 1;
      } else if (p.tackleAnimTimer > 0) {
        const k = p.tackleAnimTimer / 0.4;
        s.body.rotation = Math.atan2(p.heading.y, p.heading.x);
        s.body.scale.set(1 + 0.5 * k, 1 - 0.3 * k);
        s.body.alpha = 1;
      } else if (p.stunTimer > 0) {
        const wob = Math.sin(p.stunTimer * 25) * 0.12;
        s.body.rotation = 0;
        s.body.scale.set(1 + wob, 1 - wob);
        s.body.alpha = 0.8;
      } else if (s.body.scale.x !== 1 || s.body.scale.y !== 1 || s.body.rotation !== 0 || s.body.alpha !== 1) {
        s.body.scale.set(1, 1);
        s.body.rotation = 0;
        s.body.alpha = 1;
      }
    }

    this.updateBall(match, stepsThisFrame, flags);
    this.updateCb(match);
    this.updateFx(match, dtReal);
  }

  private updateBall(match: Match, steps: number, flags: RenderFlags): void {
    const px = toPx(match.ball.pos);

    // Trail: record when the ball actually moved.
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(px.x - last.x, px.y - last.y) > 2) {
      this.trail.push(px);
      if (this.trail.length > 16) this.trail.shift();
    }
    this.trailG.clear();
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      this.trailG.circle(t.x, t.y, 1.5 + (i / this.trail.length) * 2).fill({ color: 0xffffff, alpha: 0.06 + (i / this.trail.length) * 0.15 });
    }

    this.ballG.clear();
    // Height read (Phase 28): an airborne ball casts a shadow at its ground
    // spot while the ball itself draws bigger and nudged up-screen — the
    // classic top-down "it's in the air" cue.
    const z = match.ball.z;
    if (z > 0.15) {
      // Shadow shrinks slightly as the ball climbs — the height read.
      const sh = Math.max(2.2, 3.8 - z * 0.18);
      this.ballG.ellipse(px.x, px.y, sh, sh * 0.62).fill({ color: 0x000000, alpha: 0.35 });
    }
    // Keep a phone-readable minimum, but stay near the M0 physical scale:
    // the old 4px radius represented a 0.40m-radius ball at SCALE=10.
    const r = Math.max(2.4, BALL_RADIUS * SCALE * BALL_VISUAL_SCALE) * (1 + Math.min(z, 8) * 0.13);
    this.ballG.circle(px.x, px.y - z * 2.4, r).fill(0xffffff).stroke({ width: 1, color: 0x333333 });

    // Heatmap accumulation (weighted by sim steps so fast-forward still counts).
    if (flags.heatmap && match.phase === 'playing' && steps > 0) {
      const cx = Math.floor(((match.ball.pos.x + HALF_L) / PITCH_LENGTH) * this.heatCols);
      const cy = Math.floor(((match.ball.pos.y + HALF_W) / PITCH_WIDTH) * this.heatRows);
      if (cx >= 0 && cx < this.heatCols && cy >= 0 && cy < this.heatRows) {
        this.heat[cy * this.heatCols + cx] += steps;
      }
      if (++this.heatDirty >= 30) {
        this.heatDirty = 0;
        this.drawHeatmap();
      }
    }
    this.heatLayer.visible = flags.heatmap;
  }

  /**
   * ⭐⭐ CB (M-CB.3) — the carry-beat affordances in the tactical view.
   *
   * The ONE CB fork here is `match.cbTouchPast`, false in every production match, so an
   * unarmed match pays a boolean and a `Graphics` that stays empty. Everything drawn is read
   * off the match: the knocked ball's OWN past positions (recorded by `CbVisibility`, one
   * point per frame) and each beaten body's own `tackleCooldown` / `stunTimer`.
   */
  private updateCb(match: Match): void {
    if (!match.cbTouchPast) {
      if (this.cbG.visible) {
        this.cbG.clear();
        this.cbG.visible = false;
      }
      return;
    }
    this.cbG.visible = true;
    for (let i = 0; i < this.cbBodies.length; i++) {
      const p = match.allPlayers[i];
      const b = this.cbBodies[i];
      b.gid = p.gid;
      b.x = p.pos.x;
      b.z = p.pos.y;
      // The same reading as the render bridge's: inside his own recovery, and not the man who
      // came away with the ball.
      const beaten = p.tackleCooldown > 0 && match.ball.lastTouch !== p;
      b.cbRecover = beaten ? p.tackleCooldown : 0;
      b.cbCarryThrough = beaten ? p.stunTimer : 0;
    }
    this.cbFeed.knocks = match.cbLedger.touchPasts;
    if (match.dribbleTouch === null) this.cbFeed.touch = null;
    else {
      this.cbTouch.gid = match.dribbleTouch.gid;
      this.cbTouch.until = match.dribbleTouch.until;
      this.cbFeed.touch = this.cbTouch;
    }
    const vis = this.cbVis.update(
      match.simTime, match.ball.pos.x, match.ball.pos.y, match.ball.owner !== null,
      this.cbFeed, this.cbBodies as readonly CbBodyFrame[],
    );

    const g = this.cbG;
    g.clear();
    const k = vis.knock;
    if (k !== null) {
      // The release point, then the ball's own path since — a polyline through recorded
      // positions, never a projected curve.
      g.circle(toPxX(k.x0), toPxY(k.z0), CB_ORIGIN_PX)
        .stroke({ width: 2, color: CB_KNOCK_COLOR, alpha: CB_KNOCK_ALPHA * k.alpha });
      if (k.points >= 2) {
        g.moveTo(toPxX(k.path[0]), toPxY(k.path[1]));
        for (let i = 1; i < k.points; i++) {
          g.lineTo(toPxX(k.path[i * 2]), toPxY(k.path[i * 2 + 1]));
        }
        g.stroke({ width: 2.5, color: CB_KNOCK_COLOR, alpha: CB_KNOCK_ALPHA * k.alpha });
      }
    }
    for (let i = 0; i < vis.beatenCount; i++) {
      const m = vis.beaten[i];
      // The ring fades with HIS clock; the colour says which leg of it is running.
      g.circle(toPxX(m.x), toPxY(m.z), CB_RING_PX)
        .stroke({
          width: 2,
          color: m.carryThrough ? CB_CARRY_THROUGH_COLOR : CB_BEATEN_COLOR,
          alpha: CB_RING_ALPHA * m.frac,
        });
    }
  }

  private drawHeatmap(): void {
    const g = this.heatLayer;
    g.clear();
    let max = 1;
    for (let i = 0; i < this.heat.length; i++) max = Math.max(max, this.heat[i]);
    const cw = (PITCH_LENGTH * SCALE) / this.heatCols;
    const ch = (PITCH_WIDTH * SCALE) / this.heatRows;
    for (let y = 0; y < this.heatRows; y++) {
      for (let x = 0; x < this.heatCols; x++) {
        const v = this.heat[y * this.heatCols + x] / max;
        if (v < 0.02) continue;
        g.rect(MARGIN + x * cw, MARGIN + y * ch, cw, ch).fill({ color: 0xff4400, alpha: v * 0.4 });
      }
    }
  }

  private updateFx(match: Match, dtReal: number): void {
    // Watch for new goal events to trigger celebration FX.
    while (this.eventCursor < match.events.length) {
      const ev = match.events[this.eventCursor++];
      if (ev.type === 'goal' && ev.side !== -1) {
        this.fxTime = 0;
        this.goalText.tint = match.teams[ev.side].info.colors.primary;
      }
    }
    if (this.fxTime >= 0) {
      this.fxTime += dtReal;
      const t = this.fxTime;
      const DUR = 1.6;
      if (t >= DUR) {
        this.fxTime = -1;
        this.goalText.alpha = 0;
        this.flash.alpha = 0;
      } else {
        this.flash.alpha = Math.max(0, 0.35 * (1 - t / 0.4));
        this.goalText.alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / (DUR - 0.2);
        this.goalText.scale.set(0.6 + Math.min(t / 0.3, 1) * 0.6);
      }
    }
  }
}
