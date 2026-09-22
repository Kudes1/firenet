# Topology Canvas Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Централизовать контракт id рёбер и геометрию узлов канвы, убрать побочный эффект из рендера очереди редактора и запретить `|`/`#` в именах устройств и сетей (фронт + бэкенд).

**Architecture:** `frontend/src/topology/scene.ts` становится единственным владельцем формата id рёбер (`format*`/`parseEdgeId`) и геометрии узлов (`nodeSize`/`nodeCenter`/`nodeGeometry`); `TopologyPage`, `TopologyCanvas`, `useTopologyEditor` только вызывают эти хелперы. Валидация имён: `uniqueNameHint` во фронтенде (подсказка + блокировка submit) и `topology.ValidateName` на бэкенде — только для нового имени в `applyTopologyOperation`, не в `Topology.Validate()` (см. spec).

**Tech Stack:** TypeScript, React 18, @xyflow/react 12, Vitest + Testing Library + MSW; Go 1.25, net/http, pgx/v5.

**Spec:** `docs/superpowers/specs/2026-09-22-topology-canvas-refactor-design.md`

## Global Constraints

- Имена: запрещены только `|` и `#`; кириллица, пробелы, `.`, `:`, `_`, `-` остаются валидными.
- Бэкенд проверяет **только новое имя** в create/update операциях; существующие имена с `|`/`#` не блокируют открытие проекта (`Topology.Validate()` не трогаем).
- `parseEdgeId` на любом мусоре возвращает `null`; вызывающий игнорирует такой id.
- Форматы id не меняются: `link:<a>|<b>#<offset>` (a,b канонические через `layoutLinkKey`), `attach:<network>|<device>`.
- Подсказки фронтенда — на русском, тексты ошибок Go — на английском (как существующие).
- Тесты: сначала красный, потом зелёный; после каждого таска — коммит.
- Верификация всего плана: `make vet && make fmt && make test && make fe-test && make test-e2e`.
- Команды тестов: весь FE — `make fe-test`; один файл — `docker compose --profile test run --rm frontend-test npx vitest run <path>`; весь BE — `make test`; один пакет — `docker compose --profile test run --rm backend-test go test ./internal/<pkg>/ -run <Name> -v`. Хостовые Go/Node не используются.
- Не добавлять новые npm/Go зависимости.

## File Structure

| Файл | Действие | Ответственность |
|---|---|---|
| `frontend/src/topology/scene.ts` | modify | `formatLinkEdgeId`, `formatAttachEdgeId`, `parseEdgeId`, `nodeSize`, `nodeCenter`, `nodeGeometry`; `buildScene` использует их |
| `frontend/src/topology/scene.test.ts` | modify | юнит-тесты id- и гео-хелперов |
| `frontend/src/topology/TopologyCanvas.tsx` | modify | удаляет локальный `nodeGeometry`, центры рёбер через `nodeCenter` |
| `frontend/src/pages/TopologyPage.tsx` | modify | `parseEdgeId` вместо ручного разбора; `nodeCenter` для `pendingCenter`; подсказка `uniqueNameHint` в create-панели |
| `frontend/src/pages/TopologyPage.test.tsx` | modify | create-панель блокирует `|`/`#` |
| `frontend/src/topology/useTopologyEditor.ts` | modify | `parseEdgeId` в `removeSelected`; `channel.send` в `useEffect` |
| `frontend/src/lib/validate.ts` | modify | запрет `|`/`#` в `uniqueNameHint` |
| `frontend/src/lib/validate.test.ts` | modify | тесты запрета символов |
| `backend/internal/topology/validate.go` | modify | `ValidateName` |
| `backend/internal/topology/validate_test.go` | modify | юнит-тесты `ValidateName` |
| `backend/internal/httpapi/topology_operations.go` | modify | вызов `ValidateName` в create/update device/network |
| `backend/internal/httpapi/topology_operations_test.go` | modify | операции с `|`/`#` → ошибка |

---

### Task 1: Edge id helpers в `scene.ts`

**Files:**
- Modify: `frontend/src/topology/scene.ts`
- Test: `frontend/src/topology/scene.test.ts`

**Interfaces:**
- Consumes: `layoutLinkKey` из `frontend/src/lib/links.ts` (уже импортирован в `scene.ts`).
- Produces (используются в Task 2 и 3):
  - `formatLinkEdgeId(a: string, b: string, offset: number): string`
  - `formatAttachEdgeId(network: string, device: string): string`
  - `type ParsedEdgeId = { kind: "link"; a: string; b: string; offset: number } | { kind: "attach"; network: string; device: string }`
  - `parseEdgeId(id: string): ParsedEdgeId | null`

