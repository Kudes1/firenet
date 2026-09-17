import {
  applyEdgeChanges, applyNodeChanges, Background, Controls, MiniMap, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, useStore, type NodeMouseHandler, type OnEdgesChange, type OnMove, type OnNodesChange,
  type OnSelectionChangeFunc, type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutDoc, LayoutPoint, SubnetDoc, TopologyDoc } from "../api/types";
import type { Node } from "@xyflow/react";
import { DeviceNode } from "./DeviceNode";
import { NetworkNode } from "./NetworkNode";
import { UnionNode } from "./UnionNode";
import { LinkEdge } from "./LinkEdge";
import NetworkInfo from "./NetworkInfo";
import { EdgeActionsContext } from "./edgeActions";
import { ViewportContext } from "./viewport";
import { buildScene, unionBoxes, DEVICE_H, DEVICE_W, NET_H, NET_W, type SceneEdge, type SceneNode } from "./scene";

const nodeTypes = { device: DeviceNode, network: NetworkNode, union: UnionNode };
const edgeTypes = { link: LinkEdge, attach: LinkEdge };
type CanvasEdge = SceneEdge & { selected?: boolean };

// RF 12 рисует ребро только между «инициализированными» узлами: нужны
// известные размеры и handle-границы. В jsdom ResizeObserver не работает
// (замер через DOM невозможен), поэтому размеры и хэндлы задаются
// декларативно. В браузере это тоже корректно: размеры узлов фиксированы,
// а при замере через DOM internals.handleBounds имеет приоритет над пропом.
function nodeGeometry(type: SceneNode["type"]) {
  if (type === "device") {
    return {
      width: DEVICE_W,
      height: DEVICE_H,
      handles: [
        { type: "source" as const, position: Position.Right, x: DEVICE_W, y: DEVICE_H / 2 },
        { type: "target" as const, position: Position.Left, x: 0, y: DEVICE_H / 2 },
      ],
    };
  }
  return {
    width: NET_W,
    height: NET_H,
    handles: [{ type: "target" as const, position: Position.Left, x: 0, y: NET_H / 2 }],
  };
}

// Инструмент канвы. В "connect" узел не выделяется и не тащится: клик по
// нему адресован соединению (паритет с легаси onPlainClick).
export type CanvasTool = "select" | "connect" | "device" | "network";

type Props = {
  topology: TopologyDoc;
  layout: LayoutDoc;
  editable: boolean;
  subnets?: SubnetDoc[];
  tool?: CanvasTool;
  // Узел, ожидающий пару в connect-инструменте (легаси pending).
  pendingId?: string;
  // Клик по узлу в connect-инструменте: id узла (device:<name> /
  // network:<name>). В остальных инструментах клик остаётся select-кликом.
  onConnectPick?: (id: string) => void;
  // Курсор в координатах сцены — второй конец превью-линии connect-инструмента.
  onSceneMouseMove?: (position: { x: number; y: number }) => void;
  // Класс подсветки узла/ребра: приходит от диагностики (diag-flow-*) или
  // поиска (search-hit). undefined — обычный вид.
  markOf?: (id: string) => string | undefined;
  onMoveEnd?: (viewport: { x: number; y: number; zoom: number }) => void;
  onNodeDragStop?: (id: string, position: { x: number; y: number }) => void;
  onNodeClick?: NodeMouseHandler;
  // Клик по пустому полю (создание устройства/сети активным инструментом).
  onPaneClick?: (position: { x: number; y: number }) => void;
  // Удаление выбранных объектов по Del. ids — id узлов и рёбер RF.
  onDelete?: (ids: string[]) => void;
  // Единый источник истины о выделении — RF; страница подписывается сюда.
  onSelectionChange?: (ids: string[]) => void;
  // ПКМ по узлу/ребру: id объекта и экранные координаты — точка меню.
  onNodeContextMenu?: (id: string, at: { x: number; y: number }) => void;
  onEdgeContextMenu?: (id: string, at: { x: number; y: number }) => void;
  // Изменение точек изгиба связи (двойной клик/drag маркеров): id ребра
  // (link:<a>|<b>#<offset>) и полный массив точек этого дубликата.
  // undefined — рёбра не интерактивны.
  onWaypointsChange?: (edgeId: string, waypoints: Array<{ x: number; y: number }>) => void;
  // Оверлеи, которые должны оставаться внутри обрезаемой поверхности канвы
  // (например, preview линии соединения).
  canvasChildren?: ReactNode;
  // Оверлеи страницы (тулбар, панели) — в соседнем overlay-слое canvas-shell,
  // чтобы они не обрезались .canvas-wrap.
  children?: ReactNode;
};

