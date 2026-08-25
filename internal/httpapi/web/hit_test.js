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

  // сэмплы квадратичного сегмента: 8 хорд на сегмент
  function segPts(s) {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const q = i / 8, r = 1 - q;
      pts.push([r * r * s.x1 + 2 * r * q * s.cx + q * q * s.x2, r * r * s.y1 + 2 * r * q * s.cy + q * q * s.y2]);
    }
    return pts;
  }

  // расстояние до пути: контур сэмплируется в хорды
  function distPath(p, segs) {
    let best = Infinity;
    for (const s of segs) {
      const pts = segPts(s);
      for (let i = 0; i + 1 < pts.length; i++) {
        best = Math.min(best, distSeg(p, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
      }
    }
    return best;
  }

  // точка внутри полигона: ray-casting (even-odd)
  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function pick(list, p, z) {
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it.pick) continue;
      if (it.geom.segs) {
        if (distPath(p, it.geom.segs) <= 14 / z) return it;
        // замкнутый залитый путь (облако сети) ловит и свою внутренность
        if (it.geom.closed && it.style && it.style.fill
          && pointInPolygon(p, it.geom.segs.flatMap(segPts))) return it;
      } else if (hits(bbox(it), p)) return it;
    }
    return null;
  }

  const pickNodes = (list, r) => list.filter((it) => it.pick && it.nodeType && overlap(bbox(it), r));

  return Object.freeze({ bbox, pick, pickNodes });
})();

if (typeof module !== "undefined") module.exports = HitTest;
