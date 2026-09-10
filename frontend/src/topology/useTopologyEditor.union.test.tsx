import { renderHook, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { DraftProvider } from "../draft/DraftContext";
import { storageKeys } from "../lib/storage";
import { projectKeys } from "../api/queries";
import * as fx from "../api/fixtures";
import { useTopologyEditor } from "./useTopologyEditor";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("useTopologyEditor union operations", () => {
  // setUnion читает состав объединений из кэша react-query — прогреваем
  // его тем же запросом, что делает страница (useProjectResource).
  async function warmTopologyCache(scope: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await qc.fetchQuery({
      queryKey: projectKeys.resource(scope, "topology"),
      queryFn: () => Promise.resolve(fx.topologyFixture),
    });
    return qc;
  }

  function makeWrapper(qc: QueryClient) {
    return function wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}><DraftProvider>{children}</DraftProvider></QueryClientProvider>;
    };
  }

  it("queues a union add as one operation", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = await warmTopologyCache("draft:d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: makeWrapper(qc) });

    // sw1 не входит в u1 фикстуры — add проходит целиком.
    act(() => { result.current.setUnion("sw1", "device", "u1"); });
    await act(async () => { await result.current.flush(); });

    expect(body).toEqual({ kind: "union-add-device", unionName: "u1", deviceName: "sw1" });
  });

  it("queues a union removal as one operation", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = await warmTopologyCache("draft:d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: makeWrapper(qc) });

    act(() => { result.current.setUnion("r1", "device", null); });
    await act(async () => { await result.current.flush(); });

    // u1 — единственное объединение r1 в фикстуре: одна union-remove.
    expect(body).toEqual({ kind: "union-remove-device", unionName: "u1", deviceName: "r1" });
  });

  it("queues a union add for networks", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = await warmTopologyCache("draft:d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: makeWrapper(qc) });

    act(() => { result.current.setUnion("office", "network", "u1"); });
    await act(async () => { await result.current.flush(); });

    expect(body).toEqual({ kind: "union-add-network", unionName: "u1", networkName: "office" });
  });

  it("does not send anything when already in the target union", async () => {
    let bodies: unknown[] = [];
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const qc = await warmTopologyCache("draft:d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper: makeWrapper(qc) });

    // r1 уже сидит в u1 фикстуры — добавлять нечего, enqueue пустой.
    act(() => { result.current.setUnion("r1", "device", "u1"); });
    await act(async () => { await result.current.flush(); });
    expect(bodies).toEqual([]);
    expect(result.current.status).toBe("saved");
  });
});
