import type { CameraMode } from '../render3d/CameraController';
import type { Lighting } from '../render3d/stylePresets';
import type { FxQuality } from '../render3d/FxSystem';
import type { EdsPreviewMode } from '../game/edsPreview';
import type { A4WorldVersion } from '../game/a4World';

export type ViewMode = '2d' | '3d';
export type { FxQuality };

/** UI ↔ game contract. GameApp implements this; panels call it. */
export interface UiFlags {
  actionLabels: boolean;
  heatmap: boolean;
  formation: boolean;
  passLines: boolean;
  shotVector: boolean;
  marking: boolean;
  chasers: boolean;
  /** B1: read-only perception sandbox — the selected player's world model (3D only). */
  perception: boolean;
  /** B1 sub-toggle: overlay the hypothetical chooseAttentionGaze cone. */
  perceptionGaze: boolean;
  /** B2: perceive at synthetic awareness 0.2 instead of 0.8 (the contrast). */
  perceptionLowAwareness: boolean;
}

// Default view is CLEAN (2026-07-19, user: "把默认调试图层都关闭"): every dev
// overlay ships OFF so a first look is the football, not the diagnostics. All
// remain toggleable in the debug panel.
export const defaultFlags = (): UiFlags => ({
  actionLabels: false,
  heatmap: false,
  formation: false,
  passLines: false,
  shotVector: false,
  marking: false,
  chasers: false,
  perception: false,
  perceptionGaze: false,
  perceptionLowAwareness: false,
});

/** The overlay-channel subset of UiFlags — shared by the 2D and 3D overlays. */
export type OverlayFlags = Pick<UiFlags, 'formation' | 'passLines' | 'shotVector' | 'marking' | 'chasers'>;

/** True when any overlay channel is on (single source for both views). */
export const anyOverlayOn = (f: OverlayFlags): boolean =>
  f.formation || f.passLines || f.shotVector || f.marking || f.chasers;

export interface GameActions {
  setPaused(p: boolean): void;
  setSpeed(s: number): void;
  skipMatch(): void;
  simRound(): void;
  simSeason(): void;
  simSeasons(n: number): void;
  setAutoContinue(v: boolean): void;
  setFlag(key: keyof UiFlags, v: boolean): void;
  /** Experimental (Phase B): toggle the emergent positioning field (vs the
   * fixed formation tables). Affects new sims incl. evolution — enable, then
   * start a fresh league for a clean test. */
  setEmergentPos(v: boolean): void;
  /**
   * E4-PREP (ruling #14.3), extended by #22.5: arm one of the AUDITED preview
   * bundles for matches from the next kickoff. A mode, not a set of switches —
   * only combinations a pre-registered audit actually ran are reachable.
   */
  setEdsPreview(mode: EdsPreviewMode): void;
  /**
   * A4 PLAY-TEST (ruling #155, extended by #167.5): arm ONE of the certified
   * worlds — the enriched census substrate + the both-sides role eye + the
   * whisper home prior (obedience 0.5) on BOTH teams (v1), plus the frozen
   * per-slot discipline family (v2). 0 = off (the shipped game). Mutually
   * exclusive: arming one disarms the other. Arming reloads the current fixture
   * so the world under the eyes is the one the badge names. Async because the
   * census tables are fetched on demand.
   */
  setA4World(version: A4WorldVersion): void;
  toggleLeagueScreen(): void;
  /** Pop the tactical-DNA clash for the current match (Phase 33: the scoreboard is the button). */
  toggleClash(): void;
  saveNow(): void;
  loadNow(): void;
  newLeague(seedText: string): void;
  resetAll(): void;
  setViewMode(v: ViewMode): void;
  setCameraMode(m: CameraMode): void;
  openReplay(): void;
  setSound(volume: number): void;
  setMusic(volume: number): void;
  /** Presentation (Phase 15): all real controls, all optional. */
  setCinematic(v: boolean): void;
  /** HT/FT auto-highlight reels (Phase 33) — on by default, ⏭ skips. */
  setAutoHighlights(v: boolean): void;
  setFxQuality(q: FxQuality): void;
  /** Track F: day / night lighting for the 3D world (user pick at F0). */
  setLighting(l: Lighting): void;
  /** Save file down/upload (119a.5: the settings screen owns these now). */
  exportSave(): void;
  importSave(): void;
}
