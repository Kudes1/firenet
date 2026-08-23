"use strict";

// Simulate — статическая карта топологии с подсветкой путей и отчёт
// симуляции трафика (POST /api/simulate). Карта только для чтения:
// перетаскивание узлов и правка — на /ui/topology.
const Simulate = (() => {
  const { DEVICE_W, DEVICE_H, NET_W, NET_H, KINDS, el, center, linkOffsets, spreadOffset, pointAt } = NetMap;
  const state = { topology: null, subnets: [], layout: null, camera: Camera.create(), result: null };

  const svgEl = () => document.getElementById("sim-canvas");

  function ensureLayout() {
    state.topology.devices.forEach((d, i) => {
      if (!state.layout.devices[d.name]) state.layout.devices[d.name] = { x: 40 + (i % 5) * 200, y: 40 + Math.floor(i / 5) * 160 };
    });
    state.topology.networks.forEach((n, i) => {
      if (!state.layout.networks[n.name]) state.layout.networks[n.name] = { x: 40 + (i % 5) * 200, y: 300 + Math.floor(i / 5) * 160 };
    });
  }

  // cloudPathFor outlines an L2 segment as a cloud filling the whole bbox;
  // local copy of topology.js cloudPath (pure function of the bbox), so this
  // page doesn't depend on topology.js internals.
  function cloudPathFor(pos) {
    const x = pos.x, y = pos.y, w = NET_W, h = NET_H;
    const depth = 6;
    const HBUMPS = 7; // bumps per horizontal edge
    const VBUMPS = 3; // bumps per vertical edge
    const pts = [[x, y]];
    const edge = (x1, y1, x2, y2, n) => {
      for (let i = 1; i <= n + 1; i++) pts.push([x1 + ((x2 - x1) * i) / (n + 1), y1 + ((y2 - y1) * i) / (n + 1)]);
    };
    edge(x, y, x + w, y, HBUMPS);
    edge(x + w, y, x + w, y + h, VBUMPS);
    edge(x + w, y + h, x, y + h, HBUMPS);
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

  function highlightSet(report) {
    if (!report || !report.paths.length) return null;
    const names = new Set();
    report.paths.forEach((p) => p.nodes.forEach((n) => names.add(n.name)));
    return names;
  }

  function renderMap() {
    ensureLayout();
    const svg = svgEl();
    svg.innerHTML = "";
    const viewport = el("g", { class: "viewport", transform: Camera.transform(state.camera) });
    svg.append(viewport);
    const hl = highlightSet(state.result);
    const dim = (name) => (hl ? (hl.has(name) ? "" : " sim-dim") : "");
    const devC = (name) => center(state.layout.devices, name, DEVICE_W, DEVICE_H);
    const netC = (name) => center(state.layout.networks, name, NET_W, NET_H);

    const offsets = linkOffsets(state.topology.links);
    state.topology.links.forEach((l, i) => {
      const pa = devC(l.a.device), pb = devC(l.b.device);
      if (!pa || !pb) return;
      const mid = pointAt(pa, pb, 0.5, spreadOffset(offsets[i]));
      viewport.append(el("path", {
        class: "wire" + (l.filter ? " wire-filtered" : "") + ((hl && !(hl.has(l.a.device) && hl.has(l.b.device))) ? " sim-dim" : ""),
        d: `M ${pa.x} ${pa.y} Q ${mid.x} ${mid.y} ${pb.x} ${pb.y}`, fill: "none",
      }));
    });

    state.topology.networks.forEach((n) => {
      (n.attach || []).forEach((a) => {
        const pa = devC(a.device), c = netC(n.name);
        if (!pa || !c) return;
        viewport.append(el("line", {
          class: "wire" + ((hl && !(hl.has(n.name) && hl.has(a.device))) ? " sim-dim" : ""),
          x1: pa.x, y1: pa.y, x2: c.x, y2: c.y,
        }));
      });
    });

    state.topology.devices.forEach((d) => {
      const pos = state.layout.devices[d.name];
      const kind = KINDS[d.kind] || { rx: 6 };
      viewport.append(el("rect", { class: "node-rect " + d.kind + dim(d.name), x: pos.x, y: pos.y, width: DEVICE_W, height: DEVICE_H, rx: kind.rx }));
      if (kind.glyph) {
        viewport.append(el("path", { class: "node-glyph " + d.kind + dim(d.name), d: kind.glyph, transform: `translate(${pos.x + 8} ${pos.y + 8})` }));
        viewport.append(el("text", { class: "node-label" + dim(d.name), x: pos.x + 24, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      } else {
        viewport.append(el("text", { class: "node-label" + dim(d.name), x: pos.x + 8, y: pos.y + 18 }, `${d.name} (${d.kind})`));
      }
    });

    state.topology.networks.forEach((n) => {
      const pos = state.layout.networks[n.name];
      viewport.append(el("path", { class: "subnet-rect" + dim(n.name), d: cloudPathFor(pos) }));
      viewport.append(el("text", { class: "subnet-label" + dim(n.name), x: pos.x + 8, y: pos.y + 18 }, n.name));
      const members = (n.subnets || []).map((s) => state.subnets.find((x) => x.name === s)).filter(Boolean);
      const subtitle = members.length ? members.map((s) => s.cidr).join(", ") : "(нет подсетей)";
      viewport.append(el("text", { class: "link-label-text" + dim(n.name), x: pos.x + 8, y: pos.y + 36 }, subtitle));
    });
  }

  const BADGE = { allow: "badge-ok", deny: "badge-drop" };
  const badgeClass = (action) => BADGE[action] || "badge-default";
  // One branching point for both badge wordings: path verdicts speak
  // «разрешено/запрещено», per-router badges use iptables terms accept/drop.
  const badgeLabel = (action, iptables) =>
    action === "deny" ? (iptables ? "drop" : "запрещено") : action === "allow" ? (iptables ? "accept" : "разрешено") : action;

  function chip(node) {
    const span = document.createElement("span");
    span.className = node.kind === 0 ? "sim-chip sim-chip-router" : "sim-chip"; // kind 0 = router
    span.textContent = node.name;
    return span;
  }

  function renderReport(report) {
    const host = document.getElementById("sim-paths");
    host.innerHTML = "";
    state.result = report;
    const summary = document.getElementById("sim-summary");
    summary.hidden = false;
    summary.textContent = `${report.srcSubnet} → ${report.dstSubnet}: путей ${report.paths.length}` + (report.note ? `. ${report.note}` : "");
    if (state.topology) renderMap();
    if (!report.paths.length) {
      const p = document.createElement("p");
      p.className = "sim-unreachable";
      p.textContent = "Недостижимо: путей между подсетями нет.";
      host.append(p);
      return;
    }
    report.paths.forEach((path, i) => {
      const card = document.createElement("article");
      card.className = "sim-path";
      const head = document.createElement("header");
      const verdict = document.createElement("span");
      verdict.className = "badge " + badgeClass(path.verdict);
      verdict.textContent = badgeLabel(path.verdict);
      head.append(verdict);
      const title = document.createElement("strong");
      title.textContent = `Путь ${i + 1}`;
      head.append(title);
      card.append(head);
      if (path.note) {
        const note = document.createElement("p");
        note.className = "sim-note";
        note.textContent = path.note;
        card.append(note);
      }
      const chain = document.createElement("p");
      chain.className = "sim-chain";
      path.nodes.forEach((n, j) => {
        if (j) chain.append(Object.assign(document.createElement("span"), { className: "sim-arrow", textContent: "→" }));
        chain.append(chip(n));
      });
      card.append(chain);
      path.routers.forEach((rv) => {
        const row = document.createElement("details");
        const sum = document.createElement("summary");
        const b = document.createElement("span");
        b.className = "badge " + badgeClass(rv.action);
        b.textContent = badgeLabel(rv.action, true);
        sum.append(b, Object.assign(document.createElement("span"), { textContent: ` ${rv.router}` }));
        row.append(sum);
        const body = document.createElement("p");
        body.textContent = rv.reason + (rv.matchedRule ? ` (правило: ${rv.matchedRule})` : "");
        row.append(body);
        card.append(row);
      });
      host.append(card);
    });
  }

  async function run(ev) {
    ev.preventDefault();
    const ports = document.getElementById("sim-dstports").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const report = await Api.post("/api/simulate", {
        src: document.getElementById("sim-src").value.trim(),
        dst: document.getElementById("sim-dst").value.trim(),
        proto: document.getElementById("sim-proto").value,
        dstPorts: ports,
      });
      renderReport(report);
    } catch (e) {
      showBanner("Ошибка симуляции: " + e.message);
    }
  }

  async function boot() {
    try {
      const [topo, subnetsDoc, layout] = await Promise.all([
        Api.get("/api/topology"), Api.get("/api/subnets"), Api.get("/api/layout"),
      ]);
      state.topology = topo;
      state.subnets = subnetsDoc.subnets || [];
      state.layout = { devices: layout.devices || {}, networks: layout.networks || layout.subnets || {} };
      state.camera = layout.camera && layout.camera.z > 0
        ? { ...Camera.create(), ...layout.camera }
        : Camera.create();
      renderMap();
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    document.getElementById("sim-form").addEventListener("submit", run);
  }

  return { boot, renderReport, run, state };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", Simulate.boot);
} else {
  Simulate.boot();
}
