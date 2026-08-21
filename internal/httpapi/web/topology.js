"use strict";

const State = {
  topology: { devices: [], links: [], networks: [] },
  subnets: [],
  layout: { devices: {}, networks: {} },
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
  const LABEL_R = 5;

  let pending = null; // {device} awaiting a network to attach to
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

  // labelNear places an endpoint's interface-label point a fixed distance
  // out from `from` towards `to` (clamped for short links).
  const LABEL_DIST = DEVICE_W / 2 + 14;
  function labelNear(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const dist = Math.min(LABEL_DIST, len * 0.42);
    return { x: from.x + (dx / len) * dist, y: from.y + (dy / len) * dist };
  }

  function scheduleLayoutSave() {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      Api.put("/api/layout", State.layout).catch(() => {
        /* layout is best-effort presentation state */
      });
    }, 400);
  }

  function makeDraggable(node, kind, name, onPlainClick) {
    node.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const layoutMap = kind === "device" ? State.layout.devices : State.layout.networks;
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
    State.topology.networks.forEach((n) => {
      n.attach = (n.attach || []).filter((a) => a.device !== name);
    });
    delete State.layout.devices[name];
    render();
  }

  function removeNetwork(name) {
    State.topology.networks = State.topology.networks.filter((n) => n.name !== name);
    delete State.layout.networks[name];
    render();
  }

  function removeLink(index) {
    State.topology.links.splice(index, 1);
    render();
  }

  function removeAttach(netName, index) {
    const net = State.topology.networks.find((n) => n.name === netName);
    net.attach.splice(index, 1);
    render();
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

    // device-to-device links
    const offsets = linkOffsets(State.topology.links);
    State.topology.links.forEach((l, i) => {
      const pa = deviceCenter(l.a.device);
      const pb = deviceCenter(l.b.device);
      if (!pa || !pb) return;
      const mid = pointAt(pa, pb, 0.5, spreadOffset(offsets[i]));
      svg.append(el("path", { class: "wire", d: `M ${pa.x} ${pa.y} Q ${mid.x} ${mid.y} ${pb.x} ${pb.y}`, fill: "none" }));
      const x = el("text", { class: "wire-x", x: mid.x, y: mid.y - 6 }, "×");
      x.onclick = (e) => {
        e.stopPropagation();
        removeLink(i);
      };
      svg.append(x);
      renderLabelPoint(svg, labelNear(pa, pb), l.a, () => editLabel(l.a));
      renderLabelPoint(svg, labelNear(pb, pa), l.b, () => editLabel(l.b));
    });

    // network attachments (device -> network segment)
    State.topology.networks.forEach((n) => {
      (n.attach || []).forEach((a, i) => {
        const pa = deviceCenter(a.device);
        const c = netCenter(n.name);
        if (!pa || !c) return;
        svg.append(el("line", { class: "wire", x1: pa.x, y1: pa.y, x2: c.x, y2: c.y }));
        const mx = (pa.x + c.x) / 2;
        const my = (pa.y + c.y) / 2;
        const x = el("text", { class: "wire-x", x: mx, y: my - 6 }, "×");
        x.onclick = (e) => {
          e.stopPropagation();
          removeAttach(n.name, i);
        };
        svg.append(x);
        renderLabelPoint(svg, labelNear(pa, c), a, () => editLabel(a));
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
        x: pos.x, y: pos.y, width: DEVICE_W, height: DEVICE_H, rx: 6,
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

    // networks
    State.topology.networks.forEach((n) => {
      const pos = State.layout.networks[n.name];
      maxX = Math.max(maxX, pos.x + NET_W + 40);
      maxY = Math.max(maxY, pos.y + NET_H + 40);

      const rect = el("rect", { class: "subnet-rect", x: pos.x, y: pos.y, width: NET_W, height: NET_H });
      makeDraggable(rect, "network", n.name, () => onNetworkClick(n.name));
      svg.append(rect);
      svg.append(el("text", { class: "subnet-label", x: pos.x + 8, y: pos.y + 18 }, n.name));

      const members = (n.subnets || []).map((s) => State.subnets.find((x) => x.name === s)).filter(Boolean);
      const subtitle = members.length ? members.map((s) => s.cidr).join(", ") : "(нет подсетей)";
      svg.append(el("text", { class: "link-label-text", x: pos.x + 8, y: pos.y + 36 }, subtitle.slice(0, 24)));

      const close = el("text", { class: "node-close", x: pos.x + NET_W - 10, y: pos.y + 14 }, "×");
      close.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Удалить сеть ${n.name}?`)) removeNetwork(n.name);
      };
      svg.append(close);
    });

    svg.setAttribute("width", maxX);
    svg.setAttribute("height", maxY);
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

    document.getElementById("add-network-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = f.get("name").trim();
      if (!name) return;
      if (State.topology.networks.some((n) => n.name === name)) {
        showBanner(`Сеть ${name} уже существует`);
        return;
      }
      State.topology.networks.push({ name, subnets: [], attach: [] });
      e.target.reset();
      render();
    });

    document.getElementById("topo-save").addEventListener("click", async () => {
      try {
        State.topology = await Api.put("/api/topology", State.topology);
        showBanner("Топология сохранена", "ok");
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
    } catch {
      State.layout = { devices: {}, networks: {} };
    }
    setupForms();
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
