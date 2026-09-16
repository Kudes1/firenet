import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LayoutDoc, TopologyDoc } from "../api/types";
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

  it("optimistically deletes a device and its canvas relationships before flush", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), {
      ...fx.layoutFixture,
      links: { "r1|sw1": [[{ x: 180, y: 100 }]] },
    });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.removeSelected(["device:r1"]); });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))).toEqual({
      ...fx.topologyFixture,
      devices: [{ name: "sw1", kind: "switch", description: "подъезд" }],
      links: [],
      unions: [{ name: "u1", devices: [] }],
    });
    expect(qc.getQueryData<LayoutDoc>(projectKeys.resource("draft:d1", "layout"))).toEqual({
      ...fx.layoutFixture,
      devices: { sw1: { x: 300, y: 40 } },
      links: {},
    });
    expect(body).toBeUndefined();

    await act(async () => { await result.current.flush(); });
    expect(body).toEqual({ kind: "delete-device", deviceName: "r1" });
  });

  it("optimistically renames a device and keeps its canvas relationships before flush", async () => {
    server.use(http.post("/api/drafts/d1/topology/operations", () =>
      HttpResponse.json(fx.editorSnapshotFixture)));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), {
      ...fx.layoutFixture,
      links: { "r1|sw1": [[{ x: 180, y: 100 }]] },
    });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => {
      result.current.enqueueAll([{
        kind: "update-device",
        deviceName: "r1",
        device: { name: "core", kind: "router" },
      }]);
    });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))).toEqual({
      ...fx.topologyFixture,
      devices: [{ name: "core", kind: "router" }, { name: "sw1", kind: "switch", description: "подъезд" }],
      links: [{ a: { device: "core" }, b: { device: "sw1" } }],
      networks: [{ name: "office", subnets: ["lan"], attach: [{ device: "sw1" }] }],
      unions: [{ name: "u1", devices: ["core"] }],
    });
    expect(qc.getQueryData<LayoutDoc>(projectKeys.resource("draft:d1", "layout"))).toEqual({
      ...fx.layoutFixture,
      devices: { core: { x: 40, y: 40 }, sw1: { x: 300, y: 40 } },
      links: { "core|sw1": [[{ x: 180, y: 100 }]] },
    });

    await act(async () => { await result.current.flush(); });
  });

  it("optimistically renames a network and keeps its canvas relationships before flush", async () => {
    server.use(http.post("/api/drafts/d1/topology/operations", () =>
      HttpResponse.json(fx.editorSnapshotFixture)));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const topology: TopologyDoc = {
      ...fx.topologyFixture,
      links: [{
        a: { device: "r1" },
        b: { device: "sw1" },
        filter: { aExports: ["office"], bExports: [] },
      }],
      unions: [{ name: "u1", devices: ["r1"], networks: ["office"] }],
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), topology);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), fx.layoutFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => {
      result.current.enqueueAll([{
        kind: "update-network",
        networkName: "office",
        network: { name: "production", subnets: ["lan"], attach: [{ device: "sw1" }] },
      }]);
    });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))).toEqual({
      ...topology,
      networks: [{ name: "production", subnets: ["lan"], attach: [{ device: "sw1" }] }],
      links: [{
        a: { device: "r1" },
        b: { device: "sw1" },
        filter: { aExports: ["production"], bExports: [] },
      }],
      unions: [{ name: "u1", devices: ["r1"], networks: ["production"] }],
    });
    expect(qc.getQueryData<LayoutDoc>(projectKeys.resource("draft:d1", "layout"))).toEqual({
      ...fx.layoutFixture,
      networks: { production: { x: 40, y: 300 } },
    });

    await act(async () => { await result.current.flush(); });
  });

  it("optimistically adds a link", () => {
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), {
      ...fx.topologyFixture,
      links: [],
    });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createLink("r1", "sw1"); });

    expect(qc.getQueryData(projectKeys.resource("draft:d1", "topology"))).toMatchObject({
      links: [{ a: { device: "r1" }, b: { device: "sw1" } }],
    });
  });

  it("optimistically attaches a network", () => {
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.attachNetwork("office", "r1"); });

    expect(qc.getQueryData(projectKeys.resource("draft:d1", "topology"))).toMatchObject({
      networks: [expect.objectContaining({
        name: "office",
        attach: expect.arrayContaining([{ device: "r1" }]),
      })],
    });
  });

  it("flushes link creation without the editor debounce", async () => {
    let body: unknown;
    let requestCount = 0;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      requestCount += 1;
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => { result.current.createLink("r1", "sw1"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(requestCount).toBe(1);
    expect(body).toEqual({ kind: "create-link", link: { a: { device: "r1" }, b: { device: "sw1" } } });
  });

  it("optimistically removes a link and its waypoints", () => {
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), {
      ...fx.layoutFixture,
      links: { "r1|sw1": [[{ x: 180, y: 100 }]] },
    });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.deleteLink("r1", "sw1"); });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))?.links).toEqual([]);
    expect(qc.getQueryData<LayoutDoc>(projectKeys.resource("draft:d1", "layout"))?.links).toEqual({});
  });

  it("optimistically detaches a network", () => {
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.detachNetwork("office", "sw1"); });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))?.networks).toEqual([
      { name: "office", subnets: ["lan"], attach: [] },
    ]);
  });

  it("flushes link deletion and detachment without the editor debounce", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(fx.editorSnapshotFixture);
      }),
      http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(fx.editorSnapshotFixture);
      }),
    );
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => { result.current.deleteLink("r1", "sw1"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    act(() => { result.current.detachNetwork("office", "sw1"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(bodies).toEqual([
      { kind: "delete-link", link: { a: { device: "r1" }, b: { device: "sw1" } } },
      { kind: "detach-network", networkName: "office", attach: { device: "sw1" } },
    ]);
  });

  it("does not send redundant edge deletes with selected endpoint nodes", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(fx.editorSnapshotFixture);
      }),
      http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(fx.editorSnapshotFixture);
      }),
    );
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => {
      result.current.removeSelected([
        "device:r1", "network:office", "link:r1|sw1#0", "attach:office|sw1",
      ]);
    });
    await act(async () => { await result.current.flush(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const operations = bodies.flatMap((body) =>
      "operations" in (body as object) ? (body as { operations: Array<{ kind: string }> }).operations : [body],
    );
    expect(operations.map((operation) => (operation as { kind: string }).kind)).toEqual([
      "delete-device", "delete-network",
    ]);
  });

  it("optimistically sets a link filter and sends an operation immediately", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });
    const filter = { aExports: ["lan"], bExports: [] };

    act(() => { result.current.setLinkFilter("r1", "sw1", filter); });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))?.links).toEqual([
      { a: { device: "r1" }, b: { device: "sw1" }, filter },
    ]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(body).toEqual({
      kind: "set-link-filter",
      link: { a: { device: "r1" }, b: { device: "sw1" } },
      filter,
    });
  });

  it("optimistically clears a link filter", async () => {
    let body: unknown;
    const topology = {
      ...fx.topologyFixture,
      links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: ["lan"], bExports: [] } }],
    };
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ topology, layout: fx.layoutFixture });
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), topology);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.setLinkFilter("sw1", "r1"); });

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))?.links).toEqual([
      { a: { device: "r1" }, b: { device: "sw1" } },
    ]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(body).toEqual({
      kind: "clear-link-filter",
      link: { a: { device: "sw1" }, b: { device: "r1" } },
    });
  });

  it("flushes a later immediate link operation after an earlier request resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const first = new Promise<void>((resolve) => { firstStarted = resolve; });
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    let requestCount = 0;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      requestCount += 1;
      if (requestCount === 1) {
        firstStarted();
        await blocked;
      } else {
        secondStarted();
      }
      await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => { result.current.createLink("r1", "sw1"); });
    await act(async () => { await first; });
    act(() => { result.current.createLink("r1", "r2"); });
    release();
    await act(async () => {
      await Promise.race([
        second,
        new Promise((_, reject) => setTimeout(() => reject(new Error("second request was delayed")), 150)),
      ]);
    });
  });

  it("serializes operations from separate editor instances", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    let requestCount = 0;
    server.use(http.post("/api/drafts/d1/topology/operations", async () => {
      requestCount += 1;
      if (requestCount === 1) {
        firstStarted();
        await blocked;
      } else {
        secondStarted();
      }
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => ({ first: useTopologyEditor(), second: useTopologyEditor() }), { wrapper });

    act(() => { result.current.first.createLink("r1", "sw1"); });
    await firstRequestStarted;
    act(() => { result.current.second.createLink("r1", "r2"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(requestCount).toBe(1);
    release();
    await act(async () => {
      await Promise.race([
        second,
        new Promise((_, reject) => setTimeout(() => reject(new Error("second request was delayed")), 150)),
      ]);
    });
  });

  it("keeps a later optimistic link when an earlier flush resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const topology = {
      devices: [
        { name: "r1", kind: "router" as const },
        { name: "sw1", kind: "switch" as const },
        { name: "r2", kind: "router" as const },
      ],
      links: [], networks: [], sets: [], unions: [],
    };
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      const operation = await request.json() as { link?: { a: { device: string }; b: { device: string } } };
      requestStarted();
      await blocked;
      const nextTopology = operation.link?.b.device === "r2"
        ? { ...topology, links: [operation.link] }
        : topology;
      return HttpResponse.json({ topology: nextTopology, layout: fx.layoutFixture });
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), topology);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), fx.layoutFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createLink("r1", "sw1"); });
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    await act(async () => { await started; });
    act(() => { result.current.createLink("r1", "r2"); });
    release();
    await act(async () => { await firstFlush; });

    expect(qc.getQueryData<{ links: Array<{ a: { device: string }; b: { device: string } }> }>(
      projectKeys.resource("draft:d1", "topology"),
    )?.links).toEqual(expect.arrayContaining([
      { a: { device: "r1" }, b: { device: "r2" } },
    ]));
  });

  it("keeps a later optimistic bend when an earlier flush resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    server.use(http.post("/api/drafts/d1/topology/operations", async () => {
      requestStarted();
      await blocked;
      return HttpResponse.json({ topology: fx.topologyFixture, layout: { ...fx.layoutFixture, links: {} } });
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), { ...fx.layoutFixture, links: {} });
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.moveDevice("r1", { x: 120, y: 80 }); });
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    await started;
    act(() => { result.current.setLinkWaypoints("r1", "sw1", 0, [{ x: 180, y: 110 }]); });
    release();
    await act(async () => { await firstFlush; });

    expect(qc.getQueryData<{ links: Record<string, unknown> }>(
      projectKeys.resource("draft:d1", "layout"),
    )?.links).toEqual({ "r1|sw1": [[{ x: 180, y: 110 }]] });
  });

  it("reapplies later node and camera changes after an earlier flush resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let requestCount = 0;
    server.use(http.post("/api/drafts/d1/topology/operations", async () => {
      requestCount += 1;
      if (requestCount === 1) {
        requestStarted();
        await blocked;
      }
      return HttpResponse.json({ topology: fx.topologyFixture, layout: fx.layoutFixture });
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), fx.topologyFixture);
    qc.setQueryData(projectKeys.resource("draft:d1", "layout"), fx.layoutFixture);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.moveDevice("r1", { x: 120, y: 80 }); });
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    await started;
    act(() => {
      result.current.moveDevice("sw1", { x: 420, y: 90 });
      result.current.setCamera({ x: 10, y: 20, zoom: 1.5 });
    });
    release();
    await act(async () => { await firstFlush; });

    expect(qc.getQueryData<LayoutDoc>(projectKeys.resource("draft:d1", "layout"))).toMatchObject({
      devices: { sw1: { x: 420, y: 90 } },
      camera: { x: 10, y: 20, z: 1.5 },
    });
    await act(async () => { await result.current.flush(); });
  });

  it("removes a failed optimistic link", async () => {
    const topology = { ...fx.topologyFixture, links: [] };
    server.use(
      http.get("/api/drafts/d1/topology", () => HttpResponse.json(topology)),
      http.post("/api/drafts/d1/topology/operations", () =>
        HttpResponse.json({ error: "link rejected" }, { status: 422 })),
    );
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), topology);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createLink("r1", "sw1"); });
    expect(qc.getQueryData<{ links: unknown[] }>(projectKeys.resource("draft:d1", "topology"))?.links).toHaveLength(1);
    await act(async () => { await result.current.flush(); });

    expect(qc.getQueryData<{ links: unknown[] }>(projectKeys.resource("draft:d1", "topology"))?.links).toEqual([]);
  });

  it("rolls back a created link after a queued filter clones it", async () => {
    let releaseCreate!: () => void;
    const createBlocked = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createStarted!: () => void;
    const createRequestStarted = new Promise<void>((resolve) => { createStarted = resolve; });
    let releaseFilter!: () => void;
    const filterBlocked = new Promise<void>((resolve) => { releaseFilter = resolve; });
    let filterStarted!: () => void;
    const filterRequestStarted = new Promise<void>((resolve) => { filterStarted = resolve; });
    let requestCount = 0;
    server.use(http.post("/api/drafts/d1/topology/operations", async () => {
      requestCount += 1;
      if (requestCount === 1) {
        createStarted();
        await createBlocked;
        return HttpResponse.json({ error: "link rejected" }, { status: 422 });
      }
      filterStarted();
      await filterBlocked;
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const topology = { ...fx.topologyFixture, links: [] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(projectKeys.resource("draft:d1", "topology"), topology);
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: ({ children }) =>
      <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider> });

    act(() => { result.current.createLink("r1", "sw1"); });
    await createRequestStarted;
    act(() => { result.current.setLinkFilter("r1", "sw1", { aExports: [], bExports: [] }); });
    let firstFlush!: Promise<void>;
    act(() => { firstFlush = result.current.flush(); });
    releaseCreate();
    await act(async () => { await firstFlush; });
    await filterRequestStarted;

    expect(qc.getQueryData<TopologyDoc>(projectKeys.resource("draft:d1", "topology"))?.links).toEqual([]);
    releaseFilter();
    await act(async () => { await result.current.flush(); });
  });

  it("reports a link as pending until its request resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    server.use(http.post("/api/drafts/d1/topology/operations", async () => {
      requestStarted();
      await blocked;
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => { result.current.createLink("r1", "sw1"); });
    expect(result.current.isLinkPending("sw1", "r1")).toBe(true);
    let flush!: Promise<void>;
    act(() => { flush = result.current.flush(); });
    await started;
    expect(result.current.isLinkPending("r1", "sw1")).toBe(true);
    release();
    await act(async () => { await flush; });
    expect(result.current.isLinkPending("r1", "sw1")).toBe(false);
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
