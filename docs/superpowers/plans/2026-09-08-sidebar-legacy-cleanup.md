# Sidebar Legacy Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вычистить легаси-наследие из левого бокового меню React-фронтенда: единая подсветка через NavLink, чистые имена localStorage-ключей (`ui.*`), удаление мёртвого CSS, стили на дизайн-токенах, a11y-полировка.

**Architecture:** Новый модуль `frontend/src/lib/storage.ts` — единственная точка правды для всех ключей web-storage. Sidebar отказывается от пропа `active` и полагается на встроенную логику `NavLink` (`end` + `className`-функция); Layout перестаёт знать про меню. Draft-ключи переименовываются вместе с e2e-хелпером, который пишет их напрямую.

**Tech Stack:** React 18, react-router-dom 6, TypeScript, Vitest + Testing Library + MSW, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-08-sidebar-legacy-cleanup-design.md` (утверждён в чате 2026-09-08; ключевые решения: чистый NavLink; ключи `ui.*`; бренд удалить; logout остаётся full-reload с комментарием; user-box на токены, `--text` удалить; юнит-тесты, без новых e2e-сценариев).

## Global Constraints

- Проверка после каждой задачи: `cd frontend && npm run typecheck && npm test -- --run`.
- Финальная проверка: `make test-e2e` (обязательно — Task 4 меняет e2e-хелпер).
- Формат коммитов: `refactor(frontend): ...` / `test(frontend): ...` — смотри `git log --oneline`.
- Код компактный, без лишних комментариев; комментарии — только там, где неочевидное «почему» (AGENTS.md).
- UI-текст — на русском (существующие aria-label'ы сохраняем).
- Не трогаем поведение, кроме перечисленного: подсветка, ключи, a11y. Визуальный результат CSS-задач — пиксель-в-пиксель (токены дают те же значения: `--space-2` = 0.5rem = 8px, `--space-3` = 0.75rem = 12px, `--radius-sm` = 4px).
- Вне скоупа (не делать): восстановление бренда, e2e-сценарии для collapse/темы, блок `.submenu`/`.ctx-*` в styles.css (потенциально мёртвый — отдельная задача-расследование).

---

### Task 1: Модуль ключей web-storage

**Files:**
- Create: `frontend/src/lib/storage.ts`
- Test: `frontend/src/lib/storage.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `storageKeys` — константа с полями `sidebar`, `navGroup(id: string)`, `theme`, `draftId`, `lastDraftId`, `draftReadonly`. Значения: `"ui.sidebar"`, `` `ui.nav.${id}` ``, `"ui.theme"`, `"ui.draft.id"`, `"ui.draft.lastId"`, `"ui.draft.readonly"`. Tasks 3–4 импортируют отсюда; e2e-хелпер (Task 4) дублирует строки — тест ниже фиксирует контракт.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/storage.test.ts
import { describe, expect, it } from "vitest";
import { storageKeys } from "./storage";

