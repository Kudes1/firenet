# Разделение firenet на frontend и backend

Дата: 2026-09-07
Статус: утверждён

## Цель

Явно разнести приложение на два независимых рантайма: Go-бэкенд, который
отдаёт только JSON API, и отдельное React-приложение. Текущий самописный
Canvas2D-редактор топологии заменяется на React Flow.

## Текущее состояние

- Бэкенд: Go, `internal/httpapi` (~5.2k строк) — ~45 JSON-роутов `/api/*`,
  рендер 15 HTML-страниц на `html/template`, раздача `web/` из `go:embed`.
  Cookie-сессии `firenet_session` (httpOnly, SameSite=Lax), ETag+gzip,
  CAS через `X-Draft-Revision`.
- Фронтенд: 15 серверных страниц + ванильные ES-модули с Alpine.js
  (6820 строк кода, 9106 строк тестов на node:test), свой CSS (1236 строк).
  Канва топологии самописная: `camera.js`, `camera_input.js`,
  `canvas_view.js`, `hit_test.js`, `minimap.js`, `topo_scene.js`;
  `topology.js` — 1598 строк.
- Инфраструктура: один distroless-контейнер, `docker compose up`, порт 8787.
- E2E: 18 Playwright-спеков (1396 строк) в `e2e/`.

## Принятые решения

| Решение | Выбор |
|---|---|
| Темп миграции | Big bang — все страницы сразу |
| Раздача в проде | Отдельный контейнер под frontend, отдельный под backend, nginx на хосте |
| Ссылки | Не-SPA: URL сохраняются 1:1 (`/ui/topology`, `/ui/rules`, …) |
| Dev-режим | Vite в compose с прокси `/api` → `backend:8787` |
| Аутентификация | Cookie `firenet_session` без изменений |
| React Flow | Кастомные nodes/edges, остальное из коробки |
| Слой данных | TanStack Query |
| Объём | Все 15 страниц + оболочка |
| Тесты фронтенда | Старые удаляем, пишем Vitest + RTL |
| Роутинг | `BrowserRouter` + fallback на `index.html` |
| Судьба Go-UI | Бэкенд становится pure API |
| Раскладка репы | `frontend/` + Go на месте (`cmd/`, `internal/`) |

## Архитектура

### Юниты

| Юнит | Образ | Содержимое | Порт |
|---|---|---|---|
| `db` | postgres:16-alpine | без изменений | — |
| `backend` | golang → distroless | `cmd/firenet`, только `/api/*` | 8787 |
| `frontend` | node (dev) / nginx:alpine (prod) | Vite dev server или `dist/` | 5173 / 8080 |

### Продакшен

Контейнер `frontend` — nginx:alpine с собранным `dist/`, внутри
`try_files $uri /index.html` (нужно для `BrowserRouter`). Оба контейнера
публикуются только на `127.0.0.1`; наружу смотрит хостовой nginx:

```nginx
location /api/    { proxy_pass http://127.0.0.1:8787; }
location /        { proxy_pass http://127.0.0.1:8080; }
```

Конфиг хранится в репе как `nginx/firenet.conf` (образец); сам nginx на
хосте не входит в compose.

### Разработка

`frontend` запускает `vite --host 0.0.0.0`; `server.proxy` отправляет
`/api` и `/login` на `http://backend:8787`. Браузер открывает
`localhost:5173` — тот же origin, cookie работает без CORS. `make dev`
поднимает три сервиса.

### Аутентификация

Не меняется: `POST /api/login` ставит cookie, `auth.RequireAuth` её
читает. React при 401 уходит на `/login?next=...` — логика
`loginRedirectURL` переносится как есть, включая общий pending-promise,
чтобы параллельные 401 не наслаивали `?next=`.

## Структура `frontend/`

