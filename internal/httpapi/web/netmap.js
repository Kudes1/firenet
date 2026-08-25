"use strict";

// NetMap — общие чистые помощники отрисовки топологии: константы геометрии
// узлов и фабрика SVG-элементов. Используется интерактивной картой
// (topology.js) и статической картой страницы симуляции (simulate.js).
// Состояния страницы здесь нет.
const NetMap = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
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
    router: { rx: 16, glyph: "M2.5 6a3.5 3.5 0 1 1 0 .01M9 3.5h3m0 0-1.4-1.4M12 3.5l-1.4 1.4M9 8.5h3m0 0-1.4-1.4M12 8.5l-1.4 1.4" },
    switch: { rx: 2, glyph: "M1 4h10m0 0-2-2m2 2-2 2M11 8H1m0 0 2-2m-2 2 2 2" },
  };

  function el(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

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

  return Object.freeze({ SVG_NS, DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_COLORS, KINDS, el, center, linkOffsets, spreadOffset, pointAt, cloudSegs });
})();
