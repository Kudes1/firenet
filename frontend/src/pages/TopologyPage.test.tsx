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
    const canvas = document.querySelectorAll(".canvas-wrap")[1];
    fireEvent.keyDown(canvas, { key: "Delete" });
    // flush дебаунсится на 400 мс — ждём отправку операции.
    await waitFor(() => expect(body).toEqual({ kind: "delete-device", deviceName: "r1" }), { timeout: 2000 });
    void user;
  });
});
