# Clean Enterprise Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести общий shell и страницу топологии firenet на единый Clean enterprise дизайн со светлой темой по умолчанию и сохранённой тёмной темой.

**Architecture:** Первый этап остаётся frontend-only и опирается на существующие `Layout`, `Sidebar`, `TopologyPage`, React Flow-компоненты и общий `styles.css`. Геометрия, поверхности, цвета и состояния задаются семантическими CSS-токенами; поведение маршрутизации, API и topology editor не меняется. Остальные страницы используют результат как базовый слой и получают отдельные планы.

**Tech Stack:** React 18, TypeScript, Vite, React Flow (`@xyflow/react`), Vitest, Testing Library, Playwright для проектного E2E-набора.

**Spec:** `docs/superpowers/specs/2026-09-14-clean-enterprise-redesign-design.md`

## Global Constraints

- Светлая тема является fallback при отсутствии сохранённого выбора; тёмная тема включается существующим переключателем и сохраняется в `ui.theme`.
- Новые npm-зависимости, backend-эндпоинты и изменения API не добавляются.
- Существующие маршруты, горячие клавиши, операции topology editor и `data-testid` сохраняются.
- Используются текущие CSS custom properties и `color-mix()`; произвольные цвета в компонентах не добавляются.
- После изменений проверки запускаются в порядке `make vet`, `make fmt`, `make test`, `make fe-test`, `make test-e2e`.
- Для каждого поведения сначала добавляется или уточняется failing-тест, затем минимальная реализация, затем повторная проверка.

## File Map

- Modify `frontend/src/components/theme.ts`: изменить fallback темы на светлый и сохранить явный выбор пользователя.
- Create `frontend/src/components/theme.test.ts`: зафиксировать контракт начальной и применённой темы.
- Modify `frontend/src/components/Layout.tsx`: добавить только необходимые semantic hooks для shell без изменения потока данных и Outlet.
- Modify `frontend/src/components/Sidebar.tsx`: сохранить навигационную логику и закрепить semantic hooks для нового chrome.
- Modify `frontend/src/components/Layout.test.tsx`: проверить shell hooks, тему, collapsed navigation и сохранённые маршруты.
- Modify `frontend/src/pages/TopologyPage.tsx`: сгруппировать верхний chrome topology без изменения editor callbacks и test IDs.
- Modify `frontend/src/pages/TopologyPage.test.tsx`: зафиксировать доступные названия toolbar и наличие рабочей области.
- Modify `frontend/src/topology/TopologyCanvas.tsx`, `frontend/src/topology/DeviceNode.tsx`, `frontend/src/topology/UnionNode.tsx`, `frontend/src/topology/LinkEdge.tsx`, `frontend/src/topology/CanvasPanel.tsx`, `frontend/src/topology/ContextMenu.tsx`: добавить только нужные presentation hooks, если текущих классов недостаточно.
- Modify `frontend/src/topology/TopologyCanvas.test.tsx`: сохранить проверки React Flow-слоёв и добавить проверки новых semantic hooks только там, где они нужны для поведения.
- Modify `frontend/src/styles.css`: обновить токены, shell, topology chrome, canvas surfaces, panels, controls and responsive rules.

### Task 1: Lock the theme contract

**Files:**
- Modify: `frontend/src/components/theme.ts:0-19`
- Create: `frontend/src/components/theme.test.ts`
- Modify: `frontend/src/components/Layout.test.tsx:15-132`

**Interfaces:**
- Consumes: `storageKeys.theme` and the current `applyTheme(theme)` API.
- Produces: `initialTheme(): "light" | "dark"` returning `"light"` when no valid saved choice exists, and `applyTheme(theme)` continuing to set `document.documentElement.dataset.theme` and persist the choice.

- [x] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme, initialTheme } from "./theme";

describe("theme", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => delete document.documentElement.dataset.theme);

  it("defaults to light when no preference was saved", () => {
    expect(initialTheme()).toBe("light");
  });

  it("keeps a saved dark preference", () => {
    localStorage.setItem("ui.theme", "dark");
    expect(initialTheme()).toBe("dark");
  });

  it("applies and persists the selected theme", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ui.theme")).toBe("dark");
  });
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/components/theme.test.ts`

Expected: FAIL because `initialTheme()` currently follows `matchMedia()` and can return `"dark"` when no preference is saved.

- [x] **Step 3: Implement the minimal theme fallback**

Keep the existing explicit saved-value branch and replace the system-preference fallback with:

```ts
return "light";
```

Do not remove `applyTheme()` or change the `ui.theme` storage key.

- [x] **Step 4: Run the focused tests**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/components/theme.test.ts src/components/Layout.test.tsx`

Expected: PASS with the existing theme toggle test and the new default-theme contract passing.

- [x] **Step 5: Commit the isolated theme contract**

```bash
git add frontend/src/components/theme.ts frontend/src/components/theme.test.ts frontend/src/components/Layout.test.tsx
git commit -m "feat(frontend): make light theme the default"
```

