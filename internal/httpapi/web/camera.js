"use strict";

// Camera is the infinite-canvas viewport: a pan offset plus a zoom factor
// mapping world coordinates (node positions, stored in layout) to screen
// coordinates of the SVG canvas. Pure math only, no DOM.
const Camera = (() => {
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;

  function create() {
    return { x: 0, y: 0, z: 1 };
  }

  const clamp = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  // zoomAt returns a new camera zoomed by `factor` around the given screen
  // point, which stays stationary: the same world point remains under it.
  function zoomAt(cam, sx, sy, factor) {
    const z = clamp(cam.z * factor);
    return { x: sx - ((sx - cam.x) / cam.z) * z, y: sy - ((sy - cam.y) / cam.z) * z, z };
  }

  const screenToWorld = (cam, sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
  const worldToScreen = (cam, wx, wy) => ({ x: wx * cam.z + cam.x, y: wy * cam.z + cam.y });
  const transform = (cam) => `translate(${cam.x} ${cam.y}) scale(${cam.z})`;

  // Стейдж-модель: svg с запасом m по каждой стороне сдвинут на (-m,-m)
  // относительно контейнера, сцена внутри нарисована в координатах мира со
  // смещением o; камера применена CSS-трансформой и выполняется композитором
  // без перерисовки сцены. Инвариант тот же: контейнерная точка = world*z+cam.
  const stageTransform = (cam, o, m) =>
    `translate(${cam.x + m - o.x * cam.z}px, ${cam.y + m - o.y * cam.z}px) scale(${cam.z})`;

  // fitView подбирает зум и центр так, чтобы bbox мира (с полем pad)
  // целиком поместился во вьюпорт; мелкие сцены центрируются без увеличения.
  function fitView(cam, b, vw, vh, pad) {
    const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
    const z = clamp(Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h, 1));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return { x: vw / 2 - cx * z, y: vh / 2 - cy * z, z };
  }

  return { MIN_ZOOM, MAX_ZOOM, create, zoomAt, screenToWorld, worldToScreen, transform, stageTransform, fitView };
})();