// Контракт с e2e/helpers/ui.js: он пишет draft-ключи literal-строками.
describe("storageKeys", () => {
  it("uses the ui.* namespace", () => {
    expect(storageKeys.sidebar).toBe("ui.sidebar");
    expect(storageKeys.navGroup("firewall")).toBe("ui.nav.firewall");
    expect(storageKeys.theme).toBe("ui.theme");
    expect(storageKeys.draftId).toBe("ui.draft.id");
    expect(storageKeys.lastDraftId).toBe("ui.draft.lastId");
    expect(storageKeys.draftReadonly).toBe("ui.draft.readonly");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest --run src/lib/storage.test.ts`
Expected: FAIL — `Cannot find module './storage'`

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/storage.ts
// Все ключи web-storage приложения в одном месте — e2e-хелпер
// (e2e/helpers/ui.js) пишет draft-ключи literal-строками, не переименовывать вразнобой.

export const storageKeys = {
  sidebar: "ui.sidebar", // "collapsed" | absent
  navGroup: (id: string) => `ui.nav.${id}`, // "closed" | absent (раскрыта)
  theme: "ui.theme", // "light" | "dark"
  draftId: "ui.draft.id", // sessionStorage — активный драфт таба
  lastDraftId: "ui.draft.lastId", // localStorage — последний драфт для нового таба
  draftReadonly: "ui.draft.readonly", // sessionStorage — таб сознательно на текущей версии
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest --run src/lib/storage.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/storage.ts frontend/src/lib/storage.test.ts
git commit -m "refactor(frontend): centralize web-storage keys under ui.*"
```

---

### Task 2: Подсветка через NavLink, Sidebar без пропа active

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/Layout.tsx`
- Test: `frontend/src/components/Layout.test.tsx` (адаптация, новых тестов нет — поведение то же)

**Interfaces:**
- Consumes: react-router-dom `NavLink`, `useLocation`.
- Produces: `Sidebar` без пропов: `export default function Sidebar()`. `NavGroup({ group })` — тоже без пропов. `Layout` без изменений в интерфейсе (export default, children через `Outlet`).

- [ ] **Step 1: Адаптировать тесты**

В `Layout.test.tsx` тесты «renders the sidebar», «marks the active page», «hides Пользователи» остаются как есть — они проверяют DOM, а не реализацию. Ничего менять не нужно, но прогнать до рефакторинга: `cd frontend && npx vitest --run src/components/Layout.test.tsx` → PASS (базовая линия).

- [ ] **Step 2: Переписать Sidebar.tsx**

```tsx
import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { useMe } from "../api/queries";
import type { UserResponse } from "../api/types";
import { initialTheme, applyTheme } from "./theme";
import { CollapseIcon, MoonIcon, SunIcon } from "./icons";

const NAV_GROUPS = [
  { id: "topology", title: "Топология", links: [
    { id: "topology", href: "/ui/topology", label: "Схема" },
    { id: "devices", href: "/ui/devices", label: "Устройства" },
    { id: "networks", href: "/ui/networks", label: "Сети" },
    { id: "unions", href: "/ui/unions", label: "Объединения" },
    { id: "links", href: "/ui/links", label: "Связи" },
  ] },
  { id: "firewall", title: "Firewall", links: [
    { id: "subnets", href: "/ui/subnets", label: "Подсети" },
    { id: "sets", href: "/ui/sets", label: "Наборы" },
    { id: "rules", href: "/ui/rules", label: "Правила" },
    { id: "compile", href: "/ui/compile", label: "Компиляция" },
  ] },
  { id: "versions", title: "Версии", links: [
    { id: "drafts", href: "/ui/drafts", label: "Черновики" },
    { id: "history", href: "/ui/history", label: "История" },
  ] },
];

const STANDALONE = [
  { id: "search", href: "/ui/search", label: "Поиск" },
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика" },
  { id: "users", href: "/ui/users", label: "Пользователи", adminOnly: true },
];

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : undefined);

const setNavGroupOpen = (id: string, open: boolean) => {
  localStorage.setItem("firenet-nav-" + id, open ? "open" : "closed");
};
// (Task 3 заменит тело на storageKeys.navGroup: open → removeItem, closed → setItem)

export default function Sidebar() {
  const { data: me } = useMe();
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(localStorage.getItem("firenet-sidebar") === "collapsed");

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    // «open» — ровно как легаси (common.js): развёрнутое состояние пишется
    // этим значением, чтобы ключ firenet-sidebar остался 1:1.
    localStorage.setItem("firenet-sidebar", next ? "collapsed" : "open");
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} data-testid="sidebar">
      <button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-label="Свернуть меню">
        <CollapseIcon />
      </button>
      {NAV_GROUPS.map((group) => (
        <NavGroup key={group.id} group={group} />
      ))}
      <nav className="side-nav">
        {STANDALONE.filter((l) => !l.adminOnly || isAdmin(me)).map((link) => (
          <NavLink key={link.id} to={link.href} end className={navClass} data-testid={`nav-${link.id}`}>
            <span className="label">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="user-box">
        <span className="user-name">{me?.username ?? ""}</span>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
          aria-label="Сменить тему"
        >
          <span className="icon-sun"><SunIcon /></span>
          <span className="icon-moon"><MoonIcon /></span>
        </button>
        {/* Полная перезагрузка — осознанно: logout должен гарантированно
            сбросить всё состояние (react-query, модули, storage), navigate()
            этого не даёт. */}
        <button
          type="button"
          className="logout-btn"
          onClick={() => { void api.post("/api/logout").then(() => { window.location.href = "/login"; }); }}
        >
          Выйти
        </button>
      </div>
    </aside>
  );
}

function NavGroup({ group }: { group: (typeof NAV_GROUPS)[number] }) {
  const { pathname } = useLocation();
  const isActive = group.links.some((l) => pathname.startsWith(l.href));
  // Группы по умолчанию раскрыты — иначе в свежем браузере без localStorage
  // пользователь не видит ни одной ссылки (закрытой становится только та,
  // что явно свернули: «closed» в firenet-nav-<id>).
  const [open, setOpen] = useState(isActive || localStorage.getItem("firenet-nav-" + group.id) !== "closed");
  return (
    <div className={`nav-group${open ? "" : " closed"}`}>
      <button
        type="button"
        className="nav-group-header"
        onClick={() => { setNavGroupOpen(group.id, !open); setOpen(!open); }}
      >
        {group.title}
      </button>
      {open && (
        <nav className="side-nav nav-group-links">
          {group.links.map((link) => (
            <NavLink key={link.id} to={link.href} end className={navClass} data-testid={`nav-${link.id}`}>
              <span className="label">{link.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

const isAdmin = (me: UserResponse | undefined) => me?.role === "admin";
```

Примечания к правкам (внутри Task 2 ключи storage ещё старые — их меняет Task 3, import `storageKeys` добавится там):
- проп `active` и его сравнение по `id` заменены на `NavLink` c `end` + `className`-функцией;
- `NavGroup` определяет активность группы через `useLocation` (раскрыта, если активен любой из её путей);
- logout-кнопка получает комментарий «почему не navigate()»;
- `id="theme-toggle"` удалён.

- [ ] **Step 3: Упростить Layout.tsx**

```tsx
import { Outlet, useLocation } from "react-router-dom";
import { DraftProvider } from "../draft/DraftContext";
import BannerHost from "./BannerHost";
import DraftBanner from "./DraftBanner";
import ErrorBoundary from "./ErrorBoundary";
import Sidebar from "./Sidebar";

// Страницы users и search работают с данными вне драфта, поэтому баннер им не нужен.
const NO_DRAFT_BANNER = new Set(["users", "search"]);

function activeFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0] ?? "";
}

export default function Layout() {
  const active = activeFromPath(useLocation().pathname);
  return (
    <DraftProvider>
      <div className="app-shell">
        <Sidebar />
        <main>
          <BannerHost />
          {!NO_DRAFT_BANNER.has(active) && <DraftBanner />}
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </DraftProvider>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm run typecheck && npx vitest --run src/components/Layout.test.tsx`
Expected: typecheck OK, все тесты PASS (подсветка `.active` теперь от NavLink, проверки DOM не меняются).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/Layout.tsx
git commit -m "refactor(frontend): nav highlighting via NavLink instead of manual active prop"
```

---

### Task 3: Sidebar — ключи ui.*, aria-полировка, index.html

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/theme.ts`
- Modify: `frontend/index.html`
- Test: `frontend/src/components/Layout.test.tsx` (новые тесты collapse/theme/logout)

**Interfaces:**
- Consumes: `storageKeys.sidebar`, `storageKeys.navGroup`, `storageKeys.theme` из Task 1.
- Produces: ничего нового для других задач.

- [ ] **Step 1: Write the failing tests**

Добавить в `Layout.test.tsx` (импорты: `userEvent` из `@testing-library/user-event`; `beforeEach` уже стабит `matchMedia`). В существующий `afterEach` добавить `localStorage.clear()` рядом с `sessionStorage.clear()` — новые тесты пишут `ui.*` ключи в localStorage, без очистки будет утечка состояния между тестами:

```tsx
describe("Sidebar collapse and theme", () => {
  it("collapses via toggle, persists and toggles aria state", async () => {
    renderLayout();
    const btn = screen.getByRole("button", { name: "Свернуть меню" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("ui.sidebar")).toBe("collapsed");
    expect(document.querySelector(".sidebar")).toHaveClass("collapsed");
  });

  it("starts collapsed from stored state", () => {
    localStorage.setItem("ui.sidebar", "collapsed");
    renderLayout();
    expect(document.querySelector(".sidebar")).toHaveClass("collapsed");
    expect(screen.getByRole("button", { name: "Развернуть меню" })).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles theme, sets data-theme and persists", async () => {
    localStorage.setItem("ui.theme", "light");
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: "Сменить тему" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ui.theme")).toBe("dark");
  });

  it("logs out via full reload to /login", async () => {
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await vi.waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
```

Примечание: реализация пишет `window.location.href = "/login"` (не `assign`). В jsdom (vitest ≥ 2) запись в `href` работает с дефолтным `window.location`; если прогон покажет обратное — временно замокать через `vi.stubGlobal("location", { href: "" })`, но ассерт остаётся на `href`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest --run src/components/Layout.test.tsx`
Expected: FAIL — ключи пишутся старые (`firenet-sidebar`/`firenet-theme`), `aria-expanded` отсутствует.

- [ ] **Step 3: Обновить Sidebar.tsx (диффы поверх Task 2)**

```tsx
import { storageKeys } from "../lib/storage";
// ...
  const [collapsed, setCollapsed] = useState(localStorage.getItem(storageKeys.sidebar) === "collapsed");

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) localStorage.setItem(storageKeys.sidebar, "collapsed");
    else localStorage.removeItem(storageKeys.sidebar);
  };
// ...
      <button
        type="button"
        className="sidebar-toggle"
        onClick={toggleSidebar}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
      >
        <CollapseIcon />
      </button>
```

В `NavGroup`: `useState(isActive || localStorage.getItem(storageKeys.navGroup(group.id)) !== "closed")`; тело `setNavGroupOpen` заменить на:
```ts
const setNavGroupOpen = (id: string, open: boolean) => {
  if (open) localStorage.removeItem(storageKeys.navGroup(id));
  else localStorage.setItem(storageKeys.navGroup(id), "closed");
};
```
Комментарий про «1:1 с common.js» и про «open» удалить; семантика: absent = раскрыта, `"closed"` = свернута.

- [ ] **Step 4: Обновить theme.ts**

```ts
import { storageKeys } from "../lib/storage";

export function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem(storageKeys.theme);
  if (saved === "light" || saved === "dark") return saved;
  const mql = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
  return mql?.matches ? "dark" : "light";
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(storageKeys.theme, theme);
}
```

- [ ] **Step 5: Обновить index.html**

Inline-скрипт в `<head>` (защита от мигания темы до монтирования React):

```html
<script>
  try {
    var saved = localStorage.getItem("ui.theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
```

- [ ] **Step 6: Run tests**

Run: `cd frontend && npm run typecheck && npm test -- --run`
Expected: все PASS, включая новые 4.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/theme.ts frontend/index.html frontend/src/components/Layout.test.tsx
git commit -m "refactor(frontend): sidebar storage keys to ui.*, aria-expanded on collapse"
```

---

### Task 4: Переименование draft-ключей (фронт + e2e-хелпер)

**Files:**
- Modify: `frontend/src/draft/DraftContext.tsx:6-8` (константы ключей)
- Modify: `frontend/src/components/DraftBanner.tsx:57-58`
- Modify: `frontend/src/test/renderPage.tsx:23`
- Modify: `frontend/src/draft/DraftContext.test.tsx:39,48,52`
- Modify: `frontend/src/topology/useTopologyEditor.test.tsx:27,46,74`
- Modify: `frontend/src/components/Layout.test.tsx:68`
- Modify: `frontend/src/api/queries.test.tsx:33`
- Modify: `e2e/helpers/ui.js:15-16,24-25`

**Interfaces:**
- Consumes: `storageKeys.draftId`, `storageKeys.lastDraftId`, `storageKeys.draftReadonly` из Task 1.
- Produces: e2e-хелпер `openWithDraft`/`openTablePage` пишут новые ключи — контракт зафиксирован тестом из Task 1.

- [ ] **Step 1: Заменить ключи в DraftContext.tsx**

```tsx
import { storageKeys } from "../lib/storage";

// Активный драфт живёт в sessionStorage (у каждого таба свой), последний —
// в localStorage, чтобы новый таб продолжил в нём же. draftReadonly —
// «этот таб сознательно вернулся к текущей версии», иначе sessionStorage
// пуст и мы бы снова подхватили последний драфт.
```

Удалить три константы `DRAFT_ID_KEY`/`LAST_DRAFT_ID_KEY`/`READONLY_KEY`; все использования заменить на `storageKeys.draftId` / `storageKeys.lastDraftId` / `storageKeys.draftReadonly`. Комментарий «Ключи совпадают с common.js…» удалить.

- [ ] **Step 2: Заменить литералы в DraftBanner.tsx**

Строки 57–58:
```tsx
sessionStorage.setItem(storageKeys.draftId, draft.id);
localStorage.setItem(storageKeys.lastDraftId, draft.id);
```
(добавить `import { storageKeys } from "../lib/storage";`)

- [ ] **Step 3: Заменить литералы в тестах и renderPage.tsx**

Механическая замена во всех перечисленных файлах:
- `"firenet-draft-id"` → `storageKeys.draftId` (в .tsx) / `"ui.draft.id"` (в renderPage.tsx, если он не импортирует — импортировать `storageKeys` предпочтительнее);
- `"firenet-last-draft-id"` → `storageKeys.lastDraftId`;
- комментарий в `queries.test.tsx:29` («поэтому firenet-draft-id…») — перефразировать под `ui.draft.id`.

- [ ] **Step 4: Обновить e2e-хелпер ui.js**

```js
export async function openWithDraft(page, draftId, path) {
  await page.addInitScript((id) => {
    localStorage.setItem("ui.draft.lastId", id);
    sessionStorage.setItem("ui.draft.id", id);
  }, draftId);
  // ... остальное без изменений
}

export async function openTablePage(page, draftId, path) {
  await page.addInitScript((id) => {
    localStorage.setItem("ui.draft.lastId", id);
    sessionStorage.setItem("ui.draft.id", id);
  }, draftId);
  // ... остальное без изменений
}
```

- [ ] **Step 5: Run unit tests**

Run: `cd frontend && npm run typecheck && npm test -- --run`
Expected: все PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src frontend/src/test e2e/helpers/ui.js
git commit -m "refactor(frontend): rename draft storage keys to ui.*, update e2e helper"
```

---

### Task 5: Мёртвый CSS → удалить, user-box → токены, комментарии → актуализировать

**Files:**
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: ничего.
- Produces: без визуальных изменений (проверка глазами на dev-сервере не требуется — токены дают те же значения).

- [ ] **Step 1: Удалить мёртвые правила**

1. Строка 86: `[hidden], [x-cloak] { display: none !important; }` → `[hidden] { display: none !important; }` (`x-cloak` — атрибут Alpine.js, легаси).
2. Строки 121–130: убрать `.sidebar > strong` из группового селектора и правило `.sidebar > strong { font-size: … }`.
3. Строка 131: `.brand-short { … }` — удалить.
4. Строки 186–187: `.sidebar.collapsed .brand-full { … }` и `.sidebar.collapsed .brand-short { … }` — удалить.
5. Строки 154–155: `.nav-group-header .chevron svg { … }` и `.nav-group.closed .nav-group-header .chevron svg { … }` — удалить (`.chevron` не рендерится).
6. Строки 168–169: `nav.side-nav .icon { … }` и `nav.side-nav .icon svg { … }` — удалить (иконок в пунктах меню нет).
7. Комментарий-блок перед `.draft-banner` (строки 1213–1215) заменить на:
   ```css
   /* DraftBanner.tsx рендерит баннер первым элементом flex-колонки <main> —
      обычный поток, без fixed-позиционирования и компенсирующих паддингов. */
   ```

- [ ] **Step 2: Актуализировать легаси-комментарии**

1. Строки 88–89 (`#root`): заменить на
   ```css
   /* React монтируется в #root; без явного размера он сжимается по контенту
      и ломает flex-раскладку body. */
   ```
2. Строки 552–553 (`.submenu-left`, комментарий про `flipIfClipped в topology.js`): заменить на
   ```css
   /* Подменю контекстного меню при нехватке места справа открывается
      влево, чтобы не обрезаться overflow: hidden у .canvas-wrap. */
   ```
   (Сам блок `.submenu`/`.ctx-*` не трогать — вне скоупа, потенциально мёртвый; отмечено как отдельное расследование.)

- [ ] **Step 3: Перевести user-box/logout-btn на токены**

```css
.user-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border);
}
/* … .user-name без изменений … */
.sidebar.collapsed .user-box {
  flex-direction: column;
  padding: var(--space-2) 0;
}
.logout-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 2.1rem;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  font-size: 0.8rem;
  cursor: pointer;
}
```

- [ ] **Step 4: Удалить алиас --text**

1. Строка 6: `--text: var(--fg);` — удалить из `:root`.
2. Заменить все оставшиеся `var(--text)` → `var(--fg)` (проверенные места: строки 565, 1138, 1155, 1182, 1232, 1237 — точные номера сместятся после удалений, искать grep'ом).

Run: `grep -n "var(--text)\|--text:" frontend/src/styles.css` → пусто.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npm run typecheck && npm test -- --run`
Expected: PASS (CSS в jsdom не участвует, это регрессионная проверка).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/styles.css
git commit -m "refactor(frontend): drop dead legacy CSS, user-box on design tokens"
```

---

### Task 6: Финальная верификация

**Files:** без изменений (только проверки).

- [ ] **Step 1: Полный юнит-прогон**

Run: `cd frontend && npm run typecheck && npm test -- --run`
Expected: typecheck OK, все тест-файлы PASS.

- [ ] **Step 2: E2E (обязательно — Task 4 менял e2e-хелпер)**

Run: `make test-e2e`
Expected: все сценарии PASS. Если падают сценарии с драфтами — первым подозреваемым несоответствие ключей в `e2e/helpers/ui.js` и `storageKeys`.

- [ ] **Step 3: Go-сторона не тронута — контрольная проверка**

Run: `go build ./... && go vet ./...`
Expected: OK.

- [ ] **Step 4: Остаточный grep на легаси**

Run: `grep -rn "firenet-\|common\.js\|x-cloak\|brand-\|chevron" frontend/src frontend/index.html e2e/helpers`
Expected: только упоминания `firenet-*` в легитимных местах (e2e-контейнер `firenet-e2e-pg-*`, название приложения) — ни одного storage-ключа и ни одного «1:1 с common.js».
