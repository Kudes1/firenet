import { useCallback, useMemo, useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { LayoutDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchPrefixQuery } from "../lib/search";
import { canonicalLink } from "../lib/links";
import { useEditorLock } from "../lib/editorLock";
import { useTopologyEditor } from "../topology/useTopologyEditor";
import TopologyCanvas from "../topology/TopologyCanvas";
import ContextMenu, { type MenuItem } from "../topology/ContextMenu";
import { contextMenuItems, type CanvasTarget } from "../topology/contextMenuItems";
import { DeviceEditForm, NetworkEditForm, LinkFilterForm } from "../topology/editForms";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";
import { ConnectIcon, DeviceToolIcon, NetworkToolIcon, SearchIcon, SelectIcon, TrashIcon } from "../components/icons";

type Tool = "select" | "connect" | "device" | "network";
type EditTarget =
  | { kind: "device"; name: string }
  | { kind: "network"; name: string }
  | { kind: "link"; index: number };

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
  const save = useProjectSave<TopologyDoc>("topology");

  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

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

  const onPaneClick = useCallback((position: { x: number; y: number }) => {
    if (tool === "device") guard(() => { editor.createDevice(position, "router"); });
    if (tool === "network") guard(() => { editor.createNetwork(position); });
  }, [tool, editor, canEdit]);

  // Сборка пунктов меню: target описывает объект под курсором; операции —
  // через очередь редактора. Меню не открывается в read-only (паритет с
  // guard-поведением остальных действий канвы).
  const openMenu = useCallback((target: CanvasTarget, at: { x: number; y: number }) => {
    if (!canEdit) return;
    const items = contextMenuItems({
      doc,
      target,
      editable: true,
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
    <main className="page" data-testid="page-topology">
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
          markOf={markOf}
          onMoveEnd={(viewport) => editor.setCamera(viewport)}
          onNodeDragStop={(id, position) => {
            const [kind, ...rest] = id.split(":");
            const name = rest.join(":");
            if (kind === "device") editor.moveDevice(name, position);
            if (kind === "network") editor.moveNetwork(name, position);
          }}
          onConnect={(connection) => guard(() => editor.createLink(
            connection.source.replace("device:", ""),
            connection.target.replace("device:", ""),
          ))}
          // Источник истины о выделении — RF (рамка, Ctrl/Shift+клик и Del
          // из коробки); страница только подписывается на его изменения.
          onSelectionChange={setSelection}
          onPaneClick={onPaneClick}
          onDelete={(ids) => guard(() => editor.removeSelected(ids))}
          onNodeContextMenu={handleNodeContextMenu}
          onEdgeContextMenu={handleEdgeContextMenu}
        >
          <div className="topo-toolbar">
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
            <span className="toolbar-sep" />
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
            <span className="toolbar-sep" />
            <button
              type="button"
              data-testid="tool-select"
              className={`tool${tool === "select" ? " active" : ""}`}
              title="Выбор и перемещение (V)"
              onClick={() => setTool("select")}
            >
              <SelectIcon />
            </button>
            <button
              type="button"
              data-testid="tool-connect"
              className={`tool${tool === "connect" ? " active" : ""}`}
              title="Соединить устройства/сети (C)"
              onClick={() => setTool("connect")}
            >
              <ConnectIcon />
            </button>
            <button
              type="button"
              data-testid="tool-device"
              className={`tool${tool === "device" ? " active" : ""}`}
              title="Добавить устройство (D)"
              onClick={() => guard(() => setTool("device"))}
            >
              <DeviceToolIcon />
            </button>
            <button
              type="button"
              data-testid="tool-network"
              className={`tool${tool === "network" ? " active" : ""}`}
              title="Добавить сеть (N)"
              onClick={() => guard(() => setTool("network"))}
            >
              <NetworkToolIcon />
            </button>
            <span className="toolbar-sep" />
            <span
              id="topo-sync-status"
              className={`sync-status ${editor.status}`}
              role="status"
              aria-live="polite"
              title={statusLabel}
              aria-label={statusLabel}
            />
          </div>
          {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
        </TopologyCanvas>
      </div>

      {/* Модалки редактирования поверх канвы — те же формы, что и на
          страницах-таблицах (editForms), но операции идут через очередь
          редактора канвы. */}
      {editDevice && (
        <Modal open title={`Изменить устройство ${editDevice.name}`} onClose={() => setEditTarget(null)} undimmed>
          <DeviceEditForm
            device={editDevice}
            unions={doc.unions ?? []}
            existingNames={devices.map((d) => d.name)}
            onCancel={() => setEditTarget(null)}
            onSubmit={(operations) => { setEditTarget(null); editor.enqueueAll(operations); }}
          />
        </Modal>
      )}
      {editNetwork && (
        <Modal open title={`Изменить сеть ${editNetwork.name}`} onClose={() => setEditTarget(null)} wide undimmed>
          <NetworkEditForm
            network={editNetwork}
            networks={networks}
            allSubnets={subnets.data?.subnets ?? []}
            existingNames={networks.map((n) => n.name)}
            onCancel={() => setEditTarget(null)}
            onSubmit={(operations) => { setEditTarget(null); editor.enqueueAll(operations); }}
          />
        </Modal>
      )}
      {editLink && (
        <Modal open={!!editLink}
          title={`Фильтры связи ${editLink.a.device} ↔ ${editLink.b.device}`}
          onClose={() => setEditTarget(null)}
          wide
          undimmed
          footer={<button type="button" onClick={() => setEditTarget(null)}>Закрыть</button>}
        >
          <LinkFilterForm
            link={editLink}
            onSave={async (next) => {
              const links = (doc.links ?? []).slice();
              if (editTarget?.kind === "link") links[editTarget.index] = next;
              try {
                await save.mutateAsync({ ...doc, links });
              } catch (error) {
                notify((error as Error).message);
              }
            }}
          />
        </Modal>
      )}
    </main>
  );
}
