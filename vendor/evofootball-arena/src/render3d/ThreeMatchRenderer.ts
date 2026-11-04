import * as THREE from 'three';
import { mentalityOf } from '../ai/mentality';
import { ACTION_SHORT } from '../render/actionLabels';
import { CANVAS_H, CANVAS_W } from '../render/transform';
import type { UiFlags } from '../ui/actions';
import { colorHex } from '../ui/dom';
import { AnimationSystem } from './AnimationSystem';
import { BallModel } from './BallModel';
import { carryDisplayOffset, contactCue } from './ballPresentation';
import { BroadcastLayer } from './BroadcastLayer';
import { CameraController, type CameraMode, pickCameraSubject } from './CameraController';
import { CoachModel } from './CoachModel';
import { LinesmanModel } from './LinesmanModel';
import { RefereeModel } from './RefereeModel';
import { CrowdSystem } from './CrowdSystem';
import { FxSystem, type FxQuality } from './FxSystem';
import { Goal3D } from './GoalModel';
import { declutterLabels, type LabelItem } from './labelDeclutter';
import { CbVisibility } from '../render/cbVisibility';
import { CbLayer } from './CbLayer';
import { Overlays3D } from './Overlays3D';
import { ContactTracker } from './contactCues';
import { PerceptionSandbox3D, type PerceptionView } from './PerceptionSandbox3D';
import { createPitch, type Pitch } from './PitchModel';
import { RENDER_QUALITY, pixelRatioFor } from './renderQuality';
import { SHADOW_WINDOW, groundAim, snapToLightTexels } from './shadowFollow';
import {
  HUMAN_MODEL_SCALE, PlayerModel, disposeKit, makeKit, resetSharedPlayerResources,
  setBodyStyle, type KitMaterials,
} from './PlayerModel';
import type { FxEvent, RenderState, RenderTheme } from './RenderStateAdapter';
import { attachEnvironment, createScene, toneMappingFor } from './SceneFactory';
import { stylePreset, type StylePreset } from './stylePresets';
import { BOX_DEPTH, BOX_WIDTH, HALF_L, HALF_W } from '../sim/constants';
import { TEAM_SIZE } from '../sim/types';

/** Half-time / full-time stroll speed (m/s) — an unhurried walk to the tunnel. */
const WALKOFF_SPEED = 1.4;
/** F-Q: how far the shadow sun sits from its aim along the sun direction (m). */
const SUN_DIST = 80;
const FWD = new THREE.Vector3();

/**
 * ThreeMatchRenderer — the 3D match viewer. Pure consumer of RenderState
 * (from the live sim via the adapter, or from a ReplayBuffer); it never
 * touches simulation objects. Construction throws if WebGL is unavailable,
 * which the GameApp catches to fall back to 2D.
 */
export class ThreeMatchRenderer {
  /** The F0 style preset this renderer was built with (read-only at runtime:
   * switching styles means rebuilding, which GameApp does by re-attaching). */
  readonly style: StylePreset;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  /** F-Q: the shadow-casting sun; its box follows the play camera (`updateShadowWindow`). */
  private sun: THREE.DirectionalLight;
  private sunDir = new THREE.Vector3();
  /** Which shadow window the sun's ortho box is currently cut for (`'wide'` = full pitch). */
  private shadowMode: string | null = null;
  private pitch: Pitch;
  /** F-Q: render-detected body bumps → brace pose + dust. */
  private contacts = new ContactTracker();
  /** Bumps fired since construction (tooling — the harness proves they happen). */
  private bumpCount = 0;
  private cameraCtl: CameraController;
  /** Whose shoulder the third-person rig rode last frame (null outside that camera). */
  private cameraSubjectGid: number | null = null;
  private ball = new BallModel();
  private overlays = new Overlays3D();
  /** ⭐ CB (M-CB.3): the carry-beat affordances — inert until a CB-armed match feeds it. */
  private cbLayer = new CbLayer();
  private cbVis = new CbVisibility();
  /** B1 read-only world-model overlay (default off; host set in constructor). */
  private perception: PerceptionSandbox3D;
  /** B2: the overlay's awareness chip asks the host to flip the UI flag. */
  set onPerceptionAwarenessToggle(fn: (() => void) | null) {
    this.perception.onToggleAwareness = fn;
  }
  private fx: FxSystem;
  private goals: [Goal3D, Goal3D];
  private playersGroup = new THREE.Group();
  private players = new Map<number, PlayerModel>();
  /** Touchline coaches (Phase 66, N3) — own group so raycast picking never
   * sees them. Empty when no coach travels with the team sheet. */
  private coachesGroup = new THREE.Group();
  /** The on-pitch referee (Phase 75) — position synthesized render-side.
   * Built in the constructor, not as a field: the F0 material language must be
   * set before any body exists, and field initializers run first. */
  private referee: RefereeModel;
  private prevOwnerG: number | null = null;
  private prevLastTouchG: number | null | undefined = undefined;
  private prevHeaderCount = 0;
  private prevIsShot = false;
  private prevCarrying = false;
  private arousalAccum = 0;
  /** The assistants (Phase 77): opposite touchlines, one half each —
   * their running line IS the offside line. */
  private linesmen: [LinesmanModel, LinesmanModel];
  private coaches: CoachModel[] = [];
  /** The living crowd (66.1) — idles, ripples on chances, erupts on goals. */
  private crowd: CrowdSystem;
  /** The tactical broadcast layer (68, N4): block outline + press waves. */
  private broadcast = new BroadcastLayer();
  private kits: KitMaterials[] = [];
  private anim = new AnimationSystem();
  /** Half-time / full-time walk to the tunnel (Phase 41.1, render-only): per-gid
   * current walked position, seeded from the freeze pose and advanced each frame
   * so players stroll off instead of the stale-velocity run-in-place. */
  private walkOff = new Map<number, { x: number; z: number }>();
  private raycaster = new THREE.Raycaster();
  private lastState: RenderState | null = null;
  private theme: RenderTheme | null = null;

