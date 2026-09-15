import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import * as fx from "../api/fixtures";
import TopologyCanvas from "./TopologyCanvas";
import { unionColor } from "./scene";

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
  // Хэндлы на узлах убраны: связи создаются отдельным инструментом, а не
  // перетаскиванием с хэндла. Проверяем, что их нет даже в editable-режиме.
  it("does not render drag handles in read-only mode", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    await screen.findByTestId("rf__node-device:r1");
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("does not render handles even when editable", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable />);
    await screen.findByTestId("rf__node-device:r1");
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("applies diagnostic marks as wrapper classes", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        markOf={(id) => {
          if (id === "device:r1") return "diag-flow-ok";
          if (id === "union:u1") return "diag-dim";
          return undefined;
        }}
      />,
    );
    // RF кладёт className объекта узла на обёртку rf__node-<id>, а НЕ на
    // внутренний div кастомного компонента (см. «известные подводные камни»).
    const node = await screen.findByTestId("rf__node-device:r1");
    expect(node.className).toContain("diag-flow-ok");
    expect(screen.getByTestId("rf__node-union:u1").className).toContain("diag-dim");
  });

  // Фон канвы — один слой точек от <Background /> RF. Шаг 24px — размер
  // старой CSS-сетки .canvas-wrap, которую RF-фон заменил.
  it("renders the dotted background with 24px gap", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    const bg = await screen.findByTestId("rf__background");
    const pattern = bg.querySelector("pattern");
    expect(pattern).not.toBeNull();
    expect(pattern?.getAttribute("width")).toBe("24");
    expect(pattern?.getAttribute("height")).toBe("24");
  });

  it("hides the React Flow attribution", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    await screen.findByTestId("rf__background");
    expect(document.querySelector(".react-flow__attribution")).toBeNull();
  });

  it("renders overlays outside the clipped canvas surface", () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        canvasChildren={<div data-testid="canvas-content-child" />}
      >
        <div data-testid="canvas-overlay-child" />
      </TopologyCanvas>,
    );
    const canvasChild = screen.getByTestId("canvas-content-child");
    const shellChild = screen.getByTestId("canvas-overlay-child");
    expect(canvasChild.closest(".canvas-wrap")).not.toBeNull();
    expect(shellChild.parentElement).toHaveClass("canvas-shell");
    expect(shellChild.closest(".canvas-wrap")).toBeNull();
  });

  it("creates a node on pane click only, not on node click", async () => {
    const onPaneClick = vi.fn();
    render(<TopologyCanvas topology={topology} layout={layout} editable onPaneClick={onPaneClick} />);
    await screen.findByTestId("rf__node-device:r1");
    // Клик по узлу — это не клик по панели, создание узла не вызывается.
    fireEvent.click(screen.getByTestId("rf__node-device:r1"));
    expect(onPaneClick).not.toHaveBeenCalled();
  });

  it("reports the selected node ids on Delete", async () => {
    const onDelete = vi.fn();
    render(<TopologyCanvas topology={topology} layout={layout} editable onDelete={onDelete} />);
    const node = await screen.findByTestId("rf__node-device:r1");
    fireEvent.click(node);
    fireEvent.keyDown(screen.getByTestId("topo-canvas"), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledWith(["device:r1"]);
  });

  // Панели редактирования рендерятся в overlay-слое: Delete, нажатый в
  // инпуте панели (или любом другом поле), не должен удалять узлы канвы.
  it("ignores Delete from panel inputs and other form fields", async () => {
    const onDelete = vi.fn();
    render(<TopologyCanvas topology={topology} layout={layout} editable onDelete={onDelete} />);
    const node = await screen.findByTestId("rf__node-device:r1");
    fireEvent.click(node);
    const canvas = screen.getByTestId("topo-canvas");
    // Инпут внутри панели редактирования.
    const input = document.createElement("input");
    const panel = document.createElement("div");
    panel.className = "canvas-panel";
    panel.appendChild(input);
    canvas.appendChild(panel);
    fireEvent.keyDown(input, { key: "Delete", bubbles: true });
    expect(onDelete).not.toHaveBeenCalled();
    // Тот же Delete с самой канвы по-прежнему удаляет выделение.
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledWith(["device:r1"]);
  });

  // Единый источник истины о выделении — RF: страница получает id выбранных
  // узлов через onSelectionChange, а не ведёт свой список по кликам.
  it("reports selection changes", async () => {
    const onSelectionChange = vi.fn();
    render(
      <TopologyCanvas topology={topology} layout={layout} editable onSelectionChange={onSelectionChange} />,
    );
    fireEvent.click(await screen.findByTestId("rf__node-device:r1"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["device:r1"]);
  });

  // После drag-stop позиция сохраняется, и в кэш react-query кладутся новые
  // topology/layout (setQueryData). Пересборка scene не должна затирать
  // selected в локальном стейте узлов — выделение сохраняется.
  it("keeps node selection when topology/layout props are replaced", async () => {
    const { rerender } = render(<TopologyCanvas topology={topology} layout={layout} editable />);
    const node = await screen.findByTestId("rf__node-device:r1");
    fireEvent.click(node);
    expect(node.className).toContain("selected");
    rerender(
      <TopologyCanvas
        topology={{ ...topology, devices: topology.devices && [...topology.devices] }}
        layout={{ ...layout, devices: { ...layout.devices } }}
        editable
      />,
    );
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("selected");
  });

  // Серверный снапшот (layout в пропах) приходит с дебаунсом и не знает
  // локальных позиций, накопившихся за время его полёта. Пересборка сцены
  // должна брать состав с сервера, а позиции существующих узлов —
  // локальные, иначе узел на мгновение отпрыгивает на старое место.
  it("keeps local node positions when a server snapshot arrives", async () => {
    const { rerender } = render(<TopologyCanvas topology={topology} layout={layout} editable />);
    const node = () => screen.getByTestId("rf__node-device:r1");
    await screen.findByTestId("rf__node-device:r1");
    // Локальный перенос узла стрелкой — тот же пайплайн onNodesChange, что и drag.
    fireEvent.click(node());
    fireEvent.keyDown(node(), { key: "ArrowRight", bubbles: true });
    const localStyle = node().getAttribute("style");
    expect(localStyle).toContain("transform");
    // Снапшот с сервера: layout со старой позицией r1 + новый узел.
    rerender(
      <TopologyCanvas
        topology={{ ...topology, networks: [...(topology.networks ?? []), { name: "extra", attach: [] }] }}
        layout={{ ...layout, devices: { ...layout.devices, r1: { x: 0, y: 0 } }, networks: { ...layout.networks, extra: { x: 500, y: 500 } } }}
        editable
      />,
    );
    expect(await screen.findByTestId("rf__node-network:extra")).toBeInTheDocument();
    // Позиция r1 осталась локальной — transform не совпадает со стилем
    // узла, остававшегося на месте (extra в 500/500).
    expect(node().getAttribute("style")).not.toBe(screen.getByTestId("rf__node-network:extra").getAttribute("style"));
    expect(node().getAttribute("style")).toBe(localStyle);
  });

  // Рёбра рисуются по центрам узлов из data.from/to. Пока узел тащат, RF
  // обновляет только позиции узлов, но концы рёбер должны ехать вместе с
  // узлом, а не дожидаться drag-stop и сохранения layout. Мышный drag в
  // jsdom не воспроизводится (d3-drag требует настоящий event.view), поэтому
  // двигаем узел стрелкой — RF ведёт это через тот же пайплайн onNodesChange.
  it("moves edge ends when the node changes position", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable />);
    const node = await screen.findByTestId("rf__node-device:r1");
    const edgePath = () =>
      document.querySelector('[data-testid="link:r1|sw1#0"] path')?.getAttribute("d");
    const before = edgePath();
    fireEvent.click(node);
    fireEvent.keyDown(node, { key: "ArrowRight", bubbles: true });
    expect(edgePath()).not.toBe(before);
  });

  // Краска по типу — через классы kind-* (цвет живёт в CSS --kind-*), как в
  // легаси: router оранжевый, switch фиолетовый, network зелёный. unionColor
  // в стилях узла больше не участвует.
  it("styles nodes by kind, not by union color", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    expect(document.querySelector(".kind-router")).not.toBeNull();
    expect(document.querySelector(".kind-switch")).not.toBeNull();
    expect(document.querySelector(".network-node")).not.toBeNull();
  });

  // Сеть рисуется облаком: svg-путь с квадратичными бугорками по периметру.
  it("renders the network node as a cloud svg path", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    const cloud = document.querySelector(".network-node svg path.net-cloud-outline");
    expect(cloud).not.toBeNull();
    const d = cloud!.getAttribute("d") ?? "";
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.split("Q").length - 1).toBeGreaterThanOrEqual(18);
  });

  it("opens network info with member subnet names and CIDRs", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        subnets={[{ name: "lan", cidr: "10.0.0.0/24" }]}
      />,
    );

    fireEvent.click(await screen.findByTestId("rf__node-network:office"));

    const info = screen.getByTestId("network-info");
    expect(screen.getByTestId("rf__node-network:office").className).toContain("selected");
    expect(info).toHaveTextContent("office");
    expect(info).toHaveTextContent("lan");
    expect(info).toHaveTextContent("10.0.0.0/24");
  });

  it("switches network info when another network is clicked", async () => {
    const secondTopology = {
      ...topology,
      networks: [...(topology.networks ?? []), { name: "guest", subnets: ["guests"], attach: [] }],
    };
    const secondLayout = {
      ...layout,
      networks: { ...layout.networks, guest: { x: 300, y: 200 } },
    };
    render(
      <TopologyCanvas
        topology={secondTopology}
        layout={secondLayout}
        editable={false}
        subnets={[
          { name: "lan", cidr: "10.0.0.0/24" },
          { name: "guests", cidr: "10.0.1.0/24" },
        ]}
      />,
    );

    fireEvent.click(await screen.findByTestId("rf__node-network:office"));
    fireEvent.click(screen.getByTestId("rf__node-network:guest"));

    expect(screen.getByTestId("network-info")).toHaveTextContent("guests");
    expect(screen.getByTestId("network-info")).toHaveTextContent("10.0.1.0/24");
    expect(screen.getByTestId("network-info")).not.toHaveTextContent("10.0.0.0/24");
  });

  it("closes network info when the canvas background is clicked", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        subnets={[{ name: "lan", cidr: "10.0.0.0/24" }]}
      />,
    );
    fireEvent.click(await screen.findByTestId("rf__node-network:office"));

    fireEvent.click(document.querySelector(".react-flow__pane")!);

    expect(screen.queryByTestId("network-info")).not.toBeInTheDocument();
  });

  it("closes network info on Escape", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        subnets={[{ name: "lan", cidr: "10.0.0.0/24" }]}
      />,
    );
    fireEvent.click(await screen.findByTestId("rf__node-network:office"));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("network-info")).not.toBeInTheDocument();
  });

  // Контур объединения — подложка-прямоугольник вокруг участников с подписью
  // (легаси union:rrect + text). Реализуется RF-узлом типа union, чтобы жить
  // в общем слое под остальными узлами и двигаться с drag участников.
  it("renders union outlines as non-interactive nodes under the members", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    const box = await screen.findByTestId("rf__node-union:u1");
    const rect = box.querySelector(".union-outline-rect");
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute("stroke")).toBe(unionColor(0));
    expect(box.querySelector(".union-outline-label")!.textContent).toBe("u1");
    // Не мешает взаимодействию: без выделения и через слои под узлами.
    expect(box.className).toContain("union-outline");
    expect(box.className).not.toContain("selected");
    expect(document.querySelector('[data-testid="rf__node-device:r1"]')!.compareDocumentPosition(box)).toBeGreaterThan(0);
  });

  // ПКМ по узлу/ребру отдаёт странице id объекта и координаты в системе
  // канвы: меню позиционируется absolute внутри canvas-shell, поэтому
  // viewport-ные clientX/clientY нужно пересчитать (offset канвы вычитается).
  it("reports node and edge context menu with canvas-relative position", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const onCanvas = this.classList.contains("canvas-wrap");
      return {
        x: onCanvas ? 50 : 0, y: onCanvas ? 30 : 0,
        width: 800, height: 600, top: onCanvas ? 30 : 0, left: onCanvas ? 50 : 0,
        right: onCanvas ? 850 : 800, bottom: onCanvas ? 630 : 600, toJSON: () => ({}),
      };
    });
    const onNodeContextMenu = vi.fn();
    const onEdgeContextMenu = vi.fn();
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
      />,
    );
    const node = await screen.findByTestId("rf__node-device:r1");
    fireEvent.contextMenu(node, { clientX: 111, clientY: 222 });
    expect(onNodeContextMenu).toHaveBeenCalledWith("device:r1", { x: 61, y: 192 });
    fireEvent.contextMenu(screen.getByTestId("link:r1|sw1#0"), { clientX: 333, clientY: 44 });
    expect(onEdgeContextMenu).toHaveBeenCalledWith("link:r1|sw1#0", { x: 283, y: 14 });
  });
});
