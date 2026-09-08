import {
  Background, Controls, MiniMap, Position, ReactFlow,
  type Connection, type NodeMouseHandler, type OnMove,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import type { LayoutDoc, TopologyDoc } from "../api/types";
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
};

export default function TopologyCanvas({
  topology, layout, editable, markOf, onMoveEnd, onNodeDragStop, onConnect, onNodeClick,
}: Props) {
  const scene = useMemo(() => buildScene(topology, layout), [topology, layout]);

  // Классы подсветки навешиваются здесь, а не в узле: узел не знает, кто и
  // зачем его подсвечивает.
  const nodes = useMemo(
    () => scene.nodes.map((n) => {
      const mark = markOf?.(n.id);
      return mark
        ? { ...n, className: mark, ...nodeGeometry(n.type) }
        : { ...n, ...nodeGeometry(n.type) };
    }),
    [scene.nodes, markOf],
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

  return (
    <div className="canvas-wrap" style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
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