```
frontend/
  index.html
  package.json          # react, react-dom, react-router-dom,
                        # @tanstack/react-query, @xyflow/react,
                        # typescript, vite, vitest, @testing-library/react, msw
  vite.config.ts        # server.proxy: /api, /login -> http://backend:8787
  tsconfig.json
  Dockerfile            # node build -> nginx:alpine
  src/
    main.tsx            # QueryClientProvider + BrowserRouter
    App.tsx             # <Routes>
    api/
      client.ts         # fetch-обёртка: JSON, 401 -> редирект, ApiError
      types.ts          # ручные TS-типы под projectdoc DTO
      types.contract.test.ts
      queries.ts        # ключи + хуки useQuery/useMutation
      revision.ts       # X-Draft-Revision (CAS)
    draft/
      DraftContext.tsx  # активный драфт, isReadOnly, apiPath
    components/
      Layout.tsx        # сайдбар + тема + баннер + DraftBanner
      ErrorBoundary.tsx
      ui/               # Button, Modal, Table, Combo, Banner
    pages/
      TopologyPage.tsx  SubnetsPage.tsx  NetworksPage.tsx  DevicesPage.tsx
      SetsPage.tsx      UnionsPage.tsx   LinksPage.tsx     RulesPage.tsx
      CompilePage.tsx   DiagnosePage.tsx UsersPage.tsx     DraftsPage.tsx
      HistoryPage.tsx   SearchPage.tsx   LoginPage.tsx     InvitePage.tsx
    topology/
      TopologyCanvas.tsx  DeviceNode.tsx  NetworkNode.tsx  LinkEdge.tsx
      toolbar.tsx  useLayoutSync.ts  scene.ts  icons.ts
  public/
    favicon.svg
```

### Роутинг

```
/                  -> redirect /ui/topology
/login             -> LoginPage
/invite/:token     -> InvitePage
/ui/topology  /ui/subnets  /ui/networks  /ui/devices  /ui/sets
/ui/unions    /ui/links    /ui/rules     /ui/compile  /ui/diagnose
/ui/users     /ui/drafts   /ui/history   /ui/search
*                  -> 404 внутри shell'а
```

Fallback в nginx-контейнере даёт глубокие ссылки: `http://firenet/ui/rules`
открывается сразу на правилах. Снаружи это набор обычных адресуемых
страниц, а не SPA без URL.

### Оболочка

`Layout.tsx` забирает то, что делает `layout.html` + `common.js`: сайдбар
на 15 пунктов, переключатель темы (`data-theme` на `<html>` + localStorage),
глобальный баннер, `DraftBanner` («Черновик X» / «Только чтение, версия N»),
редирект на `/login` при 401. Страницы `users` и `search` — без баннера
драфта (сейчас `NoDraftBanner: true`).

### Контекст драфта

`DraftContext` переносит `currentDraftID`/`setCurrentDraftID`: активный
драфт в `sessionStorage` (на таб), последний — в `localStorage` (на новую
сессию), `sessionStorage["firenet-draft-readonly"]` = «таб сознательно в
read-only». Отсюда `apiPath(suffix)`: `/api/drafts/{id}/{suffix}` либо
`/api/versions/current/{suffix}`. Ключи сохраняются 1:1 с текущими, чтобы
e2e-хелпер `openWithDraft` работал без правок.

## Слой данных

### Ключи кэша

```ts
["project", scope, "topology"]   // scope = draft:<id> | current
["project", scope, "subnets"]
["project", scope, "rules"]
["project", scope, "layout"]
["drafts"], ["versions"], ["users"], ["me"]
```

`useProject("topology")` берёт `scope` из `DraftContext` и вызывает
`apiPath`.

### CAS

Модульный стор `revision.ts`: каждый ответ с `X-Draft-Revision` пишет
значение, каждая мутация драфта читает его. На 409 — `ApiError` с
`status: 409`; хук показывает «Черновик изменён в другой вкладке» и
инвалидирует ресурс, а не перезаписывает молча.

### Три класса мутаций

1. **Документ целиком** (subnets, rules, networks, devices, sets, unions,
   links) — `PUT` с `X-Draft-Revision`, оптимистичное обновление, при ошибке
   откат + баннер. Правка `rules` инвалидирует `lint` и `search-index`.
2. **Операции топологии** — `POST .../topology/operations` (и `/batch`);
   ответ содержит новый документ и ревизию → пишем прямо в кэш `topology`,
   без рефетча.
3. **Вычисления** (validate / compile / diagnose / spread / lint) — `POST`
   без записи в проект, результат в кэш по хэшу аргументов,
   `staleTime: Infinity`.

### Автосохранение

`useTopologySync` собирает операции в очередь, дебаунс ~400 мс, `onMutate`
→ «изменено», `onSuccess` → «сохранено». **Layout** (позиции узлов и камера)
пишется отдельным `PUT /layout` с дебаунсом ~1.5 с и только при реальном
изменении — он презентационный и не должен спамить сервер на каждый drag.

