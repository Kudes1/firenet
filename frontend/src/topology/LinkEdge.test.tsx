import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import TopologyCanvas from "./TopologyCanvas";

const topology: TopologyDoc = {
  devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }],
  links: [{ a: { device: "r1" }, b: { device: "sw1" } }],
  networks: [], sets: [], unions: [],
};
// r1 центр (70,30), sw1 центр (370,30): линия y=30, середина (220,30).
const layout: LayoutDoc = {
  devices: { r1: { x: 0, y: 0 }, sw1: { x: 300, y: 0 } },
  networks: {},
  links: {},
  camera: { x: 0, y: 0, z: 1 },
};

const hit = () => document.querySelector('[data-testid="link:r1|sw1#0"] path.link-hit')!;
const selectEdge = async () => fireEvent.click(await screen.findByTestId("rf__edge-link:r1|sw1#0"));

// jsdom не знает PointerEvent: RTL падает на window.Event и теряет clientX.
// PointerEvent в браузере наследует MouseEvent — строим его и добавляем
// pointerId вручную.
const pointer = (type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
};

describe("LinkEdge waypoints", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
    });
  });

  it("does not render the interaction layer in read-only mode", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    await screen.findByTestId("link:r1|sw1#0");
    expect(hit()).toBeNull();
  });

  it("applies diagnostic marks to the visible edge path", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        markOf={(id) => id === "link:r1|sw1#0" ? "diag-flow-ok diag-dim" : undefined}
      />,
    );
    const edge = await screen.findByTestId("link:r1|sw1#0");
    const classes = edge.querySelector(".react-flow__edge-path")?.getAttribute("class");
    expect(classes).toContain("diag-flow-ok");
    expect(classes).toContain("diag-dim");
  });

  it("keeps filtered and diagnostic state classes on the edge surface", async () => {
    const filteredTopology: TopologyDoc = {
      ...topology,
      links: [{ ...topology.links![0], filter: { aExports: ["lan"], bExports: [] } }],
    };
    render(
      <TopologyCanvas
        topology={filteredTopology}
        layout={layout}
        editable={false}
        markOf={(id) => id === "link:r1|sw1#0" ? "diag-flow-half" : undefined}
      />,
    );
    const edge = await screen.findByTestId("link:r1|sw1#0");
    expect(edge).toHaveClass("link-edge", "filtered", "diag-flow-half");
    expect(edge.querySelector(".react-flow__edge-path")).toHaveClass("link-edge", "filtered", "diag-flow-half");
  });

  it("shows waypoint handles only after selecting the edge", async () => {
    const withBend: LayoutDoc = {
      ...layout, links: { "r1|sw1": [[{ x: 220, y: 30 }]] },
    };
    render(<TopologyCanvas topology={topology} layout={withBend} editable onWaypointsChange={vi.fn()} />);
    const edge = await screen.findByTestId("rf__edge-link:r1|sw1#0");

    expect(screen.queryByTestId("waypoint:link:r1|sw1#0:0")).toBeNull();
    fireEvent.click(edge);
    expect(await screen.findByTestId("waypoint:link:r1|sw1#0:0")).toBeInTheDocument();
  });

  it("inserts a waypoint at the projected segment point on double click", async () => {
    const onWaypointsChange = vi.fn();
    render(<TopologyCanvas topology={topology} layout={layout} editable onWaypointsChange={onWaypointsChange} />);
    await screen.findByTestId("link:r1|sw1#0");
    fireEvent.doubleClick(hit(), { clientX: 221, clientY: 29 });
    // Проекция клика (221,29) на сегмент y=30.
    expect(onWaypointsChange).toHaveBeenCalledWith("link:r1|sw1#0", [{ x: 221, y: 30 }]);
  });

  it("removes a waypoint on double click at its handle", async () => {
    const withBend: LayoutDoc = {
      ...layout, links: { "r1|sw1": [[{ x: 220, y: 30 }]] },
    };
    const onWaypointsChange = vi.fn();
    render(<TopologyCanvas topology={topology} layout={withBend} editable onWaypointsChange={onWaypointsChange} />);
    await selectEdge();
    const handle = await screen.findByTestId("waypoint:link:r1|sw1#0:0");
    fireEvent.doubleClick(handle);
    expect(onWaypointsChange).toHaveBeenCalledWith("link:r1|sw1#0", []);
  });

  it("drags a waypoint locally and commits the final position on pointer up", async () => {
    const withBend: LayoutDoc = {
      ...layout, links: { "r1|sw1": [[{ x: 220, y: 30 }]] },
    };
    const onWaypointsChange = vi.fn();
    render(<TopologyCanvas topology={topology} layout={withBend} editable onWaypointsChange={onWaypointsChange} />);
    await selectEdge();
    const handle = await screen.findByTestId("waypoint:link:r1|sw1#0:0");
    fireEvent(handle, pointer("pointerdown", 220, 30));
    fireEvent(document, pointer("pointermove", 250, 80));
    expect(onWaypointsChange).not.toHaveBeenCalled();
    fireEvent(document, pointer("pointerup", 250, 80));
    expect(onWaypointsChange).toHaveBeenCalledWith("link:r1|sw1#0", [{ x: 250, y: 80 }]);
  });

  // Регрессия: старт drag брал нулевую точку, и между pointerdown и первым
  // pointermove маркер отрисовывался в начале координат (0,0) — точка
  // прыгала в левый верхний угол канвы и уезжала из-под курсора.
  it("keeps the handle at its own position between pointerdown and the first move", async () => {
    const withBend: LayoutDoc = {
      ...layout, links: { "r1|sw1": [[{ x: 220, y: 30 }]] },
    };
    render(<TopologyCanvas topology={topology} layout={withBend} editable onWaypointsChange={vi.fn()} />);
    await selectEdge();
    const handle = await screen.findByTestId("waypoint:link:r1|sw1#0:0");
    fireEvent(handle, pointer("pointerdown", 220, 30));
    expect(handle).toHaveAttribute("cx", "220");
    expect(handle).toHaveAttribute("cy", "30");
  });
});
