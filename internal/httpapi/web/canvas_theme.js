"use strict";

// CanvasTheme — палитра и метрики канвасного рендера топологии. Значения
// приходят из CSS-переменных страницы (create/fromComputed), поэтому тема
// не рассинхронизируется со стилями. lerpHex нужен для переходов состояний.
const CanvasTheme = (() => {
  const NAMES = ["--panel-bg", "--border", "--accent", "--muted", "--text",
    "--kind-router", "--kind-switch", "--kind-network"];

  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  function create(v) {
    const g = (n, fb) => v[n] || fb;
    return Object.freeze({
      panel: g("--panel-bg", "#f6f6f8"),
      border: g("--border", "#d8d8dc"),
      accent: g("--accent", "#2563eb"),
      muted: g("--muted", "#6b6b6b"),
      text: g("--text", "#1a1a1a"),
      kind: {
        router: g("--kind-router", "#d97706"),
        switch: g("--kind-switch", "#7c3aed"),
        network: g("--kind-network", "#16a34a"),
      },
      radius: { router: 16, switch: 2, default: 6 },
      filteredColor: "#d29922",
      flowOk: "#10b981",
      flowDeny: "#ef4444",
      dimAlpha: 0.35,
      textHideZoom: 0.5,
      fonts: { label: "12px system-ui, sans-serif", sub: "11px system-ui, sans-serif" },
      lerpHex(a, b, t) {
        const ca = hex(a), cb = hex(b);
        const k = Math.min(1, Math.max(0, t));
        const mix = (i) => Math.round(ca[i] + (cb[i] - ca[i]) * k);
        return "#" + mix(0).toString(16).padStart(2, "0") + mix(1).toString(16).padStart(2, "0") + mix(2).toString(16).padStart(2, "0");
      },
    });
  }

  const fromComputed = (style) =>
    create(Object.fromEntries(NAMES.map((n) => [n, style.getPropertyValue(n).trim()])));

  return Object.freeze({ create, fromComputed });
})();

if (typeof module !== "undefined") module.exports = CanvasTheme;
