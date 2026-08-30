# E2E-тесты пользовательских сценариев, волна 2 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. При написании каждого спека/хелпера ОБЯЗАТЕЛЬНО загружать скилл `keep-it-simple` (`.opencode/skills/SKILL.md`) — требование спеки.

**Goal:** Вторая волна Playwright E2E-сценариев: цикл черновиков/версий, права пользователей, формы создания на табличных страницах, редактор правил, таблица связей, компиляция, диагностика трафика и поведение канвас-редактора (drag, read-only, поиск).

**Architecture:** Инфраструктура волны 1 не меняется (`global-setup`/`global-teardown`/`playwright.config.js` как есть). Расширяются `e2e/helpers/api.js` и `e2e/helpers/ui.js`, добавляются 9 новых `*.spec.js`. Паттерн тот же: arrange via API → act via UI → assert через UI/API.

**Tech Stack:** Playwright Test (chromium), Node ESM, docker Postgres per-run, `bin/firenet`.

**Spec:** `docs/superpowers/specs/2026-08-30-e2e-user-scenarios-wave2-design.md`

## Global Constraints

- Приложение не зависит от node: правок в `go.mod`, `internal/`, `cmd/`, `Makefile`, `AGENTS.md` нет.
- Браузер — только chromium; все URL от `env().baseURL`.
- Креды admin: `e2e-admin` / `e2e-admin-password-1` (из `env().admin`). Не-admin пользователи создаются в каждом тесте с уникальным именем (суффикс) — username уникален глобально (auth.ErrUsernameTaken → 409).
- Разные пользователи в одном тесте → разные browser-контексты (`browser.newContext()`); cookie общая на контекст.
- Имена черновиков/объектов — с уникальным суффиксом (параллельные воркеры и retry): `const uid = () => \`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}\`;`
- Канвас-сценарии не двигают камеру (drag — исключение: он сам перемещает узел; камера по умолчанию {x:0,y:0,z:1} → мировые координаты = экранным).
- Подготовка (arrange) — через `helpers/api.js`; тестируемое — действия пользователя в UI.
- Ожидание сохранения — поллинг API (`expect.poll`/`waitTopology`), не классы UI-статусов.
- Сообщения/метки — как в UI (русские): «Открыть», «Изменения», «Удалить», «Подтвердить», «+ подсеть», «+ набор», «+ объединение», «+ правило», «Применить», «Сохранить», «Проверить», «Восстановить», «Скомпилировать», «Диагностировать», «Показать распространение», «Выйти».
- Keep-it-simple: один тест = одна пользовательская задача; arrange только из необходимых данных; никаких проверок «на всякий случай».
- После каждой задачи: `go build ./... && go vet ./... && gofmt -l .` — регрессий в Go-части быть не должно.

## Факты о приложении, на которые опираются тесты

(проверены в коде; при расхождении тест и приложение сверяются с источником)

