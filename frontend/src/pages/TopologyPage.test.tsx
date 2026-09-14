import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc } from "../api/types";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import TopologyPage from "./TopologyPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

beforeEach(() => {
  // React Flow требует ненулевой размер контейнера; в jsdom он нулевой.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
  });
});

// Фикстура layout из msw содержит только r1: для тестов, где нужны sw1 и
// сеть office на канве, подменяем layout-ручку расширенным документом.
const richLayout: LayoutDoc = {
  devices: { r1: { x: 0, y: 0 }, sw1: { x: 300, y: 0 } },
  networks: { office: { x: 0, y: 200 } },
  links: {},
  camera: { x: 0, y: 0, z: 1 },
};

function useRichLayout() {
  server.use(http.get("/api/drafts/d1/layout", () => HttpResponse.json(richLayout)));
}

// Документ без связей: фикстурная topology уже содержит r1–sw1, поэтому
// создание связи проверяется на своей подмене (msw применяется до рендера).
function useUnlinkedTopology() {
  server.use(http.get("/api/drafts/d1/topology", () => HttpResponse.json({
    devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch" }],
    links: [],
    networks: [{ name: "office" }],
    sets: [],
    unions: [],
  })));
}

// Клик по узлу: user.click уходит в d3-drag, который в jsdom падает на
// event.view === null, поэтому клики по канве идут через fireEvent.
async function pickAsync(testId: string) {
  fireEvent.click(await screen.findByTestId(testId));
}

// Тело ушедшей операции: страница дебаунсит flush на 400 мс.
function captureOperations() {
  const bodies: unknown[] = [];
  server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
    bodies.push(await request.json());
    return HttpResponse.json({ topology: {}, layout: {} });
  }));
  return bodies;
}