### Прочее

- **Загрузка:** страница грузит 2–4 документа параллельно; React Query
  дедуплицирует одинаковые ключи. ETag-кэш бэкенда остаётся полезным при
  перезагрузках.
- **DirtyGuard** → `useDirtyGuard(getData)`: `beforeunload` + перехват
  `<Link>` + `useBlocker`. `markClean()` после успешного сохранения.
- **Ошибки:** `ApiError { status, message }` из `{"error": "..."}`. Один
  `QueryCache.onError`: 401 → редирект, остальное → баннер.

## Топология на React Flow

**Модель:** документ — источник истины, React Flow — вью. `topology/scene.ts`
собирает `nodes`/`edges` из `{topology, layout}` чистой функцией (порт
`TopoScene.buildScene` без `theme`/`fade` — только геометрия и данные).
Взаимодействие пишет обратно операциями (`move-device`, `create-link`,
`attach-network`…), позиции живут в `LayoutDoc` на сервере.

**Узлы.** `DeviceNode` (140×60, глиф типа из `NetMap.KINDS`, радиус по
`kind`, цвет обводки по `d.kind`) и `NetworkNode` (160×60, «облако», цвет
по индексу объединения из `UNION_COLORS`). Оба `memo`, данные через `data`,
выделение из `selected`.

**Рёбра.** Свой `LinkEdge` на базе `getBezierPath`/`getSmoothStepPath`:
- параллельные (резервные) связи — смещение по `linkOffsets(links)`;
- waypoints — `smoothstep` с `layout.links[key][dupIdx]` в `data`, хэндлы
  для перетаскивания поверх;
- фильтрованная связь — `strokeDasharray: "6 4"` + `filteredColor`;
- `attach:${net}|${device}` — отдельный тип ребра «сеть → устройство».

**Библиотека берёт на себя:** `Background`, `Controls`, `MiniMap`, pan/zoom,
`fitView`, hit-test, выделение, drag узлов. Камера сохраняется в
`LayoutDoc.camera` через `onMoveEnd`.

**Инструменты.** `tool: 'select' | 'connect' | 'device' | 'network'`:
клик по пустому месту создаёт узел (`onPaneClick` + `screenToFlowPosition`),
в `connect` — `onConnect`. Удаление по `Del`, поиск по `Enter` подсвечивает
совпадения через `className`.

**Панели.** `LinkPanel`, `device-edit`, `net-edit`, `net-info` —
React-компоненты с обычным состоянием; позиция через `useState` + drag,
привязка к узлу через `flowToScreenPosition`.

**Диагностика.** `DiagnosePage` использует тот же `TopologyCanvas` в
read-only (`nodesDraggable={false}`), подсветка путей через `className`
(`diag-flow-ok/deny/half`). Твины не переносим — переходы на CSS.

**Удаляется без замены:** `canvas_view.js`, `canvas_theme.js`,
`topo_scene.js`, `hit_test.js`, `camera.js`, `camera_input.js`,
`minimap.js`, `floating_panel.js`, `tween.js`, `netmap.js` (глифы и
константы → `topology/icons.ts`).

## Изменения в Go

### Удаляется

- `internal/httpapi/templates/` — 15 файлов, 1306 строк;
- `internal/httpapi/web/` — целиком (alpine, style.css, 6820 строк JS,
  9106 строк тестов, favicon.svg);
- `internal/httpapi/embed.go` — оба `//go:embed`;
- из `server.go`: `parsePageTemplates`, `mustPageTemplate`, `servePage`,
  `serveTemplatedPage`, `templatedPages`, `pageData`, роуты `GET /ui/*`,
  `GET /login`, `GET /invite/{token}`, `GET /{$}`,
  `mux.Handle("/", ...FileServer)`, `noCache`;
- `server_test.go` — тесты рендера страниц.

`withAPICache` (ETag + gzip) остаётся: полезен при перезагрузках. Ассеты
больше не раздаются из Go, поэтому `noCache` уходит вместе с FileServer'ом.

### Правится

- `login.html`/`invite.html` уходят — React рисует `/login` и
  `/invite/:token`; `GET /api/invites/{token}` (JSON) остаётся;
- `favicon.svg` → `frontend/public/`;
- `handlers.go:318` — комментарий про «`/ui/links` identifies link by array
  position» пересматривается при переписывании страницы links;