- Drafts (`web/drafts.js`): форма `#create-draft-form` (input `name`), таблица `#drafts-table` (колонки имя/владелец/база/статус), в строке кнопки «Открыть» (redirect `/ui/topology` + setCurrentDraftID), «Изменения» (панель `#diff-panel`, `#diff-draft-name` = «— имя», строки kind/key/change, «добавлено»/«изменено»/«удалено»), «Удалить» (нативный confirm). `#confirm-btn` и `#all-toggle` (чекбокс `#all-checkbox`) видны только admin. Confirm: `POST /api/drafts/{id}/confirm` (RequireAdmin) → `{version:N}`, баннер «Черновик подтверждён как версия N», draft → статус merged (остаётся в списке). Merged draft остаётся в таблице со статусом «merged». У не-admin confirm API — 403. Баннер черновика на канвасе: `.draft-banner-editing`, текст `Черновик «имя» (статус).`.
- Users (`web/users.js`): admin — `#users-table` (строки: username, role, кнопка «Удалить» без confirm) + форма `#create-user-form` (inputs username/password[minlength=8], select role user|admin, submit «Создать»). Не-admin: `#access-denied` видна, таблица и форма скрыты (GET /api/users → 403). POST /api/users → 201 `{id,username,role}`; DELETE /api/users/{id} → 204.
- History (`web/history.js`): таблица `#history-table` (id, createdAt, confirmedBy, note), порядок новейшие первыми (`ORDER BY id DESC`); «Дифф» → `#diff-panel` (`#diff-version-label` «— версия N», diff против предыдущей версии); admin — «Восстановить» (confirm «Восстановить версию N? Будет создана новая версия.») → `POST /api/versions/{n}/restore` → баннер «Создана версия N», draft сбрасывается.
- Подсети (`web/subnets.js`): «+ подсеть» → dialog.modal (input `[placeholder="office-lan"]` имя, `[placeholder="10.0.0.0/24"]` CIDR, textarea `[placeholder="Заметка о подсети"]`), «Сохранить» disabled при пустых полях/дубле имени/пересечении CIDR (draftHint). Плохой формат CIDR клиентом не ловится → сервер отвечает ошибкой → баннер «Ошибка сохранения: …». Успех — баннер «Подсети сохранены».
- Сети (`web/networks.js`): кнопки «+ сеть» нет; строка → `.icon-btn.edit` → «Изменить сеть» (имя `[placeholder="office"]`, member-combo input `[placeholder="все подсети — начните вводить для поиска"]`, suggestions `.member-suggestion` `name (cidr)`), «Сохранить» → PUT topology.
- Наборы (`web/sets.js`): «+ набор» → модалка (имя `[placeholder="blocked"]`), member-combo как у сетей, адреса input `[placeholder="10.0.0.5 или 10.0.0.5/32 — Enter добавляет"]` (Enter → addAddress). Сохранить → PUT topology.
- Объединения (`web/unions.js`): «+ объединение» → модалка (имя `[placeholder="office"]`), «Сохранить»; удаление строки — `.icon-btn.delete` + confirm.
- Правила (`web/rules.js`): «+ цепочка» `.chain-tab-add` (создаёт цепочку и сразу открывает редактирование параметров); параметры: select в label «Действие по умолчанию:» (deny/allow/return), input в label «Цепочка:», кнопка «Применить» (PUT rules, баннер «Правила сохранены»); «+ правило» → модалка: имя `[placeholder="office-to-dmz"]`, Src/Dst `.modal-field` с combo input `[placeholder="имя, IP или CIDR — начните вводить"]` и `.member-suggestion` (эндпоинты: «any», имена подсетей и наборов; сети не предлагаются; при вводе IP/CIDR — literal «Добавить …»), select Action (allow/deny/return/jump), кнопка «Сохранить» (PUT rules; при ошибке — `modalError` внутри модалки, вход сохранён); draftHint требует имя, Src и Dst; удаление правила — `.icon-btn.delete` в строке + confirm; удаление цепочки — `.chain-tab-remove` (×, у не-первой вкладки) + confirm; «Проверить» → `.lint-panel` («Находки линтера (N)», при 0 — «Проблем не найдено»).
- Связи (`web/links.js`): строка — «Режим» (бейдж «фильтрованная» или hint «обычная»); кнопки: «Сделать фильтрованной» → filter `{aExports:[], bExports:[]}`; «Вернуть обычную» → filter удаляется (ключ исчезает → undefined). Сохранение — PUT topology.
- Compile (`web/compile.js`): `#compile-run` «Скомпилировать» → `#compile-output`: `section.compile-device` на каждое устройство с `h2` (имя), двумя `pre` (ipset/iptables) и ссылкой «Скачать <file>». Ошибка (422: правило, путь которого физически отсутствует, compiler.go:345) → баннер ошибки, output пуст.
- Diagnose (`web/diagnose.js`): инструменты `#diag-tool-path`/`#diag-tool-spread`; путь: форма `#diag-form` (`#diag-src`, `#diag-dst` — IP, `#diag-proto`, `#diag-dstports`), submit «Диагностировать»; `#diag-summary`: `<src-подсеть> → <dst-подсеть>: путей N` (+ note); при 0 путей — `p.diag-unreachable` «Недостижимо: путей между подсетями нет.»; при односторонней доступности — `p.diag-halpфath` «Доступность в одну сторону: …»; карточки путей `article.diag-path` с «Путь 1». Распространение: `#spread-form` (combo `#spread-src` — имя/CIDR/IP), submit «Показать распространение» → `#spread-summary` «Источник: X. Достижимо K из M подсетей.».
- Layout (`web/topology.js`): drag узла (mousedown на узле, move >3px, mouseup) → op `set-device-position`; работает только для узлов с позицией в layout (arrange ставит её op-ом); `GET /api/drafts/{id}/layout` возвращает LayoutDoc `{devices:{name:{x,y}}, networks:…, links:…}`. DEVICE_W=140, DEVICE_H=60 (центр узла = позиция + (70,30)).
- Read-only (`web/common.js`): без draft-id `apiPath()` → `/api/versions/current/…`; баннер `.draft-banner-readonly` «Только чтение — версия N.»; правка из read-only: `assertEditable()` бросает «Только чтение — откройте черновик, чтобы редактировать» → на странице баннер «Ошибка сохранения: Только чтение…».
- Sidebar: `.user-box` (`.user-name` «login · admin») и кнопка `.logout-btn` «Выйти» → `POST /api/logout` → redirect `/login`; после logout любой `/ui/…` редиректит на логин.
- Bootstrap: legacy-файлы в `e2e/.tmp` отсутствуют → стартовая версия 1 пустая; `GET /api/versions` → `[{id, createdAt, confirmedBy, note}]`.
- `PUT /api/drafts/{id}/subnets` отвергает плохой CIDR (validate.go: ParsePrefix).

## Файловая структура (итог волны 2)

```
e2e/
  scenarios/
    drafts.spec.js        # Task 1: сценарии 1–6
    users.spec.js         # Task 2: сценарии 7–10
    history.spec.js       # Task 3: сценарии 11–12
    table-create.spec.js  # Task 4: сценарии 13–17
    rules.spec.js         # Task 5: сценарии 18–21
    links-table.spec.js   # Task 6: сценарий 22
    compile.spec.js       # Task 7: сценарии 23–24
    diagnose.spec.js      # Task 8: сценарии 25–27
    canvas-editor.spec.js # Task 9: сценарии 28–30
  helpers/
    api.js                # расширения (Tasks 1, 3, 9)
    ui.js                 # расширения (Tasks 1, 9)
```

---

### Task 1: Хелперы мультипользователя + сценарии черновиков (1–6)

**Files:**
- Modify: `e2e/helpers/api.js` (login с кредами, registerUser, getVersions), `e2e/helpers/ui.js` (loginViaUI с кредами)
- Create: `e2e/scenarios/drafts.spec.js`

**Interfaces:**
- Consumes: `env()`, `createDraft`, `op` из api.js.
- Produces (для Tasks 2, 3, 8, 9):
  - `login(request, creds?)` — креды параметром, по умолчанию admin.
  - `registerUser(request, {username, password, role})` — POST /api/users (запрос должен быть admin-авторизован).
  - `getVersions(request) -> [{id, createdAt, confirmedBy?, note?}]`.
  - `loginViaUI(page, creds?)` — креды параметром, по умолчанию admin.

- [x] **Step 1: Написать спек (падает: хелперов нет)**

