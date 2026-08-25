"use strict";

// TopoScene — сборка display list сцены топологии: рамки объединений, связи,
// привязки сетей, устройства и сети-облака. Используется редактором
// (topology.js) и read-only картой симуляции (simulate.js). Взаимодействие
// (drag/select/context) страница подключает сама через opts.hook, классы
// оформления — через opts.classes, приглушение элементов — через opts.dim.
const TopoScene = (() => {
  const { DEVICE_W, DEVICE_H, NET_W, NET_H, KINDS, center, linkOffsets, spreadOffset, pointAt, cloudSegs, UNION_COLORS } = NetMap;
  const UNION_PAD = 30;

  // nameSummary joins names into "a, b" or, when the list exceeds max
  // chars, "a, b +2" with the hidden count
  function nameSummary(names, max = 24) {
    let acc = "";
    for (let i = 0; i < names.length; i++) {
      const next = acc ? `${acc}, ${names[i]}` : names[i];
      if (next.length <= max || i === names.length - 1) { acc = next; continue; }
      return `${acc} +${names.length - i}`;
    }
    return acc;
  }

  // ensureLayout даёт каждому устройству и сети позицию по умолчанию,
  // если в layout её ещё нет.
  function ensureLayout(topology, layout) {
    topology.devices.forEach((d, i) => {
      if (!layout.devices[d.name]) layout.devices[d.name] = { x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 160 };
    });
    topology.networks.forEach((n, i) => {
      if (!layout.networks[n.name]) layout.networks[n.name] = { x: 40 + (i % 5) * 200, y: 300 + Math.floor(i / 5) * 160 };
    });
  }

  // unionBox вычисляет bbox членов объединения в мировых координатах или null,
  // если ни один член не имеет позиции в layout.
  function unionBox(s, layout) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    (s.devices || []).forEach((n) => {
      const p = layout.devices[n];
      if (!p) return;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + DEVICE_W); y2 = Math.max(y2, p.y + DEVICE_H);
    });
    (s.networks || []).forEach((n) => {
      const p = layout.networks[n];
      if (!p) return;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + NET_W); y2 = Math.max(y2, p.y + NET_H);
    });
    if (x1 === Infinity) return null;
    return { x: x1 - UNION_PAD, y: y1 - UNION_PAD, w: x2 - x1 + 2 * UNION_PAD, h: y2 - y1 + 2 * UNION_PAD };
  }

  // buildScene собирает display list сцены для канвасного рендера: слои
  // unions → links → attaches → devices → networks в виде примитивов
  // {kind, id, ref, geom, style, ...}.
  // opts: theme (CanvasTheme), classes/mark/dim — состояния элементов; fade —
  // групповые коэффициенты переходов {dim, flow}; popOf(id) — прогресс
  // появления узла; item(kind, it) — хук обогащения элементов.
  const TOKENS = (str) => String(str || "").split(/\s+/).filter(Boolean);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  // styled применяет состояния к базовому стилю по правилам спецификации:
  // selected/pending → accent; search-hit → glow; sim-flow-* → лерп цвета и
  // ширины по fade.flow; search-dim|sim-dim → alpha по fade.dim.
  // Служебный признак связи (base.wire) тратится на ширину flow-подсветки
  // и в итоговый стиль не выходит.
  function styled(base, states, theme, fade) {
    const { wire, ...pub } = base;
    const st = { ...pub };
    if (states.has("selected")) { st.stroke = theme.accent; st.lineWidth = 2.5; }
    if (states.has("pending")) { st.stroke = theme.accent; st.lineWidth = 3; }
    if (states.has("search-hit")) st.glow = { color: theme.accent, blur: 8 };
    const flow = states.has("sim-flow-ok") ? theme.flowOk : states.has("sim-flow-deny") ? theme.flowDeny : null;
    // flow красит только контуры; у подписей stroke нет
    if (flow && base.stroke) {
      const k = fade?.flow ?? 1;
      st.stroke = theme.lerpHex(base.stroke, flow, k);
      st.lineWidth = pub.lineWidth + ((wire ? 4 : 2.5) - pub.lineWidth) * k;
      if (k > 0.05) st.glow = { color: flow, blur: 4 * k };
    }
    // дефолты fade.* = 1: если страница не анимирует переход, эффект
    // состояния применён полностью; fade:{dim:0} — стартовая точка твина
    if (states.has("search-dim") || states.has("sim-dim"))
      st.alpha = (st.alpha ?? 1) * (1 + (theme.dimAlpha - 1) * (fade?.dim ?? 1));
    return st;
  }

  function buildScene(scene, opts = {}) {
    const { topology, subnets, layout } = scene;
    const theme = opts.theme;
    const fade = opts.fade || {};
    const deviceCenter = (name) => center(layout.devices, name, DEVICE_W, DEVICE_H);
    const netCenter = (name) => center(layout.networks, name, NET_W, NET_H);
    const list = [];
    const emit = (kind, id, ref, geom, base, fields = {}, part = "shape") => {
      const it = { kind, id, ref, geom, style: styled(base, new Set([
        ...TOKENS(opts.classes && opts.classes(ref, part)),
        ...TOKENS(opts.mark && opts.mark(ref)),
        ...(opts.dim && opts.dim(ref) ? ["sim-dim"] : []),
      ]), theme, fade), ...fields };
      if (opts.item) opts.item(kind, it);
      list.push(it);
      return it;
    };
    // popOf: масштаб-фейд узла вокруг центра; s от 0.7 до 1, alpha = p
    const popParams = (id) => {
      const p = opts.popOf && opts.popOf(id);
      return p === undefined || p >= 1 ? null : { s: 0.7 + 0.3 * easeOutCubic(p), a: p };
    };
    const shrinkBox = (g, s, cx, cy) => ({ x: cx - ((cx - g.x) * s), y: cy - ((cy - g.y) * s), w: g.w * s, h: g.h * s });
    const nearPt = (pt, s, cx, cy) => ({ x: cx + (pt.x - cx) * s, y: cy + (pt.y - cy) * s });

    (topology.unions || []).forEach((s, i) => {
      const box = unionBox(s, layout);
      if (!box) return;
      const color = UNION_COLORS[i % UNION_COLORS.length];
      emit("rrect", `union:${s.name}`, s,
        { x: box.x, y: box.y, w: box.w, h: box.h, r: 14 },
        { fill: color, fillAlpha: 0.07, stroke: color, strokeAlpha: 0.5, lineWidth: 1 });
      emit("text", `union:${s.name}:label`, s,
        { x: box.x + 12, y: box.y - 8, w: s.name.length * 6.5 }, { fill: color }, { text: s.name }, "inner");
    });

    const offsets = linkOffsets(topology.links);
    const side = (xs) => (xs || []).join(", ") || "ничего";
    topology.links.forEach((l, i) => {
      const pa = deviceCenter(l.a.device);
      const pb = deviceCenter(l.b.device);
      if (!pa || !pb) return;
      const mid = pointAt(pa, pb, 0.5, spreadOffset(offsets[i]));
      const base = { stroke: l.filter ? theme.filteredColor : theme.muted, lineWidth: 1.5, wire: true };
      if (l.filter) base.dash = [6, 4];
      emit("path", `link:${[l.a.device, l.b.device].sort().join("|")}`, l,
        { segs: [{ x1: pa.x, y1: pa.y, cx: mid.x, cy: mid.y, x2: pb.x, y2: pb.y }] }, base,
        { pick: true, ...(l.filter ? { meta: { tooltip: `${side(l.filter.aExports)} → ${side(l.filter.bExports)}` } } : {}) });
    });

    topology.networks.forEach((n) => {
      (n.attach || []).forEach((a) => {
        const pa = deviceCenter(a.device);
        const c = netCenter(n.name);
        if (!pa || !c) return;
        emit("path", `attach:${n.name}|${a.device}`, { type: "attach", net: n, device: a.device },
          { segs: [{ x1: pa.x, y1: pa.y, cx: (pa.x + c.x) / 2, cy: (pa.y + c.y) / 2, x2: c.x, y2: c.y }] },
          { stroke: theme.muted, lineWidth: 1.5, wire: true }, { pick: true });
      });
    });

    topology.devices.forEach((d) => {
      const pos = layout.devices[d.name];
      if (!pos) return;
      const kind = KINDS[d.kind] || {};
      const stroke = theme.kind[d.kind] || theme.border;
      const pop = popParams(`device:${d.name}`);
      const cx = pos.x + DEVICE_W / 2, cy = pos.y + DEVICE_H / 2;
      const geom = { x: pos.x, y: pos.y, w: DEVICE_W, h: DEVICE_H, r: theme.radius[d.kind] ?? theme.radius.default };
      const labelX = pos.x + (kind.glyph ? 24 : 8);
      const shapeStyle = emit("rrect", `device:${d.name}`, d,
        pop ? shrinkBox(geom, pop.s, cx, cy) : geom,
        { fill: theme.panel, stroke, lineWidth: 1.5 }, { nodeType: "device", pick: true }).style;
      if (pop) shapeStyle.alpha = (shapeStyle.alpha ?? 1) * pop.a;
      const inner = (kind, id, geom2, base, fields) => {
        const st = emit(kind, id, d, geom2, base, fields, "inner").style;
        if (pop) st.alpha = (st.alpha ?? 1) * pop.a;
      };
      if (kind.glyph) {
        const g = nearPt({ x: pos.x + 8, y: pos.y + 8 }, pop ? pop.s : 1, cx, cy);
        inner("glyph", `device:${d.name}:glyph`, { d: kind.glyph, x: g.x, y: g.y }, { stroke, lineWidth: 1.6 }, {});
      }
      const t = nearPt({ x: labelX, y: pos.y + 18 }, pop ? pop.s : 1, cx, cy);
      const text = `${d.name} (${d.kind})`;
      inner("text", `device:${d.name}:label`, { x: t.x, y: t.y, w: text.length * 6.5 }, { fill: theme.text }, { text });
    });

    topology.networks.forEach((n) => {
      const pos = layout.networks[n.name];
      if (!pos) return;
      const pop = popParams(`network:${n.name}`);
      const cx = pos.x + NET_W / 2, cy = pos.y + NET_H / 2;
      let segs = cloudSegs(pos.x, pos.y, NET_W, NET_H);
      if (pop) segs = segs.map((g) => ({
        x1: cx + (g.x1 - cx) * pop.s, y1: cy + (g.y1 - cy) * pop.s,
        cx: cx + (g.cx - cx) * pop.s, cy: cy + (g.cy - cy) * pop.s,
        x2: cx + (g.x2 - cx) * pop.s, y2: cy + (g.y2 - cy) * pop.s,
      }));
      const shapeStyle = emit("path", `network:${n.name}`, n, { segs, closed: true },
        { fill: theme.panel, stroke: theme.kind.network, lineWidth: 1.5 },
        { nodeType: "network", pick: true }).style;
      if (pop) shapeStyle.alpha = (shapeStyle.alpha ?? 1) * pop.a;
      const labels = [
        [`network:${n.name}:label`, n.name, pos.x + 8, pos.y + 18, theme.text],
      ];
      const members = (n.subnets || []).map((s) => subnets.find((x) => x.name === s)).filter(Boolean);
      const subtitle = members.length ? nameSummary(members.map((s) => s.name)) : "(нет подсетей)";
      labels.push([`network:${n.name}:sub`, subtitle, pos.x + 8, pos.y + 36, theme.muted]);
      labels.forEach(([id, text, x, y, fill]) => {
        const pt = nearPt({ x, y }, pop ? pop.s : 1, cx, cy);
        const st = emit("text", id, n, { x: pt.x, y: pt.y, w: text.length * 6.5 }, { fill }, { text }, "inner").style;
        if (pop) st.alpha = (st.alpha ?? 1) * pop.a;
      });
    });

    return { list };
  }

  // bounds — bbox всей сцены по раскладке (как worldBounds в simulate.js),
  // null без позиций.
  function bounds(topology, layout) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (p, w, h) => {
      if (!p) return;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    };
    (topology.devices || []).forEach((d) => grow(layout.devices[d.name], DEVICE_W, DEVICE_H));
    (topology.networks || []).forEach((n) => grow(layout.networks[n.name], NET_W, NET_H));
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  return Object.freeze({ ensureLayout, buildScene, bounds });
})();