- [ ] **Step 1: Write the failing tests**

Добавить в конец `frontend/src/topology/scene.test.ts` (импорт `formatAttachEdgeId, formatLinkEdgeId, parseEdgeId` из `./scene`):

```ts
describe("edge id helpers", () => {
  it("formats a link id from the canonical pair with offset", () => {
    expect(formatLinkEdgeId("r2", "r1", 1)).toBe("link:r1|r2#1");
  });

  it("formats an attach id", () => {
    expect(formatAttachEdgeId("office", "sw1")).toBe("attach:office|sw1");
  });

  it("parses a link id", () => {
    expect(parseEdgeId("link:r1|r2#1")).toEqual({ kind: "link", a: "r1", b: "r2", offset: 1 });
  });

  it("parses an attach id", () => {
    expect(parseEdgeId("attach:office|sw1")).toEqual({ kind: "attach", network: "office", device: "sw1" });
  });

  it("round-trips format and parse", () => {
    expect(parseEdgeId(formatLinkEdgeId("r2", "r1", 0))).toEqual({ kind: "link", a: "r1", b: "r2", offset: 0 });
    expect(parseEdgeId(formatAttachEdgeId("office", "sw1"))).toEqual({ kind: "attach", network: "office", device: "sw1" });
  });

  it("returns null on garbage ids", () => {
    expect(parseEdgeId("link:a|b")).toBeNull();
    expect(parseEdgeId("link:a|b#x")).toBeNull();
    expect(parseEdgeId("link:a|b|c#0")).toBeNull();
    expect(parseEdgeId("link:a#b|c#0")).toBeNull();
    expect(parseEdgeId("attach:a")).toBeNull();
    expect(parseEdgeId("attach:a|b|c")).toBeNull();
    expect(parseEdgeId("wat:a|b")).toBeNull();
    expect(parseEdgeId("no-colon")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/scene.test.ts`
Expected: FAIL — `formatLinkEdgeId` is not exported / is not defined.

- [ ] **Step 3: Implement helpers and switch `buildScene` to them**

В `frontend/src/topology/scene.ts` добавить (после `defaultPoint`, до `linkOffsets`) и использовать в `buildScene`:

```ts
export type ParsedEdgeId =
  | { kind: "link"; a: string; b: string; offset: number }
  | { kind: "attach"; network: string; device: string };

export function formatLinkEdgeId(a: string, b: string, offset: number): string {
  return `link:${layoutLinkKey(a, b)}#${offset}`;
}

export function formatAttachEdgeId(network: string, device: string): string {
  return `attach:${network}|${device}`;
}

const pairOf = (raw: string): [string, string] | null => {
  const parts = raw.split("|");
  return parts.length === 2 && parts[0] && parts[1] && !parts[0].includes("#") && !parts[1].includes("#")
    ? [parts[0], parts[1]]
    : null;
};

