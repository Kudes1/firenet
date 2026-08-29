"use strict";

// NetMap — общие чистые помощники отрисовки топологии: константы геометрии
// узлов, глифы устройств и геометрия облаков. Используется интерактивной
// картой (topology.js) и статической картой страницы диагностики (diagnose.js).
// Состояния страницы здесь нет.
const NetMap = (() => {
  const DEVICE_W = 140;
  const DEVICE_H = 60;
  const NET_W = 160;
  const NET_H = 60;
  // палитра различимых оттенков; цвет = порядок объединения в документе
  const UNION_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

  // KINDS is the visual vocabulary: per device kind, the corner radius of
  // its node and a small glyph path (drawn in a 12x12 box before the
  // label). Unknown kinds fall back to a plain rectangle without a glyph.
  // Colors live in style.css (--kind-*).
  const KINDS = {
    // glyphs adapted from icons/*.svg (svgrepo.com), 24x24 grid scaled x0.5
    router: { rx: 16, glyph: "M6 10.5V6M6 10.5L7.5 9M6 10.5L4.5 9M6 6V1.5M6 6H1.5M6 6H10.5M6 1.5L4.5 3M6 1.5L7.5 3M1.5 6L3 7.5M1.5 6L3 4.5M10.5 6L9 4.5M10.5 6L9 7.5" },
    switch: { rx: 2, glyph: "M9 10L10.5 8.5M10.5 8.5L9 7M10.5 8.5H8.5C7.1193 8.5 6 7.3807 6 6C6 4.61929 4.88071 3.5 3.5 3.5H1.5M9 2L10.5 3.5M10.5 3.5L9 5M10.5 3.5L8.5 3.5C7.9372 3.5 7.41785 3.68597 7 3.999815M1.5 8.5H3.5C4.062805 8.5 4.58217 8.31385 5 8" },
  };

  function center(map, name, w, h) {
    const pos = map[name];
    if (!pos) return null;
    return { x: pos.x + w / 2, y: pos.y + h / 2 };
  }

  // linkOffsets assigns each link (keyed by its unordered device pair) a
  // fan-out offset so redundant links render as distinct parallel lines.
  function linkOffsets(links) {
    const seen = new Map();
    return links.map((l) => {
      const key = [l.a.device, l.b.device].sort().join(" ");
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      return n;
    });
  }

  function spreadOffset(index) {
    const magnitude = Math.ceil(index / 2) * 14;
    return index % 2 === 0 ? magnitude : -magnitude;
  }

  function pointAt(a, b, t, offset) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: a.x + dx * t + (-dy / len) * offset, y: a.y + dy * t + (dx / len) * offset };
  }

  // distToSeg — расстояние от точки до отрезка ab
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  // insertIndex находит сегмент ломаной points, ближайший к p, и возвращает
  // индекс его начала — новую точку изгиба вставляют сразу после него.
  function insertIndex(points, p) {
    let best = Infinity, at = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const d = distToSeg(p, points[i], points[i + 1]);
      if (d < best) { best = d; at = i; }
    }
    return at;
  }

  // cloudSegs выдаёт контур L2-облака как замкнутый список квадратичных
  // сегментов: прямоугольный периметр с наружными выпуклостями (глубина 6).
  function cloudSegs(x, y, w, h) {
    const depth = 6, HB = 7, VB = 3;
    const pts = [[x, y]];
    const edge = (x1, y1, x2, y2, n) => {
      for (let i = 1; i <= n + 1; i++) pts.push([x1 + ((x2 - x1) * i) / (n + 1), y1 + ((y2 - y1) * i) / (n + 1)]);
    };
    edge(x, y, x + w, y, HB);
    edge(x + w, y, x + w, y + h, VB);
    edge(x + w, y + h, x, y + h, HB);
    for (let i = VB; i >= 1; i--) pts.push([x, y + (h * i) / (VB + 1)]);
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      segs.push({ x1: ax, y1: ay, cx: ax + dx / 2 + (dy / len) * depth, cy: ay + dy / 2 + (-dx / len) * depth, x2: bx, y2: by });
    }
    return segs;
  }

  return Object.freeze({
    DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_COLORS, KINDS,
    center, linkOffsets, spreadOffset, pointAt, insertIndex, cloudSegs,
  });
})();

export { NetMap };
if (typeof window !== "undefined") window.NetMap = NetMap; // TODO(Task 28): remove once every classic-script consumer imports NetMap directly
