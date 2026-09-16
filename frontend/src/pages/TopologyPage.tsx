import { useCallback, useEffect, useMemo, useState } from "react";
import { useProjectResource } from "../api/queries";
import type { LayoutDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchPrefixQuery } from "../lib/search";
import { canonicalLink } from "../lib/links";
import { connectOutcome, type ConnectTarget } from "../lib/connect";
import { useEditorLock } from "../lib/editorLock";
import { useTopologyEditor } from "../topology/useTopologyEditor";
import TopologyCanvas, { type CanvasTool } from "../topology/TopologyCanvas";
import { ConnectPreview } from "../topology/ConnectPreview";
import { DEVICE_H, DEVICE_W, NET_H, NET_W } from "../topology/scene";
import ContextMenu, { type MenuItem } from "../topology/ContextMenu";
import { contextMenuItems, type CanvasTarget } from "../topology/contextMenuItems";
import { DeviceEditForm, NetworkEditForm, LinkFilterForm } from "../topology/editForms";
import CanvasPanel from "../topology/CanvasPanel";
import { notify } from "../components/notify";
import { ConnectIcon, DeviceToolIcon, NetworkToolIcon, SearchIcon, SelectIcon, SyncStatusIcon, TrashIcon } from "../components/icons";

type EditTarget =
  | { kind: "device"; name: string }
  | { kind: "network"; name: string }
  | { kind: "link"; index: number };

type CreateTarget = { kind: "device" | "network"; position: { x: number; y: number } };

const EMPTY_TOPOLOGY: TopologyDoc = { devices: [], links: [], networks: [], sets: [], unions: [] };
const EMPTY_LAYOUT: LayoutDoc = {};

