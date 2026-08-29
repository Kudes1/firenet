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
    if (g.poly) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      g.poly.forEach((p) => {
        x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
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

  // точка квадратичного сегмента при t = i/8
  function segPt(s, i) {
    const q = i / 8, r = 1 - q;
    return [r * r * s.x1 + 2 * r * q * s.cx + q * q * s.x2, r * r * s.y1 + 2 * r * q * s.cy + q * q * s.y2];
  }

  // расстояние до пути: контур сэмплируется в 8 хорд на сегмент, без аллокаций
  function distPath(p, segs) {
    let best = Infinity;
    for (const s of segs) {
      let ax = s.x1, ay = s.y1;
      for (let i = 1; i <= 8; i++) {
        const [bx, by] = segPt(s, i);
        const d = distSeg(p, ax, ay, bx, by);
        if (d < best) best = d;
        ax = bx; ay = by;
      }
    }
    return best;
  }

  // точка внутри замкнутого контура из квадратичных сегментов: ray-casting
  // (even-odd) по рёбрам, образуемым соседними сэмплами; без материала
  function pointInPolygon(p, segs) {
    let inside = false;
    let firstX = 0, firstY = 0, prevX = null, prevY = null;
    const edge = (xi, yi, xj, yj) => {
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    };
    for (const s of segs) {
      for (let i = 0; i <= 8; i++) {
        const [x, y] = segPt(s, i);
        if (prevX === null) { firstX = x; firstY = y; }
        else edge(x, y, prevX, prevY);
        prevX = x; prevY = y;
      }
    }
    if (prevX !== null) edge(firstX, firstY, prevX, prevY); // замыкание на первую точку
    return inside;
  }

  // расстояние до ломаной: минимум по всем её отрезкам
  function distPoly(p, points) {
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) best = Math.min(best, distSeg(p, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y));
    return best;
  }

  function pick(list, p, z) {
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it.pick) continue;
      if (it.geom.segs) {
        if (distPath(p, it.geom.segs) <= 14 / z) return it;
        // замкнутый залитый путь (облако сети) ловит и свою внутренность
        if (it.geom.closed && it.style && it.style.fill
          && pointInPolygon(p, it.geom.segs)) return it;
      } else if (it.geom.poly) {
        if (distPoly(p, it.geom.poly) <= 14 / z) return it;
      } else if (hits(bbox(it), p)) return it;
    }
    return null;
  }

  const pickNodes = (list, r) => list.filter((it) => it.pick && it.nodeType && overlap(bbox(it), r));

  return Object.freeze({ bbox, pick, pickNodes });
})();

export { HitTest };
