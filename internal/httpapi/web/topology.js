"use strict";

const State = {
  topology: { devices: [], links: [], networks: [], unions: [] },
  subnets: [],
  layout: { devices: {}, networks: {}, links: {} },
  camera: Camera.create(),
  tool: "select",
  selection: new Set(), // device/network/link objects
  list: [], // display list канвы (TopoScene.buildScene)
  searchFade: 0, // прогресс затемнения поиска (твин updateSearch)
};

function normalizeTopology(topo) {
  topo ||= {};
  return {
    ...topo,
    devices: topo.devices || [],
    links: topo.links || [],
    networks: topo.networks || [],
    sets: topo.sets || [],
    unions: topo.unions || [],
  };
}

// normalizeLayout/normalizeCamera mirror normalizeTopology for the layout
// half of an editor snapshot ({topology, layout} — see topology_sync.js and
// docs/superpowers/specs/2026-08-27-topology-draft-sync-design.md's
// "Клиентский поток"): every GET/reload/operation response is coerced into
// the same shape State.layout/State.camera already used, null collections
// included.
function normalizeLayout(layout) {
  layout ||= {};
  return {
    devices: layout.devices || {},
    networks: layout.networks || layout.subnets || {},
    links: layout.links || {},
    camera: normalizeCamera(layout.camera),
  };
}

function normalizeCamera(camera) {
  return camera && camera.z > 0 ? { ...Camera.create(), ...camera } : Camera.create();
}

function cameraStorageKey() {
  return "firenet-topology-camera:" + (currentDraftID() || "current");
}

function loadCamera() {
  try {
    const camera = JSON.parse(localStorage.getItem(cameraStorageKey()));
    return camera && camera.z > 0 ? normalizeCamera(camera) : null;
  } catch {
    return null;
  }
}

function saveCamera(camera) {
  try {
    localStorage.setItem(cameraStorageKey(), JSON.stringify(camera));
  } catch {
    // The topology remains usable if browser storage is unavailable.
  }
}

// --- applyTopologyOp: client-side mirror of applyTopologyOperation ---
// (internal/httpapi/topology_operations.go). Pure: never mutates snapshot,
// always returns a new {topology, layout}. This is TopologySync's `apply`
// reducer (see topology_sync.js) — it projects every not-yet-confirmed
// operation onto the last confirmed server snapshot so the canvas responds
// instantly, without waiting for the round trip. It does not validate (no
// duplicate/self-loop/reference checks — that stays server-only); an
// unknown/malformed op is a no-op here since the server would have
// rejected it before this ever runs on a confirmed response.
//
// Field names match topologyOperation's JSON tags exactly (dto.go); the
// switch is structured to read side by side with the Go one.

function canonicalLinkPair(a, b) { return a > b ? [b, a] : [a, b]; }
function layoutLinkKey(a, b) { return canonicalLinkPair(a, b).join("|"); }
function linkFind(links, a, b) {
  const [x, y] = canonicalLinkPair(a, b);
  return links.findIndex((l) => canonicalLinkPair(l.a.device, l.b.device).join("|") === `${x}|${y}`);
}
const removeString = (arr, s) => (arr || []).filter((v) => v !== s);

// cloneSnapshot deep-copies the parts of {topology, layout} an operation
// can mutate, so applying one never aliases the caller's arrays/objects —
// same discipline as topology_operations.go's cloneProjectDoc.
function cloneSnapshot(snapshot) {
  const topology = snapshot.topology;
  const layout = snapshot.layout;
  return {
    topology: {
      ...topology,
      devices: [...topology.devices],
      links: [...topology.links],
      networks: topology.networks.map((n) => ({ ...n, subnets: [...(n.subnets || [])], attach: [...(n.attach || [])] })),
      sets: topology.sets ? [...topology.sets] : [],
      unions: (topology.unions || []).map((u) => ({ ...u, devices: [...(u.devices || [])], networks: [...(u.networks || [])] })),
    },
    layout: {
      devices: { ...layout.devices },
      networks: { ...layout.networks },
      links: Object.fromEntries(Object.entries(layout.links || {}).map(([k, v]) => [k, [...v]])),
      camera: layout.camera ? { ...layout.camera } : layout.camera,
    },
  };
}

function applyTopologyOp(snapshot, op) {
  const next = cloneSnapshot(snapshot);
  const topo = next.topology;
  const layout = next.layout;

  switch (op.kind) {
    case "create-device":
      topo.devices.push(op.device);
      break;

    case "delete-device": {
      topo.devices = topo.devices.filter((d) => d.name !== op.deviceName);
      topo.links = topo.links.filter((l) => {
        if (l.a.device === op.deviceName || l.b.device === op.deviceName) {
          delete layout.links[layoutLinkKey(l.a.device, l.b.device)];
          return false;
        }
        return true;
      });
      topo.networks = topo.networks.map((n) => ({ ...n, attach: n.attach.filter((a) => a.device !== op.deviceName) }));
      topo.unions = topo.unions.map((u) => ({ ...u, devices: removeString(u.devices, op.deviceName) }));
      delete layout.devices[op.deviceName];
      break;
    }

    case "create-network":
      topo.networks.push(op.network);
      break;

    case "delete-network":
      topo.networks = topo.networks.filter((n) => n.name !== op.networkName);
      topo.unions = topo.unions.map((u) => ({ ...u, networks: removeString(u.networks, op.networkName) }));
      delete layout.networks[op.networkName];
      break;

    case "create-link":
      topo.links.push(op.link);
      break;

    case "delete-link": {
      const i = linkFind(topo.links, op.link.a.device, op.link.b.device);
      if (i < 0) break;
      delete layout.links[layoutLinkKey(op.link.a.device, op.link.b.device)];
      topo.links.splice(i, 1);
      break;
    }

    case "set-link-filter": {
      const i = linkFind(topo.links, op.link.a.device, op.link.b.device);
      if (i >= 0) topo.links[i] = { ...topo.links[i], filter: op.filter };
      break;
    }

    case "clear-link-filter": {
      const i = linkFind(topo.links, op.link.a.device, op.link.b.device);
      if (i >= 0) { const { filter, ...rest } = topo.links[i]; topo.links[i] = rest; }
      break;
    }

    case "create-union":
      topo.unions.push(op.union);
      break;

    case "delete-union":
      topo.unions = topo.unions.filter((u) => u.name !== op.unionName);
      break;

    case "attach-network": {
      const i = topo.networks.findIndex((n) => n.name === op.networkName);
      if (i >= 0) topo.networks[i] = { ...topo.networks[i], attach: [...topo.networks[i].attach, op.attach] };
      break;
    }

    case "detach-network": {
      const i = topo.networks.findIndex((n) => n.name === op.networkName);
      if (i >= 0) topo.networks[i] = { ...topo.networks[i], attach: topo.networks[i].attach.filter((a) => a.device !== op.attach.device) };
      break;
    }

    case "union-add-device": {
      const i = topo.unions.findIndex((u) => u.name === op.unionName);
      if (i >= 0) topo.unions[i] = { ...topo.unions[i], devices: [...topo.unions[i].devices, op.deviceName] };
      break;
    }

    case "union-remove-device": {
      const i = topo.unions.findIndex((u) => u.name === op.unionName);
      if (i >= 0) topo.unions[i] = { ...topo.unions[i], devices: removeString(topo.unions[i].devices, op.deviceName) };
      break;
    }

    case "union-add-network": {
      const i = topo.unions.findIndex((u) => u.name === op.unionName);
      if (i >= 0) topo.unions[i] = { ...topo.unions[i], networks: [...topo.unions[i].networks, op.networkName] };
      break;
    }

    case "union-remove-network": {
      const i = topo.unions.findIndex((u) => u.name === op.unionName);
      if (i >= 0) topo.unions[i] = { ...topo.unions[i], networks: removeString(topo.unions[i].networks, op.networkName) };
      break;
    }

    case "set-device-position":
      layout.devices[op.deviceName] = op.position;
      break;

    case "set-network-position":
      layout.networks[op.networkName] = op.position;
      break;

    case "set-link-waypoints":
      layout.links[layoutLinkKey(op.link.a.device, op.link.b.device)] = op.waypoints;
      break;

    case "set-camera":
      layout.camera = op.camera;
      break;

    default:
      break;
  }

  return next;
}