export function parseEdgeId(id: string): ParsedEdgeId | null {
  const sep = id.indexOf(":");
  if (sep < 0) return null;
  const type = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  if (type === "attach") {
    const pair = pairOf(rest);
    return pair ? { kind: "attach", network: pair[0], device: pair[1] } : null;
  }
  if (type === "link") {
    const hash = rest.lastIndexOf("#");
    if (hash < 0) return null;
    const offset = Number(rest.slice(hash + 1));
    const pair = pairOf(rest.slice(0, hash));
    return Number.isInteger(offset) && offset >= 0 && pair
      ? { kind: "link", a: pair[0], b: pair[1], offset }
      : null;
  }
  return null;
}
```

В `buildScene` заменить сборку id:

```ts
    edges.push({
      id: formatLinkEdgeId(l.a.device, l.b.device, offsets[i]),
```

(строка с `id: \`link:${key}#${offsets[i]}\``; локальная `key` остаётся — она нужна для `layout.links`).

```ts
      edges.push({
        id: formatAttachEdgeId(n.name, a.device),
```

(строка с `id: \`attach:${n.name}|${a.device}\``).

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/scene.test.ts`
Expected: PASS (все старые тесты `buildScene` тоже зелёные — формат id не изменился).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/topology/scene.ts frontend/src/topology/scene.test.ts
git commit -m "refactor(frontend): centralize topology edge id format in scene.ts"
```

---

### Task 2: Call sites разбирают id только через `parseEdgeId`

**Files:**
- Modify: `frontend/src/pages/TopologyPage.tsx:86-100` (`markOf`), `:247-263` (`handleEdgeContextMenu`), `:313-321` (`onWaypointsChange`)
- Modify: `frontend/src/topology/useTopologyEditor.ts:710-735` (`removeSelected`)

**Interfaces:**
- Consumes: `parseEdgeId` из Task 1.
- Produces: ничего нового; поведение не меняется.

- [ ] **Step 1: Write the failing test**

Зафиксировать контракт разбора на уровне редактора: в `frontend/src/topology/useTopologyEditor.test.tsx` (внутрь `describe("useTopologyEditor")`) добавить:

```ts
  it("removeSelected deletes a link and an attach by edge id without deleting their nodes", async () => {
    const bodies: unknown[] = [];
    const record = async ({ request }: { request: Request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(fx.editorSnapshotFixture);
    };
    server.use(http.post("/api/drafts/d1/topology/operations/batch", record));
    server.use(http.post("/api/drafts/d1/topology/operations", record));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    act(() => {
      result.current.removeSelected(["link:r1|r2#0", "attach:office|sw1"]);
    });
    await act(async () => { await result.current.flush(); });

    const kinds = bodies.flatMap((b) => {
      const body = b as { operations?: Array<{ kind: string }>; kind?: string };
      return body.operations ? body.operations.map((o) => o.kind) : [body.kind!];
    });
    expect(kinds).toEqual(expect.arrayContaining(["delete-link", "detach-network"]));
    expect(kinds).not.toContain("delete-device");
    expect(kinds).not.toContain("delete-network");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/useTopologyEditor.test.tsx`
Expected: FAIL — `removeSelected` не находит `link:`-id корректно (ищет `kind === "link"` после `split(":")`, имя `r1|r2#0` уезжает в `name`), `delete-link`/`detach-network` не попадают в очередь.

- [ ] **Step 3: Switch `removeSelected` to `parseEdgeId`**

В `frontend/src/topology/useTopologyEditor.ts` добавить импорт:

```ts
import { defaultPoint, parseEdgeId } from "./scene";
```

Тело цикла в `removeSelected` (строки 719-734) заменить на:

```ts
    for (const id of selection) {
      const [kind, ...rest] = id.split(":");
      const name = rest.join(":");
      if (kind === "device") enqueue({ kind: "delete-device", deviceName: name });
      else if (kind === "network") enqueue({ kind: "delete-network", networkName: name });
      else {
        const parsed = parseEdgeId(id);
        if (parsed?.kind === "link" && !selectedDevices.has(parsed.a) && !selectedDevices.has(parsed.b)) {
          deleteLink(parsed.a, parsed.b);
        } else if (
          parsed?.kind === "attach"
          && !selectedNetworks.has(parsed.network)
          && !selectedDevices.has(parsed.device)
        ) {
          detachNetwork(parsed.network, parsed.device);
        }
      }
    }
```

- [ ] **Step 4: Switch `TopologyPage` to `parseEdgeId`**

Импорт: в `frontend/src/pages/TopologyPage.tsx` существующий импорт из `../topology/scene` дополнить `parseEdgeId`:

```ts
import { DEVICE_H, DEVICE_W, NET_H, NET_W, parseEdgeId } from "../topology/scene";
```

(константы уйдут из этого импорта в Task 3, когда `pendingCenter` перейдёт на `nodeCenter`.)

`markOf` (TopologyPage.tsx:86-100) — проверка ребра редактируемой связи через `parseEdgeId`:

```ts
  const markOf = useCallback((id: string) => {
    if (linkEnds) {
      const [a, b] = linkEnds;
      if (id === `device:${a}`) return "link-end-a";
      if (id === `device:${b}`) return "link-end-b";
      const parsed = parseEdgeId(id);
      if (parsed?.kind === "link" && parsed.a === a && parsed.b === b) return undefined;
      if (id.includes(":")) return "search-dim";
    }
    if (!matches) return undefined;
    if (matches.has(id)) return "search-hit";
    return id.includes(":") ? "search-dim" : undefined;
  }, [matches, linkEnds]);
```

`handleEdgeContextMenu` (TopologyPage.tsx:251-263):

```ts
  const handleEdgeContextMenu = useCallback((id: string, at: { x: number; y: number }) => {
    const parsed = parseEdgeId(id);
    if (!parsed) return;
    if (parsed.kind === "link") {
      const { a, b } = parsed;
      const filtered = (doc.links ?? []).some((l) => [l.a.device, l.b.device].includes(a)
        && [l.a.device, l.b.device].includes(b) && !!l.filter);
      openMenu({ kind: "link", id, a, b, filtered }, at);
    }
    if (parsed.kind === "attach") {
      openMenu({ kind: "attach", id, network: parsed.network, device: parsed.device }, at);
    }
  }, [openMenu, doc.links]);
```

`onWaypointsChange` (проп `TopologyCanvas`, TopologyPage.tsx:314-321):

```ts
          onWaypointsChange={(edgeId, points) => {
            const parsed = parseEdgeId(edgeId);
            if (parsed?.kind !== "link") return;
            guard(() => editor.setLinkWaypoints(parsed.a, parsed.b, parsed.offset, points));
          }}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/useTopologyEditor.test.tsx src/pages/TopologyPage.test.tsx src/topology/scene.test.ts`
Expected: PASS.

Run: `make fe-test`
Expected: PASS (typecheck + весь Vitest).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TopologyPage.tsx frontend/src/topology/useTopologyEditor.ts frontend/src/topology/useTopologyEditor.test.tsx
git commit -m "refactor(frontend): parse topology edge ids via scene.parseEdgeId only"
```

---

### Task 3: Геометрия узлов — один источник в `scene.ts`

**Files:**
- Modify: `frontend/src/topology/scene.ts` (добавить `nodeSize`, `nodeCenter`, `nodeGeometry`)
- Modify: `frontend/src/topology/TopologyCanvas.tsx:28-44` (удалить локальный `nodeGeometry`), `:213-218` (центры рёбер)
- Modify: `frontend/src/pages/TopologyPage.tsx:178-187` (`pendingCenter`)
- Test: `frontend/src/topology/scene.test.ts`

**Interfaces:**
- Consumes: `DEVICE_W/H`, `NET_W/H` из `./icons` (уже импортированы в `scene.ts`); `Position` из `@xyflow/react`.
- Produces:
  - `nodeSize(type: "device" | "network"): { w: number; h: number }`
  - `nodeCenter(type: "device" | "network", position: LayoutPoint): LayoutPoint`
  - `nodeGeometry(type: "device" | "network"): { width: number; height: number; handles: Array<{ type: "source" | "target"; position: Position; x: number; y: number }> }` — тот же объект, что сейчас строит `TopologyCanvas.nodeGeometry`.

- [ ] **Step 1: Write the failing tests**

В `frontend/src/topology/scene.test.ts` добавить (импорт `nodeCenter, nodeGeometry, nodeSize` из `./scene`):

```ts
describe("node geometry", () => {
  it("reports fixed sizes per node kind", () => {
    expect(nodeSize("device")).toEqual({ w: DEVICE_W, h: DEVICE_H });
    expect(nodeSize("network")).toEqual({ w: NET_W, h: NET_H });
  });

  it("computes node centers from position and size", () => {
    expect(nodeCenter("device", { x: 10, y: 20 })).toEqual({ x: 10 + DEVICE_W / 2, y: 20 + DEVICE_H / 2 });
    expect(nodeCenter("network", { x: 0, y: 0 })).toEqual({ x: NET_W / 2, y: NET_H / 2 });
  });

  it("declares edge handles on node borders", () => {
    const device = nodeGeometry("device");
    expect(device.width).toBe(DEVICE_W);
    expect(device.handles).toEqual([
      { type: "source", position: "right", x: DEVICE_W, y: DEVICE_H / 2 },
      { type: "target", position: "left", x: 0, y: DEVICE_H / 2 },
    ]);
    const network = nodeGeometry("network");
    expect(network.width).toBe(NET_W);
    expect(network.handles).toEqual([
      { type: "target", position: "left", x: 0, y: NET_H / 2 },
    ]);
  });
});
```

(Если `Position.Right` сериализуется как enum-число, сравнение с `"right"` заменить на `Position.Right` — импортировать `Position` из `@xyflow/react` в тест.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/scene.test.ts`
Expected: FAIL — `nodeSize` is not defined.

- [ ] **Step 3: Implement geometry helpers in `scene.ts`**

Импорт в `frontend/src/topology/scene.ts`:

```ts
import { Position } from "@xyflow/react";
```

Добавить (после `defaultPoint`):

```ts
export function nodeSize(type: "device" | "network"): { w: number; h: number } {
  return type === "network" ? { w: NET_W, h: NET_H } : { w: DEVICE_W, h: DEVICE_H };
}

export function nodeCenter(type: "device" | "network", position: LayoutPoint): LayoutPoint {
  const { w, h } = nodeSize(type);
  return { x: position.x + w / 2, y: position.y + h / 2 };
}

export function nodeGeometry(type: "device" | "network") {
  const { w, h } = nodeSize(type);
  const handles = type === "device"
    ? [
      { type: "source" as const, position: Position.Right, x: w, y: h / 2 },
      { type: "target" as const, position: Position.Left, x: 0, y: h / 2 },
    ]
    : [{ type: "target" as const, position: Position.Left, x: 0, y: h / 2 }];
  return { width: w, height: h, handles };
}
```

В `buildScene` заменить блок `centerOf` (строки 134-138):

```ts
  const centerOf = new Map<string, LayoutPoint>();
  for (const n of nodes) {
    centerOf.set(n.id, nodeCenter(n.type, n.position));
  }
```

- [ ] **Step 4: Switch `TopologyCanvas` and `TopologyPage` to the helpers**

`frontend/src/topology/TopologyCanvas.tsx`:

- Удалить локальную функцию `nodeGeometry` (строки 23-44 вместе с комментарием — комментарий переносится к экспортной функции в `scene.ts`, текст: «RF 12 рисует ребро только между «инициализированными» узлами: нужны известные размеры и handle-границы. В jsdom ResizeObserver не работает (замер через DOM невозможен), поэтому размеры и хэндлы задаются декларативно. В браузере это тоже корректно: размеры узлов фиксированы, а при замере через DOM internals.handleBounds имеет приоритет над пропом.»).
- Импорт из `./scene` дополнить: `nodeCenter, nodeGeometry`.
- В `useMemo` для `edges` (строки 213-218) заменить расчёт центров:

```ts
    const centerOf = new Map(rfNodes.map((n) => [
      n.id, nodeCenter(((n.type ?? "device") as "device" | "network"), n.position),
    ] as const));
```

`frontend/src/pages/TopologyPage.tsx` — `pendingCenter` (строки 178-187):

```ts
  const pendingCenter = useMemo(() => {
    if (!pending) return null;
    const point = pending.kind === "device"
      ? (layout.devices ?? {})[pending.name]
      : (layout.networks ?? {})[pending.name];
    return point ? nodeCenter(pending.kind, point) : null;
  }, [pending, layout]);
```

Импорт страницы: `import { nodeCenter, parseEdgeId } from "../topology/scene";` (убрать `DEVICE_H, DEVICE_W, NET_H, NET_W` из `../topology/scene`, если больше нигде не используются — проверить grep'ом по файлу).

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/scene.test.ts src/topology/TopologyCanvas.test.tsx src/pages/TopologyPage.test.tsx`
Expected: PASS.

Run: `make fe-test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/topology/scene.ts frontend/src/topology/scene.test.ts frontend/src/topology/TopologyCanvas.tsx frontend/src/pages/TopologyPage.tsx
git commit -m "refactor(frontend): single source of node geometry in scene.ts"
```

---

### Task 4: `channel.send` — в `useEffect`

**Files:**
- Modify: `frontend/src/topology/useTopologyEditor.ts:603-620`

**Interfaces:**
- Consumes: `EditorChannel.send` (локальный тип того же файла).
- Produces: ничего нового.

- [ ] **Step 1: Write the failing test**

Побочный эффект в рендере не имеет отдельного наблюдаемого поведения — тест цикла «render → enqueue → flush работает». В `frontend/src/topology/useTopologyEditor.test.tsx` (перед `it("queues a device position…")`) добавить:

```ts
  it("flushes queued operations after mount (send is wired in an effect)", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    sessionStorage.setItem(storageKeys.draftId, "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    await act(async () => {
      result.current.moveDevice("r1", { x: 1, y: 2 });
      await result.current.flush();
    });

    expect(body).toEqual({ kind: "set-device-position", deviceName: "r1", position: { x: 1, y: 2 } });
    expect(result.current.status).toBe("saved");
  });