`e2e/scenarios/drafts.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { env, login, createDraft, op, registerUser, getVersions } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const userCreds = () => ({
  username: `e2e-user-${uid()}`,
  password: "e2e-user-password-1",
  role: "user",
});

test("создание черновика формой", async ({ page, request }) => {
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  const name = `df-form-${uid()}`;
  await page.locator("#create-draft-form input[name=name]").fill(name);
  await page.locator("#create-draft-form button[type=submit]").click();
  const row = page.locator("#drafts-table tbody tr", { hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(env().admin.username);
});

test("«Открыть» переключает черновик", async ({ page, request }) => {
  const name = `df-open-${uid()}`;
  await login(request);
  await createDraft(request, name);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Открыть" }).click();
  await page.waitForURL(/\/ui\/topology$/);
  await expect(page.locator(".draft-banner-editing")).toContainText(name);
});

test("«Изменения» показывает diff черновика", async ({ page, request }) => {
  const name = `df-diff-${uid()}`;
  await login(request);
  const id = await createDraft(request, name);
  await op(request, id, { kind: "create-device", device: { name: "df-r1", kind: "router" } });
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Изменения" }).click();
  const panel = page.locator("#diff-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("df-r1");
  await expect(panel).toContainText("добавлено");
});

test("удаление черновика", async ({ page, request }) => {
  const name = `df-del-${uid()}`;
  await login(request);
  await createDraft(request, name);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  page.on("dialog", (d) => d.accept());
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Удалить" }).click();
  await expect(page.locator("#drafts-table tbody tr", { hasText: name })).toHaveCount(0);
});

test("admin подтверждает черновик в новую версию", async ({ page, request }) => {
  const name = `df-confirm-${uid()}`;
  await login(request);
  const id = await createDraft(request, name);
  await op(request, id, { kind: "create-device", device: { name: "df-c-r1", kind: "router" } });
  const before = await getVersions(request);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/drafts");
  await page.locator("#drafts-table tbody tr", { hasText: name })
    .getByRole("button", { name: "Изменения" }).click();
  await expect(page.locator("#confirm-btn")).toBeVisible();
  await page.locator("#confirm-btn").click();
  await expect(page.locator("#error-banner")).toContainText(/Черновик подтверждён как версия \d+/);
  await expect.poll(async () => (await getVersions(request)).length)
    .toBe(before.length + 1);
});

test("не-admin: подтверждение недоступно", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page, creds);
  const id = await createDraft(page.request, `df-own-${uid()}`);
  await page.goto(env().baseURL + "/ui/drafts");
  await expect(page.locator("#all-toggle")).toBeHidden();
  await page.locator("#drafts-table tbody tr", { hasText: "df-own-" })
    .getByRole("button", { name: "Изменения" }).click();
  await expect(page.locator("#confirm-btn")).toBeHidden();
  const res = await page.request.post(`${env().baseURL}/api/drafts/${id}/confirm`, { data: {} });
  expect(res.status()).toBe(403);
});
```

Run: `cd e2e && npx playwright test scenarios/drafts.spec.js`
Expected: FAIL — `registerUser is not a function` / импорт не находится.

- [x] **Step 2: Реализовать хелперы**

`e2e/helpers/api.js` — заменить `login` и добавить:

```js
export async function login(request, creds) {
  const c = creds || env().admin;
  await ensureOk(await request.post(base() + "/api/login", { data: c }), "login");
}

export async function registerUser(request, { username, password, role }) {
  await ensureOk(
    await request.post(base() + "/api/users", { data: { username, password, role } }),
    "registerUser");
}

export const getVersions = (request) => get(request, "/api/versions");
```

`e2e/helpers/ui.js` — заменить `loginViaUI`:

```js
export async function loginViaUI(page, creds) {
  const c = creds || env().admin;
  await page.goto(env().baseURL + "/login");
  await page.locator("#login-form input[name=username]").fill(c.username);
  await page.locator("#login-form input[name=password]").fill(c.password);
  await page.locator("#login-form button[type=submit]").click();
  await page.waitForURL(/\/ui\/topology$/);
}
```

- [x] **Step 3: Прогон**

Run: `cd e2e && npx playwright test scenarios/drafts.spec.js`
Expected: PASS 6.

- [x] **Step 4: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 5: Commit**

```bash
git add e2e/helpers/api.js e2e/helpers/ui.js e2e/scenarios/drafts.spec.js
git commit -m "test(e2e): draft lifecycle scenarios with multi-user helpers"
```

---

### Task 2: Пользователи и logout (сценарии 7–10)

**Files:**
- Create: `e2e/scenarios/users.spec.js`

**Interfaces:**
- Consumes: `login(creds)`, `registerUser`, `loginViaUI(creds)` из Task 1.
- Produces: ничего.

- [x] **Step 1: Написать спек (падать не должен — хелперы есть; но сценарий 9 требует registerUser, всё уже есть)**

`e2e/scenarios/users.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { env, login, registerUser } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const userCreds = () => ({
  username: `e2e-u-${uid()}`,
  password: "e2e-user-password-1",
  role: "user",
});

test("admin создаёт пользователя формой", async ({ page }) => {
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/users");
  await expect(page.locator("#users-table")).toBeVisible();
  const username = `e2e-form-${uid()}`;
  await page.locator("#create-user-form input[name=username]").fill(username);
  await page.locator("#create-user-form input[name=password]").fill("e2e-form-pass-1");
  await page.locator("#create-user-form select[name=role]").selectOption("user");
  await page.locator("#create-user-form button[type=submit]").click();
  await expect(page.locator("#users-table tbody tr", { hasText: username })).toBeVisible();
  await expect(page.locator("#users-table tbody tr", { hasText: username })).toContainText("user");
});

test("admin удаляет пользователя", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/users");
  const row = page.locator("#users-table tbody tr", { hasText: creds.username });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Удалить" }).click();
  await expect(row).toHaveCount(0);
});

test("не-admin видит отказ доступа", async ({ page, request }) => {
  const creds = userCreds();
  await login(request);
  await registerUser(request, creds);
  await loginViaUI(page, creds);
  await page.goto(env().baseURL + "/ui/users");
  await expect(page.locator("#access-denied")).toBeVisible();
  await expect(page.locator("#users-table")).toBeHidden();
  await expect(page.locator("#create-user-form")).toBeHidden();
});

test("logout возвращает на страницу логина", async ({ page }) => {
  await loginViaUI(page);
  await page.locator(".logout-btn").click();
  await page.waitForURL(/\/login/);
  await page.goto(env().baseURL + "/ui/topology");
  await page.waitForURL(/\/login/);
});
```

