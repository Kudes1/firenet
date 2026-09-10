# CanvasPanel — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разделить модалки: табличные страницы остаются на `Modal` (`<dialog>` + затемнение), канва получает независимую немодальную плавающую панель `CanvasPanel` в координатах `.canvas-wrap`.

**Architecture:** Новый компонент `frontend/src/topology/CanvasPanel.tsx` (absolute-панель внутри канвы, drag с зажимом в rect канвы, Esc без ловушки фокуса). Три канвовые формы TopologyPage переезжают на неё как children `TopologyCanvas` (как ContextMenu). `Modal` чистится от канвового флага `undimmed`; `Combo` учитывает панель как containing block для портала подсказок.

**Tech Stack:** React 18 + TypeScript, Vitest + Testing Library (jsdom), обычный CSS (styles.css).

**Spec:** `docs/superpowers/specs/2026-09-10-canvas-panel-design.md`

## Global Constraints

- Верификация после каждой задачи: `cd frontend && npm run typecheck && npm test`.
- Финал: `make test-e2e` (docker + chromium).
- Стиль кода: компактный, без комментариев кроме нетривиальных мест (как в существующих Modal/ContextMenu — там комментарии объясняют «почему»).
- e2e-сценарии канвовые модалки не проверяют (только `dialog.modal` табличных страниц) — e2e править не нужно, только прогнать.
- Панель — children `TopologyCanvas`: рендерится внутри `.canvas-wrap`, координаты — канвовые (прецедент: ContextMenu).

---

### Task 1: Компонент CanvasPanel

**Files:**
- Create: `frontend/src/topology/CanvasPanel.tsx`
- Create: `frontend/src/topology/CanvasPanel.test.tsx`
- Modify: `frontend/src/styles.css` (блок после `.context-menu`, ~строка 600)

**Interfaces:**
- Consumes: ничего (standalone).
- Produces: `default export CanvasPanel` с props `{ title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; at?: { x: number; y: number } }`. Позиция — absolute внутри ближайшего `.canvas-wrap`. Позже Task 3 использует его вместо `Modal` на канве.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CanvasPanel from "./CanvasPanel";

function renderPanel(props: Partial<Parameters<typeof CanvasPanel>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <div className="canvas-wrap">
      <CanvasPanel title="Изменить устройство r1" onClose={onClose} {...props}>
        <label>
          Имя
          <input />
        </label>
      </CanvasPanel>
    </div>,
  );
  return { onClose, ...utils };
}

function mockRects(panelRect: DOMRect, canvasRect: DOMRect) {
  const panel = document.querySelector(".canvas-panel")!;
  const canvas = document.querySelector(".canvas-wrap")!;
  Object.defineProperty(panel, "getBoundingClientRect", { value: () => panelRect, configurable: true });
  Object.defineProperty(canvas, "getBoundingClientRect", { value: () => canvasRect, configurable: true });
}