```

(Он будет зелёным и до рефакторинга — это regression-pin на то, что перенос в эффект не сломает проводку `send`. Красным его делает только поломка цикла; поэтому Step 2 в этом таске — убедиться, что тест зелёный ДО правки, затем после правки прогнать весь файл. Это исключение из TDD-ритма осознанное: меняется не поведение, а фаза React, которую Vitest не наблюдает.)

- [ ] **Step 2: Run test to verify it passes before the change**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/useTopologyEditor.test.tsx -t "flushes queued operations after mount"`
Expected: PASS.

- [ ] **Step 3: Move the assignment into an effect**

В `frontend/src/topology/useTopologyEditor.ts` удалить строку `channel.send = ops.mutateAsync;` из тела `useTopologyEditor` (строка 608) и добавить эффект рядом с существующим `useEffect` подписки listeners (строки 611-620):

```ts
  useEffect(() => {
    channel.send = ops.mutateAsync;
  }, [channel, ops.mutateAsync]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/topology/useTopologyEditor.test.tsx`
Expected: PASS (весь файл, включая новый тест).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/topology/useTopologyEditor.ts frontend/src/topology/useTopologyEditor.test.tsx
git commit -m "refactor(frontend): wire editor channel send in an effect, not in render"
```

---

### Task 5: Фронтенд-валидация имён (запрет `|` и `#`)