- [x] **Step 2: Прогон**

Run: `cd e2e && npx playwright test scenarios/users.spec.js`
Expected: PASS 4. Если «logout» падает на последнем `waitForURL` — проверить редирект логина в `internal/httpapi/auth_handlers.go` (код 302 против UI-редиректа) и поправить селектор ожидания, не смысл.

- [x] **Step 3: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 4: Commit**

```bash
git add e2e/scenarios/users.spec.js
git commit -m "test(e2e): users page and logout scenarios"
```

---

### Task 3: История версий (сценарии 11–12)

**Files:**
- Modify: `e2e/helpers/api.js` (confirmDraft, getCurrentTopology)
- Create: `e2e/scenarios/history.spec.js`

**Interfaces:**
- Consumes: `login`, `createDraft`, `op` (Tasks 1–2).
- Produces (для Task 9):
  - `confirmDraft(request, draftId) -> {version:number}`.
  - `getCurrentTopology(request) -> {topology:{devices,links,networks,sets,unions}}` — текущая подтверждённая версия.

- [x] **Step 1: Написать спек (падает: хелперов нет)**

`e2e/scenarios/history.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { login, createDraft, op, confirmDraft, getCurrentTopology } from "../helpers/api.js";
import { loginViaUI } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test("diff новой версии против предыдущей", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `hs-diff-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "hs-r1", kind: "router" } });
  await confirmDraft(request, id); // версия 2 с устройством
  await loginViaUI(page);
  await page.goto(env0 + "/ui/history");
  const row = page.locator("#history-table tbody tr").first(); // новейшая — версия 2
  await expect(row).toContainText("e2e-admin");
  await row.getByRole("button", { name: "Дифф" }).click();
  const panel = page.locator("#diff-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("hs-r1");
  await expect(panel).toContainText("добавлено");
});