export default function TopologyCanvas(props: Props) {
  // useReactFlow (клик по панели → координаты сцены) требует провайдера:
  // оборачиваем внутренний компонент, чтобы канва работала и вне страницы.
  return (
    <ReactFlowProvider>
      <TopologyCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// Живой transform камеры поднимаем в стейт: оверлеи-дети (CanvasPanel)
// пересчитывают экранную позицию при каждом панорамировании/зуме.
function TransformSync({ onTransform }: { onTransform: (t: [number, number, number]) => void }) {
  const transform = useStore((s) => s.transform);
  useEffect(() => onTransform(transform), [transform, onTransform]);
  return null;
}

function TopologyCanvasInner({
  topology, layout, editable, subnets = [], tool = "select", pendingId, onConnectPick, markOf,
  onMoveEnd, onNodeDragStop, onNodeClick, onPaneClick, onDelete, onSelectionChange,
  onNodeContextMenu, onEdgeContextMenu, onWaypointsChange, onSceneMouseMove,
  canvasChildren, children,
}: Props) {
  const scene = useMemo(() => buildScene(topology, layout), [topology, layout]);
  const ref = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<[number, number, number]>([0, 0, 1]);
  const [networkInfoId, setNetworkInfoId] = useState<string | null>(null);
  const onTransform = useCallback((t: [number, number, number]) => setTransform(t), []);

  useEffect(() => {
    if (tool !== "select") setNetworkInfoId(null);
  }, [tool]);

  // Выделение узлов — контролируемое: без onNodesChange клик по узлу не
  // выставляет selected, и Del не знает, что удалять.
  const [rfNodes, setRfNodes] = useState<Node[]>(() => scene.nodes);
  // При обновлении topology/layout (например, после сохранения позиции)
  // берём с сервера только состав сцены (новые/удалённые узлы, содержимое),
  // а позиции уже существующих узлов оставляем локальные: локальная позиция
  // всегда новее серверной (она прилетает с дебаунсом 400 мс), и затирание
  // её снапшотом давало «мигание» — узел на мгновение отпрыгивал назад.
  // selected из локального стейта тоже сохраняется: buildScene создаёт
  // свежие объекты без этого поля.
  useEffect(() => {
    setRfNodes((current) => {
      const selected = new Set(current.filter((n) => n.selected).map((n) => n.id));
      const local = new Map(current.map((n) => [n.id, n.position]));
      return scene.nodes.map((n) => ({
        ...n,
        position: local.get(n.id) ?? n.position,
        ...(selected.has(n.id) ? { selected: true } : {}),
      }));
    });
  }, [scene.nodes]);

  const [rfEdges, setRfEdges] = useState<CanvasEdge[]>(() => scene.edges);
  useEffect(() => {
    setRfEdges((current) => {
      const selected = new Set(current.filter((e) => e.selected).map((e) => e.id));
      return scene.edges.map((e) => ({ ...e, ...(selected.has(e.id) ? { selected: true } : {}) }));
    });
  }, [scene.edges]);

  // Контуры объединений — RF-узлы с zIndex под участниками: bbox считается из
  // живых позиций rfNodes (участники тащатся локально, layout прилетает с
  // дебаунсом), чтобы контур следовал за перетаскиванием сразу, как рёбра.
  // Не выделяются и не тащатся.
  const livePositions = useMemo(() => {
    const byKind = { device: new Map<string, LayoutPoint>(), network: new Map<string, LayoutPoint>() };
    for (const n of rfNodes) {
      const kind = (n.type ?? "device") as "device" | "network";
      if (kind in byKind) byKind[kind].set(n.id.slice(kind.length + 1), n.position);
    }
    return (kind: "device" | "network", name: string) => byKind[kind].get(name);
  }, [rfNodes]);
  const unionNodes = useMemo<Node[]>(
    () => unionBoxes(topology, livePositions).map((b) => ({
      id: `union:${b.name}`,
      type: "union" as const,
      position: { x: b.x, y: b.y },
      data: { name: b.name, color: b.color, w: b.w, h: b.h },
      width: b.w,
      height: b.h,
      draggable: false,
      selectable: false,
      selectablePriority: 0,
      zIndex: -1,
      // RF ставит обёртке inline pointer-events: all (из-за общего onNodeClick)
      // и отбрасывает всплывшие до pane клики, поэтому без этого стиля клик по
      // пустому месту внутри объединения не открывал бы окно создания.
      style: { pointerEvents: "none" },
      className: ["union-outline", markOf?.(`union:${b.name}`)].filter(Boolean).join(" "),
    })),
    [topology, livePositions, markOf],
  );

  // Пока узел тащат, applyNodeChanges обновляет только позиции узлов; рёбра
  // рисуются по центрам узлов из data.from/to, поэтому пересчитываем их из
  // текущих позиций — иначе связи «догоняют» узел только после drag-stop.
  // В connect-инструменте узел не выделяется и не тащится (паритет с легаси:
  // клик по узлу адресован соединению), а клик ловится всегда — иначе RF
  // выставил бы обёртке pointer-events: none и клик не дошёл бы до страницы.
  const connecting = editable && tool === "connect" && !!onConnectPick;
  const nodes = useMemo<Node[]>(
    () => rfNodes.map((n) => {
      const geo = nodeGeometry((n.type ?? "device") as SceneNode["type"]);
      const marks = [markOf?.(n.id), n.id === pendingId ? "pending" : undefined].filter(Boolean);
      const base: Node = { ...n, ...geo, draggable: editable && !connecting, selectable: !connecting };
      return marks.length ? { ...base, className: marks.join(" ") } : base;
    }),
    [rfNodes, markOf, pendingId, editable, connecting],
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setRfNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange: OnEdgesChange<CanvasEdge> = useCallback(
    (changes) => setRfEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );

  const edges = useMemo(() => {
    const centerOf = new Map(rfNodes.map((n) => {
      const net = (n.type ?? "device") === "network";
      const [w, h] = net ? [NET_W, NET_H] : [DEVICE_W, DEVICE_H];
      return [n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2 }] as const;
    }));
    return rfEdges.map((e) => {
      const from = centerOf.get(e.source) ?? e.data.from;
      const to = centerOf.get(e.target) ?? e.data.to;
      const mark = markOf?.(e.id);
      const base = { ...e, data: { ...e.data, from, to, diagnosticMark: mark } };
      return mark ? { ...base, className: mark } : base;
    });
  }, [rfEdges, rfNodes, markOf]);

  const handleMoveEnd = useCallback<OnMove>(
    (_event, viewport) => onMoveEnd?.(viewport),
    [onMoveEnd],
  );

  // Клик по панели: координаты события переводятся в координаты сцены.
  const { screenToFlowPosition } = useReactFlow();
  const handlePaneClick = useCallback<NonNullable<ReactFlowProps["onPaneClick"]>>(
    (event) => {
      setNetworkInfoId(null);
      onPaneClick?.(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [onPaneClick, screenToFlowPosition],
  );

  // Движение мыши по панели в координатах сцены: второй конец превью-линии.
  const handlePaneMouseMove = useCallback<NonNullable<ReactFlowProps["onPaneMouseMove"]>>(
    (event) => onSceneMouseMove?.(screenToFlowPosition({ x: event.clientX, y: event.clientY })),
    [onSceneMouseMove, screenToFlowPosition],
  );

  // Клик по узлу: в connect-инструменте это выбор конца связи (легаси
  // onPlainClick); в остальных — обычный select-клик страницы.
  const handleNodeClick = useCallback<NodeMouseHandler>(
    (event, node) => {
      if (connecting) {
        setNetworkInfoId(null);
        event.stopPropagation();
        onConnectPick?.(node.id);
        return;
      }
      if (tool === "select") setNetworkInfoId(node.type === "network" ? node.id : null);
      onNodeClick?.(event, node);
    },
    [connecting, onConnectPick, onNodeClick, tool],
  );

  // Del удаляет выбранные узлы и рёбра: события клавиатуры идут на контейнер,
  // потому что фокус у React Flow, а не у инпутов страницы. Панели редактиро-
  // вания находятся в overlay-слое — их keydown (в т.ч. Delete при наборе
  // текста) не должен доходить до удаления узлов.
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Delete" || !onDelete) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof Element && target.closest(".canvas-panel"))
    ) return;
    const ids = [
      ...rfNodes.filter((n) => n.selected).map((n) => n.id),
      ...rfEdges.filter((e) => e.selected).map((e) => e.id),
    ];
    if (ids.length) onDelete(ids);
  }, [rfNodes, rfEdges, onDelete]);

  // RF сам отслеживает выделение (в т.ч. через рамку и multiSelectionKeyCode);
  // свой список по кликам дублировал бы это состояние. Важны и nodes, и
  // edges: страница использует список для состояния кнопки удаления.
  const handleSelectionChange = useCallback<OnSelectionChangeFunc>(
    ({ nodes, edges: selectedEdges }) => onSelectionChange?.([
      ...nodes.map((n) => n.id),
      ...selectedEdges.map((e) => e.id),
    ]),
    [onSelectionChange],
  );

  // Контекстные меню RF уже получают объект в точке ПКМ — отдаём странице
  // id и координаты в системе .canvas-wrap: меню позиционируется absolute
  // внутри неё, а clientX/clientY — viewport-ные, без пересчёта меню уезжает
  // на offset канвы от края вьюпорта.
  const handleNodeContextMenu = useCallback<NonNullable<ReactFlowProps["onNodeContextMenu"]>>(
    (event, node) => {
      event.preventDefault();
      const canvas = ref.current!.getBoundingClientRect();
      onNodeContextMenu?.(node.id, { x: event.clientX - canvas.left, y: event.clientY - canvas.top });
    },
    [onNodeContextMenu],
  );
  const handleEdgeContextMenu = useCallback<NonNullable<ReactFlowProps["onEdgeContextMenu"]>>(
    (event, edge) => {
      event.preventDefault();
      const canvas = ref.current!.getBoundingClientRect();
      onEdgeContextMenu?.(edge.id, { x: event.clientX - canvas.left, y: event.clientY - canvas.top });
    },
    [onEdgeContextMenu],
  );

  const infoNetwork = (topology.networks ?? []).find((item) => `network:${item.name}` === networkInfoId);
  const infoNode = rfNodes.find((item) => item.id === networkInfoId);

  return (
    <ViewportContext.Provider value={transform}>
      <div className="canvas-shell" style={{ width: "100%", height: "100%" }}>
        <div
          ref={ref}
          className={`canvas-wrap${connecting ? " connecting" : ""}`}
          data-testid="topo-canvas"
          style={{ width: "100%", height: "100%" }}
          onKeyDown={handleKeyDown}
          tabIndex={0}
        >
          <EdgeActionsContext.Provider value={editable && onWaypointsChange ? { changeWaypoints: onWaypointsChange } : undefined}>
            <ReactFlow
              nodes={[...unionNodes, ...nodes]}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView={!scene.viewport}
              defaultViewport={scene.viewport}
              nodesDraggable={editable}
              nodesConnectable={editable}
              elementsSelectable
              onMoveEnd={handleMoveEnd}
              onMoveStart={() => setNetworkInfoId(null)}
              onNodeDragStart={() => setNetworkInfoId(null)}
              onNodeDragStop={(_event, node) => onNodeDragStop?.(node.id, node.position)}
              onNodeClick={handleNodeClick}
              onPaneClick={handlePaneClick}
              onPaneMouseMove={handlePaneMouseMove}
              onSelectionChange={handleSelectionChange}
              onNodeContextMenu={handleNodeContextMenu}
              onEdgeContextMenu={handleEdgeContextMenu}
              onPaneContextMenu={(e) => e.preventDefault()}
              proOptions={{ hideAttribution: true }}
            >
              <TransformSync onTransform={onTransform} />
              <Background gap={24} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
            {canvasChildren}
          </EdgeActionsContext.Provider>
        </div>
        {infoNetwork && infoNode && (
          <NetworkInfo
            network={infoNetwork}
            subnets={subnets}
            at={{ x: infoNode.position.x + NET_W + 14, y: infoNode.position.y + 10 }}
            onClose={() => setNetworkInfoId(null)}
          />
        )}
        {children}
      </div>
    </ViewportContext.Provider>
  );
}
