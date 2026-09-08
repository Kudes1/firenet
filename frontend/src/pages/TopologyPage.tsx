import { useCallback, useMemo, useState } from "react";
import { useProjectResource } from "../api/queries";
import type { LayoutDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchPrefixQuery } from "../lib/search";
import { useTopologyEditor } from "../topology/useTopologyEditor";
import TopologyCanvas from "../topology/TopologyCanvas";
import { notify } from "../components/notify";
import { ConnectIcon, DeviceToolIcon, NetworkToolIcon, SearchIcon, SelectIcon, TrashIcon } from "../components/icons";

type Tool = "select" | "connect" | "device" | "network";

const EMPTY_TOPOLOGY: TopologyDoc = { devices: [], links: [], networks: [], sets: [], unions: [] };

export default function TopologyPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const layoutQuery = useProjectResource<LayoutDoc>("layout");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const editor = useTopologyEditor();

  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const doc = topology.data ?? EMPTY_TOPOLOGY;
  const layout = layoutQuery.data ?? {};
  const devices = doc.devices ?? [];
  const networks = doc.networks ?? [];

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
    if (!matches) return undefined;
    if (matches.has(id)) return "search-hit";
    return id.includes(":") ? "search-dim" : undefined;
  }, [matches]);

  const guard = (action: () => void) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    action();
  };

  const onPaneClick = useCallback((position: { x: number; y: number }) => {
    if (tool === "device") guard(() => { editor.createDevice(position, "router"); });
    if (tool === "network") guard(() => { editor.createNetwork(position); });
  }, [tool, editor, isReadOnly]);

  const statusLabel = editor.status === "saved" ? "Сохранено" : editor.status === "dirty" ? "Изменено" : editor.status === "saving" ? "Сохранение…" : "Ошибка";

  return (
    <main className="page" data-testid="page-topology">
      <div className="topology-layout">
        <div className="canvas-wrap">
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

          <TopologyCanvas
            topology={doc}
            layout={layout}
            editable={!isReadOnly}
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
            onNodeClick={(event, node) => {
              // Мультивыбор — Ctrl/Shift+клик (multiSelectionKeyCode RF и
              // shift-диапазон), иначе выбор затирается одним узлом и
              // мультиудаление невозможно.
              setSelection((current) => {
                const additive = event.ctrlKey || event.metaKey || event.shiftKey;
                if (!additive) return [node.id];
                return current.includes(node.id)
                  ? current.filter((id) => id !== node.id)
                  : [...current, node.id];
              });
            }}
            onPaneClick={onPaneClick}
            onDelete={(ids) => guard(() => editor.removeSelected(ids))}
          />
        </div>
      </div>
    </main>
  );
}
