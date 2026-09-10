import {
  applyNodeChanges, Background, Controls, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type NodeMouseHandler, type OnMove, type OnNodesChange, type OnSelectionChangeFunc,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutDoc, LayoutPoint, TopologyDoc } from "../api/types";
import type { Node } from "@xyflow/react";
import { DeviceNode } from "./DeviceNode";
import { NetworkNode } from "./NetworkNode";
import { UnionNode } from "./UnionNode";
import { LinkEdge } from "./LinkEdge";
import { buildScene, unionBoxes, DEVICE_H, DEVICE_W, NET_H, NET_W, type SceneNode } from "./scene";

const nodeTypes = { device: DeviceNode, network: NetworkNode, union: UnionNode };
const edgeTypes = { link: LinkEdge, attach: LinkEdge };

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

type Props = {
  topology: TopologyDoc;
  layout: LayoutDoc;
  editable: boolean;
  // Класс подсветки узла/ребра: приходит от диагностики (diag-flow-*) или
  // поиска (search-hit). undefined — обычный вид.
  markOf?: (id: string) => string | undefined;
  onMoveEnd?: (viewport: { x: number; y: number; zoom: number }) => void;
  onNodeDragStop?: (id: string, position: { x: number; y: number }) => void;
  onConnect?: (connection: Connection) => void;
  onNodeClick?: NodeMouseHandler;
  // Клик по пустому полю (создание устройства/сети активным инструментом).
  onPaneClick?: (position: { x: number; y: number }) => void;
  // Удаление выбранных узлов по Del. ids — id узлов RF (device:r1).
  onDelete?: (ids: string[]) => void;
  // Единый источник истины о выделении — RF; страница подписывается сюда.
  onSelectionChange?: (ids: string[]) => void;
  // ПКМ по узлу/ребру: id объекта и экранные координаты — точка меню.
  onNodeContextMenu?: (id: string, at: { x: number; y: number }) => void;
  onEdgeContextMenu?: (id: string, at: { x: number; y: number }) => void;
  // Оверлеи страницы (тулбар, панели) — внутри обёртки канвы, чтобы
  // позиционироваться относительно неё; .canvas-wrap остаётся один.
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

function TopologyCanvasInner({
  topology, layout, editable, markOf, onMoveEnd, onNodeDragStop, onConnect, onNodeClick,
  onPaneClick, onDelete, onSelectionChange, onNodeContextMenu, onEdgeContextMenu, children,
}: Props) {
  const scene = useMemo(() => buildScene(topology, layout), [topology, layout]);
  const ref = useRef<HTMLDivElement>(null);

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
      className: "union-outline",
    })),
    [topology, livePositions],
  );

  // Пока узел тащат, applyNodeChanges обновляет только позиции узлов; рёбра
  // рисуются по центрам узлов из data.from/to, поэтому пересчитываем их из
  // текущих позиций — иначе связи «догоняют» узел только после drag-stop.
  const nodes = useMemo<Node[]>(
    () => rfNodes.map((n) => {
      const mark = markOf?.(n.id);
      const geo = nodeGeometry((n.type ?? "device") as SceneNode["type"]);
      return mark ? { ...n, className: mark, ...geo } : { ...n, ...geo };
    }),
    [rfNodes, markOf],
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setRfNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const edges = useMemo(() => {
    const centerOf = new Map(rfNodes.map((n) => {
      const net = (n.type ?? "device") === "network";
      const [w, h] = net ? [NET_W, NET_H] : [DEVICE_W, DEVICE_H];
      return [n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2 }] as const;
    }));
    return scene.edges.map((e) => {
      const from = centerOf.get(e.source) ?? e.data.from;
      const to = centerOf.get(e.target) ?? e.data.to;
      const mark = markOf?.(e.id);
      const base = { ...e, data: { ...e.data, from, to } };
      return mark ? { ...base, className: mark } : base;
    });
  }, [scene.edges, rfNodes, markOf]);

  const handleMoveEnd = useCallback<OnMove>(
    (_event, viewport) => onMoveEnd?.(viewport),
    [onMoveEnd],
  );

  // Клик по панели: координаты события переводятся в координаты сцены.
  const { screenToFlowPosition } = useReactFlow();
  const handlePaneClick = useCallback<NonNullable<ReactFlowProps["onPaneClick"]>>(
    (event) => onPaneClick?.(screenToFlowPosition({ x: event.clientX, y: event.clientY })),
    [onPaneClick, screenToFlowPosition],
  );

  // Del удаляет выбранные узлы: события клавиатуры идут на контейнер,
  // потому что фокус у React Flow, а не у инпутов страницы. Панели редактиро-
  // вания рендерятся внутри .canvas-wrap — их keydown (в т.ч. Delete при
  // наборе текста) не должен доходить до удаления узлов.
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Delete" || !onDelete) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof Element && target.closest(".canvas-panel"))
    ) return;
    const ids = rfNodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length) onDelete(ids);
  }, [rfNodes, onDelete]);

  // RF сам отслеживает выделение (в т.ч. через рамку и multiSelectionKeyCode);
  // свой список по кликам дублировал бы это состояние.
  const handleSelectionChange = useCallback<OnSelectionChangeFunc>(
    ({ nodes }) => onSelectionChange?.(nodes.map((n) => n.id)),
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

  return (
    <div
      ref={ref}
      className="canvas-wrap"
      data-testid="topo-canvas"
      style={{ width: "100%", height: "100%" }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <ReactFlow
        nodes={[...unionNodes, ...nodes]}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={!scene.viewport}
        defaultViewport={scene.viewport}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={(_event, node) => onNodeDragStop?.(node.id, node.position)}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={handlePaneClick}
        onSelectionChange={handleSelectionChange}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        onPaneContextMenu={(e) => e.preventDefault()}
      >
        <Background gap={24} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {children}
    </div>
  );
}