**Files:**
- Modify: `frontend/src/lib/validate.ts:5-11`
- Modify: `frontend/src/lib/validate.test.ts:4-10`
- Modify: `frontend/src/pages/TopologyPage.tsx` (create-панель: подсказка + `disabled` submit)
- Test: `frontend/src/pages/TopologyPage.test.tsx`, `frontend/src/topology/editForms.test.tsx`

**Interfaces:**
- Consumes: `uniqueNameHint(name: string, taken: string[], selfIndex?: number): string` — сигнатура не меняется.
- Produces: `uniqueNameHint` дополнительно возвращает `"Недопустимые символы в имени: | #"` при `|`/`#` в имени; `""` — валидно (как сейчас). `DeviceEditForm`/`NetworkEditForm`/`SubnetsPage`/`SetsPage`/`UnionsPage` подхватывают без правок.

- [ ] **Step 1: Write the failing tests**

В `frontend/src/lib/validate.test.ts` внутри `describe("uniqueNameHint")` добавить:

```ts
  it("accepts spaces, dots, colons and cyrillic", () => {
    expect(uniqueNameHint("Офис LAN", names)).toBe("");
    expect(uniqueNameHint("r.1", names)).toBe("");
  });
  it("rejects pipe and hash", () => {
    expect(uniqueNameHint("sw|core", names)).toBe("Недопустимые символы в имени: | #");
    expect(uniqueNameHint("sw#2", names)).toBe("Недопустимые символы в имени: | #");
  });
```

