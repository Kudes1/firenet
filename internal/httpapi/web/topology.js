"use strict";

// Topology renders devices/subnets/links as an SVG canvas the user builds
// the network on directly, instead of hand-editing {device, interface}
// pairs in YAML. Connections are logical (device-to-device, device-to-
// subnet) — an interface is an optional free-text label you can attach to
// either end for documentation, never a prerequisite for wiring things up.
// Node positions have no meaning to firenet's domain model (topology.yaml
// has no such field) so they live only in State.layout, persisted via
// /api/layout.
const Topology = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEVICE_W = 140;
  const DEVICE_H = 60;
  const SUBNET_W = 160;
  const SUBNET_H = 50;
  const LABEL_R = 5;

  let pending = null; // {device} awaiting a second endpoint
  let saveLayoutTimer = null;

  function el(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function ensureLayout() {
    State.topology.devices.forEach((d, i) => {
      if (!State.layout.devices[d.name]) {
        State.layout.devices[d.name] = { x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 160 };
      }
    });
    State.topology.subnets.forEach((s, i) => {
      if (!State.layout.subnets[s.name]) {
        State.layout.subnets[s.name] = { x: 40 + (i % 5) * 200, y: 300 + Math.floor(i / 5) * 140 };
      }
    });
  }

  function deviceCenter(name) {
    const pos = State.layout.devices[name];
    if (!pos) return null;
    return { x: pos.x + DEVICE_W / 2, y: pos.y + DEVICE_H / 2 };
  }

  function subnetCenter(name) {
    const pos = State.layout.subnets[name];
    if (!pos) return null;
    return { x: pos.x + SUBNET_W / 2, y: pos.y + SUBNET_H / 2 };
  }

  // pointAt returns the point a fraction t along the segment a->b, offset
  // perpendicular to the segment by `offset` pixels (used to fan out
  // parallel links between the same device pair so they don't overlap).
  function pointAt(a, b, t, offset) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * offset;
    const ny = (dx / len) * offset;
    return { x: a.x + dx * t + nx, y: a.y + dy * t + ny };
  }

  // labelNear places an endpoint's interface-label point a fixed distance
  // out from `from` towards `to` (clamped for short links) rather than a
  // fraction of the whole segment, so it lands just outside the device box
  // instead of underneath it (device boxes render on top and would
  // otherwise swallow the click).
  const LABEL_DIST = DEVICE_W / 2 + 14;
  function labelNear(from, to, offset) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const dist = Math.min(LABEL_DIST, len * 0.42);
    const ux = dx / len;
    const uy = dy / len;
    return { x: from.x + ux * dist + -uy * offset, y: from.y + uy * dist + ux * offset };
  }

  function scheduleLayoutSave() {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      Api.put("/api/layout", State.layout).catch(() => {
        /* layout is best-effort presentation state, not worth alarming the user over */
      });
    }, 400);
  }

  function makeDraggable(node, kind, name, onPlainClick) {
    node.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const layoutMap = kind === "device" ? State.layout.devices : State.layout.subnets;
      const origin = { ...layoutMap[name] };
      let moved = false;

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        layoutMap[name] = { x: Math.max(0, origin.x + dx), y: Math.max(0, origin.y + dy) };
        render();
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) scheduleLayoutSave();
        else if (onPlainClick) onPlainClick();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function cancelPending() {
    pending = null;
    render();
  }

  function onDeviceClick(device) {
    if (!pending) {
      pending = { device };
      render();
      return;
    }
    if (pending.device === device) {
      cancelPending();
      return;
    }
    State.topology.links.push({ a: { device: pending.device }, b: { device } });
    cancelPending();
  }

  function onSubnetClick(subnetName) {
    if (!pending) return;
    const subnet = State.topology.subnets.find((s) => s.name === subnetName);
    subnet.attach = subnet.attach || [];
    subnet.attach.push({ device: pending.device });
    cancelPending();
  }

  function editLabel(endpoint) {
    const value = prompt("Метка интерфейса (необязательно):", endpoint.interface || "");
    if (value === null) return; // cancelled
    if (value.trim()) endpoint.interface = value.trim();
    else delete endpoint.interface;
    render();
  }

  function removeDevice(name) {
    State.topology.devices = State.topology.devices.filter((d) => d.name !== name);
    State.topology.links = State.topology.links.filter((l) => l.a.device !== name && l.b.device !== name);
    State.topology.subnets.forEach((s) => {
      s.attach = (s.attach || []).filter((a) => a.device !== name);
    });
    delete State.layout.devices[name];
    render();
  }

  function removeSubnet(name) {
    State.topology.subnets = State.topology.subnets.filter((s) => s.name !== name);
    State.topology.zones.forEach((z) => {
      z.subnets = (z.subnets || []).filter((s) => s !== name);
    });
    delete State.layout.subnets[name];
    render();
  }

  function removeLink(index) {
    State.topology.links.splice(index, 1);
    render();
  }

  function removeAttach(subnetName, index) {
    const subnet = State.topology.subnets.find((s) => s.name === subnetName);
    subnet.attach.splice(index, 1);
    render();
  }

  function removeZone(name) {
    State.topology.zones = State.topology.zones.filter((z) => z.name !== name);
    State.topology.zones.forEach((z) => {
      z.zones = (z.zones || []).filter((zz) => zz !== name);
    });
    renderZones();
  }

  // detectZoneCycle ports internal/topology's ResolveZone visiting-set DFS
  // to JS, so a cycle introduced by a checkbox toggle is caught immediately
  // instead of only surfacing as a save-time server error.
  function detectZoneCycle(zones) {
    const byName = Object.fromEntries(zones.map((z) => [z.name, z]));
    const state = {};
    let cycleAt = null;
    function visit(name) {
      if (cycleAt || state[name] === 2) return;
      if (state[name] === 1) {
        cycleAt = name;
        return;
      }
      const z = byName[name];
      if (!z) return;
      state[name] = 1;
      (z.zones || []).forEach(visit);
      state[name] = 2;
    }
    zones.forEach((z) => visit(z.name));
    return cycleAt;
  }

  function toggleZoneMember(zone, kind, name, checked) {
    const key = kind === "zone" ? "zones" : "subnets";
    const before = [...(zone[key] || [])];
    zone[key] = checked ? [...before, name] : before.filter((n) => n !== name);
    if (kind === "zone") {
      const cycle = detectZoneCycle(State.topology.zones);
      if (cycle) {
        zone[key] = before; // revert
        showBanner(`Это создаст цикл в зонах (через ${cycle})`);
      }
    }
    renderZones();
  }

  // ipv4CidrOverlap is a best-effort client-side hint for the same check
  // internal/topology.Validate() performs authoritatively on Save; it only
  // understands IPv4 and silently skips anything else.
  function ipv4CidrOverlap(a, b) {
    const parse = (cidr) => {
      const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
      if (!m) return null;
      const [, o1, o2, o3, o4, bits] = m.map(Number);
      const addr = (o1 << 24) | (o2 << 16) | (o3 << 8) | o4;
      const prefix = bits;
      const mask = prefix === 0 ? 0 : ~0 << (32 - prefix);
      return { base: addr & mask, mask };
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return false;
    const commonMask = pa.mask & pb.mask;
    return (pa.base & commonMask) === (pb.base & commonMask);
  }

  function renderZones() {
    const list = document.getElementById("zone-list");
    list.innerHTML = "";
    const names = Topology.endpointNames().filter((n) => n !== "any");
    State.topology.zones.forEach((zone) => {
      const box = document.createElement("div");
      box.className = "zone";
      const head = document.createElement("div");
      head.className = "zone-head";
      head.append(zone.name);
      const del = document.createElement("button");
      del.className = "icon-btn";
      del.textContent = "×";
      del.onclick = () => removeZone(zone.name);
      head.append(del);
      box.append(head);

      State.topology.subnets.forEach((s) => {
        box.append(checkboxRow(`подсеть ${s.name}`, (zone.subnets || []).includes(s.name), (v) =>
          toggleZoneMember(zone, "subnet", s.name, v)));
      });
      State.topology.zones
        .filter((z) => z.name !== zone.name)
        .forEach((z) => {
          box.append(checkboxRow(`зона ${z.name}`, (zone.zones || []).includes(z.name), (v) =>
            toggleZoneMember(zone, "zone", z.name, v)));
        });
      list.append(box);
    });
    void names; // kept for readability of the endpointNames dependency above
  }

  function checkboxRow(label, checked, onChange) {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.onchange = () => onChange(cb.checked);
    row.append(cb, " " + label);
    return row;
  }

  // linkOffsets assigns each link (keyed by its unordered device pair) a
  // fan-out offset, so redundant links between the same two devices render
  // as distinct parallel lines instead of stacking exactly on top of each other.
  function linkOffsets(links) {
    const seen = new Map();
    return links.map((l) => {
      const key = [l.a.device, l.b.device].sort().join(" ");
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      return n;
    });
  }

  function spreadOffset(index) {
    // 0, +14, -14, +28, -28, ...
    const magnitude = Math.ceil(index / 2) * 14;
    return index % 2 === 0 ? magnitude : -magnitude;
  }

  function renderLabelPoint(svg, point, endpoint, onClick) {
    const g = el("g", { class: "link-label" });
    g.append(el("circle", { cx: point.x, cy: point.y, r: LABEL_R }));
    if (endpoint.interface) {
      g.append(el("text", { class: "link-label-text", x: point.x + 7, y: point.y + 3 }, endpoint.interface));
    }
    g.append(el("title", {}, endpoint.interface ? `${endpoint.interface} (клик — изменить)` : "Добавить метку интерфейса"));
    g.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    svg.append(g);
  }

  function render() {
    ensureLayout();
    const svg = document.getElementById("topo-canvas");
    svg.innerHTML = "";
    svg.onclick = () => pending && cancelPending();

    let maxX = 800;
    let maxY = 500;

    // links
    const offsets = linkOffsets(State.topology.links);
    State.topology.links.forEach((l, i) => {
      const pa = deviceCenter(l.a.device);
      const pb = deviceCenter(l.b.device);
      if (!pa || !pb) return;
      const offset = spreadOffset(offsets[i]);
      const mid = pointAt(pa, pb, 0.5, offset);
      svg.append(el("path", {
        class: "wire",
        d: `M ${pa.x} ${pa.y} Q ${mid.x} ${mid.y} ${pb.x} ${pb.y}`,
        fill: "none",
      }));
      const x = el("text", { class: "wire-x", x: mid.x, y: mid.y - 6 }, "×");
      x.onclick = (e) => {
        e.stopPropagation();
        removeLink(i);
      };
      svg.append(x);
      renderLabelPoint(svg, labelNear(pa, pb, offset), l.a, () => editLabel(l.a));
      renderLabelPoint(svg, labelNear(pb, pa, -offset), l.b, () => editLabel(l.b));
    });

    // subnet attachments
    State.topology.subnets.forEach((s) => {
      (s.attach || []).forEach((a, i) => {
        const pa = deviceCenter(a.device);
        const c = subnetCenter(s.name);
        if (!pa || !c) return;
        svg.append(el("line", { class: "wire", x1: pa.x, y1: pa.y, x2: c.x, y2: c.y }));
        const mx = (pa.x + c.x) / 2;
        const my = (pa.y + c.y) / 2;
        const x = el("text", { class: "wire-x", x: mx, y: my - 6 }, "×");
        x.onclick = (e) => {
          e.stopPropagation();
          removeAttach(s.name, i);
        };
        svg.append(x);
        renderLabelPoint(svg, labelNear(pa, c, 0), a, () => editLabel(a));
      });
    });

    // devices
    State.topology.devices.forEach((d) => {
      const pos = State.layout.devices[d.name];
      maxX = Math.max(maxX, pos.x + DEVICE_W + 40);
      maxY = Math.max(maxY, pos.y + DEVICE_H + 40);

      const isPending = pending && pending.device === d.name;
      const rect = el("rect", {
        class: "node-rect " + d.kind + (isPending ? " pending" : ""),
        x: pos.x,
        y: pos.y,
        width: DEVICE_W,
        height: DEVICE_H,
        rx: 6,
      });
      makeDraggable(rect, "device", d.name, () => onDeviceClick(d.name));
      svg.append(rect);
      svg.append(el("text", { class: "node-label", x: pos.x + 8, y: pos.y + 18 }, `${d.name} (${d.kind})`));

      const close = el("text", { class: "node-close", x: pos.x + DEVICE_W - 10, y: pos.y + 14 }, "×");
      close.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Удалить устройство ${d.name}?`)) removeDevice(d.name);
      };
      svg.append(close);
    });

    // subnets
    State.topology.subnets.forEach((s) => {
      const pos = State.layout.subnets[s.name];
      maxX = Math.max(maxX, pos.x + SUBNET_W + 40);
      maxY = Math.max(maxY, pos.y + SUBNET_H + 40);

      const rect = el("rect", {
        class: "subnet-rect",
        x: pos.x,
        y: pos.y,
        width: SUBNET_W,
        height: SUBNET_H,
      });
      makeDraggable(rect, "subnet", s.name, () => onSubnetClick(s.name));
      svg.append(rect);
      svg.append(el("text", { class: "subnet-label", x: pos.x + 8, y: pos.y + 18 }, s.name));
      svg.append(el("text", { class: "subnet-label", x: pos.x + 8, y: pos.y + 34 }, s.cidr));

      const close = el("text", { class: "node-close", x: pos.x + SUBNET_W - 10, y: pos.y + 14 }, "×");
      close.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Удалить подсеть ${s.name}?`)) removeSubnet(s.name);
      };
      svg.append(close);
    });

    svg.setAttribute("width", maxX);
    svg.setAttribute("height", maxY);

    renderZones();
  }

  function setupForms() {
    document.getElementById("add-device-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get("name").trim();
      if (!name) return;
      if (State.topology.devices.some((d) => d.name === name)) {
        showBanner(`Устройство ${name} уже существует`);
        return;
      }
      State.topology.devices.push({ name, kind: f.get("kind") });
      e.target.reset();
      render();
    });

    document.getElementById("add-subnet-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get("name").trim();
      const cidr = f.get("cidr").trim();
      if (!name || !cidr) return;
      if (State.topology.subnets.some((s) => s.name === name)) {
        showBanner(`Подсеть ${name} уже существует`);
        return;
      }
      const overlap = State.topology.subnets.find((s) => ipv4CidrOverlap(s.cidr, cidr));
      if (overlap) {
        showBanner(`Похоже, ${cidr} пересекается с ${overlap.name} (${overlap.cidr}) — сервер откажет при сохранении`);
      }
      State.topology.subnets.push({ name, cidr, attach: [] });
      e.target.reset();
      render();
    });

    document.getElementById("add-zone-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get("name").trim();
      if (!name) return;
      if (State.topology.zones.some((z) => z.name === name)) {
        showBanner(`Зона ${name} уже существует`);
        return;
      }
      State.topology.zones.push({ name, subnets: [], zones: [] });
      e.target.reset();
      renderZones();
    });

    document.getElementById("topo-save").addEventListener("click", async () => {
      try {
        State.topology = await Api.put("/api/topology", State.topology);
        showBanner("Топология сохранена", "ok");
        render();
        Rules.render();
      } catch (e) {
        showBanner("Ошибка сохранения топологии: " + e.message);
      }
    });
  }
  setupForms();

  return {
    render,
    endpointNames() {
      return [
        "any",
        ...State.topology.subnets.map((s) => s.name).sort(),
        ...State.topology.zones.map((z) => z.name).sort(),
      ];
    },
  };
})();
