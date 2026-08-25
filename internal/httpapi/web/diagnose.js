"use strict";

// Diagnose — карта топологии на canvas с подсветкой путей и отчёт
// диагностики трафика (POST /api/diagnose). Карта только для чтения:
// перетаскивание узлов и правка — на /ui/topology.
const Diagnose = (() => {
  const { DEVICE_W, DEVICE_H, NET_W, NET_H } = NetMap;
  const state = {
    topology: null, subnets: [], layout: null, camera: Camera.create(), result: null,
    list: [], // display list канвы (TopoScene.buildScene)
    hl: null, flow: null, flowFade: 0, // разметка потока и прогресс её проявления
  };
  let theme = null, view = null, minimap = null;

  const canvasEl = () => document.getElementById("diag-canvas");
  const wrapEl = () => document.getElementById("diag-wrap");

  // buildAdj: симметричная смежность устройств и сетей — линки устройство–
  // устройство плюс привязки «сеть ↔ устройство». Ключи квалифицированы
  // префиксом пространства имён («d:»/«n:»), чтобы сеть и устройство с
  // одинаковым именем не сливались в один узел графа.
  const DEV = "d:", NET = "n:";
  const bare = (k) => k.slice(DEV.length);
  function buildAdj(topology) {
    const adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    };
    topology.links.forEach((l) => { link(DEV + l.a.device, DEV + l.b.device); link(DEV + l.b.device, DEV + l.a.device); });
    topology.networks.forEach((n) => (n.attach || []).forEach((a) => { link(NET + n.name, DEV + a.device); link(DEV + a.device, NET + n.name); }));
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

  // узел отчёта без близнеца на карте (l2-bus) даёт null и просто пропускается;
  // якорь — квалифицированный ключ (роутер-устройство или сеть)
  const anchorOf = (topology) => (n) => {
    if (n.kind === 0) return DEV + n.name;
    const w = topology.networks.find((w) => (w.subnets || []).includes(n.name));
    return w ? NET + w.name : null;
  };

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
      // l2-bus не имеет близнеца на карте; стыки ищем по соседним якорям.
      // В hl имена без префикса: подсветке не нужно различать пространства имён.
      const anchors = p.nodes.map(anchor).filter(Boolean);
      anchors.forEach((a) => hl.add(bare(a)));
      for (let i = 0; i + 1 < anchors.length; i++) {
        if (anchors[i] === anchors[i + 1]) continue;
        const chain = shortestPath(adj, anchors[i], anchors[i + 1]);
        if (chain) chain.forEach((x) => hl.add(bare(x)));
      }
    });
    return hl;
  }

  // edgeKey канонизирует пару имён концов связи/привязки в ключ ребра карты.
  const edgeKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

  // expandFlow делит маршрут на пройденную и непройденную части по вердиктам
  // роутеров: ok — узлы карты до точки срабатывания запрета, okE — рёбра,
  // которые трафик прошёл целиком (включая последний хоп к точке запрета:
  // дроп случается на самом роутере, а не на подходе к нему), denyE — рёбра
  // за точкой запрета, deny — карта «роутер → {rule, reason}» для точек
  // запрета, hl — весь путь целиком (для приглушения остального).
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
    const okE = new Set(), denyE = new Set();
    report.paths.forEach((p) => {
      const anchors = p.nodes.map(anchor).filter(Boolean);
      const di = p.routers.findIndex((rv) => rv.action === "deny");
      const cut = di >= 0 ? anchors.indexOf(DEV + p.routers[di].router) : anchors.length;
      if (cut < 0) return; // запрет вне якорей карты — маршрут не размечаем
      const rv = di >= 0 ? p.routers[di] : null;
      for (let i = 0; i + 1 < anchors.length; i++) {
        if (anchors[i] === anchors[i + 1]) continue;
        const seg = (shortestPath(adj, anchors[i], anchors[i + 1]) || []).map(bare);
        if (!seg) continue;
        const edges = seg.slice(1).map((x, j) => edgeKey(seg[j], x));
        if (rv && i + 1 > cut) {
          seg.forEach((x) => blocked.add(x));
          edges.forEach((k) => denyE.add(k));
          continue;
        }
        const stopped = rv && i + 1 === cut;
        seg.slice(0, stopped ? -1 : seg.length).forEach((x) => ok.add(x));
        edges.forEach((k) => okE.add(k));
        if (stopped) deny.set(seg[seg.length - 1], { rule: rv.matchedRule || "", reason: rv.reason || "" });
      }
    });
    deny.forEach((_, n) => ok.delete(n)); // запрет сильнее разрешения
    blocked.forEach((n) => ok.delete(n));
    return { hl, ok, deny, okE, denyE };
  }

  // baseIp — представительский адрес подсети: сетевой адрес её CIDR, который
  // по определению принадлежит подсети независимо от версии IP.
  const baseIp = (cidr) => cidr.split("/")[0];

  // resolveSpreadSources резолвит ввод инструмента «Распространение сети» в
  // список представительских источников для /api/diagnose: точное совпадение
  // с именем подсети или сети даёт известный subnetName (чтобы не опрашивать
  // источник сам про себя), а любой другой ввод считается голым IP-адресом.
  function resolveSpreadSources(input, subnets, networks) {
    const subnet = subnets.find((s) => s.name === input);
    if (subnet) return [{ ip: baseIp(subnet.cidr), subnetName: subnet.name }];
    const net = networks.find((n) => n.name === input);
    if (net) {
      return (net.subnets || []).map((name) => {
        const s = subnets.find((s) => s.name === name);
        return { ip: s ? baseIp(s.cidr) : name, subnetName: name };
      });
    }
    return [{ ip: input, subnetName: null }];
  }

  // mergeFlows объединяет несколько expandFlow (один на пару источник×подсеть-
  // назначения) в одну разметку карты. Приоритет запрета над разрешением уже
  // встроен в flowMark (проверяет deny/denyE раньше ok/okE), поэтому здесь
  // достаточно простого объединения множеств без повторного вычитания.
  function mergeFlows(flows) {
    const hl = new Set(), ok = new Set(), okE = new Set(), denyE = new Set();
    const deny = new Map();
    flows.forEach((f) => {
      f.hl.forEach((n) => hl.add(n));
      f.ok.forEach((n) => ok.add(n));
      f.okE.forEach((k) => okE.add(k));
      f.denyE.forEach((k) => denyE.add(k));
      f.deny.forEach((v, k) => { if (!deny.has(k)) deny.set(k, v); });
    });
    return { hl, ok, deny, okE, denyE };
  }

  // flowMark возвращает mark(obj) для TopoScene: состояние движения трафика
  // элемента карты. Узлы — по ok/deny; рёбра (связи и привязки) — по
  // собственным множествам okE/denyE: цвет ребра не выводится из концов,
  // иначе хоп к запрещающему роутеру красился бы по его вердикту.
  // Непомеченные элементы остаются приглушёнными.
  const flowMark = (flow) => (obj) => {
    if (!flow || obj.devices) return "";
    if (!obj.a && obj.type !== "attach")
      return flow.deny.has(obj.name) ? "diag-flow-deny" : flow.ok.has(obj.name) ? "diag-flow-ok" : "";
    const names = obj.type === "attach" ? [obj.net.name, obj.device] : [obj.a.device, obj.b.device];
    const k = edgeKey(names[0], names[1]);
    return flow.denyE.has(k) ? "diag-flow-deny" : flow.okE.has(k) ? "diag-flow-ok" : "";
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

  // denyTooltip — текст тултипа точки срабатывания запрета
  const denyTooltip = (info) => (info.rule ? `правило ${info.rule}: ` : "") + info.reason;

  // showNetInfo открывает окно состава сети у правого края её облака.
  function showNetInfo(n) {
    const pos = state.layout.networks[n.name];
    if (!pos) return;
    const r = wrapEl().getBoundingClientRect();
    NetInfo.show(n, state.subnets, Camera.worldToScreen(state.camera, pos.x + NET_W, pos.y), { w: r.width, h: r.height });
  }

  // render пересобирает display list сцены и просит канву перерисоваться
  function render() {
    TopoScene.ensureLayout(state.topology, state.layout);
    state.list = TopoScene.buildScene(state, {
      theme,
      dim: pathDim(state.hl),
      mark: flowMark(state.flow),
      fade: { flow: state.flowFade },
      // item получает примитивный kind (rrect/path/…); узел опознаём по nodeType
      item: (kind, it) => {
        if (it.nodeType === "device" && state.flow && state.flow.deny.has(it.ref.name))
          it.meta = { tooltip: denyTooltip(state.flow.deny.get(it.ref.name)) };
      },
    }).list;
    view.invalidate();
    minimap.update();
  }

  // animate гонит твин кадрами rAF; повторный запуск того же канала
  // вытесняет незавершённую анимацию (новый отчёт/полёт не спорит со старым)
  const animGen = {};
  function animate(key, tw, apply) {
    const gen = (animGen[key] = (animGen[key] || 0) + 1);
    const step = () => {
      if (animGen[key] !== gen) return;
      tw.tick(performance.now());
      apply();
      if (tw.active()) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const setCam = (c) => { state.camera = c; view.invalidate(); minimap.update(); panels.forEach((p) => p.position()); };

  // flyCam плавно ведёт камеру к цели (кнопка «вписать карту»)
  function flyCam(to, ms = 250) {
    const cur = { ...state.camera };
    const tw = Tween.create();
    tw.to(cur, to, ms);
    animate("cam", tw, () => setCam({ ...cur }));
  }

  // worldPoint переводит точку курсора в мировые координаты
  const worldPoint = (e) => {
    const r = canvasEl().getBoundingClientRect();
    return Camera.screenToWorld(state.camera, e.clientX - r.left, e.clientY - r.top);
  };

  // fitMap вписывает всю карту во вьюпорт анимацией камеры
  function fitMap() {
    TopoScene.ensureLayout(state.topology, state.layout);
    const b = TopoScene.bounds(state.topology, state.layout);
    if (!b) return;
    const r = wrapEl().getBoundingClientRect();
    flyCam(Camera.fitView(state.camera, b, Math.round(r.width), Math.round(r.height), 60));
  }

  function wireInteractions() {
    const cv = canvasEl();
    cv.addEventListener("click", (e) => {
      const it = HitTest.pick(state.list, worldPoint(e), state.camera.z);
      if (it && it.nodeType === "network") showNetInfo(it.ref);
    });
    // тултип (точка запрета, экспорт фильтров на связях): hover с задержкой
    const tip = document.getElementById("diag-tooltip");
    tip.hidden = true;
    let tipTimer = 0;
    const hideTip = () => { clearTimeout(tipTimer); tip.hidden = true; };
    cv.addEventListener("mousemove", (e) => {
      const it = HitTest.pick(state.list, worldPoint(e), state.camera.z);
      clearTimeout(tipTimer);
      if (!it || !it.meta || !it.meta.tooltip) { hideTip(); return; }
      tipTimer = setTimeout(() => {
        const r = cv.getBoundingClientRect();
        tip.textContent = it.meta.tooltip;
        tip.style.left = `${e.clientX - r.left + 14}px`;
        tip.style.top = `${e.clientY - r.top + 14}px`;
        tip.hidden = false;
      }, 300);
    });
    cv.addEventListener("mouseleave", hideTip);
    cv.addEventListener("mousedown", hideTip); // жест начался — подсказка ни к чему
    document.getElementById("diag-fit").addEventListener("click", fitMap);
    document.getElementById("diag-tool-reset").addEventListener("click", resetResult);
    updateResetButton(); // явное начальное состояние: не полагаемся на атрибут disabled в разметке
  }

  // — плавающие окна параметров: тумблер тулбара, перетаскивание, позиция —
  // Каждое окно привязано не к экрану, а к точке мировых координат холста
  // (anchor): при панорамировании/зуме камеры оно остаётся на том же месте
  // карты. createFloatingPanel — общая фабрика для обоих инструментов
  // диагностики (путь и распространение), каждый со своими id и ключами.
  const panels = [];

  function createFloatingPanel({ panelId, toolId, closeId, headerId, posKey, openKey, defaultOpen }) {
    let anchor = null;
    const panelEl = () => document.getElementById(panelId);

    function setOpen(open, persist = true) {
      panelEl().hidden = !open;
      document.getElementById(toolId).classList.toggle("active", open);
      if (persist) localStorage.setItem(openKey, open ? "1" : "0");
    }
    // position переносит окно на экран по его якорю в мировых координатах;
    // вызывается при каждой смене камеры (setCam), чтобы окно ехало вместе с картой.
    function position() {
      if (!anchor) return;
      const p = Camera.worldToScreen(state.camera, anchor.x, anchor.y);
      panelEl().style.left = `${p.x}px`;
      panelEl().style.top = `${p.y}px`;
    }
    // clampToViewport подтягивает окно внутрь видимой области холста при
    // открытии: панорамирование камеры, пока окно было закрыто (или просто
    // далеко унесено), могло увести его якорь за пределы экрана — окно не
    // должно теряться, его всегда должно быть видно сразу после открытия.
    function clampToViewport() {
      const wrap = wrapEl().getBoundingClientRect();
      const rect = panelEl().getBoundingClientRect();
      const margin = 8;
      const maxLeft = Math.max(margin, wrap.width - rect.width - margin);
      const maxTop = Math.max(margin, wrap.height - rect.height - margin);
      const left = Math.min(Math.max(parseFloat(panelEl().style.left) || 0, margin), maxLeft);
      const top = Math.min(Math.max(parseFloat(panelEl().style.top) || 0, margin), maxTop);
      panelEl().style.left = `${left}px`;
      panelEl().style.top = `${top}px`;
      anchor = Camera.screenToWorld(state.camera, left, top);
      localStorage.setItem(posKey, JSON.stringify(anchor));
    }

    document.getElementById(toolId).addEventListener("click", () => {
      const opening = panelEl().hidden;
      setOpen(opening);
      if (opening) clampToViewport();
    });
    document.getElementById(closeId).addEventListener("click", () => setOpen(false));
    document.getElementById(headerId).addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const wrap = wrapEl().getBoundingClientRect();
      const rect = panelEl().getBoundingClientRect();
      const startX = ev.clientX, startY = ev.clientY;
      const startLeft = rect.left - wrap.left, startTop = rect.top - wrap.top;
      const move = (left, top) => { panelEl().style.left = `${left}px`; panelEl().style.top = `${top}px`; };
      const onMove = (e) => move(startLeft + e.clientX - startX, startTop + e.clientY - startY);
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        anchor = Camera.screenToWorld(state.camera, parseFloat(panelEl().style.left), parseFloat(panelEl().style.top));
        localStorage.setItem(posKey, JSON.stringify(anchor));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    const storedOpen = localStorage.getItem(openKey);
    setOpen(storedOpen === null ? defaultOpen : storedOpen === "1", false);
    try {
      const saved = JSON.parse(localStorage.getItem(posKey));
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) anchor = saved;
    } catch {}
    if (!anchor) {
      const wrap = wrapEl().getBoundingClientRect();
      const rect = panelEl().getBoundingClientRect();
      anchor = Camera.screenToWorld(state.camera, rect.left - wrap.left, rect.top - wrap.top);
    }
    position();
    if (!panelEl().hidden) clampToViewport();
    return { position };
  }

  function wirePanels() {
    panels.push(createFloatingPanel({
      panelId: "diag-panel", toolId: "diag-tool-path", closeId: "diag-panel-close", headerId: "diag-panel-header",
      posKey: "firenet-diag-panel-pos-v2", openKey: "firenet-diag-panel-open-v1", defaultOpen: true,
    }));
    panels.push(createFloatingPanel({
      panelId: "spread-panel", toolId: "diag-tool-spread", closeId: "spread-panel-close", headerId: "spread-panel-header",
      posKey: "firenet-spread-panel-pos-v1", openKey: "firenet-spread-panel-open-v1", defaultOpen: false,
    }));
  }

  // — запоминание введённых параметров формы —
  const DIAG_FORM_KEY = "firenet-diag-form-v1";
  const FORM_FIELDS = ["diag-src", "diag-dst", "diag-proto", "diag-dstports"];

  function saveFormState() {
    const data = {};
    FORM_FIELDS.forEach((id) => { data[id] = document.getElementById(id).value; });
    localStorage.setItem(DIAG_FORM_KEY, JSON.stringify(data));
  }

  function restoreFormState() {
    try {
      const data = JSON.parse(localStorage.getItem(DIAG_FORM_KEY));
      if (!data) return;
      FORM_FIELDS.forEach((id) => {
        if (typeof data[id] === "string") document.getElementById(id).value = data[id];
      });
    } catch {}
  }

  function wireFormPersistence() {
    restoreFormState();
    FORM_FIELDS.forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener("input", saveFormState);
      el.addEventListener("change", saveFormState);
    });
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
    span.className = node.kind === 0 ? "diag-chip diag-chip-router" : "diag-chip"; // kind 0 = router
    span.textContent = node.name;
    return span;
  }

  function renderReport(report) {
    const host = document.getElementById("diag-paths");
    host.innerHTML = "";
    state.result = report;
    updateResetButton();
    const summary = document.getElementById("diag-summary");
    summary.hidden = false;
    summary.textContent = `${report.srcSubnet} → ${report.dstSubnet}: путей ${report.paths.length}` + (report.note ? `. ${report.note}` : "");
    const flow = expandFlow(report, state.topology);
    state.hl = flow && flow.hl;
    state.flow = flow;
    if (state.topology) {
      state.flowFade = 0;
      render();
      if (flow) {
        const tw = Tween.create();
        tw.to(state, { flowFade: 1 }, 200);
        animate("flow", tw, render);
      }
    }
    if (!report.paths.length) {
      const p = document.createElement("p");
      p.className = "diag-unreachable";
      p.textContent = "Недостижимо: путей между подсетями нет.";
      host.append(p);
      return;
    }
    report.paths.forEach((path, i) => {
      const card = document.createElement("article");
      card.className = "diag-path";
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
        note.className = "diag-note";
        note.textContent = path.note;
        card.append(note);
      }
      const chain = document.createElement("p");
      chain.className = "diag-chain";
      path.nodes.forEach((n, j) => {
        if (j) chain.append(Object.assign(document.createElement("span"), { className: "diag-arrow", textContent: "→" }));
        chain.append(chip(n));
      });
      card.append(chain);
      path.routers.forEach((rv) => {
        const row = document.createElement("details");
        row.className = "diag-verdict";
        const sum = document.createElement("summary");
        const b = document.createElement("span");
        b.className = "badge " + badgeClass(rv.action);
        b.textContent = badgeLabel(rv.action, true);
        sum.append(b, Object.assign(document.createElement("span"), { textContent: ` ${rv.router}` }));
        // шеврон вместо убранного display:flex нативного маркера summary
        const chev = document.createElement("span");
        chev.className = "diag-chevron";
        chev.innerHTML =
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
        sum.append(chev);
        row.append(sum);
        if (rv.steps && rv.steps.length) {
          const ol = document.createElement("ol");
          ol.className = "diag-steps";
          rv.steps.forEach((s) => {
            const li = document.createElement("li");
            li.textContent = s;
            ol.append(li);
          });
          row.append(ol);
        } else {
          const body = document.createElement("p");
          body.textContent = rv.reason + (rv.matchedRule ? ` (правило: ${rv.matchedRule})` : "");
          row.append(body);
        }
        card.append(row);
      });
      host.append(card);
    });
  }

  // updateResetButton держит кнопку сброса на тулбаре активной, только пока
  // есть что сбрасывать (выполнена диагностика).
  const updateResetButton = () => { document.getElementById("diag-tool-reset").disabled = !state.result; };

  // resetResult очищает отчёт любого из инструментов диагностики (путь или
  // распространение) и подсветку на карте, не трогая поля форм. animGen.flow
  // инвалидирует недоигранный твин проявления потока, чтобы он не перезаписал
  // сброшенный flowFade кадром позже.
  function resetResult() {
    animGen.flow = (animGen.flow || 0) + 1;
    state.result = null;
    state.hl = null;
    state.flow = null;
    state.flowFade = 0;
    const summary = document.getElementById("diag-summary");
    summary.hidden = true;
    summary.textContent = "";
    document.getElementById("diag-paths").innerHTML = "";
    const spreadSummary = document.getElementById("spread-summary");
    spreadSummary.hidden = true;
    spreadSummary.textContent = "";
    updateResetButton();
    if (state.topology) render();
  }

  async function run(ev) {
    ev.preventDefault();
    const ports = document.getElementById("diag-dstports").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const report = await Api.post("/api/diagnose", {
        src: document.getElementById("diag-src").value.trim(),
        dst: document.getElementById("diag-dst").value.trim(),
        proto: document.getElementById("diag-proto").value,
        dstPorts: ports,
      });
      renderReport(report);
    } catch (e) {
      showBanner("Ошибка диагностики: " + e.message);
    }
  }

  // fillSpreadSources заполняет datalist поля «Источник» именами всех сетей
  // и подсетей топологии — подсказка для инструмента распространения.
  function fillSpreadSources() {
    const dl = document.getElementById("spread-sources");
    dl.innerHTML = "";
    [...state.topology.networks.map((n) => n.name), ...state.subnets.map((s) => s.name)].forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      dl.append(opt);
    });
  }

  // ownerNetwork находит сеть, которой принадлежит подсеть — для переноса
  // источника (известного только по имени подсети) в якорь карты, где узлы
  // подсетей адресуются по имени их сети (см. anchorOf).
  const ownerNetwork = (subnetName) => {
    const n = state.topology.networks.find((n) => (n.subnets || []).includes(subnetName));
    return n ? n.name : null;
  };

  // runSpread опрашивает /api/diagnose от каждого резолвленного источника до
  // каждой другой подсети топологии (любой трафик, без фильтра по протоколу/
  // портам) и объединяет результаты в одну разметку карты. Подсеть считается
  // достижимой, если существует хотя бы один физический путь до неё от любого
  // источника, — это проверка маршрутизации, а не фаерволла: вердикт
  // правила (allow/deny/return) на достижимость не влияет. Отдельные подсети
  // источника на карте адресуются по имени владеющей сети (см. ownerNetwork).
  async function runSpread(ev) {
    ev.preventDefault();
    const input = document.getElementById("spread-src").value.trim();
    const sources = resolveSpreadSources(input, state.subnets, state.topology.networks);
    const selfNames = new Set(sources.map((s) => s.subnetName).filter(Boolean));
    const candidates = state.subnets.map((s) => s.name).filter((n) => !selfNames.has(n));
    const dstIp = (name) => baseIp(state.subnets.find((s) => s.name === name).cidr);
    const pairs = sources.flatMap((src) => candidates.map((dstName) => ({ src, dstName })));
    try {
      const reports = await Promise.all(
        pairs.map(({ src, dstName }) => Api.post("/api/diagnose", { src: src.ip, dst: dstIp(dstName), proto: "", dstPorts: [] })),
      );
      const flows = reports.map((r) => expandFlow(r, state.topology)).filter(Boolean);
      const merged = mergeFlows(flows);
      selfNames.forEach((n) => {
        const owner = ownerNetwork(n);
        if (owner) { merged.hl.add(owner); merged.ok.add(owner); }
      });
      const reached = new Set(selfNames);
      reports.forEach((r, i) => { if (r.paths.length) reached.add(pairs[i].dstName); });
      renderSpread(input, merged, reached.size);
    } catch (e) {
      showBanner("Ошибка распространения: " + e.message);
    }
  }

  // renderSpread показывает свод («достижимо N из M подсетей») и красит карту
  // той же разметкой flow, что и диагностика одного пути.
  function renderSpread(input, merged, reachedCount) {
    state.result = { spread: true };
    updateResetButton();
    state.hl = merged.hl;
    state.flow = merged;
    const summary = document.getElementById("spread-summary");
    summary.hidden = false;
    summary.textContent = `Источник: ${input}. Достижимо ${reachedCount} из ${state.subnets.length} подсетей.`;
    if (state.topology) {
      state.flowFade = 0;
      render();
      const tw = Tween.create();
      tw.to(state, { flowFade: 1 }, 200);
      animate("flow", tw, render);
    }
  }

  function setupCamera() {
    // Карта read-only: камера служит только осмотру пути и не сохраняется
    // в /api/layout, чтобы не перезаписывать раскладку редактора топологии.
    // Кнопки пана — как в редакторе: средняя и правая; левая остаётся кликам
    // (состав сети), нативное меню ПКМ гасится внутри CameraControls.
    CameraControls.wire(canvasEl(), {
      getCam: () => state.camera,
      setCam,
      buttons: [1, 2],
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
      theme = CanvasTheme.fromComputed(getComputedStyle(document.documentElement));
      view = CanvasView.create(canvasEl(), {
        getList: () => state.list,
        getCam: () => state.camera,
        getOverlay: () => [],
        textHideZoom: theme.textHideZoom,
      });
      minimap = Minimap.create(document.getElementById("diag-minimap"), {
        getBounds: () => TopoScene.bounds(state.topology, state.layout),
        getPoints: () => [
          ...state.topology.devices.map((d) => NetMap.center(state.layout.devices, d.name, DEVICE_W, DEVICE_H)),
          ...state.topology.networks.map((n) => NetMap.center(state.layout.networks, n.name, NET_W, NET_H)),
        ].filter(Boolean),
        getCam: () => state.camera,
        setCam,
        getViewport: () => { const r = wrapEl().getBoundingClientRect(); return { w: r.width, h: r.height }; },
        getTheme: () => theme,
      });
      render();
      setupCamera();
      wireInteractions();
      NetInfo.attach(canvasEl());
      fillSpreadSources();
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    wirePanels();
    wireFormPersistence();
    document.getElementById("diag-form").addEventListener("submit", run);
    document.getElementById("spread-form").addEventListener("submit", runSpread);
  }

  return {
    boot, renderReport, run, resetResult, state, expandHighlight, expandFlow, flowMark,
    resolveSpreadSources, mergeFlows, runSpread,
  };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", Diagnose.boot);
} else {
  Diagnose.boot();
}