В `frontend/src/topology/editForms.test.tsx` внутрь `describe("DeviceEditForm")` добавить (стиль `it("blocks submit on a duplicate name")`):

```tsx
  it("blocks submit on edge-id separator characters", async () => {
    const onSubmit = vi.fn();
    wrapper(
      <DeviceEditForm
        device={{ name: "r1", kind: "router" }}
        unions={[]}
        existingNames={["r1", "sw1"]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await screen.findByLabelText("Имя");
    fireEvent.change(screen.getByLabelText("Имя"), { target: { value: "sw|core" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Недопустимые символы в имени: | #")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
```

В `frontend/src/pages/TopologyPage.test.tsx` добавить (стиль соседних тестов create-панели, см. `it("creates an optimistic device…")` ~строка 150):

```tsx
  it("blocks creating a device whose name contains edge-id separators", async () => {
    server.use(http.get("/api/drafts/d1/topology", () => HttpResponse.json({
      topology: { devices: [], links: [], networks: [], sets: [], unions: [] },
      layout: { devices: {}, networks: {}, links: {}, camera: { x: 0, y: 0, z: 1 } },
    })));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    expect(screen.getByTestId("create-panel")).toBeInTheDocument();
    await user.type(await screen.findByLabelText("Имя"), "sw|core");
    expect(screen.getByText("Недопустимые символы в имени: | #")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
    expect(screen.queryByTestId("rf__node-device:sw|core")).toBeNull();
  });

  it("blocks creating a device with a duplicate name", async () => {
    server.use(http.get("/api/drafts/d1/topology", () => HttpResponse.json({
      topology: {
        devices: [{ name: "core-sw", kind: "switch" }],
        links: [], networks: [], sets: [], unions: [],
      },
      layout: {
        devices: { "core-sw": { x: 200, y: 100 } }, networks: {}, links: {},
        camera: { x: 0, y: 0, z: 1 },
      },
    })));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await user.click(await screen.findByTestId("tool-device"));
    fireEvent.click(document.querySelector(".react-flow__pane")!, { clientX: 200, clientY: 100 });
    await user.type(await screen.findByLabelText("Имя"), "core-sw");
    expect(screen.getByText("Имя уже используется")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/lib/validate.test.ts src/topology/editForms.test.tsx src/pages/TopologyPage.test.tsx`