  private possessionRing: THREE.Mesh;
  private possessionMat: THREE.MeshBasicMaterial;
  private pulsePhase = 0;
  private labelVisibleCount = 10;

  private banner: HTMLDivElement;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private scoreBug: HTMLDivElement;
  private scoreBugText = '';
  private vignette: HTMLDivElement;
  private tacmap: HTMLCanvasElement;
  private host: HTMLElement;
  private viewW = 0;
  private viewH = 0;
  private resizeObs: ResizeObserver | null = null;

  onSelectPlayer: ((gid: number) => void) | null = null;
  /** Optional external hook (sound etc.) fired once per fx event — plus
   * the render-detected 'pass'/'touch' ball transitions (78.1). */
  onFxEvent: ((type: FxEvent['type'] | 'pass' | 'touch' | 'tackle' | 'miss' | 'header') => void) | null = null;
  /** Crowd arousal bridge (Phase 90) — throttled, drives the ambience swell. */
  onArousal: ((a: number) => void) | null = null;
  /** A fast carry started/ended (Phase 90) — the dribble-step loop. */
  onCarry: ((on: boolean) => void) | null = null;
  /** Tap on the broadcast score bug (Phase 33: pops the tactical-DNA clash). */
  onScoreBugTap: (() => void) | null = null;