### Task 2: Restyle the application shell

**Files:**
- Modify: `frontend/src/components/Layout.tsx:19-33`
- Modify: `frontend/src/components/Sidebar.tsx:56-129`
- Modify: `frontend/src/components/Layout.test.tsx:22-145`
- Modify: `frontend/src/styles.css:1-230, 1390-1432`

**Interfaces:**
- Consumes: `Sidebar` navigation groups, `DraftBanner`, `BannerHost`, `ErrorBoundary` and the existing `Outlet` flow.
- Produces: stable `.app-shell`, `.sidebar`, `.app-main`, `.app-header`/semantic shell hooks as needed, while preserving current links, collapsed state, theme button, logout button and test IDs.

- [x] **Step 1: Add a structural regression assertion**

Extend the existing layout test with the shell contract that the rendered application keeps the sidebar and renders the outlet inside the main content region. Use existing accessible roles and test IDs rather than asserting CSS implementation details:

```tsx
it("keeps the enterprise shell around page content", () => {
  renderLayout();

  expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  expect(screen.getByRole("main")).toBeInTheDocument();
  expect(screen.getByTestId("page")).toBeInTheDocument();
});
```

- [x] **Step 2: Run the focused test**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/components/Layout.test.tsx`

Expected: PASS if the current markup already satisfies the semantic contract; if it does, keep the test as a regression guard and proceed to presentation-only changes.

- [x] **Step 3: Implement the shell presentation**

Update the CSS so `.app-shell` owns the viewport, `.sidebar` is a stable raised navigation surface, and the content `main` uses the new background and spacing. Keep the current collapsed widths and the existing `navClass` behavior. Group shared controls through existing classes (`.sidebar-toggle`, `.theme-toggle`, `.logout-btn`) and keep focus rings visible.

The shell implementation must not move data fetching, navigation, logout, or theme state out of `Sidebar`/`Layout`.

- [x] **Step 4: Run the focused shell tests**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/components/Layout.test.tsx src/App.test.tsx`

Expected: PASS with the sidebar, theme toggle, route rendering and all existing navigation assertions unchanged.

- [x] **Step 5: Commit the shell styling**

```bash
git add frontend/src/components/Layout.tsx frontend/src/components/Sidebar.tsx frontend/src/components/Layout.test.tsx frontend/src/styles.css
git commit -m "feat(frontend): restyle clean enterprise application shell"
```

### Task 3: Establish the topology workspace hierarchy

**Files:**
- Modify: `frontend/src/pages/TopologyPage.tsx:270-473`
- Modify: `frontend/src/pages/TopologyPage.test.tsx`
- Modify: `frontend/src/styles.css:280-440, 1670-1760`

**Interfaces:**
- Consumes: `TopologyCanvas` props, editor state, lock state, toolbar callbacks, `CanvasPanel` children and current `data-testid` values.
- Produces: a topology workspace with a clear page/toolbar/canvas hierarchy; all existing editor actions continue to invoke the same callbacks.

- [x] **Step 1: Add a topology workspace regression test**

Add a behavior-level assertion for the existing topology controls and workspace, without testing exact colors or pixel values:

```tsx
it("exposes the topology workspace and primary tools", () => {
  renderPage(<TopologyPage />, "/ui/topology", "d1");

  expect(screen.getByTestId("page-topology")).toBeInTheDocument();
  expect(screen.getByTestId("tool-select")).toBeInTheDocument();
  expect(screen.getByTestId("tool-connect")).toBeInTheDocument();
  expect(screen.getByTestId("tool-device")).toBeInTheDocument();
  expect(screen.getByTestId("tool-network")).toBeInTheDocument();
});
```

- [x] **Step 2: Run the focused topology test**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/pages/TopologyPage.test.tsx`

Expected: PASS if the existing topology controls already satisfy the behavior contract; retain it as a guard while changing only markup classes and CSS.

- [x] **Step 3: Implement the clean enterprise hierarchy**

Use the existing topology page structure to style:

- a calm page header and grouped toolbar controls;
- a white/light raised canvas surface in light mode and a corresponding dark surface in dark mode;
- a subtle React Flow grid and clear selected/connected states;
- status and danger actions with semantic tokens;
- responsive canvas sizing without changing React Flow event handling.

If a new class is necessary, add it next to the existing `data-testid`; do not rename the current test IDs.

- [x] **Step 4: Run the topology tests**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/pages/TopologyPage.test.tsx src/topology/TopologyCanvas.test.tsx`

Expected: PASS for rendering, create/edit/delete, lock/read-only behavior, connection tools and canvas layers.

- [x] **Step 5: Commit the topology workspace styling**

```bash
git add frontend/src/pages/TopologyPage.tsx frontend/src/pages/TopologyPage.test.tsx frontend/src/styles.css
git commit -m "feat(frontend): restyle topology workspace"
```

### Task 4: Align topology primitives and floating surfaces

