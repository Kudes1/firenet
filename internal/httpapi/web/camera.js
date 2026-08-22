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

  return { MIN_ZOOM, MAX_ZOOM, create, zoomAt, screenToWorld, worldToScreen, transform };
})();
