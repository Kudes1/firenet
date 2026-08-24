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
  const { el, DEVICE_W, DEVICE_H, NET_W, NET_H } = NetMap;

  let pending = null; // {device} awaiting a network to attach to
  let saveLayoutTimer = null;
  let viewportG = null;
  let previewWire = null;
  let popoverCreate = null; // callback awaiting a name from the popover
  let popoverWorld = null; // world point the open popover is anchored to
  let ctxPending = null; // {items, at}: node menu awaiting a clean right-release
  let camControls = null; // CameraControls handle (isRightDown)

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
    if (viewportG) viewportG.setAttribute("transform", Camera.transform(State.camera));
    movePopover();
  }

  function ensureLayout() {
    TopoScene.ensureLayout(State.topology, State.layout);
  }

  const deviceCenter = (name) => {
    const pos = State.layout.devices[name];
    return pos ? { x: pos.x + DEVICE_W / 2, y: pos.y + DEVICE_H / 2 } : null;
  };

  // showNetInfo открывает окно состава сети у правого края её облака.
  function showNetInfo(n) {
    const pos = State.layout.networks[n.name];
    if (!pos) return;
    const r = canvas().getBoundingClientRect();
    NetInfo.show(n, State.subnets, Camera.worldToScreen(State.camera, pos.x + NET_W, pos.y), { w: r.width, h: r.height });
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
  // middle/right-button drag via the shared CameraControls; both persist
  // through the debounced layout save. Left button stays free for selection
  // and node dragging.
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
  // delete action plus union assignment items. The menu opens on a clean
  // right-click; a right-drag (camera pan) suppresses it. Platforms differ
  // in when contextmenu fires: Linux at right-press (button still down,
  // defer), Windows/macOS after release (open immediately).
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
      const at = screenPoint(e);
      if (camControls && camControls.isRightDown()) ctxPending = { items, at };
      else showContextMenu(at, items);
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
    NetInfo.hide();
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
      NetInfo.hide();
      if (marqueeEnded) { marqueeEnded = false; return; } // click trailing the marquee drag
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

  // focusHit наводит камеру на bbox узла (мировые координаты -> центр канваса)
  function focusHit(obj) {
    const isDev = State.topology.devices.includes(obj);
    const pos = (isDev ? State.layout.devices : State.layout.networks)[obj.name];
    if (!pos) return;
    const w = isDev ? DEVICE_W : NET_W;
    const h = isDev ? DEVICE_H : NET_H;
    const r = canvas().getBoundingClientRect();
    State.camera = {
      ...State.camera,
      x: r.width / 2 - State.camera.z * (pos.x + w / 2),
      y: r.height / 2 - State.camera.z * (pos.y + h / 2),
    };
  }

  function updateSearch(raw) {
    searchQ = raw.trim().toLowerCase();
    searchHits = computeSearchHits(searchQ);
    searchSet = new Set(searchHits);
    hitIdx = 0;
    if (searchHits.length) focusHit(searchHits[0]);
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
        focusHit(searchHits[hitIdx]);
        applyCamera();
      }
    });
    // пустое поле, потерявшее фокус, прячем; активный запрос оставляем видимым
    input.addEventListener("blur", () => {
      if (!input.value) input.hidden = true;
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
        if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) { moved = true; NetInfo.hide(); }
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

  // selectWire wires click-selection and right-click delete for a wire;
  // links and attachments are only deletable through selection.
  function selectWire(wire, obj, label) {
    wire.onclick = (e) => {
      e.stopPropagation();
      if (State.tool === "select") selectNode(obj, e.shiftKey);
    };
    contextDelete(wire, obj, label);
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
        + (pending && pending.device === obj.name ? " pending" : "")
        + mark(searchSet.has(obj));
    }
    return shade(searchSet.has(obj));
  };

  // nodeHook подключает интерактив редактора к элементам сцены.
  const nodeHook = (kind, elem, obj) => {
    if (kind === "device") {
      makeDraggable(elem, "device", obj, (ev) => {
        if (State.tool === "connect") onDeviceConnect(obj.name);
        else if (State.tool === "select") { selectNode(obj, ev.shiftKey); NetInfo.hide(); }
      });
      contextDelete(elem, obj, "устройство " + obj.name, "device");
    } else if (kind === "network") {
      makeDraggable(elem, "network", obj, (ev) => {
        if (State.tool === "connect") onNetworkClick(obj.name);
        else if (State.tool === "select") { selectNode(obj, ev.shiftKey); showNetInfo(obj); }
      });
      contextDelete(elem, obj, "сеть " + obj.name, "network");
    } else if (kind === "wire") {
      selectWire(elem, obj, (obj.filter ? "фильтрованная связь " : "связь ") + obj.a.device + "–" + obj.b.device);
    } else if (kind === "attach") {
      selectWire(elem, obj, `привязка ${obj.net.name}–${obj.device}`);
    }
  };

  function render() {
    ensureLayout();
    const svg = canvas();
    svg.innerHTML = "";
    previewWire = null;
    viewportG = el("g", { class: "viewport", transform: Camera.transform(State.camera) });
    svg.append(viewportG);
    TopoScene.render(viewportG, State, { classes: nodeClasses, hook: nodeHook });
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
    setupSearch();
    NetInfo.attach(canvas());
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
