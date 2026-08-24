"use strict";

// TopoScene — общая отрисовка сцены топологии: рамки объединений, связи,
// привязки сетей, устройства и сети-облака. Используется редактором
// (topology.js) и read-only картой симуляции (simulate.js). Взаимодействие
// (drag/select/context) страница подключает сама через opts.hook, классы
// оформления — через opts.classes, приглушение элементов — через opts.dim.
const TopoScene = (() => {
  const { SVG_NS, DEVICE_W, DEVICE_H, NET_W, NET_H, UNION_COLORS, KINDS, el, center, linkOffsets, spreadOffset, pointAt } = NetMap;
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

  // cloudPath outlines an L2 segment as a tldraw-style cloud filling the
  // whole w×h bbox: a rectangle perimeter whose edges bulge outward in
  // bumps (quadratic curves), so labels stay inside the shape.
  function cloudPath(x, y, w, h) {
    const depth = 6;
    const HBUMPS = 7; // bumps per horizontal edge
    const VBUMPS = 3; // bumps per vertical edge
    const pts = [[x, y]];
    // edge appends n interior points plus the segment end (clockwise)
    const edge = (x1, y1, x2, y2, n) => {
      for (let i = 1; i <= n + 1; i++) pts.push([x1 + ((x2 - x1) * i) / (n + 1), y1 + ((y2 - y1) * i) / (n + 1)]);
    };
    edge(x, y, x + w, y, HBUMPS);
    edge(x + w, y, x + w, y + h, VBUMPS);
    edge(x + w, y + h, x, y + h, HBUMPS);
    // left side: only its bump midpoints, walked bottom-up to match the
    // clockwise traversal — the curve loops back to pts[0]
    for (let i = VBUMPS; i >= 1; i--) pts.push([x, y + (h * i) / (VBUMPS + 1)]);
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      d += ` Q ${ax + dx / 2 + (dy / len) * depth} ${ay + dy / 2 + (-dx / len) * depth} ${bx} ${by}`;
    }
    return d + " Z";
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

  // render рисует сцену scene = { topology, subnets, layout } в viewportG.
  // opts:
//   classes(obj, part)   — суффикс класса оформления; part: "shape" для
//                          контура узла, "inner" для подписей и глифов;
//   mark(obj)            — класс состояния элемента (например, разметка
//                          движения трафика на карте симуляции);
//   dim(obj)             — true, если элемент рисуется приглушённым;
  //   hook(kind, elem, obj)— интерактив страницы; kind: "device",
  //                          "network", "wire", "attach". Без хука элементы
  //                          не получают кликовых двойников (read-only).
  function render(viewportG, scene, opts = {}) {
    const { topology, subnets, layout } = scene;
    const classes = opts.classes || (() => "");
    const marked = (obj) => (opts.mark ? ` ${opts.mark(obj)}` : "");
    const dimmed = (obj) => (opts.dim && opts.dim(obj) ? " sim-dim" : "");
    const deviceCenter = (name) => center(layout.devices, name, DEVICE_W, DEVICE_H);
    const netCenter = (name) => center(layout.networks, name, NET_W, NET_H);

    // union frames sit at the very back, behind wires and nodes
    (topology.unions || []).forEach((s, i) => {
      const box = unionBox(s, layout);
      if (!box) return;
      const color = UNION_COLORS[i % UNION_COLORS.length];
      viewportG.append(el("rect", {
        class: "union-frame" + classes(s, "inner") + marked(s) + dimmed(s), "data-union": s.name,
        x: box.x, y: box.y, width: box.w, height: box.h, rx: 14,
        fill: color, "fill-opacity": 0.07, stroke: color, "stroke-opacity": 0.5,
      }));
      viewportG.append(el("text", { class: "union-label" + classes(s, "inner") + marked(s) + dimmed(s), x: box.x + 12, y: box.y - 8, fill: color }, s.name));
    });

    // device-to-device links; each interactive wire gets an invisible wide
    // "wire-hit" twin so the capture zone is much larger than the 1.5px line
    const offsets = linkOffsets(topology.links);
    topology.links.forEach((l, i) => {
      const pa = deviceCenter(l.a.device);
      const pb = deviceCenter(l.b.device);
      if (!pa || !pb) return;
      const mid = pointAt(pa, pb, 0.5, spreadOffset(offsets[i]));
      const d = `M ${pa.x} ${pa.y} Q ${mid.x} ${mid.y} ${pb.x} ${pb.y}`;
      const wire = el("path", {
        class: "wire" + (l.filter ? " wire-filtered" : "") + classes(l, "shape") + marked(l) + dimmed(l), d, fill: "none",
      });
      viewportG.append(wire);
      if (l.filter) {
        const t = document.createElementNS(SVG_NS, "title");
        const side = (xs) => (xs || []).join(", ") || "ничего";
        t.textContent = `${side(l.filter.aExports)} → ${side(l.filter.bExports)}`;
        wire.append(t);
      }
      if (opts.hook) {
        const hit = el("path", { class: "wire-hit", d, fill: "none" });
        opts.hook("wire", hit, l);
        viewportG.append(hit);
      }
    });

    // network attachments (device -> network segment)
    topology.networks.forEach((n) => {
      (n.attach || []).forEach((a) => {
        const pa = deviceCenter(a.device);
        const c = netCenter(n.name);
        if (!pa || !c) return;
        const coords = { x1: pa.x, y1: pa.y, x2: c.x, y2: c.y };
        const obj = { type: "attach", net: n, device: a.device };
        viewportG.append(el("line", { class: "wire" + classes(obj, "shape") + marked(obj) + dimmed(obj), ...coords }));
        if (opts.hook) {
          const hit = el("line", { class: "wire-hit", ...coords });
          opts.hook("attach", hit, obj);
          viewportG.append(hit);
        }
      });
    });

    // devices
    topology.devices.forEach((d) => {
      const pos = layout.devices[d.name];
      const kind = KINDS[d.kind] || { rx: 6 };
      const rect = el("rect", {
        class: "node-rect " + d.kind + classes(d, "shape") + marked(d) + dimmed(d),
        x: pos.x, y: pos.y, width: DEVICE_W, height: DEVICE_H, rx: kind.rx,
      });
      if (opts.hook) opts.hook("device", rect, d);
      viewportG.append(rect);
      if (kind.glyph) {
        viewportG.append(el("path", {
          class: "node-glyph " + d.kind + classes(d, "inner") + dimmed(d),
          d: kind.glyph,
          transform: `translate(${pos.x + 8} ${pos.y + 8})`,
        }));
        viewportG.append(el("text", { class: "node-label" + classes(d, "inner") + dimmed(d), x: pos.x + 24, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      } else {
        viewportG.append(el("text", { class: "node-label" + classes(d, "inner") + dimmed(d), x: pos.x + 8, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      }
    });

    // networks
    topology.networks.forEach((n) => {
      const pos = layout.networks[n.name];
      const shape = el("path", {
        class: "subnet-rect" + classes(n, "shape") + marked(n) + dimmed(n),
        d: cloudPath(pos.x, pos.y, NET_W, NET_H),
      });
      if (opts.hook) opts.hook("network", shape, n);
      viewportG.append(shape);
      viewportG.append(el("text", { class: "subnet-label" + classes(n, "inner") + dimmed(n), x: pos.x + 8, y: pos.y + 18 }, n.name));

      const members = (n.subnets || []).map((s) => subnets.find((x) => x.name === s)).filter(Boolean);
      const subtitle = members.length ? nameSummary(members.map((s) => s.name)) : "(нет подсетей)";
      viewportG.append(el("text", { class: "link-label-text" + classes(n, "inner") + dimmed(n), x: pos.x + 8, y: pos.y + 36 }, subtitle));
    });
  }

  return Object.freeze({ ensureLayout, render });
})();
