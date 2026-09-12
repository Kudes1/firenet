import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import { storageKeys } from "../lib/storage";
import DiagnosePage from "./DiagnosePage";

const REPORT = {
  srcSubnet: "lan",
  dstSubnet: "dmz",
  note: "путей: 1",
  paths: [{
    nodes: [{ kind: 0, name: "r1" }, { kind: 1, name: "dmz" }],
    routers: [{ router: "r1", action: "allow", reason: "правило web", matchedRule: "web" }],
    verdict: "allow",
  }],
  returnPathAllowed: true,
  mapMark: {
    hl: ["device:r1"], ok: ["device:r1", "device:sw1"], okE: ["r1\0sw1"],
    denyE: [], half: [], halfE: [], deny: {},
  },
};

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); localStorage.clear(); });
afterAll(() => server.close());

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
  });
});

describe("DiagnosePage", () => {
  it("renders accessible tool buttons with closed modals", async () => {
    renderPage(<DiagnosePage />, "/ui/diagnose");

    const pathTool = screen.getByRole("button", { name: "Диагностика пути" });
    const spreadTool = screen.getByRole("button", { name: "Распространение" });
    expect(pathTool).toHaveAttribute("aria-pressed", "false");
    expect(spreadTool).toHaveAttribute("aria-pressed", "false");
    expect(pathTool.querySelector("svg")).toBeInTheDocument();
    expect(spreadTool.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens and toggles the path tool modal", async () => {
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    const pathTool = screen.getByRole("button", { name: "Диагностика пути" });

    await user.click(pathTool);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveClass("modal-compact");
    expect(dialog.querySelector(".modal-resize-handle")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Диагностика пути" })).toBeInTheDocument();
    expect(pathTool).toHaveAttribute("aria-pressed", "true");

    await user.click(pathTool);
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(pathTool).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the diagnostic panel open when clicking the canvas", async () => {
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Диагностика пути" }));
    const dialog = await screen.findByRole("dialog");
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 150, 300, 200),
    });

    fireEvent.click(dialog, { clientX: 5, clientY: 5 });

    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Диагностика пути" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches the open modal when another tool is selected", async () => {
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Диагностика пути" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Распространение" }));
    expect(dialog).toHaveTextContent("Распространение сети");
    expect(dialog).not.toHaveClass("modal-compact");
    expect(screen.getByRole("button", { name: "Распространение" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Диагностика пути" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the read-only map", async () => {
    renderPage(<DiagnosePage />, "/ui/diagnose");
    // testid на обёртке RF — rf__node-<id> (см. Task 18, «подводные камни»):
    // внутренний div кастомного узла testid не несёт.
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("shows the member subnet details when a network is clicked", async () => {
    renderPage(<DiagnosePage />, "/ui/diagnose");

    fireEvent.click(await screen.findByTestId("rf__node-network:office"));

    expect(screen.getByTestId("network-info")).toHaveTextContent("lan");
    expect(screen.getByTestId("network-info")).toHaveTextContent("10.0.0.0/24");
  });

  it("runs a diagnose request and shows the verdict", async () => {
    let body: unknown;
    server.use(http.post("/api/versions/current/diagnose", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(REPORT);
    }));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Диагностика пути" }));
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.0.1.5");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));

    expect(await screen.findByText(/путей: 1/)).toBeInTheDocument();
    expect(screen.getByText("разрешено")).toBeInTheDocument();
    expect(screen.getByTestId("diag-report").closest("dialog")).toBe(screen.getByRole("dialog"));
    expect(body).toMatchObject({ src: "10.0.0.5", dst: "10.0.1.5", proto: "", dstPorts: [] });
  });

  it("marks the path nodes on the map", async () => {
    server.use(http.post("/api/versions/current/diagnose", () => HttpResponse.json(REPORT)));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Диагностика пути" }));
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.0.1.5");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));
    await screen.findByText(/путей: 1/);
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("diag-flow-ok");
  });

  it("reports an unreachable destination", async () => {
    server.use(http.post("/api/versions/current/diagnose", () => HttpResponse.json({
      ...REPORT, paths: [], note: "недостижимо",
    })));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Диагностика пути" }));
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.9.9.9");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));
    expect(await screen.findByText(/недостижимо/)).toBeInTheDocument();
  });

  it("runs a spread request", async () => {
    server.use(http.post("/api/versions/current/diagnose/spread", () => HttpResponse.json({
      sources: [{ IP: "10.0.0.5", SubnetName: "lan" }],
      reports: [{ candidate: "dmz", report: REPORT }],
      mark: REPORT.mapMark,
    })));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Распространение" }));
    await user.type(await screen.findByLabelText("Источник (сеть, подсеть или IP)"), "lan");
    await user.click(screen.getByRole("button", { name: "Проверить доступность" }));
    expect(await screen.findByText(/Достижимо 1 из 1/)).toBeInTheDocument();
    expect(screen.getByTestId("spread-report").closest("dialog")).toBe(screen.getByRole("dialog"));
  });

  it("restores the form from localStorage", async () => {
    localStorage.setItem(storageKeys.diagForm, JSON.stringify({ src: "10.0.0.5", dst: "10.0.1.5", proto: "tcp", dstPorts: "80" }));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(screen.getByRole("button", { name: "Диагностика пути" }));
    expect(await screen.findByLabelText("Источник")).toHaveValue("10.0.0.5");
    expect(screen.getByLabelText("Порты назначения")).toHaveValue("80");
  });
});