describe("TopologyPage", () => {
  it("exposes the topology workspace and primary tools", () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");

    expect(screen.getByTestId("page-topology")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Топология" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Инструменты топологии" })).toBeInTheDocument();
    expect(screen.getByTestId("tool-select")).toBeInTheDocument();
    expect(screen.getByTestId("tool-connect")).toBeInTheDocument();
    expect(screen.getByTestId("tool-device")).toBeInTheDocument();
    expect(screen.getByTestId("tool-network")).toBeInTheDocument();
  });

  it("renders the canvas with devices and networks", async () => {
    useRichLayout();
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    // testid на обёртке RF — rf__node-<id> (см. Task 18, «подводные камни»).
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-device:sw1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-network:office")).toBeInTheDocument();
  });

  it("shows the member subnet details when a network is clicked", async () => {
    useRichLayout();
    renderPage(<TopologyPage />, "/ui/topology", "d1");

    fireEvent.click(await screen.findByTestId("rf__node-network:office"));

    expect(screen.getByTestId("network-info")).toHaveTextContent("lan");
    expect(screen.getByTestId("network-info")).toHaveTextContent("10.0.0.0/24");
  });

  it("starts in the select tool", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-select");
    expect(screen.getByTestId("tool-select").className).toContain("active");
  });

  it("shows an icon for the current server sync status", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    const status = await screen.findByRole("status", { name: "Сохранено" });
    expect(status.querySelector("svg")).toBeInTheDocument();
  });

  it("creates a switch with the name entered before placing it", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({
        topology: {
          devices: [{ name: "core-sw", kind: "switch" }],
          links: [], networks: [], sets: [], unions: [],
        },
        layout: {
          devices: { "core-sw": { x: 200, y: 100 } }, networks: {}, links: {},
          camera: { x: 0, y: 0, z: 1 },
        },
      });
    }));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    expect(screen.getByTestId("create-panel")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.type(await screen.findByLabelText("Имя"), "core-sw");
    await user.selectOptions(screen.getByLabelText("Тип"), "switch");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(screen.getByTestId("rf__node-device:core-sw")).toBeInTheDocument();
    await waitFor(() => expect(body).toEqual({ operations: [
      { kind: "create-device", device: { name: "core-sw", kind: "switch" } },
      { kind: "set-device-position", deviceName: "core-sw", position: expect.any(Object) },
    ] }), { timeout: 2000 });
    expect(screen.getByTestId("rf__node-device:core-sw")).toBeInTheDocument();
    expect(screen.getByTestId("tool-device").className).toContain("active");
  });

  it("keeps an optimistic device when the initial topology request resolves later", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    server.use(http.get("/api/drafts/d1/topology", async () => {
      requestStarted();
      await blocked;
      return HttpResponse.json({
        devices: [], links: [], networks: [], sets: [], unions: [],
      });
    }));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await started;
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    await user.type(await screen.findByLabelText("Имя"), "late-device");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(screen.getByTestId("rf__node-device:late-device")).toBeInTheDocument();

    await act(async () => { release(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await waitFor(() => expect(screen.getByTestId("rf__node-device:late-device")).toBeInTheDocument());
  });

  it("removes an optimistically created device after a failed save", async () => {
    server.use(http.post("/api/drafts/d1/topology/operations/batch", () =>
      HttpResponse.json({ error: "name already exists" }, { status: 422 })));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    await user.type(await screen.findByLabelText("Имя"), "temporary");
    await user.click(screen.getByRole("button", { name: "Создать" }));

    expect(screen.getByTestId("rf__node-device:temporary")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("rf__node-device:temporary")).toBeNull(), { timeout: 2000 });
  });

  it("removes a failed optimistic device when another is created during rollback", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let refetchStarted!: () => void;
    const refetch = new Promise<void>((resolve) => { refetchStarted = resolve; });
    let topologyRequests = 0;
    server.use(
      http.get("/api/drafts/d1/topology", async () => {
        topologyRequests += 1;
        if (topologyRequests === 2) {
          refetchStarted();
          await blocked;
        }
        return HttpResponse.json(topologyRequests === 1 ? {
          devices: [{ name: "r1", kind: "router" }], links: [], networks: [], sets: [], unions: [],
        } : { devices: [], links: [], networks: [], sets: [], unions: [] });
      }),
      http.post("/api/drafts/d1/topology/operations/batch", () =>
        HttpResponse.json({ error: "name already exists" }, { status: 422 })),
    );
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("rf__node-device:r1");
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    await user.type(await screen.findByLabelText("Имя"), "failed-first");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(screen.getByTestId("rf__node-device:failed-first")).toBeInTheDocument();
    await act(async () => { await refetch; });

    await user.click(screen.getByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 300, clientY: 200 });
    await user.type(await screen.findByLabelText("Имя"), "kept-second");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(screen.getByTestId("rf__node-device:kept-second")).toBeInTheDocument();
    await act(async () => { release(); });

    await waitFor(() => expect(screen.queryByTestId("rf__node-device:failed-first")).toBeNull(), { timeout: 2000 });
    expect(screen.getByTestId("rf__node-device:kept-second")).toBeInTheDocument();
  });

  it("does not create a network when its dialog is cancelled", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ topology: {}, layout: {} });
    }));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-network"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    expect(screen.getByTestId("create-panel")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.type(await screen.findByLabelText("Имя"), "guest");
    expect(screen.queryByLabelText("Тип")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(body).toBeUndefined();
    expect(screen.getByTestId("tool-network").className).toContain("active");
  });

  it("closes the creation panel when the canvas is clicked outside it", async () => {
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-network"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    expect(screen.getByTestId("create-panel")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 500, clientY: 400 });
    expect(screen.queryByTestId("create-panel")).toBeNull();
  });

  it("closes the creation panel with Escape", async () => {
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    await user.type(await screen.findByLabelText("Имя"), "edge-r1");
    fireEvent.keyDown(screen.getByLabelText("Имя"), { key: "Escape" });
    expect(screen.queryByTestId("create-panel")).toBeNull();
  });

  it("warns instead of creating when read-only", async () => {
    const { user } = renderPage(<TopologyPage />, "/ui/topology");
    await screen.findByTestId("tool-device");
    await user.click(screen.getByTestId("tool-device"));
    expect(await screen.findByTestId("banner")).toBeInTheDocument();
  });

  it("filters nodes by the search query", async () => {
    useRichLayout();
    const page = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("rf__node-device:r1");
    await page.user.click(screen.getByTestId("topo-search-toggle"));
    await page.user.type(screen.getByPlaceholderText(/поиск/), "sw1");
    // Класс подсветки (search-hit/search-dim) RF кладёт на обёртку rf__node-<id>.
    expect(screen.getByTestId("rf__node-device:sw1").className).toContain("search-hit");
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("search-dim");
  });

  it("deletes the selection with Del", async () => {
    useRichLayout();
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ topology: {}, layout: {} });
    }));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    const node = await screen.findByTestId("rf__node-device:r1");
    // fireEvent, а не user.click: mousedown узла уходит в d3-drag, который в
    // jsdom падает на event.view === null; клик через fireEvent его не зовёт.
    fireEvent.click(node);
    // Канва ровно одна: обёртка страницы не должна дублировать .canvas-wrap,
    // который рендерит сам TopologyCanvas.
    const wraps = document.querySelectorAll(".canvas-wrap");
    expect(wraps.length).toBe(1);
    fireEvent.keyDown(wraps[0], { key: "Delete" });
    // flush дебаунсится на 400 мс — ждём отправку операции.
    await waitFor(() => expect(body).toEqual({ kind: "delete-device", deviceName: "r1" }), { timeout: 2000 });
    void user;
  });

  // --- connect-инструмент: клик по первому объекту, клик по второму ---

  it("creates a link between two devices", async () => {
    useRichLayout();
    useUnlinkedTopology();
    const bodies = captureOperations();
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-connect");
    await user.click(screen.getByTestId("tool-connect"));
    await pickAsync("rf__node-device:r1");
    // Первый клик только запоминает объект: узел подсвечен, операции нет.
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("pending");
    expect(bodies).toEqual([]);
    await pickAsync("rf__node-device:sw1");
    await waitFor(() => expect(bodies).toEqual([
      { kind: "create-link", link: { a: { device: "r1" }, b: { device: "sw1" } } },
    ]), { timeout: 2000 });
  });

  it("attaches a network to a device", async () => {
    useRichLayout();
    const bodies = captureOperations();
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-connect");
    await user.click(screen.getByTestId("tool-connect"));
    await pickAsync("rf__node-network:office");
    await pickAsync("rf__node-device:r1");
    await waitFor(() => expect(bodies).toEqual([
      { kind: "attach-network", networkName: "office", attach: { device: "r1" } },
    ]), { timeout: 2000 });
  });

  it("warns when the devices are already linked", async () => {
    useRichLayout();
    const bodies = captureOperations();
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-connect");
    await user.click(screen.getByTestId("tool-connect"));
    // Связь r1–sw1 уже есть в фикстуре topology.
    await pickAsync("rf__node-device:r1");
    await pickAsync("rf__node-device:sw1");
    expect(await screen.findByTestId("banner")).toHaveTextContent("уже соединены");
    expect(bodies).toEqual([]);
    // Предупреждение снимает выбор: следующий клик снова начинает пару.
    expect(screen.getByTestId("rf__node-device:r1").className).not.toContain("pending");
  });

  it("warns that networks cannot be linked to each other", async () => {
    useRichLayout();
    // Вторую сеть добавляем и в документ, и в layout: без позиции узел на
    // канву не попадает, без записи в doc сеть не видна connect-логике.
    server.use(http.get("/api/drafts/d1/topology", () => HttpResponse.json({
      devices: [{ name: "r1", kind: "router" }],
      links: [],
      networks: [{ name: "office" }, { name: "guest" }],
      sets: [],
      unions: [],
    })));
    server.use(http.get("/api/drafts/d1/layout", () => HttpResponse.json({
      devices: { r1: { x: 0, y: 0 } },
      networks: { office: { x: 0, y: 200 }, guest: { x: 300, y: 200 } },
      links: {},
      camera: { x: 0, y: 0, z: 1 },
    })));
    const bodies = captureOperations();
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-connect");
    await user.click(screen.getByTestId("tool-connect"));
    await pickAsync("rf__node-network:office");
    await pickAsync("rf__node-network:guest");
    expect(await screen.findByTestId("banner")).toHaveTextContent("не могут быть соединены напрямую");
    expect(bodies).toEqual([]);
  });

  it("cancels the pending pick on a pane click", async () => {
    useRichLayout();
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-connect");
    await user.click(screen.getByTestId("tool-connect"));
    await pickAsync("rf__node-device:r1");
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("pending");
    // Клик по пустому полю канвы (панель под узлами).
    fireEvent.click(document.querySelector(".react-flow__pane")!);
    expect(screen.getByTestId("rf__node-device:r1").className).not.toContain("pending");
  });

  it("does not select the node while connecting", async () => {
    useRichLayout();
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-connect");
    await user.click(screen.getByTestId("tool-connect"));
    await pickAsync("rf__node-device:r1");
    // Клик адресован соединению, а не выделению (паритет с легаси).
    expect(screen.getByTestId("rf__node-device:r1").className).not.toContain("selected");
  });

  it("switches tools with keyboard shortcuts", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-select");
    fireEvent.keyDown(document.body, { key: "c" });
    expect(screen.getByTestId("tool-connect").className).toContain("active");
    fireEvent.keyDown(document.body, { key: "v" });
    expect(screen.getByTestId("tool-select").className).toContain("active");
  });

  it("ignores tool shortcuts typed into a field", async () => {
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("topo-search-toggle");
    await user.click(screen.getByTestId("topo-search-toggle"));
    fireEvent.keyDown(screen.getByPlaceholderText(/поиск/), { key: "c" });
    expect(screen.getByTestId("tool-select").className).toContain("active");
  });

  // --- контекстное меню (паритет с легаси setupContextMenu) ---

  async function openNodeMenu(testId: string) {
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    const node = await screen.findByTestId(testId);
    fireEvent.contextMenu(node, { clientX: 150, clientY: 120 });
    await screen.findByTestId("topo-context-menu");
    return user;
  }

  it("opens a context menu on node right-click with union submenu", async () => {
    useRichLayout();
    await openNodeMenu("rf__node-device:sw1");
    // sw1 не входит в объединение u1 — подменю предлагает его добавить.
    const add = screen.getByTestId("ctx-sub-Добавить в объединение");
    fireEvent.mouseEnter(add);
    expect(screen.getByRole("button", { name: "В объединение «u1»" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить устройство sw1" })).toBeInTheDocument();
  });

  it("adds the clicked node to a union through the menu", async () => {
    useRichLayout();
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ topology: {}, layout: {} });
    }));
    await openNodeMenu("rf__node-device:sw1");
    fireEvent.mouseEnter(screen.getByTestId("ctx-sub-Добавить в объединение"));
    fireEvent.click(screen.getByRole("button", { name: "В объединение «u1»" }));
    // Меню закрылось, операция ушла после дебаунса flush.
    expect(screen.queryByTestId("topo-context-menu")).toBeNull();
    await waitFor(() => expect(body).toEqual({ kind: "union-add-device", unionName: "u1", deviceName: "sw1" }), { timeout: 2000 });
  });

  it("removes a node from its union through the menu", async () => {
    useRichLayout();
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ topology: {}, layout: {} });
    }));
    await openNodeMenu("rf__node-device:r1");
    fireEvent.click(screen.getByRole("button", { name: "Убрать из объединения" }));
    await waitFor(() => expect(body).toEqual({ kind: "union-remove-device", unionName: "u1", deviceName: "r1" }), { timeout: 2000 });
  });

  it("deletes a device through the menu", async () => {
    useRichLayout();
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ topology: {}, layout: {} });
    }));
    await openNodeMenu("rf__node-device:r1");
    fireEvent.click(screen.getByRole("button", { name: "Удалить устройство r1" }));
    await waitFor(() => expect(body).toEqual({ kind: "delete-device", deviceName: "r1" }), { timeout: 2000 });
  });

  it("edits a device in a panel inside the canvas", async () => {
    useRichLayout();
    await openNodeMenu("rf__node-device:r1");
    fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    // Модалка та же, что со страницы устройств: имя + объединение + описание.
    expect(await screen.findByLabelText("Имя")).toBeInTheDocument();
    expect(await screen.findByLabelText("Объединение")).toBeInTheDocument();
    expect(await screen.findByLabelText("Описание")).toBeInTheDocument();
  });

  it("edits a network in a panel inside the canvas", async () => {
    useRichLayout();
    await openNodeMenu("rf__node-network:office");
    fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    // Подсети рендерятся MemberList (label без htmlFor) — ищем бейдж lan
    // внутри модалки (на канве он тоже встречается).
    expect(await screen.findAllByText("lan")).not.toHaveLength(0);
  });

  it("edits a link filter in a panel inside the canvas", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    // Ребро — SVG <g> с data-testid; ПКМ по нему доходит до RF. Дефолтного
    // msw-layout хватает: он содержит r1, sw1 и office.
    const edge = await screen.findByTestId("link:r1|sw1#0");
    fireEvent.contextMenu(edge, { clientX: 200, clientY: 100 });
    const filter = await screen.findByRole("button", { name: "Фильтровать" });
    fireEvent.click(filter);
    // Обычная связь: «Фильтровать» создаёт пустой фильтр и открывает модалку
    // с двумя колонками «Экспорт» (по одной на сторону).
    expect((await screen.findAllByText("Экспорт", { selector: "p.filter-dir-title" })).length).toBe(2);
    // Форма редактирования — панель внутри канвы (.canvas-panel), не <dialog>.
    expect(document.querySelector(".canvas-panel")).not.toBeNull();
  });

  it("opens device edit panel inside the canvas", async () => {
    useRichLayout();
    await openNodeMenu("rf__node-device:r1");
    fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    expect(await screen.findByLabelText("Имя")).toBeInTheDocument();
    // Форма редактирования — панель внутри канвы (.canvas-panel), не <dialog>.
    expect(document.querySelector(".canvas-panel")).not.toBeNull();
  });

  it("outlines link endpoints while the filter panel is open", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    const edge = await screen.findByTestId("link:r1|sw1#0");
    fireEvent.contextMenu(edge, { clientX: 200, clientY: 100 });
    fireEvent.click(await screen.findByRole("button", { name: "Фильтровать" }));
    // Канонический порядок: a = r1 (голубой), b = sw1 (оранжевый).
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("link-end-a");
    expect(screen.getByTestId("rf__node-device:sw1").className).toContain("link-end-b");
    // Неучаствующие узлы затемняются.
    expect(screen.getByTestId("rf__node-network:office").className).toContain("search-dim");
    // Закрытие модалки снимает подсветку.
    fireEvent.click(document.querySelector("button.modal-close")!);
    expect(screen.getByTestId("rf__node-device:r1").className).not.toContain("link-end-a");
    expect(screen.getByTestId("rf__node-device:sw1").className).not.toContain("link-end-b");
  });

  it("does not open the context menu when read-only", async () => {
    renderPage(<TopologyPage />, "/ui/topology");
    const node = await screen.findByTestId("rf__node-device:r1");
    fireEvent.contextMenu(node, { clientX: 150, clientY: 120 });
    expect(screen.queryByTestId("topo-context-menu")).toBeNull();
  });
});
