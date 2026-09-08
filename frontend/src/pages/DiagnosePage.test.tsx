import { screen } from "@testing-library/react";
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
  it("renders the read-only map", async () => {
    renderPage(<DiagnosePage />, "/ui/diagnose");
    // testid на обёртке RF — rf__node-<id> (см. Task 18, «подводные камни»):
    // внутренний div кастомного узла testid не несёт.
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("runs a diagnose request and shows the verdict", async () => {
    let body: unknown;
    server.use(http.post("/api/versions/current/diagnose", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(REPORT);
    }));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.0.1.5");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));

    expect(await screen.findByText(/путей: 1/)).toBeInTheDocument();
    expect(screen.getByText("разрешено")).toBeInTheDocument();
    expect(body).toMatchObject({ src: "10.0.0.5", dst: "10.0.1.5", proto: "", dstPorts: [] });
  });

  it("marks the path nodes on the map", async () => {
    server.use(http.post("/api/versions/current/diagnose", () => HttpResponse.json(REPORT)));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
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
    await user.click(await screen.findByTitle("Распространение"));
    await user.type(await screen.findByLabelText("Источник (сеть, подсеть или IP)"), "lan");
    await user.click(screen.getByRole("button", { name: "Проверить доступность" }));
    expect(await screen.findByText(/Достижимо 1 из 1/)).toBeInTheDocument();
  });

  it("restores the form from localStorage", async () => {
    localStorage.setItem(storageKeys.diagForm, JSON.stringify({ src: "10.0.0.5", dst: "10.0.1.5", proto: "tcp", dstPorts: "80" }));
    renderPage(<DiagnosePage />, "/ui/diagnose");
    expect(await screen.findByLabelText("Источник")).toHaveValue("10.0.0.5");
    expect(screen.getByLabelText("Порты назначения")).toHaveValue("80");
  });
});
