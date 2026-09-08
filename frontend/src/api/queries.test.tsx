import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { DraftProvider } from "../draft/DraftContext";
import { storageKeys } from "../lib/storage";
import * as fx from "./fixtures";
import { projectKeys, useProjectResource, useTopologyOperations } from "./queries";
import type { EditorSnapshot, LayoutDoc, TopologyDoc } from "./types";

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
});
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <DraftProvider>{children}</DraftProvider>
    </QueryClientProvider>
  );
}

// DraftProvider читает драфт один раз при монтировании (useState +
// readInitialDraft) и на sessionStorage не подписан, поэтому ui.draft.id
// нужно выставить ДО renderHook — иначе useDraft() останется на current и
// apiPath не поведёт на /api/drafts/d1/....
function withDraft(id: string) {
  sessionStorage.setItem(storageKeys.draftId, id);
}

describe("useProjectResource", () => {
  it("loads the read-only document through apiPath", async () => {
    const { result } = renderHook(() => useProjectResource<TopologyDoc>("topology"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(fx.topologyFixture);
  });

  it("keys the cache by draft scope", () => {
    expect(projectKeys.resource("draft:d1", "topology")).toEqual(["project", "draft:d1", "topology"]);
    expect(projectKeys.resource("current", "rules")).toEqual(["project", "current", "rules"]);
  });
});

describe("useTopologyOperations", () => {
  it("posts a single operation without wrapping it in a batch", async () => {
    withDraft("d1");
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { result } = renderHook(() => useTopologyOperations(), { wrapper });
    await result.current.mutateAsync([{ kind: "create-device", device: { name: "r2", kind: "router" } }]);
    expect(body).toEqual({ kind: "create-device", device: { name: "r2", kind: "router" } });
  });

  it("wraps several operations into a batch", async () => {
    withDraft("d1");
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { result } = renderHook(() => useTopologyOperations(), { wrapper });
    await result.current.mutateAsync([
      { kind: "update-device", deviceName: "r1", device: { name: "r1b", kind: "router" } },
      { kind: "union-add-device", unionName: "u1", deviceName: "r1b" },
    ]);
    expect(body).toEqual({ operations: [
      { kind: "update-device", deviceName: "r1", device: { name: "r1b", kind: "router" } },
      { kind: "union-add-device", unionName: "u1", deviceName: "r1b" },
    ] });
  });

  it("writes the returned snapshot into topology and layout caches", async () => {
    withDraft("d1");
    // Переопределяем мутацию ответом, ОТЛИЧНЫМ от GET-фикстур: иначе тест
    // не отличил бы запись в кэш от простого совпадения данных по ссылке.
    const snapshot: EditorSnapshot = {
      topology: { ...fx.topologyFixture, devices: [{ name: "r9", kind: "router" }] },
      layout: { ...fx.layoutFixture, camera: { x: 5, y: 6, z: 7 } },
    };
    server.use(http.post("/api/drafts/d1/topology/operations", () =>
      HttpResponse.json(snapshot)));
    const { result } = renderHook(
      () => ({
        ops: useTopologyOperations(),
        topo: useProjectResource<TopologyDoc>("topology"),
        layout: useProjectResource<LayoutDoc>("layout"),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.topo.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.layout.isSuccess).toBe(true));
    await result.current.ops.mutateAsync([{ kind: "set-camera", camera: { x: 5, y: 6, z: 7 } }]);
    await waitFor(() => expect(result.current.topo.data).toEqual(snapshot.topology));
    await waitFor(() => expect(result.current.layout.data).toEqual(snapshot.layout));
  });
});