// Topology renders devices/links/networks on a canvas the user builds
// the network on directly. A network is one L2 segment: click a device,
// then a network node, to attach the segment to that device. Subnet
// membership of networks is edited on /ui/subnets and /ui/networks.
const Topology = (() => {
  const { DEVICE_W, DEVICE_H, NET_W, NET_H } = NetMap;

  let theme = null; // CanvasTheme страницы
  let view = null; // CanvasView поверх #topo-canvas
  let pending = null; // {device|network} — узел, ожидающий пару в режиме connect
  let sync = null; // TopologySync — очередь операций поверх подтверждённого снимка черновика
  let previewWire = null; // item оверлея: связь в процессе connect
  let marqueeRect = null; // рамка выделения в мировых координатах
  let popoverCreate = null; // callback awaiting a name from the popover
  let popoverWorld = null; // world point the open popover is anchored to
  let ctxPending = null; // {items, at}: node menu awaiting a clean right-release
  let camControls = null; // CameraControls handle (isRightDown)
  let minimap = null; // Minimap над #topo-minimap
  // поиск по канвасу: подсветка совпавших узлов, приглушение остальных,
  // камера центрируется на активном совпадении
  let searchQ = "";
  let searchHits = []; // device/network objects в стабильном порядке
  let searchSet = new Set();
  let hitIdx = 0;
  const canvas = () => document.getElementById("topo-canvas");
  const TOOLS = ["select", "connect", "device", "network"];

  // screenPoint converts a mouse event into canvas-relative screen coords.
  function screenPoint(e) {
    const r = canvas().getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const toWorld = (p) => Camera.screenToWorld(State.camera, p.x, p.y);

  function applyCamera() {
    view.invalidate();
    movePopover();
    minimap.update();
  }

  function setCamera(camera) {
    State.camera = camera;
    applyCamera();
    saveCamera(camera);
  }

  function ensureLayout() {
    TopoScene.ensureLayout(State.topology, State.layout);
  }

  const deviceCenter = (name) => {
    const pos = State.layout.devices[name];
    return pos ? { x: pos.x + DEVICE_W / 2, y: pos.y + DEVICE_H / 2 } : null;
  };

  const netCenter = (name) => {
    const pos = State.layout.networks[name];
    return pos ? { x: pos.x + NET_W / 2, y: pos.y + NET_H / 2 } : null;
  };

  // showNetInfo открывает окно состава сети у правого края её облака.
  function showNetInfo(n) {
    const pos = State.layout.networks[n.name];
    if (!pos) return;
    const r = canvas().getBoundingClientRect();
    NetInfo.show(n, State.subnets, Camera.worldToScreen(State.camera, pos.x + NET_W, pos.y), { w: r.width, h: r.height });
  }

  // isCreatePending — true while a create-{device,network,link} operation
  // for this exact target hasn't been confirmed by the server yet
  // (TopologySync.pending() lists in-flight + queued ops). Actions that
  // need a persisted topology (e.g. configuring a filter on a just-created
  // link) stay unavailable until the create round-trips — the design spec
  // calls this out explicitly for link filters.
  function isLinkCreatePending(a, b) {
    return sync.pending().some((op) => op.kind === "create-link"
      && canonicalLinkPair(op.link.a.device, op.link.b.device).join("|") === canonicalLinkPair(a, b).join("|"));
  }

  // openLinkPanel открывает плавающую панель редактирования фильтра связи
  // в экранной точке at (правый клик, из контекстного меню → «Редактировать»,
  // недоступно пока связь ещё не подтверждена сервером — см.
  // isLinkCreatePending). Правки применяются немедленно операцией через
  // sync.enqueue, не общей кнопкой «Сохранить».
  function openLinkPanel(link, at) {
    if (isLinkCreatePending(link.a.device, link.b.device)) return;
    const r = canvas().getBoundingClientRect();
    LinkPanel.show(link, {
      subnets: State.subnets,
      fetchExports: (side) => Api.get(apiPath(`link-exports?a=${link.a.device}&b=${link.b.device}&side=${side}`)).then((res) => res.entities || []),
      onApply: (filter) => {
        enqueueOp({
          kind: filter ? "set-link-filter" : "clear-link-filter",
          link: { a: { device: link.a.device }, b: { device: link.b.device } },
          ...(filter ? { filter } : {}),
        });
      },
    }, at, { w: r.width, h: r.height });
  }

  // enqueueOp is the one gate every canvas edit passes through: a read-only
  // tab (no active draft) never talks to the operations endpoint, matching
  // assertEditable's use everywhere else project data is written.
  function enqueueOp(op) {
    try {
      assertEditable();
    } catch {
      return; // read-only tab: nothing to persist
    }
    sync.enqueue(op);
  }

  // setupCamera wires wheel zoom (anchored at the cursor) and pan by
  // middle/right-button drag via the shared CameraControls. Camera state
  // belongs to this browser and is stored locally; it is not a topology
  // operation. Left button stays free for selection and node dragging
  // (setupSelection).
  function setupCamera() {
    camControls = CameraControls.wire(canvas(), {
      getCam: () => State.camera,
      setCam: setCamera,
      buttons: [1, 2],
      onDragEnd: (moved, button) => {
        if (button === 2 && !moved && ctxPending) showContextMenu(ctxPending.at, ctxPending.items);
        ctxPending = null;
      },
    });
  }

  // --- context menu ---

  const hideContextMenu = () => { document.getElementById("topo-context-menu").hidden = true; };

  // showContextMenu рисует меню в точке экрана. Пункт — [label, action, cls?]
  // либо {label, children} для подменю; action === null — неактивный пункт.
  function showContextMenu(at, items) {
    const menu = document.getElementById("topo-context-menu");
    menu.innerHTML = "";
    const mkItem = (label, action, cls, active = !!action, search) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      if (search !== undefined) btn.dataset.search = search;
      if (action) {
        if (cls) btn.setAttribute("class", cls);
        btn.onclick = (e) => { e.stopPropagation(); hideContextMenu(); action(); };
      }
      if (!active) btn.disabled = true;
      return btn;
    };
    // searchField добавляет в подменю фильтр по data-search: клик не должен
    // закрыть меню, ввод скрывает несовпавшие пункты через containsFold.
    const searchField = (sub) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "ctx-search";
      input.placeholder = "Поиск...";
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("input", () => {
        Array.from(sub.children).forEach((c) => {
          if (c.dataset.search !== undefined) c.hidden = !containsFold(c.dataset.search, input.value);
        });
      });
      return input;
    };
    // flipIfClipped переоткрывает подменю налево, если справа для него не
    // хватает места до правого края .canvas-wrap (он же обрезает подменю
    // через overflow: hidden) — иначе у правого края экрана подменю просто
    // срезается. mouseenter стреляет уже после применения :hover, так что
    // getBoundingClientRect тут возвращает актуальные, а не нулевые размеры.
    const flipIfClipped = (sub) => {
      sub.classList.remove("submenu-left");
      const bound = menu.closest(".canvas-wrap")?.getBoundingClientRect();
      if (bound && sub.getBoundingClientRect().right > bound.right) sub.classList.add("submenu-left");
    };
    const fill = (parent, entries) => {
      entries.forEach((it) => {
        if (it.children) {
          const wrap = document.createElement("div");
          wrap.setAttribute("class", "ctx-sub");
          const sub = document.createElement("div");
          sub.setAttribute("class", "submenu");
          if (it.searchable) {
            const search = searchField(sub);
            sub.append(search);
          }
          wrap.append(mkItem(it.label, null, null, true), sub);
          fill(sub, it.children);
          parent.append(wrap);
          wrap.addEventListener("mouseenter", () => {
            flipIfClipped(sub);
            if (it.searchable) sub.querySelector(".ctx-search").focus();
          });
        } else {
          parent.append(mkItem(...it));
        }
      });
    };
    fill(menu, items);
    menu.hidden = false;
    menu.style.left = at.x + "px";
    menu.style.top = at.y + "px";
  }

  // setUnion перемещает объект в объединение targetName (или из всех
  // объединений при targetName == null): по одной операции union-remove-*
  // на каждое объединение, где name состоит сейчас (кроме целевого), затем
  // union-add-* на целевое, если он ещё туда не входит. targetName — это имя
  // объединения (строка), а не индекс/ссылка в State.topology.unions: сам
  // объект-объединение резолвится по имени из ТЕКУЩЕГО State.topology прямо
  // здесь, в момент вызова, а не когда строилось меню — enqueueOp может
  // синхронно заменить State.topology (см. TopologySync.onState) любое
  // число раз между построением контекстного меню и кликом по его пункту, и
  // индекс/ссылка на объединение, захваченные в момент построения меню,
  // к этому моменту не указывают ни на что в новом массиве. Имя объединения
  // как идентичность переживает такую замену невредимым.
  function setUnion(name, key, targetName) {
    const idField = key === "devices" ? "deviceName" : "networkName";
    const removeKind = key === "devices" ? "union-remove-device" : "union-remove-network";
    const addKind = key === "devices" ? "union-add-device" : "union-add-network";
    const target = targetName ? State.topology.unions.find((s) => s.name === targetName) : null;
    const alreadyInTarget = !!target && (target[key] || []).includes(name);
    const removeFrom = State.topology.unions
      .filter((s) => (s[key] || []).includes(name) && (!target || s.name !== target.name))
      .map((s) => s.name);
    removeFrom.forEach((unionName) => enqueueOp({ kind: removeKind, unionName, [idField]: name }));
    if (target && !alreadyInTarget) enqueueOp({ kind: addKind, unionName: target.name, [idField]: name });
  }

  // deleteByIdentity удаляет ОДИН объект контекстного меню по его имени/паре
  // (kind + identity зафиксированы строками при построении меню в
  // menuItemsFor), а не по живой ссылке добавленной в State.selection: между
  // открытием меню и кликом по «Удалить» мог пройти publish (драг узла,
  // подтверждение любой другой операции, панорама камеры), заменяющий
  // State.topology новыми экземплярами (cloneSnapshot), так что ссылка на
  // сам объект к моменту клика могла устареть. kind здесь известен заранее
  // (nodeType/isLink на момент построения меню), поэтому, в отличие от
  // deleteSelection, дереклассифицировать объект по ссылке на актуальный
  // State.topology не требуется вовсе — как раз такая передереклассификация
  // и есть источник обеих багов, которые чинит этот путь.
  function deleteByIdentity(kind, identity) {
    if (kind === "device") enqueueOp({ kind: "delete-device", deviceName: identity.name });
    else if (kind === "network") enqueueOp({ kind: "delete-network", networkName: identity.name });
    else if (kind === "link") enqueueOp({ kind: "delete-link", link: { a: { device: identity.a }, b: { device: identity.b } } });
    else enqueueOp({ kind: "detach-network", networkName: identity.net, attach: { device: identity.device } });
    clearSelection();
  }

  // menuItemsFor собирает пункты меню объекта: редактирование фильтра
  // (только у связей), членство в объединениях (только у узлов) и удаление
  // с подписью по типу; объединения — до danger. kind/identity фиксируются
  // здесь как строки (имя устройства/сети, пара {a,b} связи, {net,device}
  // привязки), а не как ссылки на obj/State.topology.unions[i] — те могут
  // устареть до клика (см. setUnion и deleteByIdentity выше).
  function menuItemsFor(obj, nodeType, at) {
    const key = nodeType === "device" ? "devices" : nodeType === "network" ? "networks" : null;
    const isLink = !key && obj.type !== "attach";
    const kind = key === "devices" ? "device" : key === "networks" ? "network" : isLink ? "link" : "attach";
    const identity = kind === "link" ? { a: obj.a.device, b: obj.b.device }
      : kind === "attach" ? { net: obj.net.name, device: obj.device }
      : { name: obj.name };
    const label = nodeType === "device" ? `устройство ${obj.name}`
      : nodeType === "network" ? `сеть ${obj.name}`
      : obj.type === "attach" ? `привязка ${obj.net.name}–${obj.device}`
      : `${obj.filter ? "фильтрованная связь" : "связь"} ${obj.a.device}–${obj.b.device}`;
    const items = [];
    // «Редактировать» недоступно, пока create-link этой связи ещё не
    // подтверждён сервером (см. isLinkCreatePending) — настройка фильтра
    // требует сохранённой топологии.
    if (isLink) items.push(["Редактировать", isLinkCreatePending(obj.a.device, obj.b.device) ? null : () => openLinkPanel(obj, at)]);
    if (key) {
      const inSet = (s) => (s[key] || []).includes(obj.name);
      if ((State.topology.unions || []).some(inSet)) {
        items.push(["Убрать из объединения", () => setUnion(obj.name, key, null)]);
      }
      const candidates = (State.topology.unions || [])
        .filter((s) => !inSet(s))
        .map((s) => [`В объединение «${s.name}»`, () => setUnion(obj.name, key, s.name), null, true, s.name]);
      items.push({
        label: "Добавить в объединение",
        children: candidates.length ? candidates : [["(нет доступных объединений)", null]],
        searchable: candidates.length > 1,
      });
    }
    items.push(["Удалить " + label, () => deleteByIdentity(kind, identity), "danger"]);
    return items;
  }

  // Контекстное меню канвы: ПКМ по объекту в режиме select или по связи
  // в режиме connect.
  // Платформы шлют contextmenu в разное время: пока ПКМ зажата (Linux)
  // ждём чистый mouseup через ctxPending, после отпускания открываем сразу.
  function setupContextMenu() {
    canvas().addEventListener("contextmenu", (e) => {
      if (State.tool !== "select" && State.tool !== "connect") return;
      e.preventDefault();
      const hit = HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z);
      const isNode = hit && (hit.nodeType === "device" || hit.nodeType === "network");
      const isConnection = hit && (hit.id.startsWith("link:") || hit.id.startsWith("attach:"));
      if (!hit || !(isNode || isConnection) || (State.tool === "connect" && !isConnection)) return;
      const at = screenPoint(e);
      const items = menuItemsFor(hit.ref, hit.nodeType, at);
      if (camControls && camControls.isRightDown()) ctxPending = { items, at };
      else showContextMenu(at, items);
    });
    document.addEventListener("click", hideContextMenu);
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

  // marqueeSelect выбирает узлы, чьи bbox пересекают мировой прямоугольник.
  function marqueeSelect(rect, extend) {
    if (!extend) State.selection.clear();
    HitTest.pickNodes(State.list, rect).forEach((it) => State.selection.add(it.ref));
    render();
  }

  // deleteSelection drops every selected device/network/link plus any
  // selected attachments ({type:"attach", net, device} entries). The
  // server's delete-device/delete-network operations already cascade
  // (drop links/attachments/union membership/layout position that
  // reference the deleted object — topology_operations.go's delete-device
  // case), so a link or attach entry only gets its own explicit
  // delete-link/detach-network op when NEITHER of its endpoints is also
  // being deleted this batch; otherwise the cascade already removes it
  // server-side, and sending the now-redundant op would 422 ("unknown
  // link"/"not attached"). Selection AND each entry's kind (device/network/
  // link/attach) are captured up front, from the State.topology in effect
  // before any enqueue: enqueueOp can synchronously replace both
  // State.selection (TopologySync.onState → reconcileSelection) and
  // State.topology (new object identities even for untouched entries —
  // cloneSnapshot always produces fresh network/union objects) partway
  // through this function, so nothing below may re-derive a classification
  // by re-checking the live State against a stale object reference.
  function deleteSelection() {
    if (!State.selection.size) return;
    const selected = [...State.selection];
    const classify = (s) => {
      if (!s) return "none";
      if (s.type === "attach") return "attach";
      if (State.topology.devices.includes(s)) return "device";
      if (State.topology.networks.includes(s)) return "network";
      return "link";
    };
    const kinds = selected.map(classify);
    const deletedDevices = new Set(selected.filter((s, i) => kinds[i] === "device").map((d) => d.name));
    const deletedNetworks = new Set(selected.filter((s, i) => kinds[i] === "network").map((n) => n.name));

    selected.forEach((s, i) => { if (kinds[i] === "device") enqueueOp({ kind: "delete-device", deviceName: s.name }); });
    selected.forEach((s, i) => { if (kinds[i] === "network") enqueueOp({ kind: "delete-network", networkName: s.name }); });
    selected.forEach((s, i) => {
      if (kinds[i] === "attach") {
        if (!deletedNetworks.has(s.net.name) && !deletedDevices.has(s.device)) {
          enqueueOp({ kind: "detach-network", networkName: s.net.name, attach: { device: s.device } });
        }
      } else if (kinds[i] === "link") {
        if (!deletedDevices.has(s.a.device) && !deletedDevices.has(s.b.device)) {
          enqueueOp({ kind: "delete-link", link: { a: { device: s.a.device }, b: { device: s.b.device } } });
        }
      }
    });
    clearSelection();
  }

  // --- выбор, рамка и перетаскивание: единый mousedown на канвасе ---

  let marqueeEnded = false; // swallows the click a browser fires after a drag

  // startMarquee тянет рамку в мировых координатах; отрисовка — оверлеем
  // канвы. Рамка без движения мышью выделением не считается.
  function startMarquee(e) {
    marqueeEnded = false;
    let start = null;
    function onMove(ev) {
      const p = toWorld(screenPoint(ev));
      if (!start) start = toWorld(screenPoint(e));
      marqueeRect = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      view.invalidate();
    }
    function onUp(ev) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!start) return; // клик без движения — не рамка
      const rect = marqueeRect;
      marqueeRect = null;
      marqueeEnded = true;
      marqueeSelect(rect, ev.shiftKey);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // startNodeDrag переносит всю selection (или один узел) группой; порог
  // 3px отличает перетаскивание от клика. onMove — чисто локальная правка
  // (без enqueue, чтобы не слать операцию на каждый кадр); onUp ставит в
  // очередь по одной set-*-position на каждый передвинутый узел. State.layout
  // читается заново на каждом кадре (не кэшируется при старте драга): фоновая
  // синхронизация может подменить весь снимок State.layout за время долгого
  // драга (TopologySync.onState), и запись должна попасть в актуальный объект.
  function startNodeDrag(obj, e) {
    const start = screenPoint(e);
    const group = [];
    const addObj = (o) => {
      if (State.topology.devices.includes(o)) {
        if (State.layout.devices[o.name]) group.push({ kind: "device", name: o.name, pos: { ...State.layout.devices[o.name] } });
      } else if (State.topology.networks.includes(o)) {
        if (State.layout.networks[o.name]) group.push({ kind: "network", name: o.name, pos: { ...State.layout.networks[o.name] } });
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
      if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) { moved = true; NetInfo.hide(); LinkPanel.hide(); }
      group.forEach((g) => {
        const map = g.kind === "device" ? State.layout.devices : State.layout.networks;
        map[g.name] = { x: g.pos.x + dx, y: g.pos.y + dy };
      });
      render();
    }
    function onUp(ev) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (moved) {
        group.forEach((g) => {
          const map = g.kind === "device" ? State.layout.devices : State.layout.networks;
          enqueueOp({
            kind: g.kind === "device" ? "set-device-position" : "set-network-position",
            ...(g.kind === "device" ? { deviceName: g.name } : { networkName: g.name }),
            position: map[g.name],
          });
        });
      } else onPlainClick(obj, ev);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // linkDupIndex находит порядковый номер link среди параллельных связей той
  // же пары устройств — тот же индекс, что использует NetMap.linkOffsets
  // при разводке кривых, здесь адресует layout.links[key][idx].
  function linkDupIndex(link) {
    const key = [link.a.device, link.b.device].sort().join("|");
    const offsets = NetMap.linkOffsets(State.topology.links);
    return { key, idx: offsets[State.topology.links.indexOf(link)] };
  }

  const linkABFromKey = (key) => { const [a, b] = key.split("|"); return { a: { device: a }, b: { device: b } }; };

  // addWaypoint вставляет точку изгиба в место клика на связи, между
  // ближайшей парой соседних точек (концы устройств или уже существующие
  // точки изгиба), и ставит в очередь set-link-waypoints с целым
  // пересчитанным layout.links[key] (см. вики операций: waypoints — весь
  // массив параллельных связей этой пары, не одна точка).
  function addWaypoint(link, p) {
    const { key, idx } = linkDupIndex(link);
    const arr = (State.layout.links[key] || []).map((dup) => [...dup]);
    while (arr.length <= idx) arr.push([]);
    const wps = arr[idx];
    const points = [deviceCenter(link.a.device), ...wps, deviceCenter(link.b.device)];
    wps.splice(NetMap.insertIndex(points, p), 0, { x: p.x, y: p.y });
    selectNode(link, false);
    enqueueOp({ kind: "set-link-waypoints", link: { a: { device: link.a.device }, b: { device: link.b.device } }, waypoints: arr });
  }

  // removeWaypoint удаляет одну точку изгиба по ссылке хендла ({key, dupIdx, idx}).
  function removeWaypoint(ref) {
    const dup = State.layout.links[ref.key] && State.layout.links[ref.key][ref.dupIdx];
    if (!dup) return;
    const arr = State.layout.links[ref.key].map((d, i) => (i === ref.dupIdx ? d.filter((_, j) => j !== ref.idx) : d));
    enqueueOp({ kind: "set-link-waypoints", link: linkABFromKey(ref.key), waypoints: arr });
  }

  // startPointDrag тащит одну точку изгиба связи; onMove правит layout
  // локально (перечитывая State.layout на каждом кадре — см. startNodeDrag),
  // onUp ставит в очередь итоговый layout.links[key] целиком.
  function startPointDrag(ref, e) {
    function onMove(ev) {
      const arr = State.layout.links[ref.key] && State.layout.links[ref.key][ref.dupIdx];
      if (!arr) return;
      arr[ref.idx] = toWorld(screenPoint(ev));
      render();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const arr = State.layout.links[ref.key];
      if (arr) enqueueOp({ kind: "set-link-waypoints", link: linkABFromKey(ref.key), waypoints: arr });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // onCanvasDblClick: двойной клик по точке изгиба удаляет её, по связи —
  // добавляет новую точку в месте клика (и выделяет связь).
  function onCanvasDblClick(e) {
    if (State.tool !== "select") return;
    const hit = HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z);
    if (!hit) return;
    if (hit.nodeType === "linkpoint") removeWaypoint(hit.ref);
    else if (hit.id.startsWith("link:")) addWaypoint(hit.ref, toWorld(screenPoint(e)));
  }

  // onPlainClick: клик по узлу без движения — connect/select/NetInfo.
  function onPlainClick(obj, ev) {
    const isDev = State.topology.devices.includes(obj);
    if (State.tool === "connect") isDev ? onDeviceConnect(obj.name) : onNetworkClick(obj.name);
    else if (State.tool === "select") {
      selectNode(obj, ev.shiftKey);
      LinkPanel.hide();
      isDev ? NetInfo.hide() : showNetInfo(obj);
    }
  }

  // setupSelection: левая кнопка выбирает/тащит узлы, выделяет связи и
  // привязки, на пустом месте в режиме select тянет рамку.
  function setupSelection() {
    canvas().addEventListener("mousedown", (e) => {
      if (e.button !== 0 || State.tool === "device" || State.tool === "network") return;
      const hit = HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z);
      if (!hit) {
        if (State.tool === "select") startMarquee(e);
        return;
      }
      if (hit.nodeType === "linkpoint") startPointDrag(hit.ref, e);
      else if (hit.nodeType) startNodeDrag(hit.ref, e);
      else if (hit.id.startsWith("link:") || hit.id.startsWith("attach:")) selectNode(hit.ref, e.shiftKey);
    });
    canvas().addEventListener("dblclick", onCanvasDblClick);
    document.addEventListener("keydown", (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && State.selection.size) deleteSelection();
      const shortcuts = { v: "select", c: "connect", d: "device", n: "network" };
      if (shortcuts[e.key]) setTool(shortcuts[e.key]);
    });
  }

  function setTool(tool) {
    if (isReadOnly() && tool !== State.tool) return;
    State.tool = tool;
    cancelPending();
    hidePopover();
    NetInfo.hide();
    LinkPanel.hide();
    TOOLS.forEach((t) => {
      const btn = document.getElementById("tool-" + t);
      btn.setAttribute("class", "tool" + (t === tool ? " active" : ""));
    });
  }

  function setupTools() {
    const readOnly = isReadOnly();
    TOOLS.forEach((t) => {
      const btn = document.getElementById("tool-" + t);
      btn.disabled = readOnly;
      btn.addEventListener("click", () => setTool(t));
    });
    document.getElementById("topo-fit").addEventListener("click", fitMap);
    canvas().addEventListener("click", (e) => {
      if (marqueeEnded) { marqueeEnded = false; return; } // click trailing the marquee drag
      // клик по узлу/связи уже обработан их mousedown — фону он не адресован
      if (HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z)) return;
      NetInfo.hide(); // окно состава сети закрывает только клик по фону
      LinkPanel.hide();
      clearSearch(); // клик по пустому фону сбрасывает активный поиск
      if (State.tool === "device" || State.tool === "network") openNodePopover(screenPoint(e), State.tool);
      else {
        cancelPending();
        clearSelection();
      }
    });
  }

  // openNodePopover shows the inline naming form at a screen point; the
  // node is created at the popover click's world position. The box is
  // clamped into the canvas so it never opens out of view near the edges,
  // and it stays anchored to that world point while the camera moves.
  function openNodePopover(at, kind) {
    const box = document.getElementById("node-popover");
    const MARGIN = 8;
    const clamp = (v, max) => Math.min(Math.max(v, MARGIN), Math.max(MARGIN, max));
    box.hidden = false;
    // measure only once visible: a hidden box has zero offsetWidth/Height
    const w = box.offsetWidth || 240;
    const h = box.offsetHeight || 48;
    const r = canvas().getBoundingClientRect();
    box.style.left = clamp(at.x, r.width - w - MARGIN) + "px";
    box.style.top = clamp(at.y, r.height - h - MARGIN) + "px";
    document.getElementById("node-kind-select").hidden = kind !== "device";
    document.getElementById("node-name-input").focus();
    popoverWorld = toWorld(at);
    popoverCreate = (name) => createNode(kind, name, popoverWorld);
  }

  // movePopover repositions the open popover to its anchored world point
  function movePopover() {
    if (!popoverWorld) return;
    const p = Camera.worldToScreen(State.camera, popoverWorld.x, popoverWorld.y);
    const box = document.getElementById("node-popover");
    box.style.left = p.x + "px";
    box.style.top = p.y + "px";
  }

  function hidePopover() {
    const box = document.getElementById("node-popover");
    if (!box) return;
    box.hidden = true;
    document.getElementById("node-name-form").reset();
    popoverCreate = null;
    popoverWorld = null;
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

  // --- поиск ---

  const parseV4 = (s) => {
    const p = String(s).split(".").map(Number);
    return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      ? (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0) : null;
  };

  // ipInCidr true, если q — полный IPv4-адрес, попадающий в префикс cidr
  function ipInCidr(q, cidr) {
    const ip = parseV4(q);
    if (ip === null) return false;
    const [addr, bits] = String(cidr).split("/");
    const base = parseV4(addr);
    if (base === null || !bits || +bits < 0 || +bits > 32) return false;
    const mask = (~0 << (32 - +bits)) >>> 0;
    return (ip & mask) === (base & mask);
  }

  // computeSearchHits: устройства по имени; сети по имени или по имени/CIDR
  // любой из их подсетей (совпадение подсети подсвечивает родительскую сеть)
  function computeSearchHits(raw) {
    const q = raw.trim().toLowerCase();
    if (!q) return [];
    const subMatch = (name) => {
      const s = State.subnets.find((x) => x.name === name);
      return !!s && (s.name.toLowerCase().includes(q)
        || String(s.cidr).toLowerCase().includes(q)
        || ipInCidr(q, s.cidr));
    };
    return [
      ...State.topology.devices.filter((d) => d.name.toLowerCase().includes(q)),
      ...State.topology.networks.filter((n) => n.name.toLowerCase().includes(q) || (n.subnets || []).some(subMatch)),
    ];
  }

  // fitNode считает камеру, центрирующую bbox узла, или null без позиции.
  function fitNode(obj) {
    const isDev = State.topology.devices.includes(obj);
    const pos = (isDev ? State.layout.devices : State.layout.networks)[obj.name];
    if (!pos) return null;
    const w = isDev ? DEVICE_W : NET_W;
    const h = isDev ? DEVICE_H : NET_H;
    const r = canvas().getBoundingClientRect();
    return {
      ...State.camera,
      x: r.width / 2 - State.camera.z * (pos.x + w / 2),
      y: r.height / 2 - State.camera.z * (pos.y + h / 2),
    };
  }

  // затемнение поиска проявляется/гаснет твином (канал "fade")
  function tweenSearchFade(to) {
    const tw = Tween.create();
    tw.to(State, { searchFade: to }, 180);
    animate("fade", tw, render);
  }

  function updateSearch(raw) {
    searchQ = raw.trim().toLowerCase();
    searchHits = computeSearchHits(searchQ);
    searchSet = new Set(searchHits);
    hitIdx = 0;
    const target = searchHits.length && fitNode(searchHits[0]);
    if (target) flyCam(target, 180);
    tweenSearchFade(searchQ ? 1 : 0);
    render();
  }

  function clearSearch() {
    const input = document.getElementById("topo-search");
    input.value = "";
    updateSearch("");
    if (input.blur) input.blur();
    input.hidden = true;
  }

  function setupSearch() {
    const input = document.getElementById("topo-search");
    const toggle = document.getElementById("topo-search-toggle");
    input.hidden = true;
    toggle.addEventListener("click", () => {
      input.hidden = false;
      input.focus();
    });
    input.addEventListener("input", () => updateSearch(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") clearSearch();
      else if (e.key === "Enter" && searchHits.length) {
        hitIdx = (hitIdx + 1) % searchHits.length;
        const target = fitNode(searchHits[hitIdx]);
        if (target) flyCam(target, 180);
      }
    });
    // пустое поле, потерявшее фокус, прячем; активный запрос оставляем видимым
    input.addEventListener("blur", () => {
      if (!input.value) input.hidden = true;
    });
  }

  // --- pop появления узлов: id сцены → performance.now() создания ---

  const pops = new Map();
  const popOf = (id) => {
    const t0 = pops.get(id);
    return t0 === undefined ? undefined : Math.min(1, (performance.now() - t0) / 180);
  };
  let popping = false;
  function popStep() {
    const now = performance.now();
    for (const [id, t0] of pops) if (now - t0 >= 180) pops.delete(id);
    render();
    if (pops.size) requestAnimationFrame(popStep);
    else popping = false;
  }

  // createNode ставит в очередь create-device/create-network, затем сразу
  // set-device-position/set-network-position той же цели — два отдельных
  // enqueue подряд (создание без позиции неразделимо в протоколе операций),
  // не коалесцирующих между собой (разные kind), так что очередь отправит
  // их по порядку: создание всегда доедет раньше позиции.
  function createNode(kind, name, world) {
    if (kind === "device") {
      const nodeKind = document.getElementById("node-kind-select").value || "router";
      if (State.topology.devices.some((d) => d.name === name)) return showBanner(`Устройство ${name} уже существует`);
      enqueueOp({ kind: "create-device", device: { name, kind: nodeKind } });
      enqueueOp({ kind: "set-device-position", deviceName: name, position: { x: world.x - DEVICE_W / 2, y: world.y - DEVICE_H / 2 } });
    } else {
      if (State.topology.networks.some((n) => n.name === name)) return showBanner(`Сеть ${name} уже существует`);
      enqueueOp({ kind: "create-network", network: { name, subnets: [], attach: [] } });
      enqueueOp({ kind: "set-network-position", networkName: name, position: { x: world.x - NET_W / 2, y: world.y - NET_H / 2 } });
    }
    pops.set(`${kind}:${name}`, performance.now());
    if (!popping) {
      popping = true;
      requestAnimationFrame(popStep);
    }
    render();
  }

  function cancelPending() {
    pending = null;
    previewWire = null;
    render();
  }

  // animate гонит твин кадрами rAF; повторный запуск того же канала
  // вытесняет незавершённую анимацию (новый полёт камеры не спорит со старым)
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

  // flyCam плавно ведёт камеру к цели (кнопка «вписать», поиск)
  function flyCam(to, ms = 250) {
    const cur = { ...State.camera };
    const tw = Tween.create();
    tw.to(cur, to, ms);
    animate("cam", tw, () => setCamera({ ...cur }));
  }

  // fitMap вписывает всю топологию во вьюпорт анимацией камеры
  function fitMap() {
    ensureLayout();
    const b = TopoScene.bounds(State.topology, State.layout);
    if (!b) return;
    const r = canvas().getBoundingClientRect();
    flyCam(Camera.fitView(State.camera, b, Math.round(r.width), Math.round(r.height), 60));
  }

  // --- указатель: превью связи, курсор и тултипы ---

  // setupPointer ведёт mousemove канвы: пунктир от pending-устройства
  // к курсору в режиме connect; cursor grab над узлами и pointer над
  // связями. Клик по фильтрованной связи закрепляет тултип meta.tooltip;
  // клик мимо или уход с канвы его снимает.
  function setupPointer() {
    const tip = document.getElementById("topo-tooltip");
    tip.hidden = true;
    const hideTip = () => { tip.hidden = true; };
    canvas().addEventListener("mousemove", (e) => {
      const p = screenPoint(e);
      const hit = HitTest.pick(State.list, toWorld(p), State.camera.z);
      canvas().style.cursor = hit ? (hit.nodeType ? "grab" : "pointer") : "default";
      previewWire = null;
      if (pending && State.tool === "connect") {
        const from = pending.device ? deviceCenter(pending.device) : netCenter(pending.network);
        if (from) {
          const to = toWorld(p);
          previewWire = {
            kind: "path",
            geom: { segs: [{ x1: from.x, y1: from.y, cx: (from.x + to.x) / 2, cy: (from.y + to.y) / 2, x2: to.x, y2: to.y }] },
            style: { stroke: theme.accent, lineWidth: 1.5, dash: [6, 4] },
          };
        }
      }
      // hover сам по себе сцену не меняет — перерисовываем только когда есть
      // динамический оверлей (превью связи), чтобы не гонять красный кадр
      if (previewWire) view.invalidate();
    });
    canvas().addEventListener("click", (e) => {
      const p = screenPoint(e);
      const hit = HitTest.pick(State.list, toWorld(p), State.camera.z);
      if (!hit || !hit.meta || !hit.meta.filter) return hideTip();
      const f = hit.meta.filter;
      const route = (from, to, xs) =>
        `<div class="tip-route"><b>${from}</b> → <b>${to}</b></div>` +
        (xs.length
          ? `<div>${xs.map((x) => `<span class="owner-badge">${x}</span>`).join("")}</div>`
          : `<div class="hint">ничего</div>`);
      tip.innerHTML = route(f.a, f.b, f.aExports) + route(f.b, f.a, f.bExports);
      tip.style.left = p.x + 14 + "px";
      tip.style.top = p.y + 14 + "px";
      tip.hidden = false;
    });
    canvas().addEventListener("mouseleave", hideTip);
    canvas().addEventListener("mousedown", hideTip); // жест начался — подсказка ни к чему
  }

  // attachDevice — общий хвост connect «сеть–устройство» в обе стороны.
  function attachDevice(netName, device) {
    const net = State.topology.networks.find((n) => n.name === netName);
    if ((net.attach || []).some((a) => a.device === device)) {
      showBanner(`Сеть ${netName} уже подключена к ${device}`);
      cancelPending();
      return;
    }
    enqueueOp({ kind: "attach-network", networkName: netName, attach: { device } });
    cancelPending();
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
    if (pending.network) {
      attachDevice(pending.network, device);
      return;
    }
    const [a, b] = [pending.device, device].sort();
    if (State.topology.links.some((l) => [l.a.device, l.b.device].sort().join("|") === `${a}|${b}`)) {
      showBanner(`Устройства ${a} и ${b} уже соединены`);
      cancelPending();
      return;
    }
    enqueueOp({ kind: "create-link", link: { a: { device: pending.device }, b: { device } } });
    cancelPending();
  }

  function onNetworkClick(netName) {
    if (!pending) {
      pending = { network: netName };
      render();
      return;
    }
    if (!pending.network) {
      attachDevice(netName, pending.device);
      return;
    }
    if (pending.network === netName) {
      cancelPending();
      return;
    }
    showBanner(`Сети ${[pending.network, netName].sort().join(" и ")} не могут быть соединены напрямую`);
    cancelPending();
  }

  const attachSelected = (n, device) =>
    [...State.selection].some((s) => s.type === "attach" && s.net === n && s.device === device);

  // mark — класс поиска для контурной формы узла: совпавшие светятся
  // (search-hit), остальные приглушены; вне активного поиска — пусто.
  // shade — для внутренностей узла (глиф, подписи): они сами не светятся,
  // чтобы не засвечивать содержимое, а лишь следуют за своим узлом.
  const mark = (matched) => (searchQ ? (matched ? " search-hit" : " search-dim") : "");
  const shade = (matched) => (searchQ && !matched ? " search-dim" : "");

  // nodeClasses адаптирует TopoScene к состоянию редактора: контур узла
  // получает выделение/pending/подсветку поиска, внутренности — только
  // затемнение при поиске; привязки сравниваются по полям, не по ссылке.
  const nodeClasses = (obj, part) => {
    if (obj && obj.type === "attach") {
      return (part === "shape" ? (attachSelected(obj.net, obj.device) ? " selected" : "") : "") + mark(false);
    }
    if (part === "shape") {
      return (State.selection.has(obj) ? " selected" : "")
        + (pending && obj.name !== undefined && (pending.device === obj.name || pending.network === obj.name) ? " pending" : "")
        + mark(searchSet.has(obj));
    }
    return shade(searchSet.has(obj));
  };

  // getOverlay — динамические элементы поверх сцены: превью связи и рамка.
  const getOverlay = () => [
    ...(previewWire ? [previewWire] : []),
    ...(marqueeRect ? [{
      kind: "rrect",
      geom: { ...marqueeRect, r: 0 },
      style: { stroke: theme.accent, lineWidth: 1, dash: [4, 3], fill: theme.accent, fillAlpha: 0.08 },
    }] : []),
  ];

  const linkKeyOf = (l) => [l.a.device, l.b.device].sort().join("|");

  // reconcileSelection re-points every selection entry to its equivalent
  // object in the just-replaced State.topology (matched by name / endpoint
  // pair / attach net+device — array-position and object identity are not
  // stable across a TopologySync snapshot swap, see onState below), dropping
  // entries whose target no longer exists. Without this, selection
  // highlighting (nodeClasses/attachSelected use identity — State.selection.has(obj))
  // and the trash button's enabled state would silently desync from the
  // canvas after every confirmed or locally-projected edit.
  function reconcileSelection() {
    const next = new Set();
    State.selection.forEach((s) => {
      if (!s) return;
      if (s.type === "attach") {
        const net = State.topology.networks.find((n) => n.name === s.net.name);
        if (net && (net.attach || []).some((a) => a.device === s.device)) next.add({ type: "attach", net, device: s.device });
        return;
      }
      if (s.a && s.b) {
        const link = State.topology.links.find((l) => linkKeyOf(l) === linkKeyOf(s));
        if (link) next.add(link);
        return;
      }
      const dev = State.topology.devices.find((d) => d.name === s.name);
      if (dev) { next.add(dev); return; }
      const net = State.topology.networks.find((n) => n.name === s.name);
      if (net) next.add(net);
    });
    State.selection = next;
  }

  // renderSyncStatus reflects TopologySync's three onStatus states in the
  // toolbar's status indicator (aria-live, replaces the removed DirtyGuard
  // warning as the only signal an edit persisted) and, on error, also
  // surfaces a banner: a silent label is easy to miss when a queued edit
  // just got dropped after a 409/422/network failure.
  function renderSyncStatus(status) {
    const el = document.getElementById("topo-sync-status");
    if (!el) return;
    const states = {
      saved: {
        label: "Сохранено",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
      },
      saving: {
        label: "Сохраняется…",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4M4 13a8 8 0 0 0 14.9 4"/><path d="M5 3v4h4M19 21v-4h-4"/></svg>',
      },
      error: {
        label: "Ошибка синхронизации",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 10 18H2z"/><path d="M12 9v4M12 17h.01"/></svg>',
      },
    };
    const state = states[status] || states.saved;
    el.innerHTML = state.icon;
    el.setAttribute("class", "sync-status " + status);
    el.setAttribute("data-status", status);
    el.setAttribute("aria-label", state.label);
    el.setAttribute("title", state.label);
    if (status === "error") {
      showBanner("Не удалось сохранить последнее изменение: черновик мог измениться в другой вкладке, либо прервалась связь. Повторите действие.");
    }
  }

  function render() {
    ensureLayout();
    State.list = TopoScene.buildScene(State, {
      theme,
      classes: nodeClasses,
      popOf,
      fade: { dim: State.searchFade },
      editable: (obj) => State.selection.has(obj),
    }).list;
    view.invalidate();
    minimap.update();
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

  async function boot() {
    renderSyncStatus("saved");
    try {
      const [topo, subnetsDoc] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
      State.topology = normalizeTopology(topo);
      State.subnets = subnetsDoc.subnets || [];
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    try {
      const layout = await Api.get(apiPath("layout"));
      State.layout = normalizeLayout(layout);
    } catch {
      State.layout = normalizeLayout({});
    }
    State.camera = loadCamera() || State.layout.camera;
    theme = CanvasTheme.fromComputed(getComputedStyle(document.documentElement));
    view = CanvasView.create(canvas(), {
      getList: () => State.list,
      getCam: () => State.camera,
      getOverlay,
      textHideZoom: theme.textHideZoom,
    });
    minimap = Minimap.create(document.getElementById("topo-minimap"), {
      getBounds: () => TopoScene.bounds(State.topology, State.layout),
      getPoints: () => [
        ...State.topology.devices.map((d) => deviceCenter(d.name)),
        ...State.topology.networks.map((n) => netCenter(n.name)),
      ].filter(Boolean),
      getCam: () => State.camera,
      setCam: setCamera,
      getViewport: () => { const r = canvas().getBoundingClientRect(); return { w: r.width, h: r.height }; },
      getTheme: () => theme,
    });

    // TopologySync (topology_sync.js) owns the confirmed+projected snapshot
    // from here on: every canvas edit goes through enqueueOp, never a
    // direct State.topology/State.layout write (see
    // docs/superpowers/specs/2026-08-27-topology-draft-sync-design.md,
    // "Клиентский поток"). seed() is called once, right after this initial
    // load, with the real starting snapshot — never before.
    sync = TopologySync.create({
      read: () => State,
      write: (op) => Api.post(apiPath("topology/operations"), op)
        .then((res) => ({ topology: normalizeTopology(res.topology), layout: normalizeLayout(res.layout) })),
      apply: applyTopologyOp,
      onState: (snapshot) => {
        State.topology = snapshot.topology;
        State.layout = snapshot.layout;
        reconcileSelection();
        render();
      },
      onStatus: renderSyncStatus,
      reload: () => Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("layout"))])
        .then(([t, l]) => ({ topology: normalizeTopology(t), layout: normalizeLayout(l) })),
    });
    sync.seed({ topology: State.topology, layout: { ...State.layout, camera: State.camera } });

    setupCamera();
    setupTools();
    setupSelection();
    setupDeleteButton();
    setupPointer();
    setupContextMenu();
    setupPopover();
    setupSearch();
    NetInfo.attach(canvas());
    LinkPanel.attach(canvas());
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
