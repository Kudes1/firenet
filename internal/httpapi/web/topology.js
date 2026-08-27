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

// Topology renders devices/links/networks on a canvas the user builds
// the network on directly. A network is one L2 segment: click a device,
// then a network node, to attach the segment to that device. Subnet
// membership of networks is edited on /ui/subnets and /ui/networks.
const Topology = (() => {
  const { DEVICE_W, DEVICE_H, NET_W, NET_H } = NetMap;

  let theme = null; // CanvasTheme страницы
  let view = null; // CanvasView поверх #topo-canvas
  let pending = null; // {device|network} — узел, ожидающий пару в режиме connect
  let saveLayoutTimer = null;
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

  // openLinkPanel открывает плавающую панель редактирования фильтра связи
  // в экранной точке at (правый клик, из контекстного меню). Правки идут в
  // State.topology.links в памяти, как и остальные правки канвы — сохранение
  // общей кнопкой «Сохранить», не отдельным запросом.
  function openLinkPanel(link, at) {
    const index = State.topology.links.indexOf(link);
    if (index < 0) return;
    const r = canvas().getBoundingClientRect();
    LinkPanel.show(link, index, {
      subnets: State.subnets,
      fetchExports: (i, side) => Api.get(apiPath(`link-exports?link=${i}&side=${side}`)).then((res) => res.entities || []),
      onApply: (filter) => {
        const { filter: _drop, ...rest } = link;
        State.topology.links[index] = filter ? { ...rest, filter } : rest;
        render();
      },
    }, at, { w: r.width, h: r.height });
  }

  function scheduleLayoutSave() {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      try {
        assertEditable();
      } catch {
        return; // read-only tab: nothing to persist
      }
      Api.put(apiPath("layout"), { ...State.layout, camera: State.camera }).catch(() => {
        /* layout is best-effort presentation state */
      });
    }, 400);
  }

  // setupCamera wires wheel zoom (anchored at the cursor) and pan by
  // middle/right-button drag via the shared CameraControls; both persist
  // through the debounced layout save. Left button stays free for selection
  // and node dragging (setupSelection).
  function setupCamera() {
    camControls = CameraControls.wire(canvas(), {
      getCam: () => State.camera,
      setCam: (c) => { State.camera = c; applyCamera(); },
      buttons: [1, 2],
      onChange: scheduleLayoutSave,
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
            wrap.addEventListener("mouseenter", () => search.focus());
          }
          wrap.append(mkItem(it.label, null, null, true), sub);
          fill(sub, it.children);
          parent.append(wrap);
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

  // setUnion перемещает объект в объединение idx (или из всех объединений при idx < 0).
  function setUnion(name, key, idx) {
    State.topology.unions.forEach((s) => { s[key] = (s[key] || []).filter((n) => n !== name); });
    if (idx >= 0) {
      const s = State.topology.unions[idx];
      s[key] = [...(s[key] || []), name];
    }
    render();
  }

  // menuItemsFor собирает пункты меню объекта: редактирование фильтра
  // (только у связей), членство в объединениях (только у узлов) и удаление
  // с подписью по типу; объединения — до danger.
  function menuItemsFor(obj, nodeType, at) {
    const key = nodeType === "device" ? "devices" : nodeType === "network" ? "networks" : null;
    const isLink = !key && obj.type !== "attach";
    const label = nodeType === "device" ? `устройство ${obj.name}`
      : nodeType === "network" ? `сеть ${obj.name}`
      : obj.type === "attach" ? `привязка ${obj.net.name}–${obj.device}`
      : `${obj.filter ? "фильтрованная связь" : "связь"} ${obj.a.device}–${obj.b.device}`;
    const items = [];
    if (isLink) items.push(["Редактировать", () => openLinkPanel(obj, at)]);
    if (key) {
      const inSet = (s) => (s[key] || []).includes(obj.name);
      if ((State.topology.unions || []).some(inSet)) {
        items.push(["Убрать из объединения", () => setUnion(obj.name, key, -1)]);
      }
      const candidates = (State.topology.unions || [])
        .filter((s) => !inSet(s))
        .map((s) => [`В объединение «${s.name}»`, () => setUnion(obj.name, key, State.topology.unions.indexOf(s)), null, true, s.name]);
      items.push({
        label: "Добавить в объединение",
        children: candidates.length ? candidates : [["(нет доступных объединений)", null]],
        searchable: candidates.length > 1,
      });
    }
    items.push(["Удалить " + label, () => {
      State.selection.clear();
      State.selection.add(obj);
      deleteSelection();
      scheduleLayoutSave();
    }, "danger"]);
    return items;
  }

  // Контекстное меню канвы: правый клик по объекту в режиме select.
  // Платформы шлют contextmenu в разное время: пока ПКМ зажата (Linux)
  // ждём чистый mouseup через ctxPending, после отпускания открываем сразу.
  function setupContextMenu() {
    canvas().addEventListener("contextmenu", (e) => {
      if (State.tool !== "select") return;
      e.preventDefault();
      const hit = HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z);
      const isNode = hit && (hit.nodeType === "device" || hit.nodeType === "network");
      if (!hit || !(isNode || hit.id.startsWith("link:") || hit.id.startsWith("attach:"))) return;
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
  // selected attachments ({type:"attach", net, device} entries). Deleting a
  // device also cascades to links and attachments that reference it, so the
  // topology never ends up with dangling references the server would reject.
  function deleteSelection() {
    if (!State.selection.size) return;
    const deletedDevices = new Set();
    State.selection.forEach((s) => {
      if (s && s.type === "attach") s.net.attach = s.net.attach.filter((a) => a.device !== s.device);
    });
    State.topology.devices = State.topology.devices.filter((d) => {
      if (State.selection.has(d)) {
        delete State.layout.devices[d.name];
        dropMember(d.name, "devices");
        deletedDevices.add(d.name);
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
    if (deletedDevices.size) {
      State.topology.networks.forEach((n) => {
        n.attach = n.attach.filter((a) => !deletedDevices.has(a.device));
      });
    }
    State.topology.links = State.topology.links.filter((l) => {
      if (State.selection.has(l)) return false;
      return !deletedDevices.has(l.a.device) && !deletedDevices.has(l.b.device);
    });
    clearSelection();
  }

  // dropMember вычищает имя удалённого объекта из членства объединений.
  function dropMember(name, key) {
    (State.topology.unions || []).forEach((s) => { s[key] = (s[key] || []).filter((n) => n !== name); });
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

  // startNodeDrag переносит всю selection (или один узел) группой;
  // порог 3px отличает перетаскивание от клика.
  function startNodeDrag(obj, e) {
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
      if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) { moved = true; NetInfo.hide(); LinkPanel.hide(); }
      group.forEach((g) => { g.map[g.name] = { x: g.pos.x + dx, y: g.pos.y + dy }; });
      render();
    }
    function onUp(ev) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (moved) scheduleLayoutSave();
      else onPlainClick(obj, ev);
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

  // addWaypoint вставляет точку изгиба в место клика на связи, между
  // ближайшей парой соседних точек (концы устройств или уже существующие
  // точки изгиба).
  function addWaypoint(link, p) {
    const { key, idx } = linkDupIndex(link);
    State.layout.links[key] = State.layout.links[key] || [];
    const arr = State.layout.links[key];
    while (arr.length <= idx) arr.push([]);
    const wps = arr[idx];
    const points = [deviceCenter(link.a.device), ...wps, deviceCenter(link.b.device)];
    wps.splice(NetMap.insertIndex(points, p), 0, { x: p.x, y: p.y });
    selectNode(link, false);
    scheduleLayoutSave();
  }

  // removeWaypoint удаляет одну точку изгиба по ссылке хендла ({key, dupIdx, idx}).
  function removeWaypoint(ref) {
    const arr = State.layout.links[ref.key] && State.layout.links[ref.key][ref.dupIdx];
    if (!arr) return;
    arr.splice(ref.idx, 1);
    scheduleLayoutSave();
    render();
  }

  // startPointDrag тащит одну точку изгиба связи; сохранение — тем же
  // debounced-путём, что и перетаскивание узлов.
  function startPointDrag(ref, e) {
    const arr = State.layout.links[ref.key][ref.dupIdx];
    function onMove(ev) {
      arr[ref.idx] = toWorld(screenPoint(ev));
      render();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scheduleLayoutSave();
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
    TOOLS.forEach((t) => {
      document.getElementById("tool-" + t).addEventListener("click", () => setTool(t));
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
    pops.set(`${kind}:${name}`, performance.now());
    if (!popping) {
      popping = true;
      requestAnimationFrame(popStep);
    }
    setTool("select");
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
    animate("cam", tw, () => { State.camera = { ...cur }; applyCamera(); });
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
    net.attach = net.attach || [];
    if (net.attach.some((a) => a.device === device)) {
      showBanner(`Сеть ${netName} уже подключена к ${device}`);
      cancelPending();
      return;
    }
    net.attach.push({ device });
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
    State.topology.links.push({ a: { device: pending.device }, b: { device } });
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

  function setupForms() {
    DirtyGuard.arm(() => State.topology);
    document.getElementById("topo-save").addEventListener("click", async () => {
      try {
        assertEditable();
        State.topology = await Api.put(apiPath("topology"), State.topology);
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
      const [topo, subnetsDoc] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
      State.topology = topo;
      State.subnets = subnetsDoc.subnets || [];
    } catch (e) {
      showBanner("Не удалось загрузить топологию: " + e.message);
    }
    try {
      const layout = await Api.get(apiPath("layout"));
      State.layout = { devices: layout.devices || {}, networks: layout.networks || layout.subnets || {}, links: layout.links || {} };
      State.camera = layout.camera && layout.camera.z > 0 ? { ...Camera.create(), ...layout.camera } : Camera.create();
    } catch {
      State.layout = { devices: {}, networks: {}, links: {} };
    }
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
      setCam: (c) => { State.camera = c; applyCamera(); scheduleLayoutSave(); },
      getViewport: () => { const r = canvas().getBoundingClientRect(); return { w: r.width, h: r.height }; },
      getTheme: () => theme,
    });
    setupForms();
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