export default function TopologyPage() {
  const { isReadOnly, scope } = useDraft();
  // Блокировка канвы между вкладками: редактирует та вкладка, что захватила
  // лок первой; остальные смотрят (расширение на другие страницы — по
  // потребности, useEditorLock готов к переиспользованию).
  const lock = useEditorLock(isReadOnly ? null : scope);
  const canEdit = !isReadOnly && !lock.locked;
  const topology = useProjectResource<TopologyDoc>("topology");
  const layoutQuery = useProjectResource<LayoutDoc>("layout");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const editor = useTopologyEditor();

  const [tool, setTool] = useState<CanvasTool>("select");
  // Первый объект connect-инструмента (легаси pending): ждёт пары.
  const [pending, setPending] = useState<ConnectTarget | null>(null);
  // Курсор в координатах сцены — второй конец превью-линии.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [createName, setCreateName] = useState("");
  const [createDeviceKind, setCreateDeviceKind] = useState<"router" | "switch">("router");

  const doc = topology.data ?? EMPTY_TOPOLOGY;
  const layout = layoutQuery.data ?? EMPTY_LAYOUT;
  const devices = doc.devices ?? [];
  const networks = doc.networks ?? [];

  // Каноническая пара [a, b] связи в открытой модалке фильтра: канва красит
  // устройства контурами A/B, пока модалка открыта (легаси link-ends highlight).
  const editLink = editTarget?.kind === "link" ? (doc.links ?? [])[editTarget.index] : undefined;
  const linkEnds: [string, string] | null = editLink
    ? canonicalLink(editLink.a.device, editLink.b.device)
    : null;

  const cidrOf = useMemo(() => {
    const map = new Map((subnets.data?.subnets ?? []).map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [subnets.data]);

  // Поиск по канве: имя устройства/сети, состав сети и CIDR её подсетей.
  const matches = useMemo(() => {
    if (!query) return null;
    const hit = new Set<string>();
    for (const d of devices) if (containsFold(d.name, query)) hit.add(`device:${d.name}`);
    for (const n of networks) {
      const byName = containsFold(n.name, query);
      const bySubnet = (n.subnets ?? []).some((s) => containsFold(s, query) || matchPrefixQuery(cidrOf(s), query));
      if (byName || bySubnet) hit.add(`network:${n.name}`);
    }
    return hit;
  }, [query, devices, networks, cidrOf]);

  const markOf = useCallback((id: string) => {
    if (linkEnds) {
      // Подсветка концов редактируемой связи — поверх поиска: узлы концов
      // получают цвета A/B, остальные узлы и связи затемняются (само ребро
      // редактируемой связи остаётся обычным).
      const [a, b] = linkEnds;
      if (id === `device:${a}`) return "link-end-a";
      if (id === `device:${b}`) return "link-end-b";
      if (id.startsWith(`link:${a}|${b}`) || id.startsWith(`link:${b}|${a}`)) return undefined;
      if (id.includes(":")) return "search-dim";
    }
    if (!matches) return undefined;
    if (matches.has(id)) return "search-hit";
    return id.includes(":") ? "search-dim" : undefined;
  }, [matches, linkEnds]);

  const guard = (action: () => void) => {
    if (!canEdit) {
      notify(lock.locked ? "Черновик редактируется в другой вкладке" : "Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    action();
  };

  // Смена инструмента сбрасывает ожидающий объект: пара, выбранная в connect,
  // не должна доживать до возврата в него (легаси setTool → cancelPending).
  const selectTool = useCallback((next: CanvasTool) => {
    setPending(null);
    setCursor(null);
    setTool(next);
  }, []);

  // pendingId — id узла-кандидата в терминах канвы (device:<name>).
  const pendingId = pending && `${pending.kind}:${pending.name}`;

  // Второй клик connect-инструмента: исход считает connectOutcome (чистая
  // логика), страница только исполняет его — операция в очередь, баннер или
  // сброс. Инструмент остаётся активным: можно соединять следующую пару.
  const onConnectPick = useCallback((id: string) => {
    const kind = id.startsWith("device:") ? "device" : "network";
    const target: ConnectTarget = { kind, name: id.slice(kind.length + 1) };
    if (!pending) {
      setPending(target);
      return;
    }
    const outcome = connectOutcome(pending, target, doc);
    setPending(null);
    setCursor(null);
    if ("operation" in outcome) {
      guard(() => {
        const op = outcome.operation;
        if (op.kind === "create-link" && op.link) editor.createLink(op.link.a.device, op.link.b.device);
        else if (op.kind === "attach-network" && op.networkName && op.attach) {
          editor.attachNetwork(op.networkName, op.attach.device);
        }
      });
    } else if ("warning" in outcome) {
      notify(outcome.warning);
    }
  }, [pending, doc, guard, editor]);

  // Горячие клавиши инструментов (легаси shortcuts: v/c/d/n) и Esc — отмена
  // ожидающего объекта. Клавиши гаснут в полях ввода и панелях редактирования.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key === "Escape" && createTarget) {
        setCreateTarget(null);
        return;
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof Element && target.closest(".canvas-panel"))
      ) return;
      if (event.key === "Escape" && pending) {
        setPending(null);
        setCursor(null);
        return;
      }
      const shortcuts: Record<string, CanvasTool> = { v: "select", c: "connect", d: "device", n: "network" };
      const next = shortcuts[event.key];
      if (next) selectTool(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canEdit, pending, createTarget, selectTool]);

  // Центр ожидающего объекта — первый конец превью-линии. Позиция из
  // layout, как у узла на канве; без записи в layout превью не рисуется.
  const pendingCenter = useMemo(() => {
    if (!pending) return null;
    const point = pending.kind === "device"
      ? (layout.devices ?? {})[pending.name]
      : (layout.networks ?? {})[pending.name];
    if (!point) return null;
    const w = pending.kind === "device" ? DEVICE_W : NET_W;
    const h = pending.kind === "device" ? DEVICE_H : NET_H;
    return { x: point.x + w / 2, y: point.y + h / 2 };
  }, [pending, layout]);

  const onPaneClick = useCallback((position: { x: number; y: number }) => {
    // Клик по пустому полю отменяет ожидающий объект (легаси setupTools).
    setPending(null);
    setCursor(null);
    if (createTarget) {
      setCreateTarget(null);
      return;
    }
    if (tool !== "device" && tool !== "network") return;
    guard(() => {
      setCreateTarget({ kind: tool, position });
      setCreateName("");
      setCreateDeviceKind("router");
    });
  }, [tool, canEdit, createTarget]);

  const create = () => {
    if (!createTarget || !createName.trim()) return;
    const name = createName.trim();
    guard(() => {
      if (createTarget.kind === "device") editor.createDevice(createTarget.position, createDeviceKind, name);
      else editor.createNetwork(createTarget.position, name);
      setCreateTarget(null);
    });
  };

  // Сборка пунктов меню: target описывает объект под курсором; операции —
  // через очередь редактора. Меню не открывается в read-only (паритет с
  // guard-поведением остальных действий канвы).
  const openMenu = useCallback((target: CanvasTarget, at: { x: number; y: number }) => {
    if (!canEdit) return;
    const items = contextMenuItems({
      doc,
      target,
      editable: true,
      isLinkPending: editor.isLinkPending,
      selection,
      actions: {
        editDevice: (name) => setEditTarget({ kind: "device", name }),
        editNetwork: (name) => setEditTarget({ kind: "network", name }),
        editLinkFilter: (a, b) => {
          const index = (doc.links ?? []).findIndex((l) => {
            const pair = [l.a.device, l.b.device];
            return pair.includes(a) && pair.includes(b);
          });
          if (index >= 0) setEditTarget({ kind: "link", index });
        },
        setUnion: (name, kind, union) => editor.setUnion(name, kind, union),
        deleteNode: (id) => editor.removeSelected([id]),
        deleteLink: (a, b) => editor.deleteLink(a, b),
        detachNetwork: (network, device) => editor.detachNetwork(network, device),
      },
    });
    setMenu({ at, items });
  }, [canEdit, doc, selection, editor]);

  // Контекстные меню: RF отдаёт id узла/ребра; состав ребра (концы связи,
  // сеть привязки) восстанавливаем по id — формат стабилен (scene.ts).
  const handleNodeContextMenu = useCallback((id: string, at: { x: number; y: number }) => {
    openMenu({ kind: "node", id }, at);
  }, [openMenu]);

  const handleEdgeContextMenu = useCallback((id: string, at: { x: number; y: number }) => {
    // id ребра строит scene.ts: link:<a>|<b>#<offset> или attach:<net>|<device>.
    const type = id.slice(0, id.indexOf(":"));
    const rest = id.slice(id.indexOf(":") + 1);
    const key = type === "link" ? rest.slice(0, rest.lastIndexOf("#")) : rest;
    const [a, b] = key.split("|");
    if (type === "link") {
      const filtered = (doc.links ?? []).some((l) => [l.a.device, l.b.device].includes(a)
        && [l.a.device, l.b.device].includes(b) && !!l.filter);
      openMenu({ kind: "link", id, a, b, filtered }, at);
    }
    if (type === "attach") openMenu({ kind: "attach", id, network: a, device: b }, at);
  }, [openMenu, doc.links]);

  const statusLabel = editor.status === "saved" ? "Сохранено" : editor.status === "dirty" ? "Изменено" : editor.status === "saving" ? "Сохранение…" : "Ошибка";

  const editDevice = editTarget?.kind === "device" ? devices.find((d) => d.name === editTarget.name) : undefined;
  const editNetwork = editTarget?.kind === "network" ? networks.find((n) => n.name === editTarget.name) : undefined;

  return (
    <main className="page topology-page" data-testid="page-topology">
      <header className="topology-page-header">
        <div>
          <p className="topology-page-eyebrow">Рабочая область</p>
          <h1 className="topology-page-title">Топология</h1>
        </div>
        <p>Устройства, сети и связи проекта</p>
      </header>
      {/* Чужая вкладка держит лок редактирования: канва только смотрит. */}
      {lock.locked && (
        <div className="draft-banner draft-banner-readonly" data-testid="topo-lock-banner">
          <span>Черновик редактируется в другой вкладке.</span>
          <button type="button" onClick={lock.acquire}>Захватить редактирование</button>
        </div>
      )}
      {/* Оверлеи (тулбар, меню) — children канвы: единственный .canvas-wrap
          рендерит сам TopologyCanvas (иначе двойные рамка/фон/сетка). */}
      <div className="topology-layout">
        <TopologyCanvas
          topology={doc}
          layout={layout}
          editable={canEdit}
          subnets={subnets.data?.subnets ?? []}
          tool={tool}
          pendingId={pendingId ?? undefined}
          onConnectPick={onConnectPick}
          markOf={markOf}
          onMoveEnd={(viewport) => editor.setCamera(viewport)}
          onNodeDragStop={(id, position) => {
            const [kind, ...rest] = id.split(":");
            const name = rest.join(":");
            if (kind === "device") editor.moveDevice(name, position);
            if (kind === "network") editor.moveNetwork(name, position);
          }}
          // Источник истины о выделении — RF (рамка, Ctrl/Shift+клик и Del
          // из коробки); страница только подписывается на его изменения.
          onSelectionChange={setSelection}
          onPaneClick={onPaneClick}
          onSceneMouseMove={pending ? setCursor : undefined}
          onDelete={(ids) => guard(() => editor.removeSelected(ids))}
          onNodeContextMenu={handleNodeContextMenu}
          onEdgeContextMenu={handleEdgeContextMenu}
          canvasChildren={pendingCenter && cursor ? <ConnectPreview from={pendingCenter} to={cursor} /> : null}
          onWaypointsChange={(edgeId, points) => {
            // id ребра строит scene.ts: link:<a>|<b>#<offset>; attach-рёбра
            // изгибов не имеют (бэкенд хранит waypoints только по парам устройств).
            if (!edgeId.startsWith("link:")) return;
            const rest = edgeId.slice(5, edgeId.lastIndexOf("#"));
            const [a, b] = rest.split("|");
            guard(() => editor.setLinkWaypoints(a, b, Number(edgeId.slice(edgeId.lastIndexOf("#") + 1)), points));
          }}
        >
          <div className="topo-toolbar" role="toolbar" aria-label="Инструменты топологии">
            <div className="topo-tool-group topo-search-group">
              <button
                type="button"
                data-testid="topo-search-toggle"
                className="tool"
                title="Поиск по устройствам, сетям, подсетям"
                onClick={() => setSearchOpen(!searchOpen)}
              >
                <SearchIcon />
              </button>
              <input
                id="topo-search"
                hidden={!searchOpen}
                placeholder="поиск: имя / CIDR / IP"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="topo-tool-group">
              <button
                type="button"
                className="tool danger"
                data-testid="topo-delete"
                title="Удалить выбранное (Del)"
                disabled={!selection.length}
                onClick={() => guard(() => editor.removeSelected(selection))}
              >
                <TrashIcon />
              </button>
            </div>
            <div className="topo-tool-group">
              <button
                type="button"
                data-testid="tool-select"
                className={`tool${tool === "select" ? " active" : ""}`}
                title="Выбор и перемещение (V)"
                onClick={() => selectTool("select")}
              >
                <SelectIcon />
              </button>
              <button
                type="button"
                data-testid="tool-connect"
                className={`tool${tool === "connect" ? " active" : ""}`}
                title="Соединить устройства/сети (C)"
                onClick={() => selectTool("connect")}
              >
                <ConnectIcon />
              </button>
              <button
                type="button"
                data-testid="tool-device"
                className={`tool${tool === "device" ? " active" : ""}`}
                title="Добавить устройство (D)"
                onClick={() => guard(() => selectTool("device"))}
              >
                <DeviceToolIcon />
              </button>
              <button
                type="button"
                data-testid="tool-network"
                className={`tool${tool === "network" ? " active" : ""}`}
                title="Добавить сеть (N)"
                onClick={() => guard(() => selectTool("network"))}
              >
                <NetworkToolIcon />
              </button>
            </div>
            <div className="topo-tool-group topo-status-group">
              <span
                id="topo-sync-status"
                className={`sync-status ${editor.status}`}
                role="status"
                aria-live="polite"
                title={statusLabel}
                aria-label={statusLabel}
              >
                <SyncStatusIcon status={editor.status} />
              </span>
            </div>
          </div>
          {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
          {/* Панели редактирования — overlay-объекты canvas-shell: координаты
              канвовые, но .canvas-wrap их не обрезает (см. CanvasPanel). */}
          {editDevice && (
            <CanvasPanel title={`Изменить устройство ${editDevice.name}`} onClose={() => setEditTarget(null)}>
              <DeviceEditForm
                device={editDevice}
                unions={doc.unions ?? []}
                existingNames={devices.map((d) => d.name)}
                onCancel={() => setEditTarget(null)}
                onSubmit={(operations) => { setEditTarget(null); editor.enqueueAll(operations); }}
              />
            </CanvasPanel>
          )}
          {editNetwork && (
            <CanvasPanel title={`Изменить сеть ${editNetwork.name}`} onClose={() => setEditTarget(null)} wide>
              <NetworkEditForm
                network={editNetwork}
                networks={networks}
                allSubnets={subnets.data?.subnets ?? []}
                existingNames={networks.map((n) => n.name)}
                onCancel={() => setEditTarget(null)}
                onSubmit={(operations) => { setEditTarget(null); editor.enqueueAll(operations); }}
              />
            </CanvasPanel>
          )}
          {editLink && (
            <CanvasPanel
              title={`Фильтры связи ${editLink.a.device} ↔ ${editLink.b.device}`}
              onClose={() => setEditTarget(null)}
              wide
            >
              <LinkFilterForm
                link={editLink}
                onSave={async (next) => {
                  editor.setLinkFilter(next.a.device, next.b.device, next.filter);
                }}
              />
            </CanvasPanel>
          )}
          {createTarget && (
            <CanvasPanel
              title={createTarget.kind === "device" ? "Новое устройство" : "Новая сеть"}
              onClose={() => setCreateTarget(null)}
              compact
              testId="create-panel"
              at={createTarget.position}
            >
              <form className="create-panel-form" onSubmit={(event) => { event.preventDefault(); create(); }}>
                <label>
                  Имя
                  <input autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} />
                </label>
                {createTarget.kind === "device" && (
                  <label>
                    Тип
                    <select value={createDeviceKind} onChange={(event) => setCreateDeviceKind(event.target.value as "router" | "switch")}>
                      <option value="router">Роутер</option>
                      <option value="switch">Свитч</option>
                    </select>
                  </label>
                )}
                <div className="modal-actions">
                  <button type="button" onClick={() => setCreateTarget(null)}>Отмена</button>
                  <button type="submit" className="primary" disabled={!createName.trim()}>Создать</button>
                </div>
              </form>
            </CanvasPanel>
          )}
        </TopologyCanvas>
      </div>
    </main>
  );
}
