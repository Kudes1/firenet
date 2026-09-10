import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { NET_CLOUD_PATH, NET_H, NET_W } from "./cloud";

// Узел сети — «облако»: контур из квадратичных сегментов, цвет обводки по
// объединению, внутри имя и состав.
export const NetworkNode = memo(function NetworkNode({ data, selected }: NodeProps) {
  const { name, subnets, description } = data as unknown as {
    name: string; subnets?: string[]; description?: string;
  };
  return (
    <div
      className={`topo-node network-node${selected ? " selected" : ""}`}
      title={description || undefined}
      style={{ width: NET_W, height: NET_H }}
    >
      <svg
        className="net-cloud"
        width={NET_W + 14}
        height={NET_H + 14}
        viewBox="-7 -7 174 74"
        aria-hidden
      >
        <path className="net-cloud-outline" d={NET_CLOUD_PATH} />
      </svg>
      <span className="node-label">{name}</span>
      {!!subnets?.length && <span className="node-hint">{subnets.join(", ")}</span>}
    </div>
  );
});