Expected: FAIL — `uniqueNameHint("sw|core", …)` возвращает `""`; submit в create-панели и в `DeviceEditForm` не disabled.

- [ ] **Step 3: Implement the name check**

`frontend/src/lib/validate.ts` — заменить `uniqueNameHint`:

```ts
const NAME_FORBIDDEN = /[|#]/;

export function uniqueNameHint(name: string, taken: string[], selfIndex = -1): string {
  const trimmed = name.trim();
  if (!trimmed) return "Имя обязательно";
  if (NAME_FORBIDDEN.test(trimmed)) return "Недопустимые символы в имени: | #";
  const clash = taken.findIndex((n) => n === trimmed);
  if (clash !== -1 && clash !== selfIndex) return "Имя уже используется";
  return "";
}
```

- [ ] **Step 4: Wire the create panel on the canvas**

`frontend/src/pages/TopologyPage.tsx`:

Импорт: `import { uniqueNameHint } from "../lib/validate";`

После `editNetwork` (строка 268) добавить:

```ts
  const createHint = createTarget
    ? uniqueNameHint(
      createName,
      createTarget.kind === "device" ? devices.map((d) => d.name) : networks.map((n) => n.name),
    )
    : "";
```

В `create()` (строки 205-213) заменить гард:

```ts
  const create = () => {
    if (!createTarget || createHint) return;
    const name = createName.trim();
    guard(() => {
      if (createTarget.kind === "device") editor.createDevice(createTarget.position, createDeviceKind, name);
      else editor.createNetwork(createTarget.position, name);
      setCreateTarget(null);
    });
  };
```

В форме create-панели (строки 453-471) — под полем «Имя» и у submit:

```tsx
                <label>
                  Имя
                  <input autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} />
                </label>
                {createHint && <p className="cell-hint">{createHint}</p>}
```

```tsx
                <button type="submit" className="primary" disabled={!!createHint}>Создать</button>
```

(строка 469: было `disabled={!createName.trim()}`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker compose --profile test run --rm frontend-test npx vitest run src/lib/validate.test.ts src/pages/TopologyPage.test.tsx src/topology/editForms.test.tsx`
Expected: PASS.

Run: `make fe-test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/validate.ts frontend/src/lib/validate.test.ts frontend/src/pages/TopologyPage.tsx frontend/src/pages/TopologyPage.test.tsx frontend/src/topology/editForms.test.tsx
git commit -m "feat(frontend): forbid edge-id separator characters in entity names"
```

---

### Task 6: Бэкенд `ValidateName` в операциях create/update

**Files:**
- Modify: `backend/internal/topology/validate.go`
- Modify: `backend/internal/topology/validate_test.go`
- Modify: `backend/internal/httpapi/topology_operations.go:168-183` (create/update-device), `:255-271` (create/update-network)
- Test: `backend/internal/httpapi/topology_operations_test.go`

**Interfaces:**
- Consumes: ничего нового (пакет `topology` уже существует).
- Produces: `topology.ValidateName(name string) string` — `""` если имя допустимо, иначе текст ошибки по-английски.

- [ ] **Step 1: Write the failing tests**

В `backend/internal/topology/validate_test.go` добавить (пакет `topology`, стиль соседних тестов):

```go
func TestValidateName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"r1", true},
		{"Офис LAN", true},
		{"r.1", true},
		{"a:b", true},
		{"", false},
		{"  ", false},
		{"sw|core", false},
		{"sw#2", false},
	}
	for _, c := range cases {
		why := ValidateName(c.name)
		if c.ok && why != "" {
			t.Errorf("ValidateName(%q) = %q, want ok", c.name, why)
		}
		if !c.ok && why == "" {
			t.Errorf("ValidateName(%q) = ok, want error", c.name)
		}
	}
}
```

В `backend/internal/httpapi/topology_operations_test.go` добавить:

```go
func TestApplyTopologyOperation_RejectsEdgeIDSeparatorNames(t *testing.T) {
	cases := []topologyOperation{
		{Kind: "create-device", Device: &DeviceDoc{Name: "sw|core", Kind: "router"}},
		{Kind: "create-device", Device: &DeviceDoc{Name: "sw#2", Kind: "router"}},
		{Kind: "create-network", Network: &NetworkDoc{Name: "n|dmz"}},
		{Kind: "update-device", DeviceName: "r1", Device: &DeviceDoc{Name: "r|1", Kind: "router"}},
		{Kind: "update-network", NetworkName: "n-office", Network: &NetworkDoc{Name: "of|fice"}},
	}
	for _, op := range cases {
		if _, err := applyTopologyOperation(fixtureProjectDoc(), op); err == nil {
			t.Errorf("%s: want error for name with | or #, got nil", op.Kind)
		}
	}
}

