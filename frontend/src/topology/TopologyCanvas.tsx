import {
  applyNodeChanges, Background, Controls, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type NodeMouseHandler, type OnMove, type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import type { Node } from "@xyflow/react";
import { DeviceNode } from "./DeviceNode";
import { NetworkNode } from "./NetworkNode";
import { LinkEdge } from "./LinkEdge";
import { buildScene, DEVICE_H, DEVICE_W, NET_H, NET_W, type SceneNode } from "./scene";

const nodeTypes = { device: DeviceNode, network: NetworkNode };
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
  onPaneClick, onDelete,
}: Props) {
  const scene = useMemo(() => buildScene(topology, layout), [topology, layout]);

  // Выделение узлов — контролируемое: без onNodesChange клик по узлу не
  // выставляет selected, и Del не знает, что удалять.
  const [rfNodes, setRfNodes] = useState<Node[]>(() => scene.nodes);
  useEffect(() => { setRfNodes(scene.nodes); }, [scene.nodes]);

  // Классы подсветки навешиваются здесь, а не в узле: узел не знает, кто и
  // зачем его подсвечивает. applyNodeChanges работает с RF-узлами, поэтому
  // стор хранит RF-тип Node, а SceneNode восстанавливается по type.
  const nodes = useMemo<Node[]>(
    () => rfNodes.map((n) => {
      const mark = markOf?.(n.id);
      return mark
        ? { ...n, className: mark, ...nodeGeometry((n.type ?? "device") as SceneNode["type"]) }
        : { ...n, ...nodeGeometry((n.type ?? "device") as SceneNode["type"]) };
    }),
    [rfNodes, markOf],
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setRfNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const edges = useMemo(
    () => scene.edges.map((e) => {
      const mark = markOf?.(e.id);
      return mark ? { ...e, className: mark } : e;
    }),
    [scene.edges, markOf],
  );

  const handleMoveEnd = useCallback<OnMove>(
    (_event, viewport) => onMoveEnd?.(viewport),
    [onMoveEnd],
  );

  // Клик по панели: координаты события переводятся в координаты сцены.
  const { screenToFlowPosition } = useReactFlow();
  const handlePaneClick = useCallback((event: React.MouseEvent) => {
    if (!onPaneClick) return;
    onPaneClick(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [onPaneClick, screenToFlowPosition]);

  // Del удаляет выбранные узлы: события клавиатуры идут на контейнер,
  // потому что фокус у React Flow, а не у инпутов страницы.
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Delete" || !onDelete) return;
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length) onDelete(ids);
  }, [nodes, onDelete]);

  return (
    <div
      className="canvas-wrap"
      data-testid="topo-canvas"
      style={{ width: "100%", height: "100%" }}
      onClick={handlePaneClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <ReactFlow
        nodes={nodes}
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
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