  constructor(host: HTMLElement, style: StylePreset = stylePreset()) {
    this.host = host;
    this.style = style;
    // F0: the body material language is a module-level switch shared by every
    // kit factory, so it must be set BEFORE the first body is built.
    setBodyStyle(style);
    this.fx = new FxSystem(style);
    this.crowd = new CrowdSystem(style);
    this.referee = new RefereeModel();
    this.linesmen = [new LinesmanModel(1, -1), new LinesmanModel(-1, 1)];
    this.perception = new PerceptionSandbox3D(host);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Named so tools can tell the stage apart from the tacmap inset (68) —
    // '#three-host canvas' alone matches both since the broadcast layer.
    this.renderer.domElement.className = 'gl-canvas';
    this.renderer.setSize(CANVAS_W, CANVAS_H);
    // F-Q: the ratio comes from the quality ladder — `medium` keeps the old
    // cap of 2, `high` renders native on a DPR-3 phone.
    this.renderer.setPixelRatio(pixelRatioFor(this.fx.quality, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = toneMappingFor(style);
    this.renderer.toneMappingExposure = style.exposure;
    host.appendChild(this.renderer.domElement);

    const bundle = createScene(style);
    this.scene = bundle.scene;
    this.sun = bundle.sun;
    this.sunDir.set(...style.sun.pos).normalize();
    const quality = RENDER_QUALITY[this.fx.quality];
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    attachEnvironment(this.renderer, this.scene, style);
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.pitch = createPitch(maxAniso, style, quality);
    this.scene.add(this.pitch.group);
    this.goals = [new Goal3D(1, maxAniso), new Goal3D(-1, maxAniso)];
    this.scene.add(this.goals[0].group, this.goals[1].group);
    this.scene.add(this.ball.root, this.ball.worldTrail, this.overlays.root, this.cbLayer.root, this.perception.root, this.fx.root, this.playersGroup, this.coachesGroup, this.crowd.root, this.broadcast.root, this.referee.root, this.linesmen[0].root, this.linesmen[1].root);

    // Possession indicator: pulsing team-colored ring under the ball carrier.
    this.possessionMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    });
    this.possessionRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.12, 24), this.possessionMat);
    this.possessionRing.rotation.x = -Math.PI / 2;
    this.possessionRing.position.y = 0.07;
    this.possessionRing.visible = false;
    this.scene.add(this.possessionRing);

    this.cameraCtl = new CameraController(CANVAS_W / CANVAS_H);

    // DOM overlays on the 3D host: goal banner, broadcast score bug, and a
    // subtle vignette that keeps the pitch the visual center.
    host.style.position = 'relative';
    this.banner = document.createElement('div');
    this.banner.className = 'goal-banner hidden';
    this.vignette = document.createElement('div');
    this.vignette.className = 'pitch-vignette';
    this.scoreBug = document.createElement('div');
    this.scoreBug.className = 'score-bug hidden';
    this.scoreBug.addEventListener('click', () => this.onScoreBugTap?.());
    // The live mini formation map (Phase 68, N4) — the broadcast inset.
    this.tacmap = document.createElement('canvas');
    this.tacmap.className = 'tacmap hidden';
    this.tacmap.width = 168;
    this.tacmap.height = 112;
    host.append(this.vignette, this.scoreBug, this.banner, this.tacmap);

    // RESPONSIVE renderer (2026-07-20): size the WebGL buffer + camera aspect
    // to the HOST box, not a fixed CANVAS_W×H — so the pitch fills whatever
    // space it has and grows to fill the viewport in cinematic (the host box
    // changes when the panels hide). One observer covers window resize AND the
    // cinematic toggle; no per-caller resize wiring needed.
    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);

    // Renderer-owned event feedback.
    this.fx.hooks = {
      onGoal: (side) => {
        this.goals[side].shake();
        // Punch the back net at the ball's impact point (Phase 74) — the
        // goal event fires while the ball is still at/behind the line.
        const b = this.lastState?.ball;
        if (b) this.goals[side].bulge(b.z, Math.max(0.42, b.y ?? 0.42));
        this.crowd.erupt(); // the stands go up (66.1)
        const team = this.theme?.teams[side];
        const pens = this.lastState?.shootout;
        if (team && pens) {
          // Shootout theater's winning moment: pens score, not the FT score.
          this.showBanner('WINS THE SHOOTOUT!', `${team.name} · ${pens.h}–${pens.a} pens`, team.primary);
        } else if (team) {
          const score = this.lastState ? `${this.lastState.score[0]}–${this.lastState.score[1]}` : '';
          this.showBanner('GOAL!', `${team.name}${score ? ` · ${score}` : ''}`, team.primary);
        }
      },
      onShot: () => {
        this.cameraCtl.pulse();
        // The whole dugout and the stands tighten on a strike (66.1).
        for (const coach of this.coaches) coach.nudge();
        this.crowd.ripple(0.4);
      },
      onEvent: (type) => {
        if (type === 'save') this.crowd.ripple(0.55);
        else if (type === 'corner') this.crowd.ripple(0.3);
        this.onFxEvent?.(type);
      },
    };

    this.renderer.domElement.addEventListener('pointerdown', (ev) => this.pick(ev));
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Rebuild player models and kit materials for a new match. */
  attach(theme: RenderTheme): void {
    this.theme = theme;
    for (const model of this.players.values()) {
      this.playersGroup.remove(model.root);
      model.dispose();
    }
    this.players.clear();
    for (const kit of this.kits) disposeKit(kit);
    this.kits = [];

    // Kit contrast: if the two primaries are too close (CVD/duplicate hues),
    // team B plays in its inverted kit so the teams stay tellable-apart.
    const clash = colorDist(theme.teams[0].primary, theme.teams[1].primary) < 110;
    const teamKits = theme.teams.map((t, side) => {
      const invert = clash && side === 1;
      const p = invert ? t.secondary : t.primary;
      const s = invert ? t.primary : t.secondary;
      return { outfield: makeKit(p, s), keeper: makeKit(s, p) };
    });
    for (const tk of teamKits) this.kits.push(tk.outfield, tk.keeper);

    for (const p of theme.players) {
      const tk = teamKits[p.side];
      const labelColor = colorHex(theme.teams[p.side].primary);
      const model = new PlayerModel(
        p.gid,
        p.role,
        p.name,
        p.role === 'GK' ? tk.keeper : tk.outfield,
        labelColor,
      );
      this.players.set(p.gid, model);
      this.playersGroup.add(model.root);
    }

    // The coaches take their technical areas (Phase 66, N3): bench side
    // (+z, where subs enter and the tunnel sits), either side of halfway,
    // clear of the walk-off fan (|x| ≤ 6.5 at z = HALF_W + 1.2). Only a
    // NAMED coach stands there — ad-hoc teams play with an empty dugout.
    for (const coach of this.coaches) {
      this.coachesGroup.remove(coach.root);
      coach.dispose();
    }
    this.coaches = [];
    theme.teams.forEach((t, side) => {
      if (!t.coach) return;
      const model = new CoachModel(
        side as 0 | 1, t.coach, t.primary, side === 0 ? -8 : 8, HALF_W + 1.7, t.tinker,
      );
      this.coaches.push(model);
      this.coachesGroup.add(model.root);
    });

    this.overlays.applyTheme(theme);
    this.broadcast.applyTheme(theme);
    this.fx.reset();
    this.referee.reset();
    for (const lm of this.linesmen) lm.reset();
    this.hideBanner();
    this.lastState = null;
    this.prevOwnerG = null;
    this.prevLastTouchG = undefined;
    this.prevHeaderCount = 0;
    this.prevIsShot = false;
    this.prevCarrying = false;
    this.cbVis.reset();
    this.cbLayer.clear();
  }

  update(
    state: RenderState | null, dt: number, flags: UiFlags, selectedGid: number | null,
    perception: PerceptionView | null = null,
  ): void {
    if (state) {
      // Assign early so fx hooks (goal banner) see the post-event score.
      this.lastState = state;
      this.updateScoreBug(state);
      // Half-time / full-time: stroll to the tunnel instead of the stale-
      // velocity run-in-place (Phase 41.1). Render-only — the sim is frozen.
      const walkingOff = state.phase === 'halftime' || state.phase === 'fulltime';
      for (const p of state.players) {
        const model = this.players.get(p.gid);
        if (!model) continue;
        // A substitution changed the slot's man (Phase 61) — cheap string
        // compare per frame, canvas redraw only on the actual swap.
        if (p.name !== undefined) model.setName(p.name);
        // The body follows the occupant + his evolved strength (Phase 76).
        model.setBody(p.name, p.str ?? 0.5);
        if (walkingOff) {
          this.poseWalkOff(model, p, state, dt, selectedGid);
        } else {
          model.setPose(p.x, p.z, p.yaw);
          model.setSelected(selectedGid === p.gid);
          model.setLabel(ACTION_SHORT[p.action], flags.actionLabels);
          this.anim.update(model, p, state, dt);
        }
      }
      if (!walkingOff && this.walkOff.size > 0) this.walkOff.clear();
      // F-Q body bumps: a pair entering the sim's shell at speed gets a
      // brace/recoil on both bodies and dust at the contact point. Detected
      // from consecutive frames, so live play and replay both show it.
      if (walkingOff) {
        this.contacts.reset();
      } else {
        for (const b of this.contacts.update(state.players, state.t)) {
          const pa = state.players.find((q) => q.gid === b.a);
          const pb = state.players.find((q) => q.gid === b.b);
          const ma = this.players.get(b.a);
          const mb = this.players.get(b.b);
          if (ma && pa) this.anim.bump(ma, pa, b.nx, b.nz, b.closing);
          if (mb && pb) this.anim.bump(mb, pb, -b.nx, -b.nz, b.closing);
          this.fx.bump(b.x, b.z, b.nx, b.nz, b.closing);
          this.bumpCount++;
        }
      }
      this.declutter(state, selectedGid);
      if (walkingOff) this.possessionRing.visible = false; // dead ball — no carrier
      else this.updatePossessionRing(state, dt);
      // A diving keeper's hands carry the ball (31.9, user report "球的位置
      // 应该随着手部变化"): while the owner's body is tilted, hand the
      // BallModel a hands anchor in world space so the held ball rides the
      // dive instead of hovering at the standing carry spot. Render-only.
      let hands: { x: number; y: number; z: number; t: number } | null = null;
      if (state.ball.ownerGid !== null) {
        const ownerModel = this.players.get(state.ball.ownerGid);
        const tilt = ownerModel ? Math.abs(ownerModel.body.rotation.z) : 0;
        if (ownerModel && tilt > 0.05) {
          const v = new THREE.Vector3(0, 1.8, 0.25);
          ownerModel.body.updateWorldMatrix(true, false);
          ownerModel.body.localToWorld(v);
          hands = { x: v.x, y: v.y, z: v.z, t: Math.min(1, tilt / 0.9) };
        }
      }
      // Outfield possession is rendered at the authoritative sim position.
      // Only a held keeper ball gets a pose/height anchor; the old 0.45–0.75m
      // outfield offset made the viewer watch a different ball from the one
      // the tackle and contact substrate queried.
      const owner = state.ball.ownerGid === null
        ? undefined
        : state.players.find((q) => q.gid === state.ball.ownerGid);
      const carry = carryDisplayOffset(state.ball, owner);
      // Audio transitions (78.1, user report "pass/touch 听不到"): a
      // release at speed is a PASS (shots already fire their own event);
      // a pickup is a TOUCH. Render-side detection, same as the ball hop.
      const og = state.ball.ownerGid;
      const contact = contactCue(this.prevLastTouchG, state.ball, state.players);
      if (contact !== null) {
        this.ball.pulseContact(contact);
        if (contact === 'tackle') this.onFxEvent?.('tackle');
      }
      if (
        contact !== 'tackle' && this.prevOwnerG !== null && og === null &&
        state.ball.speed > 8 && !state.ball.isShot
      ) {
        this.onFxEvent?.('pass');
      } else if (og !== null && og !== this.prevOwnerG) {
        this.onFxEvent?.('touch');
      }
      this.prevOwnerG = og;
      this.prevLastTouchG = state.ball.lastTouchGid;
      // Header thud (Phase 90): a header flag rose this frame.
      let headerCount = 0;
      for (const q of state.players) if (q.header) headerCount++;
      if (headerCount > this.prevHeaderCount) this.onFxEvent?.('header');
      this.prevHeaderCount = headerCount;
      // The near thing (Phase 90): a shot ended with neither a goal nor a
      // save in the fx window — the crowd deflates.
      if (this.prevIsShot && !state.ball.isShot) {
        const resolved = state.fx.some(
          (f) => f.type === 'goal' || f.type === 'save' || f.type === 'woodwork',
        );
        if (!resolved) this.onFxEvent?.('miss');
      }
      this.prevIsShot = state.ball.isShot;
      const carrying = carry !== null && !state.ball.heldByGk && state.ball.ownerGid !== null;
      if (carrying !== this.prevCarrying) {
        this.prevCarrying = carrying;
        this.onCarry?.(carrying);
      }
      this.ball.update(state.ball, state.players, dt, hands, carry);
      // The dugout lives the match (Phase 66 → 66.1): each coach tracks
      // the ball, celebrates HIS goals, despairs at concessions — and
      // works the touchline on the SAME mentality ramp the sim plays,
      // read at his own tinker gene (the stoic barely stirs).
      for (const coach of this.coaches) {
        const mood =
          state.celebratingSide === -1 ? 'neutral'
          : state.celebratingSide === coach.side ? 'celebrate'
          : 'despair';
        const diff = state.score[coach.side] - state.score[1 - coach.side];
        const m = mentalityOf(diff, state.minute, coach.tinker);
        coach.update(state.ball.x, state.ball.z, mood, Math.max(m.urgency, m.holding), dt);
      }
      // The referee patrols his diagonal, whistles fouls, raises cards
      // (Phase 75) — all synthesized from the state, never from the sim.
      this.referee.update(state, dt);
      // The assistants run the offside line and flag the calls (Phase 77).
      for (const lm of this.linesmen) lm.update(state, dt);
      this.overlays.update(state.overlays, flags);
      // ⭐ CB (M-CB.3): the knock's real path and the beaten defenders' own recovery clocks.
      // `state.cb` is absent in every production frame, so this is one property read and an
      // early return there — and the layer draws nothing it was not handed.
      this.cbLayer.update(
        state.cb === undefined ? null
          : this.cbVis.update(
            state.t, state.ball.x, state.ball.z, state.ball.ownerGid !== null,
            state.cb, state.players,
          ),
      );
      if (this.theme) {
        this.fx.process(state, [this.theme.teams[0].primary, this.theme.teams[1].primary]);
      }
      // Third person rides ONE body (the viewer's pick, else the ball's
      // protagonist — `pickCameraSubject`); every other camera ignores it.
      const subject = this.cameraCtl.mode === 'thirdPerson'
        ? pickCameraSubject(state.players, state.ball, selectedGid)
        : null;
      this.cameraSubjectGid = subject?.gid ?? null;
      this.cameraCtl.update(state.ball, dt, subject);
    } else {
      this.scoreBug.classList.add('hidden');
      this.cameraSubjectGid = null;
      this.cameraCtl.update({ x: 0, z: 0, vx: 0, vz: 0 }, dt);
      this.cbLayer.clear();
    }
    // The analyst layer lives ONLY in the tacfeed camera (Phase 72, user
    // design): the camera choice IS the toggle, and each element gates on
    // its own moment inside the layer.
    this.updateShadowWindow();
    const tacfeed = this.cameraCtl.mode === 'tacfeed';
    this.broadcast.update(state, tacfeed);
    this.updateTacmap(state, tacfeed);
    // B1 read-only world-model overlay — draws the selected observer's belief,
    // never the sim. Hidden (payload null) unless the sandbox flag is on.
    this.perception.update(perception, dt);
    this.fx.update(dt);
    this.goals[0].update(dt);
    this.goals[1].update(dt);
    this.crowd.update(dt); // the stands breathe even between matches
    this.arousalAccum += dt;
    if (this.arousalAccum > 0.5) {
      this.arousalAccum = 0;
      this.onArousal?.(this.crowd.arousal);
    }
    this.renderer.render(this.scene, this.cameraCtl.camera);
  }

  /** The tunnel: a single mouth at the halfway line by one touchline. Players
   * fan across it by squad slot so they stream off without stacking on a point. */
  private tunnelTarget(gid: number): { x: number; z: number } {
    const slot = gid % TEAM_SIZE; // 0..TEAM_SIZE-1
    return { x: (slot - (TEAM_SIZE - 1) / 2) * 2.6, z: HALF_W + 1.2 };
  }

  /** Walk one model toward the tunnel at an unhurried pace (Phase 41.1). The sim
   * has frozen the players with stale velocity (a run-in-place), so ignore its
   * pose: advance a render-only position and feed the gait a matching speed so
   * the legs stroll instead of sprint. */
  private poseWalkOff(
    model: PlayerModel, p: RenderState['players'][number], state: RenderState,
    dt: number, selectedGid: number | null,
  ): void {
    let wp = this.walkOff.get(p.gid);
    if (!wp) { wp = { x: p.x, z: p.z }; this.walkOff.set(p.gid, wp); }
    const t = this.tunnelTarget(p.gid);
    const dx = t.x - wp.x;
    const dz = t.z - wp.z;
    const d = Math.hypot(dx, dz);
    let speed = 0;
    if (d > 0.3) {
      const move = Math.min(WALKOFF_SPEED * dt, d) / d;
      wp.x += dx * move;
      wp.z += dz * move;
      speed = WALKOFF_SPEED;
    }
    const yaw = d > 0.3 ? Math.atan2(dx, dz) : model.root.rotation.y;
    model.setPose(wp.x, wp.z, yaw);
    model.setSelected(selectedGid === p.gid);
    model.setLabel('', false);
    this.anim.update(
      model,
      { ...p, x: wp.x, z: wp.z, yaw, speed, action: 'MakeRun', saving: false, header: false, tackling: false, stunned: false },
      state,
      dt,
    );
  }

  /** Size the WebGL buffer + camera aspect to the host box (responsive). */
  /**
   * F-Q: cut the sun's shadow box to what the camera can see and snap it to
   * whole texels in light space (`shadowFollow.ts`). Wide cameras keep the
   * full-pitch box the game shipped with; every play camera gets a window
   * 2–5× denser. The sun and its target move TOGETHER, so the light
   * direction — and therefore the shading — never changes.
   */
  private updateShadowWindow(): void {
    const mode = this.cameraCtl.mode;
    const win = SHADOW_WINDOW[mode] ?? null;
    const sc = this.sun.shadow.camera;
    if (!win) {
      if (this.shadowMode !== 'wide') {
        this.shadowMode = 'wide';
        const s = 62;
        sc.left = -s; sc.right = s; sc.top = s * 0.75; sc.bottom = -s * 0.75;
        sc.near = 10; sc.far = 180;
        sc.updateProjectionMatrix();
        this.sun.position.set(...this.style.sun.pos);
        this.sun.target.position.set(0, 0, 0);
      }
      return;
    }
    if (this.shadowMode !== mode) {
      this.shadowMode = mode;
      sc.left = -win.halfX; sc.right = win.halfX; sc.top = win.halfY; sc.bottom = -win.halfY;
      // The sun sits SUN_DIST out along its direction; the scene within the
      // window spans roughly ±35 m of depth around that.
      sc.near = SUN_DIST - 50; sc.far = SUN_DIST + 60;
      sc.updateProjectionMatrix();
    }
    const cam = this.cameraCtl.camera;
    cam.getWorldDirection(FWD);
    const aim = groundAim(cam.position, FWD);
    const t = snapToLightTexels(aim, this.sunDir, win, this.sun.shadow.mapSize.x);
    this.sun.target.position.set(t.x, t.y, t.z);
    this.sun.position.set(
      t.x + this.sunDir.x * SUN_DIST, t.y + this.sunDir.y * SUN_DIST, t.z + this.sunDir.z * SUN_DIST,
    );
  }

  private resize(): void {
    const w = Math.round(this.host.clientWidth) || CANVAS_W;
    const h = Math.round(this.host.clientHeight) || CANVAS_H;
    if (w === this.viewW && h === this.viewH) return;
    this.viewW = w;
    this.viewH = h;
    this.renderer.setSize(w, h);
    this.cameraCtl.camera.aspect = w / h;
    this.cameraCtl.camera.updateProjectionMatrix();
  }

  /** Hide low-priority labels that would overlap on screen. */
  private declutter(state: RenderState, selectedGid: number | null): void {
    const items: LabelItem[] = [];
    const v = new THREE.Vector3();
    for (const p of state.players) {
      const model = this.players.get(p.gid);
      if (!model) continue;
      v.set(p.x, 3.1 * HUMAN_MODEL_SCALE, p.z).project(this.cameraCtl.camera);
      const priority =
        p.gid === selectedGid ? 4 : p.gid === state.ball.ownerGid ? 3 : p.role === 'GK' ? 2 : 1;
      items.push({ gid: p.gid, x: (v.x * 0.5 + 0.5) * CANVAS_W, y: (-v.y * 0.5 + 0.5) * CANVAS_H, priority });
    }
    const visible = declutterLabels(items, 46);
    this.labelVisibleCount = visible.size;
    for (const [gid, model] of this.players) model.setLabelVisible(visible.has(gid));
  }

  private updatePossessionRing(state: RenderState, dt: number): void {
    const owner = state.ball.ownerGid !== null
      ? state.players.find((p) => p.gid === state.ball.ownerGid)
      : undefined;
    this.possessionRing.visible = owner !== undefined;
    if (owner && this.theme) {
      this.possessionRing.position.set(owner.x, 0.07, owner.z);
      this.possessionMat.color.setHex(this.theme.teams[owner.side].primary);
      this.pulsePhase += dt * 6;
      const s = 1 + Math.sin(this.pulsePhase) * 0.1;
      this.possessionRing.scale.set(s, s, 1);
    }
  }

  /**
   * The live mini formation map (Phase 68, N4): a broadcast inset — tiny
   * pitch, twelve dots, the ball. Both teams' CURRENT shape at a glance,
   * whatever the main camera is doing. Hidden with the broadcast flag,
   * without a match, and while the shootout theater owns the stage.
   */
  private updateTacmap(state: RenderState | null, on: boolean): void {
    const show = state !== null && on && !state.shootout && this.theme !== null;
    this.tacmap.classList.toggle('hidden', !show);
    if (!show) return;
    const ctx = this.tacmap.getContext('2d')!;
    const W = this.tacmap.width;
    const H = this.tacmap.height;
    const X = (x: number): number => ((x + HALF_L) / (HALF_L * 2)) * (W - 10) + 5;
    const Z = (z: number): number => ((z + HALF_W) / (HALF_W * 2)) * (H - 10) + 5;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10, 22, 14, 0.82)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(240, 246, 252, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(X(-HALF_L), Z(-HALF_W), X(HALF_L) - X(-HALF_L), Z(HALF_W) - Z(-HALF_W));
    ctx.beginPath();
    ctx.moveTo(X(0), Z(-HALF_W));
    ctx.lineTo(X(0), Z(HALF_W));
    ctx.stroke();
    for (const sx of [-1, 1]) {
      const gx = sx * HALF_L;
      const bx = sx * (HALF_L - BOX_DEPTH);
      ctx.strokeRect(
        Math.min(X(gx), X(bx)), Z(-BOX_WIDTH / 2),
        Math.abs(X(bx) - X(gx)), Z(BOX_WIDTH / 2) - Z(-BOX_WIDTH / 2),
      );
    }
    for (const p of state.players) {
      const color = this.theme!.teams[p.side].primary;
      ctx.fillStyle = colorHex(color);
      ctx.beginPath();
      ctx.arc(X(p.x), Z(p.z), p.role === 'GK' ? 2.2 : 2.8, 0, Math.PI * 2);
      ctx.fill();
      if (p.role === 'GK') {
        ctx.strokeStyle = 'rgba(240,246,252,0.8)';
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.arc(X(state.ball.x), Z(state.ball.z), 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Broadcast score bug: `RUS 2–1 OBS · 34'` (`· pens 3–2` during shootouts). */
  private updateScoreBug(state: RenderState): void {
    const t = this.theme;
    if (!t) return;
    this.scoreBug.classList.remove('hidden');
    const pens = state.shootout ? `${state.shootout.h}:${state.shootout.a}` : '';
    // `?? minute` keeps pre-Phase-28.1 replay snapshots (no clock field) honest.
    const clock = state.clock ?? String(state.minute);
    const text = `${t.teams[0].short}${state.score[0]}${state.score[1]}${t.teams[1].short}${clock}${pens}`;
    if (text === this.scoreBugText) return;
    this.scoreBugText = text;
    this.scoreBug.innerHTML =
      `<span class="sb-chip" style="background:${colorHex(t.teams[0].primary)}"></span>` +
      `<span class="sb-team">${t.teams[0].short}</span>` +
      `<span class="sb-score">${state.score[0]}–${state.score[1]}</span>` +
      `<span class="sb-team">${t.teams[1].short}</span>` +
      `<span class="sb-chip" style="background:${colorHex(t.teams[1].primary)}"></span>` +
      (state.shootout
        ? `<span class="sb-min">pens ${state.shootout.h}–${state.shootout.a}</span>`
        : `<span class="sb-min">${clock}'</span>`);
  }

  private showBanner(title: string, sub: string, color: number): void {
    this.banner.innerHTML =
      `<div class="gb-title">${title}</div>` +
      `<div class="gb-sub">${sub}</div>`;
    this.banner.style.borderColor = colorHex(color);
    this.banner.style.color = colorHex(color);
    this.banner.classList.remove('hidden');
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.hideBanner(), 2200);
  }

  private hideBanner(): void {
    this.banner.classList.add('hidden');
  }

  /**
   * Quality: one control for the FX budget AND the render ladder (F-Q) —
   * pixel ratio, shadow map size, pitch paint resolution, turf relief. See
   * `renderQuality.ts` for the rows. Changing the shadow map size or the turf
   * bump recompiles a shader or two ONCE, on the button press.
   */
  setFxQuality(q: FxQuality): void {
    this.fx.quality = q;
    this.vignette.style.display = q === 'low' ? 'none' : '';
    const spec = RENDER_QUALITY[q];
    this.renderer.setPixelRatio(pixelRatioFor(q, window.devicePixelRatio));
    if (this.sun.shadow.mapSize.x !== spec.shadowMap) {
      this.sun.shadow.mapSize.set(spec.shadowMap, spec.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.pitch.setQuality(spec);
  }

  get fxQuality(): FxQuality {
    return this.fx.quality;
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraCtl.setMode(mode);
  }

  get cameraMode(): CameraMode {
    return this.cameraCtl.mode;
  }

  /**
   * Cut to the goal celebration (F7c). The CALLER decides whether to do this,
   * not the fx hook below: this renderer is deliberately blind to where its
   * frames come from (live sim or ReplayBuffer), and a replay has already
   * chosen its own camera via `cameraForEvent`. Only the game loop knows which
   * it is, so only the game loop gets to ask.
   */
  goalCut(): void {
    const ball = this.lastState?.ball;
    if (ball) this.cameraCtl.goalCut(ball);
  }

  /** Re-arm one-shot effects (replay jump/scrub). */
  resetFx(): void {
    this.fx.reset();
    this.referee.reset();
    for (const lm of this.linesmen) lm.reset();
    // CB (#270.2): a reel cut / replay jump is a discontinuity — forget the visibility
    // tracker's episode state so a knock trail or ring never straddles the jump.
    this.cbVis.reset();
  }

  /* -------- selection & tooling -------- */

  private pick(ev: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cameraCtl.camera);
    const hits = this.raycaster.intersectObjects(this.playersGroup.children, true);
    for (const hit of hits) {
      const gid = hit.object.userData.gid as number | undefined;
      if (gid !== undefined) {
        this.onSelectPlayer?.(gid);
        return;
      }
    }
  }

  /** Player positions projected to renderer-logical pixels (for tests/tools). */
  playerScreenPositions(): Array<{ gid: number; x: number; y: number }> {
    const out: Array<{ gid: number; x: number; y: number }> = [];
    const v = new THREE.Vector3();
    for (const [gid, model] of this.players) {
      v.copy(model.root.position);
      v.y = 1.2;
      v.project(this.cameraCtl.camera);
      out.push({ gid, x: (v.x * 0.5 + 0.5) * CANVAS_W, y: (-v.y * 0.5 + 0.5) * CANVAS_H });
    }
    return out;
  }

  debugInfo(): {
    players: number;
    coaches: number;
    crowd: number;
    crowdArousal: number;
    broadcastLines: boolean;
    broadcastBlock: boolean;
    pressConverge: boolean;
    offsideFlash: boolean;
    tacmapVisible: boolean;
    goals: number;
    cameraMode: CameraMode;
    cameraSubject: number | null;
    drawCalls: number;
    ball: { x: number; z: number } | null;
    possessionRing: boolean;
    ballMarker: boolean;
    ballTrail: boolean;
    labelsVisible: number;
    netShaking: boolean;
    netBulging: boolean;
    referee: { x: number; z: number; calling: boolean };
    linesmen: Array<{ x: number; z: number; flag: boolean }>;
    bannerVisible: boolean;
    scoreBugVisible: boolean;
    fxQuality: FxQuality;
    /** F-Q: what the render ladder actually applied. */
    pixelRatio: number;
    shadowMap: number;
    shadowWindow: string | null;
    pitchBump: boolean;
    environment: boolean;
    bumps: number;
  } {
    return {
      players: this.players.size,
      coaches: this.coaches.length,
      crowd: this.crowd.count,
      crowdArousal: this.crowd.arousal,
      broadcastLines: this.broadcast.linesVisible,
      broadcastBlock: this.broadcast.blockVisible,
      pressConverge: this.broadcast.pressVisible,
      offsideFlash: this.broadcast.offsideFlash,
      // COMPUTED, not classList: the class said "hidden" for four phases
      // while an ID-specificity CSS rule kept the frame on screen (75.1).
      tacmapVisible: getComputedStyle(this.tacmap).display !== 'none',
      goals: 2,
      cameraMode: this.cameraCtl.mode,
      cameraSubject: this.cameraSubjectGid,
      drawCalls: this.renderer.info.render.calls,
      ball: this.lastState ? { x: this.lastState.ball.x, z: this.lastState.ball.z } : null,
      possessionRing: this.possessionRing.visible,
      ballMarker: this.ball.markerVisible,
      ballTrail: this.ball.trailVisible,
      labelsVisible: this.labelVisibleCount,
      netShaking: this.goals[0].isShaking || this.goals[1].isShaking,
      netBulging: this.goals[0].isBulging || this.goals[1].isBulging,
      referee: { ...this.referee.pos, calling: this.referee.calling },
      linesmen: this.linesmen.map((lm) => ({ ...lm.pos, flag: lm.flagging })),
      bannerVisible: !this.banner.classList.contains('hidden'),
      scoreBugVisible: !this.scoreBug.classList.contains('hidden'),
      fxQuality: this.fx.quality,
      pixelRatio: this.renderer.getPixelRatio(),
      shadowMap: this.sun.shadow.mapSize.x,
      shadowWindow: this.shadowMode,
      pitchBump: this.pitch.hasBump,
      environment: this.scene.environment !== null,
      bumps: this.bumpCount,
    };
  }

  /** Free every GPU resource and remove the canvas. */
  dispose(): void {
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.banner.remove();
    this.scoreBug.remove();
    this.vignette.remove();
    this.tacmap.remove();
    this.perception.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        std.map?.dispose();
        m.dispose();
      }
    });
    this.scene.environment?.dispose();
    for (const model of this.players.values()) model.dispose();
    this.players.clear();
    for (const coach of this.coaches) coach.dispose();
    this.coaches = [];
    // The traverse above disposed the shared player geometry/materials too —
    // forget the module caches so the next 3D init rebuilds them fresh.
    resetSharedPlayerResources();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function colorDist(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
