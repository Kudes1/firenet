"use strict";

const State = {
  topology: { devices: [], links: [], networks: [], unions: [] },
  subnets: [],
  layout: { devices: {}, networks: {} },
  camera: Camera.create(),
  tool: "select",
  selection: new Set(), // device/network/link objects
};

// Topology renders devices/links/networks as an SVG canvas the user builds
// the network on directly. A network is one L2 segment: click a device,
// then a network node, to attach the segment to that device. Subnet
// membership of networks is edited on /ui/subnets and /ui/networks.
const Topology = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEVICE_W = 140;
  const DEVICE_H = 60;
  const NET_W = 160;
  const NET_H = 60;
  const UNION_PAD = 30;
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

  let pending = null; // {device} awaiting a network to attach to
  let saveLayoutTimer = null;
  let viewportG = null;
  let previewWire = null;
  let popoverCreate = null; // callback awaiting a name from the popover
  const canvas = () => document.getElementById("topo-canvas");
  const TOOLS = ["select", "connect", "device", "network"];

  function el(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // screenPoint converts a mouse event into canvas-relative screen coords.
  function screenPoint(e) {
    const r = canvas().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const toWorld = (p) => Camera.screenToWorld(State.camera, p.x, p.y);

  function applyCamera() {
    if (viewportG) viewportG.setAttribute("transform", Camera.transform(State.camera));
  }

  function ensureLayout() {
    State.topology.devices.forEach((d, i) => {
      if (!State.layout.devices[d.name]) {
        State.layout.devices[d.name] = { x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 160 };
      }
    });
    State.topology.networks.forEach((n, i) => {
      if (!State.layout.networks[n.name]) {
        State.layout.networks[n.name] = { x: 40 + (i % 5) * 200, y: 300 + Math.floor(i / 5) * 160 };
      }
    });
  }

  function center(map, name, w, h) {
    const pos = map[name];
    if (!pos) return null;
    return { x: pos.x + w / 2, y: pos.y + h / 2 };
  }
  const deviceCenter = (name) => center(State.layout.devices, name, DEVICE_W, DEVICE_H);
  const netCenter = (name) => center(State.layout.networks, name, NET_W, NET_H);

  // unionBox вычисляет bbox членов объединения в мировых координатах или null,
  // если ни один член не имеет позиции в layout.
  function unionBox(s) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    (s.devices || []).forEach((n) => {
      const p = State.layout.devices[n];
      if (!p) return;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + DEVICE_W); y2 = Math.max(y2, p.y + DEVICE_H);
    });
    (s.networks || []).forEach((n) => {
      const p = State.layout.networks[n];
      if (!p) return;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + NET_W); y2 = Math.max(y2, p.y + NET_H);
    });
    if (x1 === Infinity) return null;
    return { x: x1 - UNION_PAD, y: y1 - UNION_PAD, w: x2 - x1 + 2 * UNION_PAD, h: y2 - y1 + 2 * UNION_PAD };
  }

  function scheduleLayoutSave() {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      Api.put("/api/layout", { ...State.layout, camera: State.camera }).catch(() => {
        /* layout is best-effort presentation state */
      });
    }, 400);
  }

  // setupCamera wires wheel zoom (anchored at the cursor) and pan by
  // middle-button drag; both persist through the debounced layout save.
  function setupCamera() {
    const svg = canvas();
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = screenPoint(e);
      State.camera = Camera.zoomAt(State.camera, p.x, p.y, Math.exp(-e.deltaY * 0.002));
      applyCamera();
      scheduleLayoutSave();
    });
    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      let last = screenPoint(e);
      function onMove(ev) {
        const p = screenPoint(ev);
        State.camera = { ...State.camera, x: State.camera.x + p.x - last.x, y: State.camera.y + p.y - last.y };
        last = p;
        applyCamera();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        scheduleLayoutSave();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // --- context menu ---

  function hideContextMenu() {
    const menu = document.getElementById("topo-context-menu");
    if (menu) menu.hidden = true;
  }

  // Элемент меню — [label, action, cls?] либо {label, children} для подменю.
  // action === null рендерит неактивный пункт.
  function showContextMenu(at, items) {
    const menu = document.getElementById("topo-context-menu");
    menu.innerHTML = "";
    // mkItem: action === null рендерит неактивный пункт, если не передан active
    const mkItem = (label, action, cls, active = !!action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      if (action) {
        if (cls) btn.setAttribute("class", cls);
        btn.onclick = (e) => {
          e.stopPropagation();
          hideContextMenu();
          action();
        };
      }
      if (!active) btn.disabled = true;
      return btn;
    };
    const fill = (parent, entries) => {
      entries.forEach((it) => {
        if (it.children) {
          const wrap = document.createElement("div");
          wrap.setAttribute("class", "ctx-sub");
          const sub = document.createElement("div");
          sub.setAttribute("class", "submenu");
          wrap.append(mkItem(it.label, null, null, true), sub);
          fill(sub, it.children);
          parent.append(wrap);
        } else {
          const [label, action, cls] = it;
          parent.append(mkItem(label, action, cls));
        }
      });
    };
    fill(menu, items);
    menu.hidden = false;
    menu.style.left = at.x + "px";
    menu.style.top = at.y + "px";
  }

  // contextDelete wires right-click on a node element to a menu with the
  // delete action plus union assignment items.
  function contextDelete(elem, obj, label, kind) {
    elem.addEventListener("contextmenu", (e) => {
      if (State.tool !== "select") return;
      e.preventDefault();
      e.stopPropagation();
      const key = kind ? memberKey(kind) : null;
      const items = [];
      if (key && unionIndex(obj.name, key) >= 0) {
        items.push(["Убрать из объединения", () => setUnion(obj.name, key, -1)]);
      }
      if (key) {
        const candidates = (State.topology.unions || [])
          .map((s, i) => [s, i])
          .filter(([s]) => !(s[key] || []).includes(obj.name))
          .map(([s, i]) => ["В объединение «" + s.name + "»", () => setUnion(obj.name, key, i)]);
        items.push({
          label: "Добавить в объединение",
          children: candidates.length ? candidates : [["(нет доступных объединений)", null]],
        });
      }
      items.push(["Удалить " + label, () => {
        State.selection.clear();
        State.selection.add(obj);
        deleteSelection();
        scheduleLayoutSave();
      }, "danger"]);
      showContextMenu(screenPoint(e), items);
    });
  }

  const memberKey = (kind) => (kind === "device" ? "devices" : "networks");

  function unionIndex(name, key) {
    return (State.topology.unions || []).findIndex((s) => (s[key] || []).includes(name));
  }

  // setUnion перемещает объект в объединение idx (или из всех объединений при idx < 0).
  function setUnion(name, key, idx) {
    State.topology.unions.forEach((s) => { s[key] = (s[key] || []).filter((n) => n !== name); });
    if (idx >= 0) {
      const s = State.topology.unions[idx];
      s[key] = [...(s[key] || []), name];
    }
    render();
  }

  // dropMember вычищает имя удалённого объекта из членства объединений.
  function dropMember(name, key) {
    (State.topology.unions || []).forEach((s) => { s[key] = (s[key] || []).filter((n) => n !== name); });
  }


  const clearSelection = () => {
    State.selection.clear();
    render();
  };

  function selectNode(obj, shift) {
    if (shift) State.selection.has(obj) ? State.selection.delete(obj) : State.selection.add(obj);
    else {
      State.selection.clear();
      State.selection.add(obj);
    }
    render();
  }

  // marqueeSelect selects every node whose bbox intersects the screen rect.
  function marqueeSelect(a, b, extend) {
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    const hit = (pos, w, h) => pos.x < x2 && pos.x + w > x1 && pos.y < y2 && pos.y + h > y1;
    if (!extend) State.selection.clear();
    State.topology.devices.forEach((d) => {
      if (hit(State.layout.devices[d.name], DEVICE_W, DEVICE_H)) State.selection.add(d);
    });
    State.topology.networks.forEach((n) => {
      if (hit(State.layout.networks[n.name], NET_W, NET_H)) State.selection.add(n);
    });
    render();
  }

  // deleteSelection drops every selected device/network/link plus any
  // selected attachments ({type:"attach", net, device} entries).
  function deleteSelection() {
    if (!State.selection.size) return;
    State.selection.forEach((s) => {
      if (s && s.type === "attach") s.net.attach = s.net.attach.filter((a) => a.device !== s.device);
    });
    State.topology.devices = State.topology.devices.filter((d) => {
      if (State.selection.has(d)) {
        delete State.layout.devices[d.name];
        dropMember(d.name, "devices");
        return false;
      }
      return true;
    });
    State.topology.networks = State.topology.networks.filter((n) => {
      if (State.selection.has(n)) {
        delete State.layout.networks[n.name];
        dropMember(n.name, "networks");
        return false;
      }
      return true;
    });
    State.topology.links = State.topology.links.filter((l) => !State.selection.has(l));
    clearSelection();
  }

  // setupSelection wires background marquee drag and Del deletion.
  let marqueeEnded = false; // swallows the click a browser fires after a drag
  function setupSelection() {
    const svg = canvas();
    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target !== svg || State.tool !== "select") return;
      marqueeEnded = false;
      let start = screenPoint(e);
      let rect = null;
      function onMove(ev) {
        const p = screenPoint(ev);
        if (!rect) {
          rect = el("rect", { class: "marquee", fill: "none" });
          svg.append(rect);
        }
        rect.setAttribute("x", Math.min(start.x, p.x));
        rect.setAttribute("y", Math.min(start.y, p.y));
        rect.setAttribute("width", Math.abs(p.x - start.x));
        rect.setAttribute("height", Math.abs(p.y - start.y));
      }
      function onUp(ev) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (rect) {
          rect.remove();
          marqueeEnded = true;
          marqueeSelect(toWorld(start), toWorld(screenPoint(ev)), ev.shiftKey);
        }
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    document.addEventListener("keydown", (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && State.selection.size) deleteSelection();
      const shortcuts = { v: "select", c: "connect", d: "device", n: "network" };
      if (shortcuts[e.key]) setTool(shortcuts[e.key]);
    });
  }


  function setTool(tool) {
    State.tool = tool;
    cancelPending();
    hidePopover();
    TOOLS.forEach((t) => {
      const btn = document.getElementById("tool-" + t);
      btn.setAttribute("class", "tool" + (t === tool ? " active" : ""));
    });
  }

  function setupTools() {
    TOOLS.forEach((t) => {
      document.getElementById("tool-" + t).addEventListener("click", () => setTool(t));
    });
    const svg = canvas();
    svg.addEventListener("click", (e) => {
      if (e.target !== svg) return; // node/wire clicks handle themselves
      if (marqueeEnded) { marqueeEnded = false; return; } // click trailing the marquee drag
      if (State.tool === "device" || State.tool === "network") openNodePopover(screenPoint(e), State.tool);
      else {
        cancelPending();
        clearSelection();
      }
    });
  }

  // openNodePopover shows the inline naming form at a screen point; the
  // node is created at the popover click's world position.
  function openNodePopover(at, kind) {
    const box = document.getElementById("node-popover");
    box.hidden = false;
    box.style.left = at.x + "px";
    box.style.top = at.y + "px";
    document.getElementById("node-kind-select").hidden = kind !== "device";
    document.getElementById("node-name-input").focus();
    popoverCreate = (name) => createNode(kind, name, toWorld(at));
  }

  function hidePopover() {
    const box = document.getElementById("node-popover");
    if (!box) return;
    box.hidden = true;
    document.getElementById("node-name-form").reset();
    popoverCreate = null;
  }

  function setupPopover() {
    document.getElementById("node-name-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById("node-name-input").value.trim();
      if (popoverCreate && name) popoverCreate(name);
      hidePopover();
    });
    document.getElementById("node-name-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") hidePopover();
    });
  }

  function createNode(kind, name, world) {
    if (kind === "device") {
      const nodeKind = document.getElementById("node-kind-select").value || "router";
      if (State.topology.devices.some((d) => d.name === name)) return showBanner(`Устройство ${name} уже существует`);
      State.topology.devices.push({ name, kind: nodeKind });
      State.layout.devices[name] = { x: world.x - DEVICE_W / 2, y: world.y - DEVICE_H / 2 };
    } else {
      if (State.topology.networks.some((n) => n.name === name)) return showBanner(`Сеть ${name} уже существует`);
      State.topology.networks.push({ name, subnets: [], attach: [] });
      State.layout.networks[name] = { x: world.x - NET_W / 2, y: world.y - NET_H / 2 };
    }
    setTool("select");
    render();
  }

  function makeDraggable(node, kind, obj, onPlainClick) {
    node.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const start = screenPoint(e);
      const group = [];
      const addObj = (o) => {
        if (State.topology.devices.includes(o)) {
          const pos = State.layout.devices[o.name];
          if (pos) group.push({ map: State.layout.devices, name: o.name, pos: { ...pos } });
        } else if (State.topology.networks.includes(o)) {
          const pos = State.layout.networks[o.name];
          if (pos) group.push({ map: State.layout.networks, name: o.name, pos: { ...pos } });
        }
      };
      if (State.selection.has(obj)) State.selection.forEach(addObj);
      else addObj(obj);
      let moved = false;

      function onMove(ev) {
        const p = screenPoint(ev);
        const w = toWorld(p);
        const o = toWorld(start);
        const dx = w.x - o.x;
        const dy = w.y - o.y;
        if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) moved = true;
        group.forEach((g) => { g.map[g.name] = { x: g.pos.x + dx, y: g.pos.y + dy }; });
        render();
      }
      function onUp(ev) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) scheduleLayoutSave();
        else if (onPlainClick) onPlainClick(ev);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function cancelPending() {
    pending = null;
    if (previewWire) {
      previewWire.remove();
      previewWire = null;
    }
    render();
  }

  // setupConnectPreview draws a dashed line from the pending device to the
  // cursor while the connect tool awaits the second endpoint.
  function setupConnectPreview() {
    canvas().addEventListener("mousemove", (e) => {
      const want = pending && State.tool === "connect";
      if (want) {
        const from = deviceCenter(pending.device);
        const to = toWorld(screenPoint(e));
        if (from) {
          if (!previewWire) {
            previewWire = el("path", { class: "wire-preview", fill: "none" });
            viewportG.append(previewWire);
          }
          previewWire.setAttribute("d", `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
        }
      } else if (previewWire) {
        previewWire.remove();
        previewWire = null;
      }
    });
  }

  function onDeviceConnect(device) {
    if (!pending) {
      pending = { device };
      render();
      return;
    }
    if (pending.device === device) {
      cancelPending();
      return;
    }
    const [a, b] = [pending.device, device].sort();
    if (State.topology.links.some((l) => [l.a.device, l.b.device].sort().join("|") === `${a}|${b}`)) {
      showBanner(`Устройства ${a} и ${b} уже соединены`);
      cancelPending();
      return;
    }
    State.topology.links.push({ a: { device: pending.device }, b: { device } });
    cancelPending();
  }

  function onNetworkClick(netName) {
    if (!pending) return;
    const net = State.topology.networks.find((n) => n.name === netName);
    net.attach = net.attach || [];
    if (net.attach.some((a) => a.device === pending.device)) {
      showBanner(`Сеть ${netName} уже подключена к ${pending.device}`);
      cancelPending();
      return;
    }
    net.attach.push({ device: pending.device });
    cancelPending();
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

  // selectWire wires click-selection and right-click delete for a wire;
  // links and attachments are only deletable through selection.
  function selectWire(wire, obj, label) {
    wire.onclick = (e) => {
      e.stopPropagation();
      if (State.tool === "select") selectNode(obj, e.shiftKey);
    };
    contextDelete(wire, obj, label);
  }

  const attachSel = (net, device) => ({ type: "attach", net, device });
  const attachSelected = (n, device) =>
    [...State.selection].some((s) => s.type === "attach" && s.net === n && s.device === device);

  function render() {
    ensureLayout();
    const svg = canvas();
    svg.innerHTML = "";
    previewWire = null;
    viewportG = el("g", { class: "viewport", transform: Camera.transform(State.camera) });
    svg.append(viewportG);

    // union frames sit at the very back, behind wires and nodes
    (State.topology.unions || []).forEach((s, i) => {
      const box = unionBox(s);
      if (!box) return;
      const color = UNION_COLORS[i % UNION_COLORS.length];
      viewportG.append(el("rect", {
        class: "union-frame", "data-union": s.name,
        x: box.x, y: box.y, width: box.w, height: box.h, rx: 14,
        fill: color, "fill-opacity": 0.07, stroke: color, "stroke-opacity": 0.5,
      }));
      viewportG.append(el("text", { class: "union-label", x: box.x + 12, y: box.y - 8, fill: color }, s.name));
    });

    // device-to-device links; each visible wire gets an invisible wide
    // "wire-hit" twin so the capture zone is much larger than the 1.5px line
    const offsets = linkOffsets(State.topology.links);
    State.topology.links.forEach((l, i) => {
      const pa = deviceCenter(l.a.device);
      const pb = deviceCenter(l.b.device);
      if (!pa || !pb) return;
      const mid = pointAt(pa, pb, 0.5, spreadOffset(offsets[i]));
      const d = `M ${pa.x} ${pa.y} Q ${mid.x} ${mid.y} ${pb.x} ${pb.y}`;
      const wire = el("path", {
        class: "wire" + (l.filter ? " wire-filtered" : "") + (State.selection.has(l) ? " selected" : ""), d, fill: "none",
      });
      viewportG.append(wire);
      if (l.filter) {
        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        const side = (xs) => (xs || []).join(", ") || "ничего";
        t.textContent = `${side(l.filter.aExports)} → ${side(l.filter.bExports)}`;
        wire.append(t);
      }
      const hit = el("path", { class: "wire-hit", d, fill: "none" });
      selectWire(hit, l, (l.filter ? "фильтрованная связь " : "связь ") + l.a.device + "–" + l.b.device);
      viewportG.append(hit);
    });

    // network attachments (device -> network segment)
    State.topology.networks.forEach((n) => {
      (n.attach || []).forEach((a) => {
        const pa = deviceCenter(a.device);
        const c = netCenter(n.name);
        if (!pa || !c) return;
        const coords = { x1: pa.x, y1: pa.y, x2: c.x, y2: c.y };
        const line = el("line", {
          class: "wire" + (attachSelected(n, a.device) ? " selected" : ""), ...coords,
        });
        viewportG.append(line);
        const hit = el("line", { class: "wire-hit", ...coords });
        selectWire(hit, attachSel(n, a.device), `привязка ${n.name}–${a.device}`);
        viewportG.append(hit);
      });
    });

    // devices
    State.topology.devices.forEach((d) => {
      const pos = State.layout.devices[d.name];

      const kind = KINDS[d.kind] || { rx: 6 };
      const isPending = pending && pending.device === d.name;
      const rect = el("rect", {
        class: "node-rect " + d.kind + (isPending ? " pending" : "") + (State.selection.has(d) ? " selected" : ""),
        x: pos.x, y: pos.y, width: DEVICE_W, height: DEVICE_H, rx: kind.rx,
      });
      makeDraggable(rect, "device", d, (ev) => {
        if (State.tool === "connect") onDeviceConnect(d.name);
        else if (State.tool === "select") selectNode(d, ev.shiftKey);
      });
      contextDelete(rect, d, "устройство " + d.name, "device");
      viewportG.append(rect);
      if (kind.glyph) {
        viewportG.append(el("path", {
          class: "node-glyph " + d.kind,
          d: kind.glyph,
          transform: `translate(${pos.x + 8} ${pos.y + 8})`,
        }));
        viewportG.append(el("text", { class: "node-label", x: pos.x + 24, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      } else {
        viewportG.append(el("text", { class: "node-label", x: pos.x + 8, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      }
    });

    // networks
    State.topology.networks.forEach((n) => {
      const pos = State.layout.networks[n.name];

      const shape = el("path", {
        class: "subnet-rect" + (State.selection.has(n) ? " selected" : ""),
        d: cloudPath(pos.x, pos.y, NET_W, NET_H),
      });
      makeDraggable(shape, "network", n, (ev) => {
        if (State.tool === "connect") onNetworkClick(n.name);
        else if (State.tool === "select") selectNode(n, ev.shiftKey);
      });
      contextDelete(shape, n, "сеть " + n.name, "network");
      viewportG.append(shape);
      viewportG.append(el("text", { class: "subnet-label", x: pos.x + 8, y: pos.y + 18 }, n.name));

      const members = (n.subnets || []).map((s) => State.subnets.find((x) => x.name === s)).filter(Boolean);
      const subtitle = members.length ? members.map((s) => s.cidr).join(", ") : "(нет подсетей)";
      viewportG.append(el("text", { class: "link-label-text", x: pos.x + 8, y: pos.y + 36 }, subtitle.slice(0, 24)));
    });

    // trash button mirrors the selection state
    document.getElementById("topo-delete").disabled = !State.selection.size;
  }

  // setupDeleteButton wires the trash button: nodes and networks confirm
  // by name (links/attachments delete silently), then selection is dropped.
  function setupDeleteButton() {
    document.getElementById("topo-delete").addEventListener("click", () => {
      const named = [
        ...State.topology.devices.filter((d) => State.selection.has(d)).map((d) => "устройство " + d.name),
        ...State.topology.networks.filter((n) => State.selection.has(n)).map((n) => "сеть " + n.name),
      ];
      if (named.length && !confirm("Удалить " + named.join(", ") + "?")) return;
      deleteSelection();
    });
  }

  function setupForms() {
    DirtyGuard.arm(() => State.topology);
    document.getElementById("topo-save").addEventListener("click", async () => {
      try {
        State.topology = await Api.put("/api/topology", State.topology);
        showBanner("Топология сохранена", "ok");
        DirtyGuard.markClean();
        render();
      } catch (e) {
        showBanner("Ошибка сохранения топологии: " + e.message);
      }
    });
  }

  async function boot() {
    try {
      const [topo, subnetsDoc] = await Promise.all([Api.get("/api/topology"), Api.get("/api/subnets")]);
      State.topology = topo;
      State.subnets = subnetsDoc.subnets || [];
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    try {
      const layout = await Api.get("/api/layout");
      State.layout = { devices: layout.devices || {}, networks: layout.networks || layout.subnets || {} };
      State.camera = layout.camera && layout.camera.z > 0 ? { ...Camera.create(), ...layout.camera } : Camera.create();
    } catch {
      State.layout = { devices: {}, networks: {} };
    }
    setupForms();
    setupCamera();
    setupTools();
    setupSelection();
    setupDeleteButton();
    setupConnectPreview();
    setupPopover();
    document.addEventListener("click", hideContextMenu);
    setTool("select");
    Topology.render();
  }

  const Topology = {
    render,
    boot,
  };
  return Topology;
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", Topology.boot);
} else {
  Topology.boot();
}
