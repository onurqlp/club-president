import * as THREE from 'three';
import type { Role } from '../sim/types';
import { disposeKit, makeKit, PlayerModel, type KitMaterials } from './PlayerModel';

/**
 * THE PLAYER SHOWCASE (Phase 119a — user ask: "这个人的样子, 3d, 摆着姿势,
 * 动态, 可旋转全身"). A tiny standalone three.js turntable that reuses the
 * MATCH's player model verbatim — kit, back number, earned body (height off
 * the name, bulk off evolved strength), GK gloves-and-broad-build identity —
 * so the man on the card IS the man on the pitch.
 *
 * Lifecycle: the PlayerScreen owns ONE showcase for its lifetime. mount()
 * re-parents the same canvas into each fresh render and swaps the model only
 * when the occupant changes; stop() halts the RAF loop when the screen hides.
 * One WebGL context total — never one per render (contexts are a browser-
 * capped resource).
 */

export interface ShowcaseSpec {
  name: string;
  role: Role;
  /** Evolved strength attribute (0..1) — drives the body's bulk. */
  strength: number;
  primary: number;
  secondary: number;
}

const W = 300;
const H = 380;
/** Matches the UI's --surface card color so the stage reads as one card. */
const BG = 0x0d1526;

export class PlayerShowcase {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  /** Pedestal + player spin together — the museum turntable. */
  private turntable!: THREE.Group;
  private model: PlayerModel | null = null;
  private kit: KitMaterials | null = null;
  private specKey = '';
  private baseLeanY = 0;
  /** The pose's shoulder pitch — idle sway oscillates AROUND it, so the
   * keeper's arms-forward stance survives the animation. */
  private armBaseX: [number, number] = [0, 0];
  private raf = 0;
  private t = 0;
  private lastFrame = 0;
  /** Auto-spin resumes a beat after the last drag — the toy stays alive. */
  private dragging = false;
  private idleSince = 0;

  /** Re-parent the canvas into `host` and show `spec`'s man. */
  mount(host: HTMLElement, spec: ShowcaseSpec): void {
    if (!this.renderer) this.build();
    const canvas = this.renderer!.domElement;
    host.appendChild(canvas);
    this.setModel(spec);
    this.start();
  }

  /** Halt rendering (screen hidden). The context and model stay warm. */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private build(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(W, H, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.className = 'showcase-canvas';
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG);
    // Re-framed for the F1 body scale (0.64): the old 5.6m stand-off framed
    // a 2.7m figure and now frames a 1.7m one. Same shot, closer and lower.
    this.camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 50);
    this.camera.position.set(0, 1.12, 3.6);
    this.camera.lookAt(0, 0.68, 0);

    // Studio lighting: soft sky fill, a warm key that casts the shadow,
    // a cool rim from behind so the silhouette pops off the dark card.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x233047, 0.85));
    const key = new THREE.DirectionalLight(0xfff2df, 1.5);
    key.position.set(2.4, 4.2, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    const sc = key.shadow.camera;
    sc.near = 1;
    sc.far = 12;
    sc.left = -2.2;
    sc.right = 2.2;
    sc.top = 3;
    sc.bottom = -2;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb8ff, 0.55);
    rim.position.set(-2.2, 3, -3.4);
    this.scene.add(rim);

