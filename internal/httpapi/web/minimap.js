"use strict";

import { Camera } from "./camera.js";

// Minimap — плавающий обзор всей схемы в углу канваса: показывается только
// когда сцена не помещается в текущий вьюпорт, рисует упрощённые точки узлов
// и рамку вьюпорта, клик/драг по ней двигает камеру страницы.
const Minimap = (() => {
  // layout вписывает bbox сцены в mw×mh — та же формула, что Camera.fitView,
  // но без запрета увеличения (миникарта должна занимать всё место).
  function layout(b, mw, mh, pad) {
    const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
    const z = Math.min((mw - 2 * pad) / w, (mh - 2 * pad) / h);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return { x: mw / 2 - cx * z, y: mh / 2 - cy * z, z };
  }

  // overflows — сцена (в мировых координатах, растянутая на текущий зум)
  // шире или выше видимого окна vw×vh.
  function overflows(b, cam, vw, vh) {
    return !!b && ((b.maxX - b.minX) * cam.z > vw || (b.maxY - b.minY) * cam.z > vh);
  }

  // viewportRect — прямоугольник видимого мира (заданного камерой cam на
  // экране vw×vh), спроецированный в пространство миникарты через map.
  function viewportRect(map, cam, vw, vh) {
    const tl = Camera.screenToWorld(cam, 0, 0);
    const br = Camera.screenToWorld(cam, vw, vh);
    const p1 = Camera.worldToScreen(map, tl.x, tl.y);
    const p2 = Camera.worldToScreen(map, br.x, br.y);
    return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
  }

  // create(canvas, opts) владеет собственным маленьким канвасом-миникартой:
  // getBounds/getPoints/getCam описывают сцену страницы, setCam двигает её
  // камеру по клику/драгу, getViewport — размер основного холста в css px.
  function create(canvas, { getBounds, getPoints, getCam, setCam, getViewport, getTheme, pad = 10 }) {
    let map = null; // текущее отображение мир -> пиксели миникарты

    let cw = 0, ch = 0;
    function draw(b) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      if (w !== cw || h !== ch) {
        cw = w; ch = h;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      const theme = (getTheme && getTheme()) || {};
      map = layout(b, cw, ch, pad);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = theme.muted || "#6b6b6b";
      (getPoints() || []).forEach((p) => {
        const s = Camera.worldToScreen(map, p.x, p.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
      const vp = getViewport();
      const r = viewportRect(map, getCam(), vp.w, vp.h);
      ctx.strokeStyle = theme.accent || "#2563eb";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    function update() {
      const b = getBounds();
      const vp = getViewport();
      const visible = overflows(b, getCam(), vp.w, vp.h);
      canvas.hidden = !visible;
      if (visible) draw(b);
    }

    // moveCameraTo центрирует вьюпорт страницы на мировой точке под пикселем
    // миникарты (mx,my), сохраняя текущий зум.
    function moveCameraTo(mx, my) {
      if (!map) return;
      const w = Camera.screenToWorld(map, mx, my);
      const cam = getCam();
      const vp = getViewport();
      setCam({ x: vp.w / 2 - w.x * cam.z, y: vp.h / 2 - w.y * cam.z, z: cam.z });
    }

    const pointFromEvent = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    canvas.addEventListener("mousedown", (e) => {
      const p = pointFromEvent(e);
      moveCameraTo(p.x, p.y);
      const onMove = (ev) => { const q = pointFromEvent(ev); moveCameraTo(q.x, q.y); };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    return Object.freeze({ update });
  }

  return Object.freeze({ layout, overflows, viewportRect, create });
})();

export { Minimap };
