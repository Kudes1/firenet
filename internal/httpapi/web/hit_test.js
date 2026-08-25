"use strict";

// HitTest — геометрическая проверка попадания по display list канваса.
// Заменяет per-element SVG-хуки: один вызов отвечает «что под курсором».
const HitTest = (() => {
  const PAD = 4; // запас на толщину обводки

  function bbox(item) {
    const g = item.geom;
    if (g.segs) {
      if (!g.segs.length) return { x: 0, y: 0, w: 0, h: 0 };
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      g.segs.forEach((s) => {
        x1 = Math.min(x1, s.x1, s.cx, s.x2); y1 = Math.min(y1, s.y1, s.cy, s.y2);
        x2 = Math.max(x2, s.x1, s.cx, s.x2); y2 = Math.max(y2, s.y1, s.cy, s.y2);
      });
      return { x: x1 - PAD, y: y1 - PAD, w: x2 - x1 + 2 * PAD, h: y2 - y1 + 2 * PAD };
    }
    return { x: g.x - PAD, y: g.y - PAD, w: (g.w || 0) + 2 * PAD, h: (g.h || 0) + 2 * PAD };
  }

  const hits = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  const overlap = (b, r) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;

  // расстояние от точки до отрезка
  function distSeg(p, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
    return Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
  }

  // расстояние до пути: квадратичные сегменты сэмплируются в линии
  function distPath(p, segs) {
    let best = Infinity;
    for (const s of segs) {
      for (let i = 0; i < 8; i++) {
        const q = (i + 1) / 8, r = i / 8;
        const px = (1 - q) ** 2 * s.x1 + 2 * (1 - q) * q * s.cx + q * q * s.x2;
        const py = (1 - q) ** 2 * s.y1 + 2 * (1 - q) * q * s.cy + q * q * s.y2;
        const qx = (1 - r) ** 2 * s.x1 + 2 * (1 - r) * r * s.cx + r * r * s.x2;
        const qy = (1 - r) ** 2 * s.y1 + 2 * (1 - r) * r * s.cy + r * r * s.y2;
        best = Math.min(best, distSeg(p, qx, qy, px, py));
      }
    }
    return best;
  }

  function pick(list, p, z) {
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it.pick) continue;
      if (it.geom.segs) {
        if (distPath(p, it.geom.segs) <= 14 / z) return it;
      } else if (hits(bbox(it), p)) return it;
    }
    return null;
  }

  const pickNodes = (list, r) => list.filter((it) => it.pick && it.nodeType && overlap(bbox(it), r));

  return Object.freeze({ bbox, pick, pickNodes });
})();

if (typeof module !== "undefined") module.exports = HitTest;