describe("CanvasPanel", () => {
  it("renders header, close button and body at the given point", () => {
    renderPanel({ at: { x: 120, y: 80 } });
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    expect(screen.getByText("Изменить устройство r1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Имя/)).toBeInTheDocument();
    expect(panel.style.left).toBe("120px");
    expect(panel.style.top).toBe("80px");
  });

  it("centers in the canvas when no at is given", () => {
    // useLayoutEffect центрирования выполняется внутри render(), поэтому
    // rect-моки ставим на прототип ДО render (после render уже поздно).
    const proto = Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      value: function (this: Element) {
        if (this.classList.contains("canvas-wrap")) return new DOMRect(0, 0, 800, 600);
        if (this.classList.contains("canvas-panel")) return new DOMRect(0, 0, 300, 200);
        return new DOMRect(0, 0, 0, 0);
      },
      configurable: true,
    });
    renderPanel();
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    // Канва 800x600, панель 300x200 → центр (250, 200).
    expect(panel.style.left).toBe("250px");
    expect(panel.style.top).toBe("200px");
    delete (Element.prototype as any).getBoundingClientRect;
    void proto;
  });

  it("closes on Escape outside inputs", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps open on Escape inside an input", () => {
    const { onClose } = renderPanel();
    const input = screen.getByLabelText(/Имя/);
    input.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("drags by the header and clamps to the canvas", () => {
    renderPanel({ at: { x: 100, y: 100 } });
    // Канва 800x600, панель 300x200 → x ≤ 500, y ≤ 400.
    mockRects(new DOMRect(100, 100, 300, 200), new DOMRect(0, 0, 800, 600));
    const header = screen.getByText("Изменить устройство r1").closest(".canvas-panel-header")!;
    fireEvent.mouseDown(header, { clientX: 150, clientY: 120 });
    fireEvent.mouseMove(window, { clientX: 1200, clientY: -400 });
    fireEvent.mouseUp(window);
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    expect(panel.style.left).toBe("500px");
    expect(panel.style.top).toBe("0px");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/topology/CanvasPanel.test.tsx`
Expected: FAIL — модуль `./CanvasPanel` не найден.

- [ ] **Step 3: Write the implementation**

`frontend/src/topology/CanvasPanel.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Props = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  at?: { x: number; y: number };
};

// Плавающая панель редактирования на канве: absolute внутри .canvas-wrap
// (рендерится children'ом TopologyCanvas, как ContextMenu), поэтому координаты
// канвовые и панель обрезается рамкой канвы. Немодальная: фокуса не ловим,
// канва остаётся доступной; Esc закрывает, если фокус не в текстовом поле
// (Esc внутри Combo гасится им самим и закрывает только подсказки).
export default function CanvasPanel({ title, onClose, children, wide, at }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; max: { x: number; y: number } } | null>(null);
  // Позиция известна после измерения (центрирование) — до этого панель скрыта.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(at ?? null);

  useLayoutEffect(() => {
    if (at || !ref.current) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    setPos({ x: (canvas.width - r.width) / 2, y: (canvas.height - r.height) / 2 });
    // Центрируем один раз при открытии; дальше панель двигают вручную.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !ref.current || !pos) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    drag.current = {
      startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y,
      max: { x: canvas.width - r.width, y: canvas.height - r.height },
    };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const x = Math.min(Math.max(d.baseX + e.clientX - d.startX, 0), d.max.x);
      const y = Math.min(Math.max(d.baseY + e.clientY - d.startY, 0), d.max.y);
      setPos({ x, y });
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`canvas-panel${wide ? " canvas-panel-lg" : ""}`}
      style={{ left: pos?.x, top: pos?.y, visibility: pos ? undefined : "hidden" }}
    >
      <header className="canvas-panel-header" onMouseDown={onHeaderMouseDown}>
        <h3>{title}</h3>
        <button type="button" className="modal-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="canvas-panel-body">{children}</div>
    </div>
  );
}
```

CSS в `frontend/src/styles.css` — вставить после блока `.context-menu` (~строка 600):

```css
/* Canvas edit panel (topology edit forms): absolute inside .canvas-wrap —
   clipped by the canvas, coordinates are canvas-relative, drag clamps to
   the canvas rect. Chrome mirrors .floating-panel (diagnose panels). */
.canvas-panel {
  position: absolute;
  z-index: 12;
  min-width: 22rem;
  max-width: calc(100% - 2 * var(--space-3));
  max-height: calc(100% - 2 * var(--space-3));
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
}
.canvas-panel-lg { width: min(44rem, calc(100% - 2 * var(--space-3))); }
.canvas-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
  touch-action: none;
}
.canvas-panel-header h3 { margin: 0; font-size: 1rem; }
.canvas-panel-body { padding: var(--space-3) var(--space-4); overflow-y: auto; }
```

Замечание по тестам с jsdom: `getBoundingClientRect` в jsdom всегда нулевой, поэтому в тестах drag/центрирования rect мокаются — до render для layout-эффектов (центрирование) через `Element.prototype`, после render для событий (drag) через `Object.defineProperty` на конкретных элементах.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/topology/CanvasPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/topology/CanvasPanel.tsx frontend/src/topology/CanvasPanel.test.tsx frontend/src/styles.css
git commit -m "feat(topology): add CanvasPanel — floating edit panel inside the canvas"
```

---

### Task 2: Combo — портал подсказок внутри canvas-panel

**Files:**
- Modify: `frontend/src/components/ui/Combo.tsx` (строки 42 и 68)
- Modify: `frontend/src/components/ui/Combo.test.tsx`

**Interfaces:**
- Consumes: CSS-класс `.canvas-panel` (Task 1).
- Produces: `Combo` работает внутри `CanvasPanel` — подсказки порталится в панель (absolute относительно неё). API Combo не меняется.

- [ ] **Step 1: Write the failing test**

Добавить в `Combo.test.tsx` (существующий файл, стиль повторить по соседним тестам):

```tsx
it("portals suggestions into a canvas panel when used inside one", async () => {
  const user = userEvent.setup();
  render(
    <div className="canvas-wrap">
      <div className="canvas-panel" style={{ position: "absolute", left: 50, top: 50 }}>
        <Combo items={["alpha", "beta"]} onPick={() => {}} />
      </div>
    </div>,
  );
  await user.click(screen.getByRole("textbox"));
  const suggestions = document.querySelector(".canvas-panel .member-suggestions");
  expect(suggestions).not.toBeNull();
  // absolute внутри панели, не fixed в body
  expect((suggestions as HTMLElement).style.position).toBe("absolute");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ui/Combo.test.tsx`
Expected: FAIL — подсказки уходят в `document.body` (fixed), селектор `.canvas-panel .member-suggestions` пуст.

- [ ] **Step 3: Implement**

В `Combo.tsx` два места, селектор расширяется на панель:

Строка 42 (в `measure`):
```ts
const dialog = input.closest("dialog[open], .canvas-panel");
```

Строка 68 (`portalTarget`):
```ts
const portalTarget = inputRef.current?.closest("dialog[open], .canvas-panel") ?? document.body;
```

Комментарий у `measure` дополнить одной фразой: «то же для .canvas-panel (позиционированный контейнер в канве)».

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ui/Combo.test.tsx`
Expected: PASS, все существующие тесты Combo тоже зелёные.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/Combo.tsx frontend/src/components/ui/Combo.test.tsx
git commit -m "feat(ui): portal Combo suggestions into .canvas-panel containers"
```

---

### Task 3: Переезд канвовых форм на CanvasPanel, чистка Modal

**Files:**
- Modify: `frontend/src/pages/TopologyPage.tsx` (строки 13, 274–321)
- Modify: `frontend/src/pages/TopologyPage.test.tsx` (строки ~180, 188)
- Modify: `frontend/src/components/ui/Modal.tsx` (Props, строка 75)
- Modify: `frontend/src/styles.css` (строка 1016)

**Interfaces:**
- Consumes: `CanvasPanel` (Task 1), обновлённый `Combo` (Task 2).
- Produces: канвовые формы в `.canvas-panel`; `Modal` без флага `undimmed` — только табличные страницы.

- [ ] **Step 1: Update TopologyPage tests to the new selector**

В `TopologyPage.test.tsx` обе проверки `modal-undimmed` (строки 180 и 188) заменить на:

```ts
expect(document.querySelector(".canvas-panel")).not.toBeNull();
```

Комментарии над ними («Канвовые модалки не затемняют канву…») заменить на: «Форма редактирования — панель внутри канвы (.canvas-panel), не <dialog>».

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/TopologyPage.test.tsx`
Expected: FAIL — панели ещё рендерятся как `dialog.modal`.

- [ ] **Step 3: Migrate TopologyPage**

В `TopologyPage.tsx`:

1. Импорт: `import Modal from "../components/ui/Modal";` → `import CanvasPanel from "../topology/CanvasPanel";`
2. Три блока модалок (строки 274–321, после `</div>` topology-layout) перенести **внутрь** `<TopologyCanvas>` — после `{menu && <ContextMenu … />}`, перед `</TopologyCanvas>`, и заменить на:

```tsx
        {/* Панели редактирования — children канвы: координаты канвовые,
            панель обрезается рамкой .canvas-wrap (см. CanvasPanel). */}
        {editDevice && (
          <CanvasPanel title={`Изменить устройство ${editDevice.name}`} onClose={() => setEditTarget(null)}>
            <DeviceEditForm
              device={editDevice}
              unions={doc.unions ?? []}
              existingNames={devices.map((d) => d.name)}
              onCancel={() => setEditTarget(null)}
              onSubmit={(operations) => { setEditTarget(null); editor.enqueueAll(operations); }}
            />
          </CanvasPanel>
        )}
        {editNetwork && (
          <CanvasPanel title={`Изменить сеть ${editNetwork.name}`} onClose={() => setEditTarget(null)} wide>
            <NetworkEditForm
              network={editNetwork}
              networks={networks}
              allSubnets={subnets.data?.subnets ?? []}
              existingNames={networks.map((n) => n.name)}
              onCancel={() => setEditTarget(null)}
              onSubmit={(operations) => { setEditTarget(null); editor.enqueueAll(operations); }}
            />
          </CanvasPanel>
        )}
        {editLink && (
          <CanvasPanel
            title={`Фильтры связи ${editLink.a.device} ↔ ${editLink.b.device}`}
            onClose={() => setEditTarget(null)}
            wide
          >
            <LinkFilterForm
              link={editLink}
              onSave={async (next) => {
                const links = (doc.links ?? []).slice();
                if (editTarget?.kind === "link") links[editTarget.index] = next;
                try {
                  await save.mutateAsync({ ...doc, links });
                } catch (error) {
                  notify((error as Error).message);
                }
              }}
            />
          </CanvasPanel>
        )}
```

Footer «Закрыть» у link-фильтра выпадает — крестик в хедере и Esc закрывают. Если e2e/тесты ожидают кнопку «Закрыть» на канве — вернуть `footer` нельзя (у CanvasPanel нет футера); вместо этого в тело LinkFilterForm-инстанса добавить внизу `<div className="modal-actions"><button type="button" onClick={() => setEditTarget(null)}>Закрыть</button></div>` — но только если тест этого требует (сначала прогнать без).

3. `open`-пропсы исчезают: `{editDevice && <CanvasPanel …>}` — рендер = открытая панель.

- [ ] **Step 4: Clean Modal**

`Modal.tsx`: удалить `undimmed?: boolean;` из Props и из className-шаблона (строка 75):

```tsx
className={`modal${wide ? " modal-lg" : ""}`}
```

`styles.css`: удалить строку 1016:

```css
dialog.modal.modal-undimmed::backdrop { background: transparent; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npm run typecheck && npm test`
Expected: PASS. Если e2e-предусловие из Step 3 сработает (тест ждёт «Закрыть» на канве) — добавить кнопку в тело link-панели, как описано.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/TopologyPage.tsx frontend/src/pages/TopologyPage.test.tsx frontend/src/components/ui/Modal.tsx frontend/src/styles.css
git commit -m "feat(topology): canvas edit forms use CanvasPanel; drop undimmed from Modal"
```

---

### Task 4: Полная верификация

**Files:** без изменений кода (правки только если верификация что-то нашла).

- [ ] **Step 1: Юнит-тесты и typecheck**

Run: `cd frontend && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 2: E2E**

Run: `make test-e2e`
Expected: PASS. Канвовые e2e-сценарии (canvas-editor, create-objects, delete) не открывают edit-панели, табличные не затронуты; контроль — link-filter/links-table (табличный `dialog.modal` не изменился).

- [ ] **Step 3: Ручная smoke-проверка (опционально, если docker поднят)**

Run: `docker compose up -d --build frontend` → открыть топологию, ПКМ по устройству → «Редактировать»: панель в канве, двигается в пределах канвы, Esc закрывает, канва интерактивна под панелью (пан/зум работает), Combo-подсказки в форме сети открываются внутри панели.

- [ ] **Step 4: Commit (если были правки)**

```bash
git add -A && git commit -m "fix(topology): address verification findings for CanvasPanel"
```