- `search_index.go` — комментарий «served to `/ui/search`» обновляется;
- `README.md` — структура проекта (добавить `frontend/`), команды
  разработки, описание запуска (три сервиса, nginx на хосте);
- `Dockerfile` остаётся backend'овым; `docker-compose.yml` получает сервисы
  `backend` и `frontend`; добавляется `frontend/Dockerfile`;
- `Makefile`: `dev`, `fe-test`, `fe-build`; `test-e2e` без изменений.

### Не трогается

`internal/app`, `internal/topology`, `internal/rules`, `internal/compiler`,
`internal/diagnose`, `internal/lint`, `internal/pgstore`, `internal/auth` —
домен и API-контракты остаются 1:1. Все ~45 хендлеров и DTO в
`internal/projectdoc` не меняются.

## Тестирование

**Удаляется:** 9106 строк `node:test`-тестов — они проверяют
Alpine-компоненты, DOM-стабы и самописную канву, которые исчезают.

**Добавляется:**
- Vitest + @testing-library/react: `api/client.ts` (парсинг ошибок,
  401-редирект), `revision.ts` (CAS), `DraftContext`, `topology/scene.ts`
  (разнос параллельных связей, waypoints, привязки сетей), табличные
  компоненты, `Layout` (баннер драфта, тема);
- Vitest + MSW для хуков TanStack Query: мок `/api/*`, проверка
  инвалидации и обработки 409;
- `api/types.contract.test.ts` — сверка TS-типов с фикстурами ответов Go.

**Playwright** (`e2e/`, 18 спеков) остаётся главным e2e:
- `helpers/ui.js`: селекторы `#login-form input[name=username]` и
  `#tool-select.active` заменяются на `data-testid`, которые добавляются в
  React-компоненты;
- `openWithDraft` пишет `localStorage["firenet-last-draft-id"]` /
  `sessionStorage["firenet-draft-id"]` — ключи сохраняются, хелпер работает
  без правок;
- `global-setup.js`: `baseURL` указывает на фронтенд (5173 в dev / 8080 в
  CI); `/api/*` идёт на тот же origin через nginx или Vite-прокси, а не
  напрямую на 8787. Единственное реальное изменение e2e-инфраструктуры.

**Go-тесты:** правятся только `server_test.go`; остальные 30+ пакетов не
затрагиваются.

## Порядок работ

1. **Каркас** — `frontend/` с Vite+TS, пустой `Layout`, роутинг на 17 путей,
   прокси `/api`. Без логики.
2. **Слой данных** — `client.ts`, `types.ts`, `queries.ts`, `DraftContext`,
   `revision.ts`. Тесты Vitest.
3. **Оболочка** — сайдбар, тема, баннер, `DraftBanner`, логин/инвайт,
   401-редирект.
4. **Табличные страницы** (12): subnets, networks, devices, sets, unions,
   links, rules, compile, users, drafts, history, search.
5. **Топология** — `scene.ts`, `DeviceNode`, `NetworkNode`, `LinkEdge`,
   инструменты, панели, синхронизация layout.
6. **Диагностика** — read-only канва поверх готового `TopologyCanvas`.
7. **Чистка Go** — удаление `templates/`, `web/`, `embed.go`, страничных
   роутов; правка `server_test.go`, README, Makefile, compose.
8. **Инфраструктура** — `frontend/Dockerfile` (node build → nginx), сервис в
   compose, `nginx/firenet.conf`, `make dev`.
9. **e2e** — правка `ui.js`-хелперов, прогон 18 спеков против React.

Каждая стадия завершается `cd frontend && npm test` (стадии 2+) и
`go build ./... && go vet ./... && gofmt -l . && go test ./...` (после 7).

## Риски

- **Потеря покрытия на время big bang.** Старые тесты удаляются на стадии 7,
  новые пишутся на стадиях 2–6. Пока не пройдена стадия 9, e2e — единственная
  защита от регрессий в UI.
- **Расхождение TS-типов с Go-DTO.** Типы пишутся руками; смягчается
  контракт-тестом. При частых изменениях API имеет смысл вернуться к
  кодогенерации.
- **Объём React Flow.** Кастомные узлы/рёбра + waypoints + панели — самая
  сложная часть; оценка стадии 5 может вырасти.