test("восстановление пустой версии опустошает текущую", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `hs-restore-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "hs-r2", kind: "router" } });
  await confirmDraft(request, id); // версия 2 с устройством
  await loginViaUI(page);
  await page.goto(env().baseURL + "/ui/history");
  page.on("dialog", (d) => d.accept());
  // версия 1 (пустая bootstrap) — последняя строка
  await page.locator("#history-table tbody tr").last()
    .getByRole("button", { name: "Восстановить" }).click();
  await expect(page.locator("#error-banner")).toContainText(/Создана версия \d+/);
  const doc = await getCurrentTopology(request);
  expect(doc.topology.devices).toEqual([]);
});
```

Первая строка спека использует `env0` опечаткой — заменить на `env().baseURL` при написании (в итоговом файле `const { baseURL } = env();` в начале файла, а в тестах `baseURL + "/ui/history"`).

- [x] **Step 2: Реализовать хелперы**

`e2e/helpers/api.js` — добавить:

```js
export async function confirmDraft(request, id) {
  const res = await ensureOk(
    await request.post(`${base()}/api/drafts/${id}/confirm`, { data: {} }),
    "confirmDraft");
  return res.json(); // {version}
}

export const getCurrentTopology = (request) =>
  get(request, "/api/versions/current/topology").then((doc) => (doc.topology ? doc : { topology: doc }));
```

- [x] **Step 3: Прогон**

Run: `cd e2e && npx playwright test scenarios/history.spec.js`
Expected: PASS 2. Если diff версии 2 не содержит устройства — сверить `pgstore.DiffVersions` (diff ведётся против предыдущей версии) и поправить ожидания, не смысл.

- [x] **Step 4: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 5: Commit**

```bash
git add e2e/helpers/api.js e2e/scenarios/history.spec.js
git commit -m "test(e2e): version history diff and restore scenarios"
```

---

### Task 4: Формы создания на табличных страницах (сценарии 13–17)

**Files:**
- Create: `e2e/scenarios/table-create.spec.js`

**Interfaces:**
- Consumes: `login, createDraft, op, getSubnets, getTopology, putSubnets` (Tasks 1–3).
- Produces: ничего.

- [x] **Step 1: Написать спек**

`e2e/scenarios/table-create.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { login, createDraft, op, getSubnets, getTopology, putSubnets } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

test("создание подсети формой", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-sub");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await expect(dialog).toBeVisible();
  const name = `tcf-${uid()}`;
  await dialog.locator('[placeholder="office-lan"]').fill(name);
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill("10.31.0.0/24");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("#error-banner")).toContainText("Подсети сохранены");
  await expect.poll(async () => (await getSubnets(request, id)).subnets.map((s) => s.name))
    .toContain(name);
});

test("сервер отвергает подсеть с плохим CIDR", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-bad");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/subnets");
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill("tcf-bad-sub");
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill("10.0.0");
  // draftHint не ловит формат — кнопка активна; сервер отвечает ошибкой
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("#error-banner")).toContainText("Ошибка сохранения");
  await expect.poll(async () => (await getSubnets(request, id)).subnets.map((s) => s.name))
    .not.toContain("tcf-bad-sub");
});

test("добавление подсети-члена в сеть через модалку", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-net");
  await putSubnets(request, id, [{ name: "tcf-sub", cidr: "10.32.0.0/24" }]);
  await op(request, id, { kind: "create-network", network: { name: "tcf-net", subnets: [], attach: [] } });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/networks");
  const row = page.locator("tbody tr", { hasText: "tcf-net" });
  await row.locator(".icon-btn.edit").click();
  const dialog = page.locator("dialog.modal");
  const combo = dialog.locator('[placeholder="все подсети — начните вводить для поиска"]');
  await combo.fill("tcf-sub");
  await dialog.locator(".member-suggestion", { hasText: "tcf-sub" }).click();
  await expect(dialog.locator(".member-row", { hasText: "tcf-sub" })).toBeVisible();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const doc = await getTopology(request, id);
    return doc.topology.networks.find((n) => n.name === "tcf-net")?.subnets;
  }, { timeout: 5_000 }).toContain("tcf-sub");
});

test("создание набора с подсетью и адресом", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-set");
  await putSubnets(request, id, [{ name: "tcf-s-sub", cidr: "10.33.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/sets");
  await page.getByRole("button", { name: "+ набор" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="blocked"]').fill(`tcf-set-${uid()}`);
  const combo = dialog.locator('[placeholder="все подсети — начните вводить для поиска"]');
  await combo.fill("tcf-s-sub");
  await dialog.locator(".member-suggestion", { hasText: "tcf-s-sub" }).click();
  const addr = dialog.locator('[placeholder="10.0.0.5 или 10.0.0.5/32 — Enter добавляет"]');
  await addr.fill("10.33.1.7/32");
  await addr.press("Enter");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const doc = await getTopology(request, id);
    return doc.topology.sets.find((s) => s.name.startsWith("tcf-set-"));
  }, { timeout: 5_000 }).toMatchObject({ subnets: ["tcf-s-sub"], addresses: ["10.33.1.7/32"] });
});

test("создание и удаление объединения", async ({ page, request }) => {
  const id = await freshDraft(request, "tcf-union");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/unions");
  await page.getByRole("button", { name: "+ объединение" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office"]').fill("tcf-union");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await getTopology(request, id)).topology.unions.map((u) => u.name))
    .toContain("tcf-union");
  page.on("dialog", (d) => d.accept());
  await page.locator("tbody tr", { hasText: "tcf-union" }).locator(".icon-btn.delete").click();
  await expect.poll(async () => (await getTopology(request, id)).topology.unions, { timeout: 5_000 })
    .toHaveLength(0);
});
```

- [x] **Step 2: Прогон**

Run: `cd e2e && npx playwright test scenarios/table-create.spec.js`
Expected: PASS 5. Если «плохой CIDR» падает из-за того, что клиентский draftHint всё же блокирует кнопку — сверить `ipv4CidrOverlap` в `common.js` и заменить негатив на пересечение CIDR с существующей подсетью (arrange: `putSubnets` c "10.31.0.0/24", ввод "10.31.1.0/24") с assert'ом на текст draftHint в модалке; не менять суть проверки.

- [x] **Step 3: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 4: Commit**

```bash
git add e2e/scenarios/table-create.spec.js
git commit -m "test(e2e): create subnet, network member, set, union via table forms"
```

---

### Task 5: Редактор правил (сценарии 18–21)

**Files:**
- Create: `e2e/scenarios/rules.spec.js`

**Interfaces:**
- Consumes: `login, createDraft, getRules, putRules, putSubnets` (Tasks 1–3).
- Produces: ничего.

- [x] **Step 1: Написать спек**

`e2e/scenarios/rules.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { login, createDraft, getRules, putRules, putSubnets } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

test("создание цепочки и её параметры", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-chain");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.locator(".chain-tab-add").click(); // addChain сразу открывает параметры
  await page.locator(".rules-settings-group label", { hasText: "Действие" })
    .locator("select").selectOption("allow");
  await page.locator(".rules-settings-group input").fill("rc-chain");
  await page.getByRole("button", { name: "Применить" }).click();
  await expect.poll(async () => (await getRules(request, id)).chains).toContainEqual(
    expect.objectContaining({ name: "rc-chain", defaultAction: "allow", rules: [] }),
  );
});

test("создание правила с эндпоинтами", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-rule");
  await putSubnets(request, id, [{ name: "rr-sub", cidr: "10.34.0.0/24" }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.getByRole("button", { name: "+ правило" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-to-dmz"]').fill("rr-allow");
  const srcField = dialog.locator(".modal-field", { hasText: "Src" }).first();
  await srcField.locator('[placeholder="имя, IP или CIDR — начните вводить"]').fill("rr-sub");
  await srcField.locator(".member-suggestion", { hasText: "rr-sub" }).click();
  const dstField = dialog.locator(".modal-field", { hasText: "Dst" }).first();
  await dstField.locator('[placeholder="имя, IP или CIDR — начните вводить"]').click();
  await dstField.locator(".member-suggestion", { hasText: /^any$/ }).click();
  await dialog.locator("label", { hasText: "Action" }).locator("select").selectOption("allow");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  const allRules = (await getRules(request, id)).chains.flatMap((c) => c.rules);
  expect(allRules).toContainEqual(expect.objectContaining({
    name: "rr-allow", src: ["rr-sub"], dst: ["any"], action: "allow",
  }));
});

test("удаление правила и цепочки", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-del");
  await putRules(request, id, [
    {
      name: "main", defaultAction: "deny",
      rules: [{ name: "rd-keep", src: ["any"], dst: ["any"], proto: "any", action: "deny" }],
    },
    {
      name: "rd-chain", defaultAction: "deny",
      rules: [{ name: "rd-drop", src: ["any"], dst: ["any"], proto: "any", action: "deny" }],
    },
  ]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  page.on("dialog", (d) => d.accept());
  await page.locator("tbody tr", { hasText: "rd-keep" }).locator(".icon-btn.delete").click();
  await expect.poll(async () => (await getRules(request, id)).chains.flatMap((c) => c.rules.map((r) => r.name)))
    .not.toContain("rd-keep");
  await page.locator(".chain-tab", { hasText: "rd-chain" }).locator(".chain-tab-remove").click();
  await expect.poll(async () => (await getRules(request, id)).chains.map((c) => c.name))
    .not.toContain("rd-chain");
});

test("«Проверить» на корректных правилах — находок нет", async ({ page, request }) => {
  const id = await freshDraft(request, "rl-lint");
  await putRules(request, id, [{ name: "main", defaultAction: "deny", rules: [] }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/rules");
  await page.getByRole("button", { name: "Проверить" }).click();
  const panel = page.locator(".lint-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Находки линтера (0)");
  await expect(panel).toContainText("Проблем не найдено");
});
```

- [x] **Step 2: Прогон**

Run: `cd e2e && npx playwright test scenarios/rules.spec.js`
Expected: PASS 4. Если первый chain после bootstrap не называется «main» — в тестах «правило» и «удаление» используется `flatMap`, имя цепочки не предполагается; в тесте «цепочка» имя не может конфликтовать (уникально? проверяется только содержимое). Если lint даёт находки на пустых правилах — сверить `internal/app/lint.go` и поправить arrange (не assert).

- [x] **Step 3: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 4: Commit**

```bash
git add e2e/scenarios/rules.spec.js
git commit -m "test(e2e): rules editor - chain, rule with endpoints, delete, lint"
```

---

### Task 6: Таблица связей (сценарий 22)

**Files:**
- Create: `e2e/scenarios/links-table.spec.js`

**Interfaces:**
- Consumes: `login, createDraft, op, getTopology` (Tasks 1–3).
- Produces: ничего.

- [x] **Step 1: Написать спек**

`e2e/scenarios/links-table.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { login, createDraft, op, getTopology } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

test("переключение фильтра связи из таблицы связей", async ({ page, request }) => {
  const id = await freshDraft(request, "lt-filter");
  await op(request, id, { kind: "create-device", device: { name: "lta-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "lta-r2", kind: "router" } });
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: "lta-r1" }, b: { device: "lta-r2" } },
  });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/links");
  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("обычная");
  await row.getByRole("button", { name: "Сделать фильтрованной" }).click();
  await expect.poll(async () => (await getTopology(request, id)).topology.links[0].filter)
    .toEqual({ aExports: [], bExports: [] });
  await row.getByRole("button", { name: "Вернуть обычную" }).click();
  await expect.poll(async () => (await getTopology(request, id)).topology.links[0].filter)
    .toBeNull();
});
```

- [x] **Step 2: Прогон**

Run: `cd e2e && npx playwright test scenarios/links-table.spec.js`
Expected: PASS 1.

- [x] **Step 3: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 4: Commit**

```bash
git add e2e/scenarios/links-table.spec.js
git commit -m "test(e2e): toggle link filter from links table"
```

---

### Task 7: Компиляция (сценарии 23–24)

**Files:**
- Create: `e2e/scenarios/compile.spec.js`

**Interfaces:**
- Consumes: `login, createDraft, op, putRules, putSubnets` (Tasks 1–3).
- Produces: ничего.

- [x] **Step 1: Написать спек**

`e2e/scenarios/compile.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { login, createDraft, op, putRules, putSubnets } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

async function arrangeLinkedDevices(request, id, prefix) {
  await op(request, id, { kind: "create-device", device: { name: `${prefix}-r1`, kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: `${prefix}-r2`, kind: "router" } });
  await op(request, id, {
    kind: "create-link",
    link: { a: { device: `${prefix}-r1` }, b: { device: `${prefix}-r2` } },
  });
}

test("компиляция выдаёт скрипты по устройствам", async ({ page, request }) => {
  const id = await freshDraft(request, "cp-ok");
  await arrangeLinkedDevices(request, id, "cp");
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/compile");
  await page.locator("#compile-run").click();
  const out = page.locator("#compile-output");
  await expect(out.locator("section.compile-device")).toHaveCount(2);
  await expect(out.locator("h2").first()).toHaveText("cp-r1");
  await expect(out.locator("pre").first()).toBeVisible();
  await expect(out.locator("a").first()).toContainText("Скачать");
});

test("компиляция с недостижимым правилом показывает баннер", async ({ page, request }) => {
  const id = await freshDraft(request, "cp-bad");
  await putSubnets(request, id, [
    { name: "cpb-a", cidr: "10.40.0.0/24" },
    { name: "cpb-b", cidr: "10.41.0.0/24" },
  ]);
  // два устройства без связи: физического пути a→b нет
  await op(request, id, { kind: "create-device", device: { name: "cpb-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "cpb-r2", kind: "router" } });
  await putRules(request, id, [{
    name: "main", defaultAction: "deny",
    rules: [{ name: "cpb-allow", src: ["cpb-a"], dst: ["cpb-b"], proto: "any", action: "allow" }],
  }]);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/compile");
  await page.locator("#compile-run").click();
  await expect(page.locator("#error-banner")).toBeVisible();
  await expect(page.locator("#compile-output")).not.toContainText("cpb-r1");
});
```

- [x] **Step 2: Прогон**

Run: `cd e2e && npx playwright test scenarios/compile.spec.js`
Expected: PASS 2. Если первый тест падает на `toHaveCount(2)` — сверить `compiler.Compile` (какие устройства попадают в вывод: все или «managed»), поправить arrange/assert по факту, не суть.

- [x] **Step 3: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 4: Commit**

```bash
git add e2e/scenarios/compile.spec.js
git commit -m "test(e2e): compile output and compile error scenarios"
```

---

### Task 8: Диагностика трафика (сценарии 25–27)

**Files:**
- Create: `e2e/scenarios/diagnose.spec.js`

**Interfaces:**
- Consumes: `login, createDraft, op, putRules, putSubnets` (Tasks 1–3).
- Produces: ничего.

Arrange общий: две подсети с хостами, две сети, привязанные к устройствам, связь, allow-правило (варианты: с mirror / без mirror / без связи).

- [x] **Step 1: Написать спек**

`e2e/scenarios/diagnose.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { login, createDraft, op, putRules, putSubnets } from "../helpers/api.js";
import { loginViaUI, openTablePage } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function freshDraft(request, name) {
  await login(request);
  return createDraft(request, `${name}-${uid()}`);
}

async function arrangeTwoSites(request, id, { linked = true, mirror = true } = {}) {
  const a = `dg-a-${uid()}`, b = `dg-b-${uid()}`;
  await putSubnets(request, id, [
    { name: a, cidr: "10.50.0.0/24" },
    { name: b, cidr: "10.51.0.0/24" },
  ]);
  await op(request, id, { kind: "create-device", device: { name: "dg-r1", kind: "router" } });
  await op(request, id, { kind: "create-device", device: { name: "dg-r2", kind: "router" } });
  await op(request, id, { kind: "create-network", network: { name: `${a}-net`, subnets: [a], attach: [{ device: "dg-r1" }] } });
  await op(request, id, { kind: "create-network", network: { name: `${b}-net`, subnets: [b], attach: [{ device: "dg-r2" }] } });
  if (linked) {
    await op(request, id, {
      kind: "create-link",
      link: { a: { device: "dg-r1" }, b: { device: "dg-r2" } },
    });
  }
  await putRules(request, id, [{
    name: "main", defaultAction: "deny",
    rules: [{ name: "dg-allow", src: [a], dst: [b], proto: "any", action: "allow", mirror }],
  }]);
  return { a, b };
}

test("путь найден между двумя подсетями", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-found");
  const { a, b } = await arrangeTwoSites(request, id);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  await page.locator("#diag-tool-path").click();
  await expect(page.locator("#diag-panel")).toBeVisible();
  await page.locator("#diag-src").fill("10.50.0.7");
  await page.locator("#diag-dst").fill("10.51.0.7");
  await page.getByRole("button", { name: "Диагностировать" }).click();
  const summary = page.locator("#diag-summary");
  await expect(summary).toContainText(new RegExp(`${a} → ${b}: путей 1`));
  await expect(page.locator("#diag-paths")).toContainText("Путь 1");
});

test("путь не найден без связи", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-none");
  const { a, b } = await arrangeTwoSites(request, id, { linked: false });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  await page.locator("#diag-tool-path").click();
  await page.locator("#diag-src").fill("10.50.0.7");
  await page.locator("#diag-dst").fill("10.51.0.7");
  await page.getByRole("button", { name: "Диагностировать" }).click();
  await expect(page.locator("#diag-summary")).toContainText(": путей 0");
  await expect(page.locator(".diag-unreachable")).toContainText("Недостижимо: путей между подсетями нет.");
});

test("односторонняя доступность без mirror", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-half");
  await arrangeTwoSites(request, id, { mirror: false });
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  await page.locator("#diag-tool-path").click();
  await page.locator("#diag-src").fill("10.50.0.7");
  await page.locator("#diag-dst").fill("10.51.0.7");
  await page.getByRole("button", { name: "Диагностировать" }).click();
  await expect(page.locator(".diag-halfpath")).toContainText("Доступность в одну сторону");
});

test("распространение сети", async ({ page, request }) => {
  const id = await freshDraft(request, "dg-spread");
  await arrangeTwoSites(request, id);
  await loginViaUI(page);
  await openTablePage(page, id, "/ui/diagnose");
  await page.locator("#diag-tool-spread").click();
  await expect(page.locator("#spread-panel")).toBeVisible();
  await page.locator("#spread-src").fill("10.50.0.7");
  await page.getByRole("button", { name: "Показать распространение" }).click();
  await expect(page.locator("#spread-summary")).toContainText(/Достижимо \d+ из \d+ подсетей/);
});
```

Замечание: в `arrangeTwoSites` имена сетей содержат суффикс uid — report.srcSubnet/dstSubnet это имена подсетей (имена в report — имена подсетей, см. `diagnose.js:487`).

- [x] **Step 2: Прогон**

Run: `cd e2e && npx playwright test scenarios/diagnose.spec.js`
Expected: PASS 4. Числа в «распространении» (ожидается 1 из 2: вторая подсеть достижима через связь, источник сам не считается) сверить по факту; правка — в ожидаемом regex, не в сути.

- [x] **Step 3: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 4: Commit**

```bash
git add e2e/scenarios/diagnose.spec.js
git commit -m "test(e2e): traffic diagnose - path found, unreachable, half-path, spread"
```

---

### Task 9: Канвас-редактор: drag, read-only, поиск (сценарии 28–30)

**Files:**
- Modify: `e2e/helpers/api.js` (getLayout), `e2e/helpers/ui.js` (dragNode, openCurrentVersion)
- Create: `e2e/scenarios/canvas-editor.spec.js`

**Interfaces:**
- Consumes: `login, createDraft, op, confirmDraft` (Tasks 1–3), `waitTopology` (волна 1).
- Produces: ничего (листовые сценарии).

- [x] **Step 1: Написать спек (падает: хелперов нет)**

`e2e/scenarios/canvas-editor.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { env, login, createDraft, op, confirmDraft, getLayout } from "../helpers/api.js";
import { loginViaUI, openWithDraft, openCurrentVersion, dragNode } from "../helpers/ui.js";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test("перетаскивание узла сохраняет позицию", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-drag-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "cd-r1", kind: "router" } });
  await op(request, id, { kind: "set-device-position", deviceName: "cd-r1", position: { x: 400, y: 300 } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  // центр узла: позиция (400,300) + (DEVICE_W/2=70, DEVICE_H/2=30)
  await dragNode(page, { x: 470, y: 330 }, { x: 570, y: 430 });
  await expect.poll(async () => (await getLayout(request, id)).devices["cd-r1"], { timeout: 5_000 })
    .toEqual({ x: 500, y: 400 });
  // после перезагрузки узел на новом месте: клик по центру выделяет
  await page.reload();
  await page.locator("#topo-canvas").click({ position: { x: 570, y: 430 } });
  await expect(page.locator("#topo-delete")).toBeEnabled();
});

test("текущая версия открыта только для чтения", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-ro-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "ce-ro-r1", kind: "router" } });
  await confirmDraft(request, id);
  await loginViaUI(page);
  await openCurrentVersion(page, "/ui/subnets");
  await expect(page.locator(".draft-banner-readonly")).toContainText(/Только чтение — версия \d+/);
  // правка из read-only: сервер/клиент отклоняют, пользователь видит баннер
  await page.getByRole("button", { name: "+ подсеть" }).click();
  const dialog = page.locator("dialog.modal");
  await dialog.locator('[placeholder="office-lan"]').fill("ce-ro-sub");
  await dialog.locator('[placeholder="10.0.0.0/24"]').fill("10.60.0.0/24");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.locator("#error-banner")).toContainText("Только чтение");
});

test("поиск на канвасе выделяет узел", async ({ page, request }) => {
  await login(request);
  const id = await createDraft(request, `ce-search-${uid()}`);
  await op(request, id, { kind: "create-device", device: { name: "ce-s-r1", kind: "router" } });
  await loginViaUI(page);
  await openWithDraft(page, id, "/ui/topology");
  await page.locator("#topo-search-toggle").click();
  await page.locator("#topo-search").fill("ce-s-r1");
  await page.keyboard.press("Enter");
  await expect(page.locator("#topo-delete")).toBeEnabled();
});
```

(В третьем тесте импорт `env` может не понадобиться — убрать неиспользуемый импорт при написании, keep-it-simple.)

- [x] **Step 2: Реализовать хелперы**

`e2e/helpers/api.js` — добавить:

```js
export const getLayout = (request, id) => get(request, `/api/drafts/${id}/layout`);
```

`e2e/helpers/ui.js` — добавить:

```js
export async function openCurrentVersion(page, path) {
  await page.goto(env().baseURL + path);
}

// drag по канвасу: from/to — экранные координаты относительно канваса
// (мировые = экранным при камере по умолчанию).
export async function dragNode(page, from, to) {
  const box = await page.locator("#topo-canvas").boundingBox();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}
```

- [x] **Step 3: Прогон**

Run: `cd e2e && npx playwright test scenarios/canvas-editor.spec.js`
Expected: PASS 3. Если drag не двигает узел — убедиться с `--headed`, что mousedown попал в узел (центр 470,330 при позиции 400,300 и камере {0,0,1}); если read-only баннер не появляется — сверить `renderDraftBanner` (`.draft-banner-readonly`), поправить селектор, не суть.

- [x] **Step 4: Go-проверки не задеты**

Run: `go build ./... && go vet ./... && gofmt -l .`
Expected: пусто.

- [x] **Step 5: Commit**

```bash
git add e2e/helpers/api.js e2e/helpers/ui.js e2e/scenarios/canvas-editor.spec.js
git commit -m "test(e2e): canvas editor - node drag layout, read-only version, search"
```

---

### Task 10: Финализация — полный прогон и отметка в плане

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-e2e-user-scenarios-wave2.md` (checkboxes)

- [x] **Step 1: Полный прогон**

Run: `make test-e2e`
Expected: все спеки PASS (wave-1 + wave-2, fixme волны 1 пропущен); teardown чистит контейнер (`docker ps | grep firenet-e2e` пуст).

- [x] **Step 2: Полная верификация**

Run: `go build ./... && go vet ./... && gofmt -l . && go test ./... && node --test 'internal/httpapi/web/*.test.js' && make test-e2e`
Expected: всё зелёное.

- [x] **Step 3: Отметить выполнение в плане**

Все `- [ ]` этого плана → `- [x]`; commit:

```bash
git add docs/superpowers/plans/2026-08-30-e2e-user-scenarios-wave2.md
git commit -m "docs(plan): mark e2e wave 2 tasks complete"
```

---

## Само-ревью плана

- **Покрытие спеки:** сценарии 1–30 спеки → Tasks 1–9 (1–6: Task 1; 7–10: Task 2; 11–12: Task 3; 13–17: Task 4; 18–21: Task 5; 22: Task 6; 23–24: Task 7; 25–27: Task 8; 28–30: Task 9). Расширения хелперов из спеки: login(creds)/registerUser/getVersions — Task 1; confirmDraft/getCurrentTopology — Task 3; getLayout/dragNode/openCurrentVersion — Task 9. Компромиссы спеки (lint без негативных находок, без проверки содержимого download, состав объединений вне рамок) отражены.
- **Placeholders:** нет TBD/«похоже на Task N»; каждый шаг содержит код или точную команду.
- **Имена/типы:** `login(request, creds?)`, `registerUser(request, creds)`, `getVersions(request)`, `confirmDraft(request, id)`, `getCurrentTopology(request)`, `getLayout(request, id)`, `loginViaUI(page, creds?)`, `openCurrentVersion(page, path)`, `dragNode(page, from, to)` — согласованы между задачами.