**Files:**
- Modify: `frontend/src/topology/TopologyCanvas.tsx`
- Modify: `frontend/src/topology/DeviceNode.tsx`
- Modify: `frontend/src/topology/UnionNode.tsx`
- Modify: `frontend/src/topology/LinkEdge.tsx`
- Modify: `frontend/src/topology/CanvasPanel.tsx`
- Modify: `frontend/src/topology/ContextMenu.tsx`
- Modify: `frontend/src/topology/TopologyCanvas.test.tsx`
- Modify: `frontend/src/styles.css:307-440, 560-760, 1180-1390`

**Interfaces:**
- Consumes: existing React Flow node/edge props, panel drag/close callbacks and context-menu actions.
- Produces: unified node, edge, tooltip, context-menu and panel chrome with unchanged data and interaction contracts.

- [x] **Step 1: Add focused state assertions where coverage is missing**

Cover only user-visible behavior that can regress during restyling: selected node receives its selected class, filtered/diagnostic edge keeps its state class, and a canvas panel keeps its close button accessible name.

- [x] **Step 2: Run the focused topology primitive tests**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/topology/TopologyCanvas.test.tsx src/topology/ContextMenu.test.tsx src/topology/LinkEdge.test.tsx`

Expected: FAIL only for newly added assertions, or PASS if the existing classes already provide the contract.

- [x] **Step 3: Implement shared primitive styling**

Apply the design tokens consistently to `.topo-node`, `.link-edge`, `.canvas-panel`, `.context-menu`, `.net-info` and related selectors. Keep topology-kind colors semantic, make selection visible in both themes, and use a single raised-surface treatment for floating UI.

- [x] **Step 4: Run the primitive tests**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/topology/TopologyCanvas.test.tsx src/topology/ContextMenu.test.tsx src/topology/LinkEdge.test.tsx`

Expected: PASS with existing drag, context-menu, edge and panel behavior intact.

- [x] **Step 5: Commit the topology primitives**

```bash
git add frontend/src/topology frontend/src/styles.css
git commit -m "feat(frontend): unify topology surfaces and states"
```

### Task 5: Add responsive and accessibility safeguards

**Files:**
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/components/Layout.test.tsx`
- Modify: `frontend/src/pages/TopologyPage.test.tsx`

**Interfaces:**
- Consumes: shell and topology classes from Tasks 2–4.
- Produces: predictable behavior at narrow viewport widths, preserved keyboard focus, and no loss of accessible names or semantic status messages.

- [x] **Step 1: Add regression assertions**

Add the assertions to the existing layout/topology tests so the key controls remain keyboard-discoverable after the markup changes:

```tsx
expect(screen.getByRole("button", { name: "Сменить тему" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "Свернуть меню" })).toBeInTheDocument();
expect(await screen.findByRole("status", { name: "Сохранено" })).toBeInTheDocument();
```

When the test opens a `CanvasPanel`, assert its existing close control with `screen.getByRole("button", { name: "Закрыть" })`.

- [x] **Step 2: Run the focused accessibility tests**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/components/Layout.test.tsx src/pages/TopologyPage.test.tsx`

Expected: PASS before responsive CSS changes.

- [x] **Step 3: Implement responsive rules**

At the narrow breakpoint, keep the sidebar collapsed geometry, let the topology toolbar wrap, keep the canvas usable, and make floating panels fit inside the viewport. Do not hide primary actions or rely on hover-only access.

- [x] **Step 4: Run the focused tests again**

Run: `docker compose --profile test run --rm frontend-test npm test -- src/components/Layout.test.tsx src/pages/TopologyPage.test.tsx`

Expected: PASS with all accessible names and existing interactions unchanged.

- [x] **Step 5: Commit responsive safeguards**

```bash
git add frontend/src/styles.css frontend/src/components/Layout.test.tsx frontend/src/pages/TopologyPage.test.tsx
git commit -m "feat(frontend): make redesigned shell responsive"
```

### Task 6: Integrate and verify phase one

**Files:**
- Modify: only files listed in Tasks 1–5 if a verification issue requires a focused correction.
- Test: project verification commands below.

**Interfaces:**
- Consumes: completed theme, shell, topology and responsive work.
- Produces: a verified first-stage redesign ready for the next roadmap plan.

- [x] **Step 1: Review the diff and scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Confirm that only phase-one frontend files and the intended tests changed; do not stage unrelated existing worktree changes.

- [x] **Step 2: Run the project verification order**

Run exactly:

```bash
make vet
make fmt
make test
make fe-test
make test-e2e
```

Expected: every command exits with status 0; frontend and E2E output reports zero failed tests. Existing warnings from React Router/MSW or Docker tooling are recorded but are not treated as new failures unless they change exit status or identify a regression in the redesigned shell/topology.

- [x] **Step 3: Commit the integrated phase**

```bash
git add frontend/src docs/superpowers/specs/2026-09-14-clean-enterprise-redesign-design.md docs/superpowers/plans/2026-09-14-clean-enterprise-redesign.md
git commit -m "feat(frontend): establish clean enterprise redesign foundation"
```
