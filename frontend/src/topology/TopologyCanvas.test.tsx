import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import * as fx from "../api/fixtures";
import TopologyCanvas from "./TopologyCanvas";

const topology: TopologyDoc = fx.topologyFixture;
const layout: LayoutDoc = {
  devices: { r1: { x: 0, y: 0 }, sw1: { x: 300, y: 0 } },
  networks: { office: { x: 0, y: 200 } },
  links: {},
  camera: { x: 0, y: 0, z: 1 },
};

describe("TopologyCanvas", () => {
  beforeEach(() => {
    // React Flow требует ненулевой размер контейнера; в jsdom он нулевой.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
    });
  });

  it("renders one node per positioned device and network", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-network:office")).toBeInTheDocument();
    // label узла — «r1 (router)»; проверяем текст внутри обёртки узла.
    expect(screen.getByTestId("rf__node-device:r1")).toHaveTextContent("r1");
    expect(screen.getByTestId("rf__node-network:office")).toHaveTextContent("office");
  });

  it("renders links and attachments as edges", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    // id ребра из buildScene (Task 17): link:<канонический ключ>#<offset>.
    // LinkEdge ставит его как data-testid на корневой <g>.
    expect(await screen.findByTestId("link:r1|sw1#0")).toBeInTheDocument();
    expect(screen.getByTestId("attach:office|sw1")).toBeInTheDocument();
  });

  // Обёртку узла RF маркирует rf__node-<id>, обёртку ребра — rf__edge-<id>.
  // Эту обёртку и используем как якорь, чтобы не зависеть от внутренних div.
  it("does not render drag handles in read-only mode", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    await screen.findByTestId("rf__node-device:r1");
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("renders handles when editable", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable />);
    await screen.findByTestId("rf__node-device:r1");
    expect(document.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0);
  });

  it("applies diagnostic marks as wrapper classes", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        markOf={(id) => (id === "device:r1" ? "diag-flow-ok" : undefined)}
      />,
    );
    // RF кладёт className объекта узла на обёртку rf__node-<id>, а НЕ на
    // внутренний div кастомного компонента (см. «известные подводные камни»).
    const node = await screen.findByTestId("rf__node-device:r1");
    expect(node.className).toContain("diag-flow-ok");
  });
});
