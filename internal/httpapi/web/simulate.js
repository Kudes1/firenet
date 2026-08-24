"use strict";

// Simulate — статическая карта топологии с подсветкой путей и отчёт
// симуляции трафика (POST /api/simulate). Карта только для чтения:
// перетаскивание узлов и правка — на /ui/topology.
const Simulate = (() => {
  const { el, NET_W } = NetMap;
  const state = { topology: null, subnets: [], layout: null, camera: Camera.create(), result: null };

  const svgEl = () => document.getElementById("sim-canvas");
  let viewportG = null;

  // buildAdj: симметричная смежность устройств и сетей — линки устройство–
  // устройство плюс привязки «сеть ↔ устройство».
  function buildAdj(topology) {
    const adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    };
    topology.links.forEach((l) => { link(l.a.device, l.b.device); link(l.b.device, l.a.device); });
    topology.networks.forEach((n) => (n.attach || []).forEach((a) => { link(n.name, a.device); link(a.device, n.name); }));
    return adj;
  }

  // shortestPath: BFS-цепочка имён от якоря from до to; null, если связи нет.
  function shortestPath(adj, from, to) {
    if (from === to) return [from];
    const prev = new Map([[from, null]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const next of adj.get(cur) || []) {
        if (prev.has(next)) continue;
        prev.set(next, cur);
        if (next === to) {
          const path = [];
          for (let n = to; n !== null; n = prev.get(n)) path.unshift(n);
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  }

  // узел отчёта без близнеца на карте (l2-bus) даёт null и просто пропускается
  const anchorOf = (topology) => (n) => n.kind === 0 ? n.name
    : (topology.networks.find((w) => (w.subnets || []).includes(n.name)) || {}).name || null;

  // expandHighlight переводит путь отчёта в имена элементов карты. Узлы
  // отчёта — подсети, роутеры и синтетические l2-bus, поэтому каждая пара
  // соседей приводится к якорю карты (роутер или сеть по членству подсети),
  // а стыки соединяются кратчайшей физической цепочкой устройств через
  // свитчи; всё это попадает в результирующий набор.
  function expandHighlight(report, topology) {
    if (!report || !report.paths.length) return null;
    const adj = buildAdj(topology);
    const anchor = anchorOf(topology);
    const hl = new Set();
    report.paths.forEach((p) => {
      // l2-bus не имеет близнеца на карте; стыки ищем по соседним якорям
      const anchors = p.nodes.map(anchor).filter(Boolean);
      anchors.forEach((a) => hl.add(a));
      for (let i = 0; i + 1 < anchors.length; i++) {
        if (anchors[i] === anchors[i + 1]) continue;
        const chain = shortestPath(adj, anchors[i], anchors[i + 1]);
        if (chain) chain.forEach((x) => hl.add(x));
      }
    });
    return hl;
  }

  // expandFlow делит маршрут на пройденную и непройденную части по вердиктам
  // роутеров: ok — элементы карты до точки срабатывания запрета (включая
  // сети-концы разрешённых маршрутов), deny — карта «роутер → {rule, reason}»
  // для точек запрета, hl — весь путь целиком (для приглушения остального).
  // Запрет сильнее разрешения: элемент с deny-вердиктом и всё за ним на
  // запрещённом маршруте никогда не попадают в ok.
  function expandFlow(report, topology) {
    const hl = expandHighlight(report, topology);
    if (!hl) return null;
    const adj = buildAdj(topology);
    const anchor = anchorOf(topology);
    const ok = new Set();
    const deny = new Map();
    const blocked = new Set();
    report.paths.forEach((p) => {
      const anchors = p.nodes.map(anchor).filter(Boolean);
      const di = p.routers.findIndex((rv) => rv.action === "deny");
      const cut = di >= 0 ? anchors.indexOf(p.routers[di].router) : anchors.length;
      if (cut < 0) return; // запрет вне якорей карты — маршрут не размечаем
      const rv = di >= 0 ? p.routers[di] : null;
      for (let i = 0; i + 1 < anchors.length; i++) {
        if (anchors[i] === anchors[i + 1]) continue;
        const seg = shortestPath(adj, anchors[i], anchors[i + 1]);
        if (!seg) continue;
        if (rv && i + 1 > cut) { seg.forEach((x) => blocked.add(x)); continue; }
        const stopped = rv && i + 1 === cut;
        seg.slice(0, stopped ? -1 : seg.length).forEach((x) => ok.add(x));
        if (stopped) deny.set(seg[seg.length - 1], { rule: rv.matchedRule || "", reason: rv.reason || "" });
      }
    });
    deny.forEach((_, n) => ok.delete(n)); // запрет сильнее разрешения
    blocked.forEach((n) => ok.delete(n));
    return { hl, ok, deny };
  }

  // flowMark возвращает mark(obj) для TopoScene: класс движения трафика
  // элемента карты — deny-точка краснее пройденного зелёного, непройденные
  // элементы без метки (остаются приглушёнными).
  const flowMark = (flow) => (obj) => {
    if (!flow) return "";
    const names = obj.type === "attach" ? [obj.net.name, obj.device]
      : obj.a ? [obj.a.device, obj.b.device]
      : [obj.name];
    if (names.some((n) => flow.deny.has(n))) return "sim-flow-deny";
    if (names.every((n) => flow.ok.has(n))) return "sim-flow-ok";
    return "";
  };

  // pathDim приглушает всё, что не принадлежит подсвеченному пути:
  // узлы и сети — по имени, связи — по паре устройств, привязки — по
  // паре «сеть–устройство».
  const pathDim = (hl) => (obj) => {
    if (!hl) return false;
    const names = obj.type === "attach" ? [obj.net.name, obj.device]
      : obj.a ? [obj.a.device, obj.b.device]
      : [obj.name];
    return !names.every((n) => hl.has(n));
  };

  // showNetInfo открывает окно состава сети у правого края её облака.
  function showNetInfo(n) {
    const pos = state.layout.networks[n.name];
    if (!pos) return;
    const r = svgEl().getBoundingClientRect();
    NetInfo.show(n, state.subnets, Camera.worldToScreen(state.camera, pos.x + NET_W, pos.y), { w: r.width, h: r.height });
  }

  function renderMap() {
    TopoScene.ensureLayout(state.topology, state.layout);
    const svg = svgEl();
    svg.innerHTML = "";
    viewportG = el("g", { class: "viewport", transform: Camera.transform(state.camera) });
    svg.append(viewportG);
    const flow = expandFlow(state.result, state.topology);
    TopoScene.render(viewportG, state, {
      dim: pathDim(flow && flow.hl),
      mark: flowMark(flow),
      hook: (kind, elem, obj) => {
        if (kind === "network") elem.onclick = () => showNetInfo(obj);
        if (kind === "device" && flow && flow.deny.has(obj.name)) {
          // нативный SVG-тултип с точкой срабатывания запрета
          const info = flow.deny.get(obj.name);
          const t = document.createElementNS(NetMap.SVG_NS, "title");
          t.textContent = (info.rule ? `правило ${info.rule}: ` : "") + info.reason;
          elem.append(t);
        }
      },
    });
  }

  // — перетаскиваемый разделитель «форма ↔ карта» —
  const FORM_MIN = 320, MAP_MIN = 320, SPLIT_W = 16, FORM_DEFAULT = 420;
  const SIM_SPLIT_KEY = "firenet-sim-split-v1";

  function clampFormWidth(px, total) {
    return Math.min(Math.max(Math.round(px), FORM_MIN), Math.max(FORM_MIN, total - MAP_MIN - SPLIT_W));
  }

  function applyFormWidth(w) {
    document.getElementById("sim-layout").style.setProperty("--sim-form-w", `${w}px`);
  }

  function wireSplitter() {
    const layout = document.getElementById("sim-layout");
    const handle = document.getElementById("sim-splitter");
    const apply = (w) => {
      state.formWidth = clampFormWidth(w, layout.getBoundingClientRect().width);
      applyFormWidth(state.formWidth);
    };
    handle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      handle.classList.add("dragging");
      const startX = ev.clientX;
      const start = state.formWidth ?? FORM_DEFAULT;
      const onMove = (e) => apply(start + e.clientX - startX);
      const onUp = () => {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        localStorage.setItem(SIM_SPLIT_KEY, JSON.stringify(state.formWidth));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    handle.addEventListener("dblclick", () => {
      localStorage.removeItem(SIM_SPLIT_KEY);
      state.formWidth = FORM_DEFAULT;
      applyFormWidth(FORM_DEFAULT);
    });
    try {
      const saved = JSON.parse(localStorage.getItem(SIM_SPLIT_KEY));
      if (Number.isFinite(saved)) apply(saved);
    } catch {}
  }

  const BADGE = { allow: "badge-ok", deny: "badge-drop", return: "badge-return" };
  const badgeClass = (action) => BADGE[action] || "badge-default";
  // One branching point for both badge wordings: path verdicts speak
  // «разрешено/запрещено/возврат в FORWARD», per-router badges use iptables
  // terms accept/drop/return.
  const badgeLabel = (action, iptables) =>
    action === "deny" ? (iptables ? "drop" : "запрещено")
      : action === "allow" ? (iptables ? "accept" : "разрешено")
        : action === "return" ? (iptables ? "return" : "возврат в FORWARD")
          : action;

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

  function setupCamera() {
    // Карта read-only: камера служит только осмотру пути и не сохраняется
    // в /api/layout, чтобы не перезаписывать раскладку редактора топологии.
    CameraControls.wire(svgEl(), {
      getCam: () => state.camera,
      setCam: (c) => {
        state.camera = c;
        if (viewportG) viewportG.setAttribute("transform", Camera.transform(c));
      },
    });
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
      setupCamera();
      NetInfo.attach(svgEl());
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    wireSplitter();
    document.getElementById("sim-form").addEventListener("submit", run);
  }

  return { boot, renderReport, run, state, expandHighlight, expandFlow, flowMark, clampFormWidth };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", Simulate.boot);
} else {
  Simulate.boot();
}