func TestApplyTopologyOperation_AllowsSpacedAndCyrillicNames(t *testing.T) {
	if _, err := applyTopologyOperation(fixtureProjectDoc(), topologyOperation{
		Kind: "create-device", Device: &DeviceDoc{Name: "Офис LAN", Kind: "router"},
	}); err != nil {
		t.Fatalf("create-device with cyrillic name: %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose --profile test run --rm backend-test go test ./internal/topology/ ./internal/httpapi/ -run "ValidateName|EdgeIDSeparator|SpacedAndCyrillic" -v`
Expected: FAIL — `ValidateName` is not defined; `create-device` с `sw|core` проходит без ошибки.

- [ ] **Step 3: Implement `ValidateName`**

`backend/internal/topology/validate.go` — добавить (импорт `strings` уже есть; `fmt` уже есть):

```go
// ValidateName reports "" when name is usable as a device or network name,
// otherwise the reason. Pipe and hash separate segments in canvas edge ids
// (frontend scene.ts) and in layoutLinkKey/pgstore.linkKey, so they are
// forbidden here.
func ValidateName(name string) string {
	if strings.TrimSpace(name) == "" {
		return "name is empty"
	}
	if strings.ContainsAny(name, "|#") {
		return fmt.Sprintf("name %q contains forbidden characters '|#'", name)
	}
	return ""
}
```

- [ ] **Step 4: Call it from create/update operations**

`backend/internal/httpapi/topology_operations.go` — импорт дополнить:

```go
import (
	"fmt"

	"github.com/kudes1/firenet/internal/projectdoc"
	"github.com/kudes1/firenet/internal/topology"
)
```

В `case "create-device"` после проверки `op.Device == nil` (строки 168-172):

```go
		if why := topology.ValidateName(op.Device.Name); why != "" {
			return doc, fmt.Errorf("create-device: %s", why)
		}
```

В `case "update-device"` после проверки missing (строки 174-177):

```go
		if why := topology.ValidateName(op.Device.Name); why != "" {
			return doc, fmt.Errorf("update-device: %s", why)
		}
```

В `case "create-network"` после проверки `op.Network == nil` (строки 255-259):

```go
		if why := topology.ValidateName(op.Network.Name); why != "" {
			return doc, fmt.Errorf("create-network: %s", why)
		}
```

В `case "update-network"` после проверки missing (строки 261-264):

```go
		if why := topology.ValidateName(op.Network.Name); why != "" {
			return doc, fmt.Errorf("update-network: %s", why)
		}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker compose --profile test run --rm backend-test go test ./internal/topology/ ./internal/httpapi/ -v`
Expected: PASS.

Run: `make test`
Expected: PASS (весь Go-набор, включая Postgres-тесты).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/topology/validate.go backend/internal/topology/validate_test.go backend/internal/httpapi/topology_operations.go backend/internal/httpapi/topology_operations_test.go
git commit -m "feat(backend): reject | and # in new device and network names"
```

---

### Task 7: Полная верификация

**Files:**
- Modify: только правки по замечаниям тестов (если всплывут).

**Interfaces:**
- Consumes: все предыдущие таски.
- Produces: зелёный полный прогон.

- [ ] **Step 1: go vet + gofmt**

Run: `make vet`
Expected: PASS.

Run: `make fmt`
Expected: без изменений в `git status` (или раскоммитить формат отдельно, если gofmt что-то дотронет — сообщить в отчёте).

- [ ] **Step 2: Go-тесты**

Run: `make test`
Expected: PASS.

- [ ] **Step 3: Frontend typecheck + Vitest**

Run: `make fe-test`
Expected: PASS.

- [ ] **Step 4: E2E**

Run: `make test-e2e`
Expected: PASS. (Требует Docker + Node + `frontend/node_modules` + `e2e/node_modules` + Chromium — см. AGENTS.md.)

- [ ] **Step 5: Final commit (если были дотяжки)**

```bash
git add -A
git commit -m "chore: topology canvas refactor verification fixes"
```

(Если дотяжек не было — шаг пропускается.)
