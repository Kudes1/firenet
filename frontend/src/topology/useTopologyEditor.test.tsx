import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { DraftProvider } from "../draft/DraftContext";
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

  it("does nothing in read-only mode", async () => {
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });
    act(() => { result.current.moveDevice("r1", { x: 1, y: 1 }); });
    await act(async () => { await result.current.flush(); });
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
