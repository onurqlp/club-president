import * as THREE from 'three';
import { HALF_L, HALF_W } from '../sim/constants';
import { stylePreset, type StylePreset } from './stylePresets';

/**
 * Scene, lights and atmosphere for the diorama-style pitch. No stadium —
 * a clean floating pitch on a dark backdrop matching the app theme.
 *
 * Every value comes from an F0 style preset; the default preset reproduces the
 * shipped look exactly, so passing nothing changes nothing.
 */
export interface SceneBundle {
  scene: THREE.Scene;
  /** The shadow-casting sun. F-Q: its shadow box follows the play camera
   * (`ThreeMatchRenderer.updateShadowWindow`), so the renderer needs a handle. */
  sun: THREE.DirectionalLight;
}

export function createScene(style: StylePreset = stylePreset()): SceneBundle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(style.background);
  scene.fog = style.fog
    ? new THREE.Fog(style.fog.color, style.fog.near, style.fog.far)
    : null;

  const hemi = new THREE.HemisphereLight(style.hemi.sky, style.hemi.ground, style.hemi.intensity);
  scene.add(hemi);

  // Toon ramps have no specular to lift them, so the toy arm buys a flat fill.
  if (style.ambient) {
    scene.add(new THREE.AmbientLight(style.ambient.color, style.ambient.intensity));
  }

  const sun = new THREE.DirectionalLight(style.sun.color, style.sun.intensity);
  sun.position.set(...style.sun.pos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 62;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s * 0.75;
  sun.shadow.camera.bottom = -s * 0.75;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 180;
  sun.shadow.bias = -0.0004;
  // F-Q: with a 2–5× denser shadow map the old bias alone shows acne on the
  // round bodies; a small normal offset is the standard fix and costs nothing.
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  // The shadow camera aims at `sun.target`; three only updates a target's
  // world matrix when it is in the scene graph. It is at the origin (the
  // shipped behaviour) until the renderer starts moving it with the camera.
  scene.add(sun.target);

  // Pedestal under the pitch so the diorama reads as a solid object.
  const pedestal = new THREE.Mesh(
    new THREE.BoxGeometry(HALF_L * 2 + 14, 2.5, HALF_W * 2 + 14),
    new THREE.MeshStandardMaterial({ color: style.pedestal, roughness: 0.95 }),
  );
  pedestal.position.y = -1.3;
  pedestal.receiveShadow = true;
  scene.add(pedestal);

  return { scene, sun };
}

/**
 * F-Q: a procedural environment map — sky dome over grass, with the sun as a
 * bright disc in its own direction — pre-filtered with PMREM and set as the
 * scene's image-based lighting. Code only, no image files (F-DIRECTION).
 * `MeshStandardMaterial` picks it up through `scene.environment`; the toon
 * bodies ignore it, which is the point: only the ball, goal frame, boards
 * and grass gain a specular response. A preset with `environment: 0` gets
 * none — the banked `current` frame is unchanged.
 */
export function attachEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, style: StylePreset): void {
  if (style.environment <= 0) {
    scene.environment = null;
    return;
  }
  const env = new THREE.Scene();
  const sky = new THREE.Color(style.background);
  const horizon = style.fog ? new THREE.Color(style.fog.color) : sky.clone();
  const ground = new THREE.Color(style.hemi.ground);
  // A big inside-out sphere with a vertical colour gradient: zenith → horizon → ground.
  const geo = new THREE.SphereGeometry(40, 24, 16);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 40; // -1 .. 1
    if (h >= 0) c.lerpColors(horizon, sky, Math.min(1, h * 1.6));
    else c.lerpColors(horizon, ground, Math.min(1, -h * 3));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  // The sun: a small hot disc where the key light comes from.
  const sunDir = new THREE.Vector3(...style.sun.pos).normalize();
  const disc = new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 12, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(style.sun.color).multiplyScalar(6) }),
  );
  disc.position.copy(sunDir).multiplyScalar(36);
  env.add(disc);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  geo.dispose();
  scene.environment = target.texture;
  scene.environmentIntensity = style.environment;
}

/** three's tone-mapping enum for a preset's setting. */
export function toneMappingFor(style: StylePreset): THREE.ToneMapping {
  if (style.toneMapping === 'aces') return THREE.ACESFilmicToneMapping;
  if (style.toneMapping === 'neutral') return THREE.NeutralToneMapping;
  return THREE.NoToneMapping;
}
