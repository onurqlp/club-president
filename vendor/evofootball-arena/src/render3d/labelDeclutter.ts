/**
 * Label decluttering — pure and unit-tested. Given projected screen positions
 * and a priority per label, greedily keep the highest-priority labels and drop
 * any lower-priority label that would land within `minDist` px of a kept one.
 *
 * Priorities used by the 3D view: selected 4 > ball carrier 3 > GK 2 > rest 1.
 */
export interface LabelItem {
  gid: number;
  x: number;
  y: number;
  priority: number;
}

export function declutterLabels(items: LabelItem[], minDist: number): Set<number> {
  const kept: LabelItem[] = [];
  const visible = new Set<number>();
  const sorted = [...items].sort((a, b) => b.priority - a.priority || a.gid - b.gid);
  const d2 = minDist * minDist;
  for (const item of sorted) {
    let clear = true;
    for (const k of kept) {
      const dx = item.x - k.x;
      const dy = item.y - k.y;
      if (dx * dx + dy * dy < d2) {
        clear = false;
        break;
      }
    }
    if (clear) {
      kept.push(item);
      visible.add(item.gid);
    }
  }
  return visible;
}
