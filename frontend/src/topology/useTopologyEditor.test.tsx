import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { DraftProvider } from "../draft/DraftContext";
import { projectKeys } from "../api/queries";
import { storageKeys } from "../lib/storage";
import * as fx from "../api/fixtures";
import { useTopologyEditor } from "./useTopologyEditor";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider>;
}

describe("useTopologyEditor", () => {
  it("queues a device position and flushes it as one operation", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => { result.current.moveDevice("r1", { x: 120, y: 80 }); });
    expect(result.current.status).toBe("dirty");
    await act(async () => { await result.current.flush(); });

    expect(body).toEqual({ kind: "set-device-position", deviceName: "r1", position: { x: 120, y: 80 } });
    expect(result.current.status).toBe("saved");
  });

  it("batches several operations into one request", async () => {
    let url = "";
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
      url = request.url;
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => {
      result.current.createDevice({ x: 10, y: 20 }, "router");
      result.current.moveDevice("r1", { x: 5, y: 5 });
    });
    await act(async () => { await result.current.flush(); });

    expect(url).toContain("/batch");
    const ops = (body as { operations: Array<{ kind: string }> }).operations;
    // createDevice кладёт create-device + позицию нового устройства,
    // moveDevice("r1") — позицию отдельного устройства: три операции.
    expect(ops.map((o) => o.kind)).toEqual([
      "create-device", "set-device-position", "set-device-position",
    ]);
  });

  it("keeps a later optimistic create when an earlier flush resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async () => {
      requestStarted();
      await blocked;
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), fx.layoutFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createDevice({ x: 10, y: 20 }, "router", "first"); });
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    await started;
    act(() => { result.current.createDevice({ x: 30, y: 40 }, "router", "second"); });
    release();
    await act(async () => { await firstFlush; });

    const topology = qc.getQueryData<{ devices: Array<{ name: string }> }>(
      projectKeys.resource("draft:d1", "topology"),
    );
    expect(topology?.devices).toEqual(expect.arrayContaining([expect.objectContaining({ name: "second" })]));
  });

  it("serializes flushes without dropping a later optimistic create", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestCount = 0;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async () => {
      requestCount += 1;
      if (requestCount === 1) {
        requestStarted();
        await blocked;
      }
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), fx.layoutFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createDevice({ x: 10, y: 20 }, "router", "first"); });
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    await started;
    act(() => { result.current.createDevice({ x: 30, y: 40 }, "router", "second"); });
    let secondFlush!: Promise<void>;
    act(() => { secondFlush = result.current.flush(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(requestCount).toBe(1);
    } finally {
      release();
      await act(async () => { await firstFlush; await secondFlush; });
    }
    expect(qc.getQueryData<{ devices: Array<{ name: string }> }>(
      projectKeys.resource("draft:d1", "topology"),
    )?.devices).toEqual(expect.arrayContaining([expect.objectContaining({ name: "second" })]));
  });

  it("optimistically adds a network and its position", () => {
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), fx.layoutFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createNetwork({ x: 500, y: 120 }, "guest"); });

    expect(qc.getQueryData(projectKeys.resource("draft:d1", "topology"))).toMatchObject({
      networks: expect.arrayContaining([expect.objectContaining({ name: "guest" })]),
    });
    expect(qc.getQueryData(projectKeys.resource("draft:d1", "layout"))).toMatchObject({
      networks: { guest: { x: 500, y: 120 } },
    });
  });

  it("does nothing in read-only mode", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });
    act(() => { result.current.moveDevice("r1", { x: 1, y: 1 }); });
    act(() => { result.current.createDevice({ x: 2, y: 2 }, "router", "r2"); });
    await act(async () => { await result.current.flush(); });
    expect(result.current.status).toBe("saved");
    expect(qc.getQueryData(projectKeys.resource("current", "topology"))).toBeUndefined();
  });

  it("setLinkWaypoints replaces one duplicate and echoes the layout cache", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Дубликаты пары r1|sw1: у второго (index 1) уже есть своя точка.
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), {
      devices: {}, networks: {},
      links: { "r1|sw1": [null, [{ x: 150, y: 120 }]] },
    });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.setLinkWaypoints("r1", "sw1", 0, [{ x: 100, y: 50 }]); });
    // Эхо-апдейт кэша: точка видна сразу, до flush (flush дебаунсится).
    expect(qc.getQueryData(projectKeys.resource("draft:d1", "layout"))).toMatchObject({
      links: { "r1|sw1": [[{ x: 100, y: 50 }], [{ x: 150, y: 120 }]] },
    });
    await act(async () => { await result.current.flush(); });
    expect(body).toEqual({
      kind: "set-link-waypoints",
      link: { a: { device: "r1" }, b: { device: "sw1" } },
      waypoints: [[{ x: 100, y: 50 }], [{ x: 150, y: 120 }]],
    });
    expect(result.current.status).toBe("saved");
  });

  it("reports a failed flush", async () => {
    server.use(http.post("/api/drafts/d1/topology/operations", () =>
      HttpResponse.json({ error: "unknown topology operation kind \"x\"" }, { status: 422 })));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });
    act(() => { result.current.moveDevice("r1", { x: 1, y: 1 }); });
    await act(async () => { await result.current.flush(); });
    expect(result.current.status).toBe("error");
  });
});
