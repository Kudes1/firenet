import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import DevicesPage from "./DevicesPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("DevicesPage", () => {
  it("translates kinds to Russian", async () => {
    renderPage(<DevicesPage />, "/ui/devices", "d1");
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("маршрутизатор")).toBeInTheDocument();
    expect(screen.getByText("коммутатор")).toBeInTheDocument();
  });

  it("saves a rename as a single operation when the union is unchanged", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<DevicesPage />, "/ui/devices", "d1");
    await screen.findByText("r1");
    await user.click(screen.getByTitle("Изменить устройство r1"));
    const nameInput = await screen.findByLabelText("Имя");
    await user.clear(nameInput);
    await user.type(nameInput, "r1b");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Устройство сохранено")).toBeInTheDocument();
    // union не менялся (r1 в u1, u1 и остаётся) → только update-device, и он
    // уходит одиночным POST /operations (ops.length === 1 в useTopologyOperations).
    expect(body).toEqual({ kind: "update-device", deviceName: "r1", device: { name: "r1b", kind: "router" } });
  });

  it("moves a device to another union, referring to the new name", async () => {
    // Топология: r1 в u1; переносим в u2, имя не трогаем.
    server.use(http.get("/api/drafts/d1/topology", () =>
      HttpResponse.json({
        ...fx.topologyFixture,
        unions: [{ name: "u1", devices: ["r1"] }, { name: "u2", devices: [] }],
      })));
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<DevicesPage />, "/ui/devices", "d1");
    await screen.findByText("r1");
    await user.click(screen.getByTitle("Изменить устройство r1"));
    await user.selectOptions(await screen.findByLabelText("Объединение"), "u2");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Устройство сохранено")).toBeInTheDocument();
    // Смена union → батч из 2 операций; обе ссылаются на новое имя (каскад
    // update-device на бэкенде уже переименовал устройство во всех union).
    expect(body).toMatchObject({ operations: [
      { kind: "update-device", deviceName: "r1", device: { name: "r1", kind: "router" } },
      { kind: "union-remove-device", unionName: "u1", deviceName: "r1" },
      { kind: "union-add-device", unionName: "u2", deviceName: "r1" },
    ] });
  });

  it("deletes through delete-device", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    window.confirm = vi.fn(() => true);
    const { user } = renderPage(<DevicesPage />, "/ui/devices", "d1");
    await screen.findByText("r1");
    await user.click(screen.getByTitle("Удалить устройство r1"));
    expect(await screen.findByText("Устройство удалено")).toBeInTheDocument();
    expect(body).toEqual({ kind: "delete-device", deviceName: "r1" });
  });
});
