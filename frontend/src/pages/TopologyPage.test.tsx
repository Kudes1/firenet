import { fireEvent, screen, waitFor } from "@testing-library/react";
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

describe("TopologyPage", () => {
  it("renders the canvas with devices and networks", async () => {
    useRichLayout();
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    // testid на обёртке RF — rf__node-<id> (см. Task 18, «подводные камни»).
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-device:sw1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-network:office")).toBeInTheDocument();
  });

  it("starts in the select tool", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-select");
    expect(screen.getByTestId("tool-select").className).toContain("active");
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
