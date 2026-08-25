"use strict";

// CanvasView — рендерер display list в Canvas2D: полный redraw кадра по
// invalidate (≤1 на rAF), камера через setTransform, culling вне вьюпорта.
// Рендерер ничего не знает о топологии — только примитивы и стили.
const CanvasView = (() => {
  const raf = typeof requestAnimationFrame === "function"
    ? (fn) => requestAnimationFrame(fn)
    : (fn) => fn();

  function trace(ctx, item) {
    const g = item.geom;
    if (g.segs) {
      ctx.beginPath();
      ctx.moveTo(g.segs[0].x1, g.segs[0].y1);
      g.segs.forEach((s) => ctx.quadraticCurveTo(s.cx, s.cy, s.x2, s.y2));
      if (g.closed) ctx.closePath();
    } else {
      ctx.beginPath();
      const r = g.r || 0;
      if (typeof ctx.roundRect === "function") ctx.roundRect(g.x, g.y, g.w, g.h, r);
      else ctx.rect(g.x, g.y, g.w, g.h);
    }
  }

  function paint(ctx, item) {
    const s = item.style || {};
    ctx.save();
    ctx.globalAlpha = s.alpha ?? 1;
    if (item.kind === "text") {
      ctx.font = s.font;
      ctx.fillStyle = s.fill;
      ctx.fillText(item.text, item.geom.x, item.geom.y);
    } else if (item.kind === "glyph") {
      ctx.translate(item.geom.x, item.geom.y);
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.lineWidth || 1.6;
      ctx.stroke(new Path2D(item.geom.d));
    } else {
      trace(ctx, item);
      if (s.fill) {
        ctx.globalAlpha = (s.alpha ?? 1) * (s.fillAlpha ?? 1);
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      if (s.stroke) {
        ctx.globalAlpha = (s.alpha ?? 1) * (s.strokeAlpha ?? 1);
        ctx.strokeStyle = s.stroke;
        ctx.lineWidth = s.lineWidth || 1;
        if (s.dash) ctx.setLineDash(s.dash);
        ctx.lineCap = "round";
        ctx.stroke();
        if (s.dash) ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

function create(canvas, { getList, getCam, getOverlay, textHideZoom = 0.5 }) {
    let dirty = true;
    let scheduled = false;
    let ctx = null;
    let cw = 0, ch = 0;
    let view0 = null;
    let hideText = false;

    function resizeIfNeeded() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === cw && h === ch && ctx) return;
      cw = w; ch = h;
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx = canvas.getContext("2d");
    }

    function paintIfVisible(it) {
      if (it.text && hideText) return;
      const b = HitTest.bbox(it);
      if (b.x > view0.x + view0.w || b.x + b.w < view0.x || b.y > view0.y + view0.h || b.y + b.h < view0.y) return;
      paint(ctx, it);
    }

    function draw() {
      resizeIfNeeded();
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const cam = getCam();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.setTransform(cam.z * dpr, 0, 0, cam.z * dpr, cam.x * dpr, cam.y * dpr);
      // видимый мировой прямоугольник
      view0 = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: cw / cam.z, h: ch / cam.z };
      hideText = cam.z < textHideZoom;
      for (const it of getList() || []) paintIfVisible(it);
      for (const it of getOverlay ? getOverlay() || [] : []) paintIfVisible(it);
    }

    function schedule() {
      if (!dirty || scheduled) return;
      scheduled = true;
      raf(() => { scheduled = false; if (dirty) { dirty = false; draw(); } });
    }

    window.addEventListener("resize", () => { dirty = true; schedule(); });

    return {
      invalidate() { dirty = true; schedule(); },
      draw,
      _ctxForTest: () => ctx,
    };
  }

  return Object.freeze({ create });
})();

if (typeof module !== "undefined") module.exports = CanvasView;
