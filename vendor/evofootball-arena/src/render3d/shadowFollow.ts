/**
 * Camera-following sun shadows (Track F, F-Q) — the PURE half.
 *
 * The shadow map used to cover the whole pitch whatever the camera looked at:
 * 124 × 93 m in 2048 px is ~16 texels per metre, so a boot's contact shadow
 * was a 6-texel smear. The play cameras (broadcast, follow, third person,
 * behind-goal, penalty) only ever see a window of the pitch, so the ortho
 * shadow box now follows the camera's aim and shrinks to that window:
 * 2–5× the texel density for the same map.
 *
 * A moving shadow box SHIMMERS unless its position is snapped to whole
 * texels in light space — every frame the same blade would fall on a
 * different texel boundary and the edge would crawl. `snapToLightTexels`
 * does the snapping on a fixed basis derived from the sun direction, so two
 * aims closer than one texel apart produce the SAME box. Pure so the test
 * can pin that.
 */

export interface Vec3 { x: number; y: number; z: number }

export interface ShadowWindow {
  /** Half-extent of the ortho box across the light's right axis (m). */
  halfX: number;
  /** Half-extent along the light's up axis (m). */
  halfY: number;
}

/**
 * Half-extents per camera mode. Bounded by what the camera can SEE at its
 * usual distance (vertical FOV 46°): broadcast sits ~43 m from its aim (a
 * ~36 m tall slice, wider on desktop), follow ~22 m, third person ~7 m,
 * behind-goal ~14 m. Wide/analyst cameras keep the full-pitch box and are
 * absent here on purpose — `null` means "cover the pitch".
 */
export const SHADOW_WINDOW: Record<string, ShadowWindow | null> = {
  tactical: null,
  tacfeed: null,
  broadcast: { halfX: 30, halfY: 24 },
  follow: { halfX: 20, halfY: 16 },
  thirdPerson: { halfX: 14, halfY: 12 },
  behindGoal: { halfX: 22, halfY: 18 },
  penalty: { halfX: 16, halfY: 13 },
};

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The light-space basis for a sun DIRECTION (from the target toward the sun).
 * Matches three's shadow camera: it looks down -dir with world +y as the up
 * hint, so `right = up × dir` and `up = dir × right`.
 */
export function lightBasis(sunDir: Vec3): { right: Vec3; up: Vec3; dir: Vec3 } {
  const dir = norm(sunDir);
  const right = norm(cross({ x: 0, y: 1, z: 0 }, dir));
  const up = cross(dir, right);
  return { right, up, dir };
}

/**
 * Snap `aim` to the light-space texel grid of a box `2·half` wide rendered
 * into `mapSize` texels. Movement along the sun direction is irrelevant to
 * the projection and is left alone.
 */
export function snapToLightTexels(
  aim: Vec3, sunDir: Vec3, win: ShadowWindow, mapSize: number,
): Vec3 {
  const { right, up } = lightBasis(sunDir);
  const tx = (2 * win.halfX) / mapSize;
  const ty = (2 * win.halfY) / mapSize;
  const sx = dot(aim, right);
  const sy = dot(aim, up);
  const dx = Math.round(sx / tx) * tx - sx;
  const dy = Math.round(sy / ty) * ty - sy;
  return {
    x: aim.x + right.x * dx + up.x * dy,
    y: aim.y + right.y * dx + up.y * dy,
    z: aim.z + right.z * dx + up.z * dy,
  };
}

/**
 * Where the camera's forward ray meets the ground plane (y = 0), or its
 * position projected down if it looks up/level. This is the shadow box's
 * aim for every mode — no per-mode ball logic, so a camera cut, a goal cut
 * or a replay scrub all land the shadows where the viewer is looking.
 */
export function groundAim(camPos: Vec3, camForward: Vec3, maxDist = 120): Vec3 {
  if (camForward.y < -1e-4) {
    const t = Math.min(maxDist, -camPos.y / camForward.y);
    return { x: camPos.x + camForward.x * t, y: 0, z: camPos.z + camForward.z * t };
  }
  return { x: camPos.x, y: 0, z: camPos.z };
}