    this.turntable = new THREE.Group();
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.42, 1.55, 0.18, 40),
      new THREE.MeshStandardMaterial({ color: 0x18233c, roughness: 0.45, metalness: 0.25 }),
    );
    pedestal.position.y = -0.09;
    pedestal.receiveShadow = true;
    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(1.48, 0.022, 10, 48),
      new THREE.MeshStandardMaterial({ color: 0x4a90d9, roughness: 0.3, metalness: 0.6 }),
    );
    trim.rotation.x = Math.PI / 2;
    trim.position.y = 0.005;
    this.turntable.add(pedestal, trim);
    this.scene.add(this.turntable);

    // Drag-to-rotate (pointer events cover mouse + touch).
    let lastX = 0;
    canvas.addEventListener('pointerdown', (ev) => {
      this.dragging = true;
      lastX = ev.clientX;
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return;
      this.turntable.rotation.y += (ev.clientX - lastX) * 0.012;
      lastX = ev.clientX;
    });
    const release = () => {
      this.dragging = false;
      this.idleSince = this.t;
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  /** Swap the man on the pedestal — only when the occupant really changed. */
  private setModel(spec: ShowcaseSpec): void {
    const key = `${spec.name}:${spec.role}:${spec.strength.toFixed(2)}:${spec.primary}:${spec.secondary}`;
    if (key === this.specKey) return;
    this.specKey = key;
    if (this.model) {
      this.turntable.remove(this.model.root);
      this.disposeModel(this.model);
    }
    // Keepers wear the inverted kit — same rule as the match renderer.
    const isGK = spec.role === 'GK';
    this.kit = isGK ? makeKit(spec.secondary, spec.primary) : makeKit(spec.primary, spec.secondary);
    this.model = new PlayerModel(0, spec.role, spec.name, this.kit, '#fff');
    this.model.setLabelVisible(false); // the card already names him
    this.model.setBody(spec.name, spec.strength);
    this.model.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.receiveShadow = false;
    });
    this.baseLeanY = this.model.lean.position.y;
    this.pose(this.model, isGK);
    this.turntable.add(this.model.root);
    this.turntable.rotation.y = -0.5; // three-quarter opening angle
    this.idleSince = this.t;
  }

  /** The stance he holds for the portrait — keepers crouch ready, outfielders
   * stand easy. Idle motion in frame() breathes AROUND this base. */
  private pose(m: PlayerModel, isGK: boolean): void {
    if (isGK) {
      m.lean.rotation.x = 0.3;
      m.armL.rotation.set(-0.85, 0, 0.35);
      m.armR.rotation.set(-0.85, 0, -0.35);
      m.elbowL.rotation.x = -0.6;
      m.elbowR.rotation.x = -0.6;
      m.legL.rotation.x = 0.28;
      m.legR.rotation.x = 0.28;
      m.kneeL.rotation.x = 0.5;
      m.kneeR.rotation.x = 0.5;
    } else {
      m.lean.rotation.x = 0.04;
      m.armL.rotation.set(0.1, 0, 0.16);
      m.armR.rotation.set(-0.1, 0, -0.16);
      m.elbowL.rotation.x = -0.3;
      m.elbowR.rotation.x = -0.35;
      m.legL.rotation.x = 0.06;
      m.legR.rotation.x = -0.06;
      m.kneeL.rotation.x = 0.1;
      m.kneeR.rotation.x = 0.16;
    }
    this.armBaseX = [m.armL.rotation.x, m.armR.rotation.x];
  }

  private start(): void {
    if (this.raf) return;
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private frame(dt: number): void {
    this.t += dt;
    if (!this.dragging && this.t - this.idleSince > 2.5) {
      this.turntable.rotation.y += dt * 0.45;
    }
    const m = this.model;
    if (m) {
      // Breathing + a lazy arm sway — alive, not marching.
      m.lean.position.y = this.baseLeanY + Math.sin(this.t * 1.7) * 0.012;
      const sway = Math.sin(this.t * 1.4) * 0.045;
      m.armL.rotation.x = this.armBaseX[0] + sway;
      m.armR.rotation.x = this.armBaseX[1] - sway;
      m.body.rotation.y = Math.sin(this.t * 0.6) * 0.04;
    }
    this.renderer!.render(this.scene, this.camera);
  }

  /** Per-instance resources only: kit materials + label/number textures and
   * their basic/sprite materials. Shared GEO and skin/tone materials belong
   * to the match renderer's cache — never disposed here. */
  private disposeModel(m: PlayerModel): void {
    m.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat instanceof THREE.MeshBasicMaterial || mat instanceof THREE.SpriteMaterial) {
        mat.map?.dispose();
        mat.dispose();
      }
    });
    if (this.kit) disposeKit(this.kit);
    this.kit = null;
  }
}
