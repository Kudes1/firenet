# Frontend/Backend Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разделить firenet на два независимых рантайма — Go-бэкенд, отдающий только JSON API, и отдельное React-приложение (Vite + TypeScript + React Flow) с сохранением всех текущих URL.

**Architecture:** Бэкенд `cmd/firenet` остаётся на месте, но `internal/httpapi` теряет `html/template`-страницы, `go:embed`-ассеты и Alpine.js — остаются только `/api/*`. Новое React-приложение живёт в `frontend/`, общается с API через TanStack Query, получает данные по cookie-сессии (без изменений на бэкенде) и собирается в отдельный nginx-контейнер. Редактор топологии переводится с самописного Canvas2D на React Flow с кастомными узлами и рёбрами.

**Tech Stack:** React 18, TypeScript 5, Vite 5, React Router 6, TanStack Query 5, React Flow (`@xyflow/react` 12), Vitest 2 + @testing-library/react + MSW; Go 1.25 (без новых зависимостей), Docker Compose, nginx.

**Spec:** `docs/superpowers/specs/2026-09-07-frontend-backend-split-design.md`

---

## Global Constraints

- Go-домен не меняется: `internal/app`, `internal/topology`, `internal/rules`, `internal/compiler`, `internal/diagnose`, `internal/lint`, `internal/pgstore`, `internal/auth`, `internal/projectdoc` — ни один файл не редактируется (кроме комментариев, явно указанных в задачах).
- API-контракт не меняется: ни один handler, ни один JSON-тег не трогается.
- Аутентификация — cookie `firenet_session` (httpOnly, SameSite=Lax). JWT не вводится.
- Ключи браузерного хранилища сохраняются 1:1 с легаси: `firenet-draft-id`, `firenet-last-draft-id`, `firenet-draft-readonly`, `firenet-theme`, `firenet-sidebar`, `firenet-nav-<id>`, `firenet-diag-form-v1`, `firenet-<page>-col-widths-v<n>`.
- URL остаются 1:1: `/login`, `/invite/:token`, `/ui/{topology,subnets,networks,devices,sets,unions,links,rules,compile,diagnose,users,drafts,history,search}`.
- Код на русском там, где в легаси были русские строки UI; комментарии в Go — по-английски (согласно существующему стилю), в TS — по-русски (согласно `web/*.js`).
- Никаких новых Go-зависимостей.
- Каждая задача заканчивается зелёными тестами и отдельным коммитом.

---

## Проверка после каждой задачи

```bash
cd frontend && npm run typecheck && npm test     # задачи 1+
cd /root/repos/firenet && go build ./... && go vet ./... && gofmt -l . && go test ./...   # задача 21+
```

---

### Task 1: Скаффолд `frontend/`

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/tsconfig.app.json`, `frontend/tsconfig.node.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `frontend/src/styles.css`, `frontend/src/test/setup.ts`, `frontend/Dockerfile`, `frontend/.dockerignore`, `frontend/nginx.conf`, `frontend/public/favicon.svg`
- Modify: `.gitignore`

**Interfaces:**
- Produces: рабочий `npm run typecheck` / `npm run build` / `npm test`; `<App/>` с 17 маршрутами (14 страниц `/ui/*` + `/` + `/login` + `/invite/:token` + `*`), который будут наполнять задачи 3–20.

Здесь же — единственное место, где описан dev-вход: `npm run dev` поднимает Vite на 5173 и проксирует `/api` на бэкенд. До задачи 22 `make dev` (`docker compose up`) фронтенд не поднимает: compose-сервис `frontend` и dev-стейдж `Dockerfile` добавляются там.

- [x] **Step 1: Создать `frontend/package.json`**

```json
{
  "name": "firenet-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "@xyflow/react": "^12.3.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/node": "^22.7.4",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "jsdom": "^25.0.1",
    "msw": "^2.4.9",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.2"
  }
}
```

`@testing-library/dom` — явный peer `@testing-library/react` 16 (`^10.0.0`); без записи в devDependencies `npm ci` на чистой машине не гарантирует мажорную версию. `@types/node` нужен `tsconfig.node.json` (`types: ["node"]`) для `process.cwd()` в `vite.config.ts`.

- [x] **Step 2: Создать `frontend/tsconfig.json` — корень project references**

Разделение как в официальном шаблоне `create-vite` react-ts: приложение (`src`, DOM + тестовые типы) и конфиг (`vite.config.ts`, типы node) проверяются разными программами, поэтому `process.cwd()` не требует типов node в коде приложения.

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

- [x] **Step 2.1: Создать `frontend/tsconfig.app.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "useDefineForClassFields": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [x] **Step 2.2: Создать `frontend/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["vite.config.ts"]
}
```

`composite: true` обязателен для `references`, `noEmit: true` — чтобы `tsc -b` не пытался выдать JS рядом с конфигом.

- [x] **Step 3: Создать `frontend/vite.config.ts`**

Один конфиг на Vite и Vitest: `defineConfig` из `vitest/config` принимает и `server.*`, и `test.*` (в `vite` — не принимает `test`, это проверяется type-тестами Vite), поэтому отдельный `vitest.config.ts` не нужен.

> **Правка относительно исходного черновика (выявлено контролем, см. Task 23 Step 1).** Изначальный код читал таргет через `loadEnv(mode, process.cwd(), "")`. Это **не работает** в Vite 5.4: `resolveEnvPrefix` (packages/vite/src/node/config.ts) бросает исключение на пустой префикс (`envPrefix contains value ''`), поэтому `vite config` падает на старте. Ниже — рабочий вариант: таргет читается напрямую из `process.env.VITE_API_TARGET`. Переменные процесса с префиксом `VITE_` имеют высший приоритет в Vite (источник `process.env` перекрывает `.env`-файлы), так что в dev-стейдже, где `VITE_API_TARGET` задаётся через `ENV` в `frontend/Dockerfile`, значение подхватится без всяких `.env`-файлов.

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Конфиг один на Vite и на Vitest: defineConfig из vitest/config принимает и
// server.*, и test.*, поэтому отдельный vitest.config.ts не нужен.
// Таргет прокси читается из переменной процесса VITE_API_TARGET (задаётся ENV
// в dev-стейдже frontend/Dockerfile и в e2e/global-setup.js): process.env имеет
// высший приоритет над .env-файлами, поэтому loadEnv с пустым префиксом не
// нужен — а в Vite 5.4 он и запрещён (resolveEnvPrefix бросает исключение на
// пустой префикс). Файла .env в контейнере нет.
const apiTarget = process.env.VITE_API_TARGET ?? "http://backend:8787";

export default defineConfig(() => ({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Vite dev-сервер — единственная точка входа в dev: /api уходит в
      // backend-контейнер, всё остальное отдаётся React-приложением. Один
      // origin на клиенте — cookie-сессия работает без CORS.
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
```

- [x] **Step 4: Создать `frontend/index.html`**

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>firenet</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script>
  try {
    var saved = localStorage.getItem("firenet-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch (e) {}
</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [x] **Step 5: Скопировать стили и иконку из легаси**

```bash
mkdir -p /root/repos/firenet/frontend/public
cp /root/repos/firenet/internal/httpapi/web/style.css /root/repos/firenet/frontend/src/styles.css
cp /root/repos/firenet/internal/httpapi/web/favicon.svg /root/repos/firenet/frontend/public/favicon.svg
```

Стиль переносится как есть — React-компоненты будут использовать те же классы (`.data-table`, `.owner-badge`, `.modal`, `.side-nav`, `.draft-banner`, …).

- [x] **Step 6: Создать `frontend/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [x] **Step 7: Создать `frontend/src/App.tsx`**

```tsx
import { Navigate, Route, Routes } from "react-router-dom";

// Пути 1:1 с легаси-страницами Go. Страницы появляются в задачах 8–20;
// до этого рендерятся заглушки с data-testid="page-<name>".
const routes: Array<[string, string]> = [
  ["/ui/topology", "topology"],
  ["/ui/subnets", "subnets"],
  ["/ui/networks", "networks"],
  ["/ui/devices", "devices"],
  ["/ui/sets", "sets"],
  ["/ui/unions", "unions"],
  ["/ui/links", "links"],
  ["/ui/rules", "rules"],
  ["/ui/compile", "compile"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/users", "users"],
  ["/ui/drafts", "drafts"],
  ["/ui/history", "history"],
  ["/ui/search", "search"],
];

function Placeholder({ name }: { name: string }) {
  return <main data-testid={`page-${name}`}>{name}</main>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/ui/topology" replace />} />
      {routes.map(([path, name]) => (
        <Route key={path} path={path} element={<Placeholder name={name} />} />
      ))}
      <Route path="/login" element={<Placeholder name="login" />} />
      <Route path="/invite/:token" element={<Placeholder name="invite" />} />
      <Route path="*" element={<Placeholder name="notfound" />} />
    </Routes>
  );
}
```

- [x] **Step 7.1: Создать `frontend/src/App.test.tsx`**

Без этого теста Step 13 проверял бы только то, что код компилируется — сам роутинг оставался бы непроверенным. `MemoryRouter` вместо `BrowserRouter`: в jsdom история браузера общая на все тесты.

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const pages = [
  ["/ui/topology", "topology"],
  ["/ui/subnets", "subnets"],
  ["/ui/networks", "networks"],
  ["/ui/devices", "devices"],
  ["/ui/sets", "sets"],
  ["/ui/unions", "unions"],
  ["/ui/links", "links"],
  ["/ui/rules", "rules"],
  ["/ui/compile", "compile"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/users", "users"],
  ["/ui/drafts", "drafts"],
  ["/ui/history", "history"],
  ["/ui/search", "search"],
  ["/login", "login"],
  ["/invite/abc123", "invite"],
  ["/ui/unknown", "notfound"],
] as const;

describe("App routing", () => {
  it.each(pages)("renders placeholder for %s", (path, name) => {
    renderAt(path);
    expect(screen.getByTestId(`page-${name}`)).toHaveTextContent(name);
  });

  it("redirects / to topology page", () => {
    renderAt("/");
    expect(screen.getByTestId("page-topology")).toBeInTheDocument();
  });
});
```

- [x] **Step 8: Создать `frontend/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [x] **Step 9: Создать `frontend/Dockerfile`**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [x] **Step 9.1: Создать `frontend/.dockerignore`**

Без него `COPY . .` затирает результат `npm ci` хостовыми `node_modules` (в образе они от alpine-сборки) и тащит уже собранный `dist`:

```
node_modules
dist
Dockerfile
.dockerignore
.git
.gitignore
*.local
```

`nginx.conf` в список **не** добавлять: он копируется вторым `COPY` в nginx-стейдж и должен остаться в контексте сборки.

- [x] **Step 10: Создать `frontend/nginx.conf`**

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # Глубокие ссылки BrowserRouter: всё, что не файл, отдаём index.html.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
```

- [x] **Step 11: Добавить `frontend/dist/` в `.gitignore`**

Дописать в `/root/repos/firenet/.gitignore` в секцию «Build artifacts»:

```
frontend/dist/
frontend/node_modules/
```

- [x] **Step 12: Установить зависимости**

```bash
cd /root/repos/firenet/frontend && npm install
```

- [x] **Step 13: Проверить типы, тесты и сборку**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test && npm run build
```

Expected: `tsc -b` молчит, 18 тестов зелёные (все из `App.test.tsx`: 17 маршрутов + редирект с `/`), `vite build` пишет `dist/index.html` + `dist/assets/*.js`. Контракт-тесты появятся только в задаче 2, здесь их нет.

- [x] **Step 13.1: Проверить, что прокси читает env**

```bash
cd /root/repos/firenet/frontend && VITE_API_TARGET=http://from-env:1234 node --input-type=module -e '
const { loadConfigFromFile } = await import("vite");
const res = await loadConfigFromFile({ command: "serve", mode: "development" }, process.cwd() + "/vite.config.ts", process.cwd());
console.log(JSON.stringify((await res.config).server.proxy));
process.exit(0);
'
```

Expected: `{"/api":{"target":"http://from-env:1234","changeOrigin":true}}`. Без переменной — `http://backend:8787`. Это и есть связка с `ENV VITE_API_TARGET` из задачи 22: если её убрать, dev-контейнер молча поедет на дефолтный таргет.

> Механизм работает потому, что `vite.config.ts` (Step 3) читает `process.env.VITE_API_TARGET` напрямую, а Vite отдаёт переменным процесса с префиксом `VITE_` высший приоритет. Если `loadConfigFromFile` выше упадёт с `envPrefix contains value ''` — в конфиге всё ещё остался `loadEnv(..., "")`; убрать его (см. правку в Step 3).

- [x] **Step 14: Commit**

```bash
cd /root/repos/firenet && git add frontend .gitignore && git status --short && git commit -m "feat(frontend): scaffold Vite + React + TS project"
```

В `git status` должны быть только файлы `frontend/` и `.gitignore`: `frontend/node_modules/` и `frontend/dist/` уже в `.gitignore` (Step 11), `package-lock.json` — в коммите (он нужен `npm ci` в Dockerfile).

---

### Task 2: Типы API-контракта

**Files:**
- Create: `frontend/src/api/types.ts`, `frontend/src/api/fixtures.ts`, `frontend/src/api/types.contract.test.ts`

**Interfaces:**
- Produces: `EndpointDoc`, `LinkFilterDoc`, `LinkDoc`, `DeviceDoc`, `NetworkDoc`, `SetDoc`, `UnionDoc`, `TopologyDoc`, `SubnetDoc`, `SubnetsDoc`, `RuleDoc`, `ChainDoc`, `PolicyDoc`, `LayoutPoint`, `LayoutCamera`, `LayoutDoc`, `EntityDoc`, `TopologyOperation`, `EditorSnapshot`, `DraftResponse`, `VersionInfo`, `UserResponse`, `SearchEntry`, `LintFinding`, `DiagnoseRequest`, `DiagnoseReport`, `SpreadRequest`, `SpreadResult`, `CompiledDevice`, `EntityDiff`, `DraftDiffEntry`, `Conflict`.

Все имена полей — точные копии JSON-тегов из `internal/projectdoc/*.go` и DTO из `internal/httpapi/*.go`.

- [x] **Step 1: Написать `frontend/src/api/types.ts`**

```ts
// Wire-формат firenet API. Имена полей — точные копии JSON-тегов Go:
// internal/projectdoc/{topology,subnets,rules,layout,project}.go и
// DTO из internal/httpapi/{handlers,draft_handlers,version_handlers,
// user_handlers,search_index}.go. types.contract.test.ts ловит расхождение.

export type ErrorResponse = { error: string };

export type EndpointDoc = { device: string };
export type LinkFilterDoc = { aExports: string[]; bExports: string[] };
export type LinkDoc = { a: EndpointDoc; b: EndpointDoc; filter?: LinkFilterDoc };

export type DeviceKind = "router" | "switch";
export type DeviceDoc = { name: string; kind: DeviceKind; description?: string };

export type NetworkDoc = {
  name: string;
  subnets?: string[];
  attach?: EndpointDoc[];
  description?: string;
};

export type SetDoc = {
  name: string;
  subnets?: string[];
  addresses?: string[];
  description?: string;
};

export type UnionDoc = {
  name: string;
  devices?: string[];
  networks?: string[];
  description?: string;
};

export type TopologyDoc = {
  devices: DeviceDoc[];
  links: LinkDoc[];
  networks: NetworkDoc[];
  sets: SetDoc[];
  unions: UnionDoc[];
};

export type SubnetDoc = { name: string; cidr: string; description?: string };
export type SubnetsDoc = { subnets: SubnetDoc[] };

export type RuleAction = "allow" | "deny" | "return" | "jump";
export type RuleDoc = {
  name: string;
  comment?: string;
  src: string[];
  dst: string[];
  proto?: string;
  srcPorts?: string[];
  dstPorts?: string[];
  action: RuleAction;
  jumpTo?: string;
  mirror?: boolean;
};

export type ChainDoc = {
  name: string;
  defaultAction: string;
  chainPosition?: "top" | "bottom";
  rules: RuleDoc[];
};

export type PolicyDoc = { chains: ChainDoc[] };

export type LayoutPoint = { x: number; y: number };
export type LayoutCamera = { x: number; y: number; z: number };
export type LayoutDoc = {
  devices?: Record<string, LayoutPoint>;
  networks?: Record<string, LayoutPoint>;
  links?: Record<string, LayoutPoint[][]>;
  camera?: LayoutCamera;
};

export type EntityDoc = { name: string; cidr?: string };

// kind — полный список из internal/httpapi/topology_operations.go.
// Поля, которые читает каждый kind, см. в комментариях там же.
export type TopologyOperationKind =
  | "create-device" | "update-device" | "delete-device"
  | "create-network" | "update-network" | "delete-network"
  | "create-link" | "delete-link" | "set-link-filter" | "clear-link-filter"
  | "create-union" | "delete-union"
  | "attach-network" | "detach-network"
  | "union-add-device" | "union-remove-device"
  | "union-add-network" | "union-remove-network"
  | "set-device-position" | "set-network-position"
  | "set-link-waypoints" | "set-camera";

export type TopologyOperation = {
  kind: TopologyOperationKind | string;
  device?: DeviceDoc;
  network?: NetworkDoc;
  link?: LinkDoc;
  union?: UnionDoc;
  filter?: LinkFilterDoc;
  deviceName?: string;
  networkName?: string;
  unionName?: string;
  attach?: EndpointDoc;
  position?: LayoutPoint;
  waypoints?: LayoutPoint[][];
  camera?: LayoutCamera;
};

export type EditorSnapshot = { topology: TopologyDoc; layout: LayoutDoc };

export type DraftStatus = "open" | "conflict" | "merged" | "closed";
export type DraftResponse = {
  id: string;
  owner: string;
  name: string;
  baseVersion: number;
  status: DraftStatus;
};

export type VersionInfo = {
  id: number;
  createdAt: string;
  confirmedBy?: string;
  draftId?: string;
  note?: string;
};

export type UserRole = "admin" | "user";
export type UserResponse = {
  id: string;
  username: string;
  role: UserRole;
  activated: boolean;
  createdAt: string;
};

export type SearchEntryType =
  | "device" | "subnet" | "network" | "set" | "union" | "link" | "rule";
export type SearchEntry = {
  type: SearchEntryType;
  name: string;
  details?: string;
  description?: string;
  prefixes?: string[];
};

export type LintFinding = {
  severity: "warning" | "info";
  chain: string;
  rules?: string[];
  message: string;
};

// У compiled-устройств в Go нет json-тегов — приходят имена полей Go.
export type CompiledDevice = {
  Name: string;
  IPSetsScript: string;
  RulesScript: string;
};

export type EntityDiff = {
  kind: string;
  key: string;
  change: "added" | "modified" | "removed";
  before?: unknown;
  after?: unknown;
};

export type DraftDiffEntry = EntityDiff & { conflict: boolean };
export type Conflict = {
  kind: string;
  key: string;
  draftValue?: unknown;
  currentValue?: unknown;
};

export type GraphNodeKind = 0 | 1 | 2; // 0 router, 1 subnet, 2 L2 domain
export type GraphNode = { kind: GraphNodeKind; name: string };
export type RouterVerdict = {
  router: string;
  action: "allow" | "deny" | "return" | "jump";
  matchedRule?: string;
  reason: string;
  steps?: string[];
};
export type PathResult = {
  nodes: GraphNode[];
  routers: RouterVerdict[];
  verdict: "allow" | "deny" | "return";
  note?: string;
};
export type DenyInfo = { rule: string; reason: string };
export type MapMark = {
  hl: string[];
  ok: string[];
  okE: string[];
  denyE: string[];
  half: string[];
  halfE: string[];
  deny: Record<string, DenyInfo>;
};
export type DiagnoseReport = {
  srcSubnet: string;
  dstSubnet: string;
  note: string;
  paths: PathResult[];
  returnPathAllowed: boolean;
  mapMark: MapMark;
};

export type DiagnoseRequest = {
  src: string;
  dst: string;
  proto: "" | "tcp" | "udp" | "icmp";
  srcPorts: string[];
  dstPorts: string[];
};

export type SpreadRequest = {
  src: string;
  proto: "" | "tcp" | "udp" | "icmp";
  dstPorts: string[];
};

export type SpreadResult = {
  sources: Array<{ IP: string; SubnetName: string }>;
  reports: Array<{ candidate: string; report: DiagnoseReport }>;
  mark: MapMark;
};

export type LinkExportsResponse = { entities: EntityDoc[] };
export type LintResponse = { findings: LintFinding[] };
export type ValidateResponse = { valid: boolean; errors: string[] };
export type RestoreResponse = { version: number };
export type ConfirmResponse = { version: number } | { conflicts: Conflict[] };
export type CreateUserResponse = { user: UserResponse; inviteUrl: string };
export type InviteURLResponse = { inviteUrl: string };
export type InviteInfoResponse = { username: string };
```

- [x] **Step 2: Написать `frontend/src/api/fixtures.ts`**

Фикстуры — точные слепки ответов Go (используются в контракт-тесте и в тестах страниц):

```ts
import type {
  TopologyDoc, SubnetsDoc, PolicyDoc, LayoutDoc, DraftResponse,
  UserResponse, SearchEntry, LintFinding, CompiledDevice, EditorSnapshot,
  DiagnoseReport, SpreadResult,
} from "./types";

export const topologyFixture: TopologyDoc = {
  devices: [{ name: "r1", kind: "router" }, { name: "sw1", kind: "switch", description: "подъезд" }],
  links: [{ a: { device: "r1" }, b: { device: "sw1" } }],
  networks: [{ name: "office", subnets: ["lan"], attach: [{ device: "sw1" }] }],
  sets: [{ name: "srv", addresses: ["10.0.0.5/32"] }],
  unions: [{ name: "u1", devices: ["r1"] }],
};

export const subnetsFixture: SubnetsDoc = {
  subnets: [{ name: "lan", cidr: "10.0.0.0/24" }],
};

export const policyFixture: PolicyDoc = {
  chains: [{
    name: "FORWARD",
    defaultAction: "deny",
    chainPosition: "top",
    rules: [{ name: "web", src: ["lan"], dst: ["any"], proto: "tcp", dstPorts: ["80"], action: "allow" }],
  }],
};

export const layoutFixture: LayoutDoc = {
  devices: { r1: { x: 40, y: 40 } },
  networks: {},
  links: {},
  camera: { x: 0, y: 0, z: 1 },
};

export const editorSnapshotFixture: EditorSnapshot = {
  topology: topologyFixture,
  layout: layoutFixture,
};

export const draftFixture: DraftResponse = {
  id: "d1", owner: "u1", name: "правки", baseVersion: 3, status: "open",
};

export const userFixture: UserResponse = {
  id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
};

export const searchIndexFixture: SearchEntry[] = [
  { type: "device", name: "r1", details: "router" },
  { type: "subnet", name: "lan", details: "10.0.0.0/24", prefixes: ["10.0.0.0/24"] },
];

export const lintFixture: LintFinding[] = [
  { severity: "warning", chain: "FORWARD", rules: ["web"], message: "правило недостижимо" },
];

export const compileFixture: CompiledDevice[] = [
  { Name: "r1", IPSetsScript: "create lan hash:net", RulesScript: "-A FORWARD -j ACCEPT" },
];

// У diagnose-ответов имена полей тоже нестандартные (Go-структуры без
// json-тегов: MapMark/DenyInfo из internal/diagnose, Source из spread.go),
// поэтому они тоже проверяются контракт-тестом — по буквам, а не по догадке.
export const diagnoseFixture: DiagnoseReport = {
  srcSubnet: "lan",
  dstSubnet: "dmz",
  note: "диагностика рассматривает первый пакет нового соединения",
  paths: [{
    nodes: [{ kind: 0, name: "r1" }, { kind: 1, name: "dmz" }],
    routers: [{ router: "r1", action: "allow", matchedRule: "web", reason: "правило web", steps: ["сработало правило \"web\""] }],
    verdict: "allow",
  }],
  returnPathAllowed: true,
  mapMark: {
    hl: ["device:r1"], ok: ["device:r1"], okE: ["r1\0sw1"],
    denyE: [], half: [], halfE: [], deny: {},
  },
};

export const spreadFixture: SpreadResult = {
  sources: [{ IP: "10.0.0.1", SubnetName: "lan" }],
  reports: [{ candidate: "dmz", report: diagnoseFixture }],
  mark: diagnoseFixture.mapMark,
};
```

- [x] **Step 3: Написать контракт-тест `frontend/src/api/types.contract.test.ts`**

Тест фиксирует, что фикстуры содержат ровно те ключи, которые ждёт TS-тип: лишний ключ (опечатка, забытое поле, `Ip` вместо `IP`) падает здесь, а не в рантайме.

Чего тест **не** делает: он не сверяет TS с Go напрямую — Go-код в тесте не участвует. Если бэкенд добавит новое поле, тип и фикстура просто о нём не узнают, и тест останется зелёным. Полноценная сверка потребовала бы генерации типов из Go (вынесено за рамки плана), поэтому покрытие сознательно сдвинуто туда, где ошибка вероятнее всего — туда, где имена полей не выводятся из json-тегов и написаны «по памяти»: `CompiledDevice`, `DiagnoseReport`, `SpreadResult`, `MapMark`.

```ts
import { describe, expect, it } from "vitest";
import type {
  TopologyDoc, SubnetsDoc, PolicyDoc, LayoutDoc, DraftResponse,
  UserResponse, CompiledDevice, DiagnoseReport, SpreadResult,
} from "./types";
import * as fx from "./fixtures";

// Ключи фикстур — это и есть контракт: расхождение с типами видно здесь.
function expectKeys<T>(value: T, keys: string[]) {
  expect(Object.keys(value as object).sort()).toEqual([...keys].sort());
}

describe("API contract", () => {
  it("TopologyDoc matches Go json tags", () => {
    const t: TopologyDoc = fx.topologyFixture;
    expectKeys(t, ["devices", "links", "networks", "sets", "unions"]);
    expectKeys(t.devices[0], ["name", "kind"]);
    expectKeys(t.links[0], ["a", "b"]);
    expectKeys(t.networks[0], ["name", "subnets", "attach"]);
    expectKeys(t.sets[0], ["name", "addresses"]);
    expectKeys(t.unions[0], ["name", "devices"]);
  });

  it("SubnetsDoc matches Go json tags", () => {
    const s: SubnetsDoc = fx.subnetsFixture;
    expectKeys(s, ["subnets"]);
    expectKeys(s.subnets[0], ["name", "cidr"]);
  });

  it("PolicyDoc matches Go json tags", () => {
    const p: PolicyDoc = fx.policyFixture;
    expectKeys(p, ["chains"]);
    expectKeys(p.chains[0], ["name", "defaultAction", "chainPosition", "rules"]);
    expectKeys(p.chains[0].rules[0], ["name", "src", "dst", "proto", "dstPorts", "action"]);
  });

  it("LayoutDoc matches Go json tags", () => {
    const l: LayoutDoc = fx.layoutFixture;
    expectKeys(l, ["devices", "networks", "links", "camera"]);
    expectKeys(l.camera!, ["x", "y", "z"]);
  });

  it("DraftResponse and UserResponse match Go json tags", () => {
    const d: DraftResponse = fx.draftFixture;
    expectKeys(d, ["id", "owner", "name", "baseVersion", "status"]);
    const u: UserResponse = fx.userFixture;
    expectKeys(u, ["id", "username", "role", "activated", "createdAt"]);
  });

  // Ниже — структуры без json-тегов: имена полей приходят как в Go.
  it("CompiledDevice uses Go field names", () => {
    const c: CompiledDevice = fx.compileFixture[0];
    expectKeys(c, ["Name", "IPSetsScript", "RulesScript"]);
  });

  it("DiagnoseReport and its nested shapes match Go field names", () => {
    const r: DiagnoseReport = fx.diagnoseFixture;
    expectKeys(r, ["srcSubnet", "dstSubnet", "note", "paths", "returnPathAllowed", "mapMark"]);
    expectKeys(r.paths[0], ["nodes", "routers", "verdict"]);
    expectKeys(r.paths[0].nodes[0], ["kind", "name"]);
    expectKeys(r.paths[0].routers[0], ["router", "action", "matchedRule", "reason", "steps"]);
    expectKeys(r.mapMark, ["hl", "ok", "okE", "denyE", "half", "halfE", "deny"]);
  });

  it("SpreadResult uses Go field names for sources", () => {
    const s: SpreadResult = fx.spreadFixture;
    expectKeys(s, ["sources", "reports", "mark"]);
    expectKeys(s.sources[0], ["IP", "SubnetName"]);
    expectKeys(s.reports[0], ["candidate", "report"]);
  });
});
```

- [x] **Step 4: Запустить тест**

```bash
cd /root/repos/firenet/frontend && npm test
```

Expected: 8 passed (5 базовых контрактов + `CompiledDevice` + `DiagnoseReport` + `SpreadResult`).

- [x] **Step 5: Commit**

```bash
cd /root/repos/firenet && git add frontend/src/api && git commit -m "feat(frontend): API wire types with contract test"
```

---

### Task 3: Чистые помощники (`lib/`)

**Files:**
- Create: `frontend/src/lib/links.ts`, `frontend/src/lib/links.test.ts`, `frontend/src/lib/search.ts`, `frontend/src/lib/search.test.ts`, `frontend/src/lib/validate.ts`, `frontend/src/lib/validate.test.ts`

**Interfaces:**
- Produces: `canonicalLink`, `layoutLinkKey`; `containsFold`, `parseQueryPrefix`, `matchPrefixQuery`, `matchSubnetMembers`, `ipv4CidrOverlap`, `parseHostAddress`, `validPortSpec`; `uniqueNameHint`.
- Consumes: типы из Task 2.

Это порт чистых функций из `internal/httpapi/web/common.js` (`containsFold`, `parseQueryPrefix`, `partialPrefix`, `prefixContains`, `prefixOverlap`, `matchPrefixQuery`, `matchSubnetMembers`, `ipv4CidrOverlap`) и `internal/httpapi/topology_operations.go` (`canonicalLink`, `layoutLinkKey`). Поведение переносится 1:1 — это проверяется тестами.

Сознательные расхождения с легаси (задокументированы рядом с кодом):
- `parseQueryPrefix`/`prefixOverlap` возвращают `{addr, bits}` и маскируют базу при сравнении, как `normPrefix` в `common.js` — поэтому `matchPrefixQuery("10.0.0.5", "10.0.0.0/24")` даёт `true` (голый адрес пересекается с блоком), тогда как легаси отвергал голые адреса в `matchPrefixQuery` (требовал явный `/32` и добавлял его в вызывающем коде). Поиск по адресам набора (`SetsPage`) от этого только выигрывает.
- `parseHostAddress` нормализует голый IPv4 к `/32` и IPv6 к `/128`; легаси-`sets.js` хранил голый IP как есть. Расхождение сознательное: на бэкенде `projectdoc.parseHostPrefix` всё равно сводит к полной маске, а единый канонический вид нужен поиску и дедупликации адресов.
- `validPortSpec` использует разделитель диапазона `-` (как легаси-`rules.js` и `internal/rules/validate.go`), а не `:` — последний это формат диагностики (`handlers.go`/`compiler`), не правил.

- [x] **Step 1: Написать `frontend/src/lib/links.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { canonicalLink, layoutLinkKey } from "./links";

describe("canonicalLink", () => {
  it("orders the pair lexicographically", () => {
    expect(canonicalLink("r1", "sw1")).toEqual(["r1", "sw1"]);
    expect(canonicalLink("sw1", "r1")).toEqual(["r1", "sw1"]);
  });
});

describe("layoutLinkKey", () => {
  it('is "min(a,b)|max(a,b)"', () => {
    expect(layoutLinkKey("sw1", "r1")).toBe("r1|sw1");
    expect(layoutLinkKey("r1", "sw1")).toBe("r1|sw1");
  });
});
```

- [x] **Step 2: Запустить — тест падает (модуля нет)**

```bash
cd /root/repos/firenet/frontend && npm test
```

Expected: FAIL `Cannot find module './links'`.

- [x] **Step 3: Реализовать `frontend/src/lib/links.ts`**

```ts
// Идентичность связи не зависит от того, какая сторона названа A.
// Формат ключа совпадает с internal/httpapi/topology_operations.go
// (layoutLinkKey) и с pgstore.linkKey — позиции в массиве не используются.
export function canonicalLink(a: string, b: string): [string, string] {
  return a > b ? [b, a] : [a, b];
}

export function layoutLinkKey(a: string, b: string): string {
  return canonicalLink(a, b).join("|");
}
```

- [x] **Step 4: Написать `frontend/src/lib/search.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  containsFold, ipv4CidrOverlap, matchPrefixQuery, matchSubnetMembers, parseQueryPrefix,
} from "./search";

describe("containsFold", () => {
  it("matches case-insensitively and treats missing as empty", () => {
    expect(containsFold("Office", "fic")).toBe(true);
    expect(containsFold(undefined, "x")).toBe(false);
    expect(containsFold("a", "")).toBe(true);
  });
});

describe("parseQueryPrefix", () => {
  it("completes a bare IP to /32", () => {
    expect(parseQueryPrefix("10.0.0.5")).toEqual({ addr: "10.0.0.5", bits: 32 });
  });
  it("reads an explicit CIDR", () => {
    expect(parseQueryPrefix("10.0.0.0/24")).toEqual({ addr: "10.0.0.0", bits: 24 });
  });
  it("turns a partial address into a prefix", () => {
    expect(parseQueryPrefix("10.0.")).toEqual({ addr: "10.0.0.0", bits: 16 });
    expect(parseQueryPrefix("10.0")).toEqual({ addr: "10.0.0.0", bits: 16 });
    expect(parseQueryPrefix("10.0.0")).toEqual({ addr: "10.0.0.0", bits: 24 });
  });
  it("rejects octets over 255 and leading zeros in partials", () => {
    expect(parseQueryPrefix("999.")).toBeNull();
    expect(parseQueryPrefix("010.0.")).toBeNull();
  });
  it("returns null for non-addresses", () => {
    expect(parseQueryPrefix("lan")).toBeNull();
  });
});

describe("matchPrefixQuery", () => {
  it("matches containing prefixes at /32 and overlapping below", () => {
    expect(matchPrefixQuery("10.0.0.5/32", "10.0.0.0/24")).toBe(true);
    expect(matchPrefixQuery("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
  it("falls back to a case-insensitive substring for names", () => {
    expect(matchPrefixQuery("lan", "LAN")).toBe(true);
  });
});

describe("matchSubnetMembers", () => {
  const cidrOf = (n: string) => (n === "lan" ? "10.0.0.0/24" : "192.168.0.0/24");
  it("matches by member name or CIDR", () => {
    expect(matchSubnetMembers(["lan"], cidrOf, "10.0.0")).toBe(true);
    expect(matchSubnetMembers(["lan"], cidrOf, "192.168")).toBe(false);
  });
});

describe("ipv4CidrOverlap", () => {
  it("detects overlapping blocks and ignores disjoint ones", () => {
    expect(ipv4CidrOverlap("10.0.0.0/24", "10.0.0.128/25")).toBe(true);
    expect(ipv4CidrOverlap("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
});
```

- [x] **Step 5: Реализовать `frontend/src/lib/search.ts`** — порт из `internal/httpapi/web/common.js`, поведение 1:1

```ts
// Поисковые помощники страниц — порт common.js (containsFold, parseQueryPrefix,
// prefixContains/prefixOverlap, matchPrefixQuery, matchSubnetMembers,
// ipv4CidrOverlap). Чистые функции: ни DOM, ни состояния.

export function containsFold(value: string | undefined | null, query: string): boolean {
  if (!query) return true;
  return String(value ?? "").toLowerCase().includes(query.toLowerCase());
}

const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toInt(addr: string): number | null {
  const m = IPV4_OCTETS.exec(addr);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export type Prefix = { addr: string; bits: number };

// partialPrefix превращает частично набранный адрес («10.», «10.0», «10.0.0»,
// «10.0.0.5») в подразумеваемый CIDR-блок — порт partialPrefix из common.js:
// неполные октеты добиваются нулями, битовая маска = заполненным октетам.
// Отвергает октеты > 255 и ведущие нули («010.»), как легаси.
function partialPrefix(q: string): Prefix | null {
  let parts = q.split(".");
  if (parts.length > 4 || parts[0] === "") return null;
  if (parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  if (!parts.length) return null;
  for (const p of parts) {
    if (!/^\d+$/.test(p) || Number(p) > 255 || (p.startsWith("0") && p.length > 1)) return null;
  }
  const octets = parts.map(Number);
  while (octets.length < 4) octets.push(0);
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const bits = parts.length * 8;
  return { addr: `${(base >>> 24) & 255}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${base & 255}`, bits };
}

// parseQueryPrefix разбирает пользовательский запрос: голый IP → /32,
// неполный адрес («10.0», «10.0.0») → префикс по заполненным октетам,
// CIDR — как есть. Порт common.js parseQueryPrefix.
export function parseQueryPrefix(query: string): Prefix | null {
  const q = query.trim();
  if (!q) return null;
  const [addr, bitsRaw] = q.split("/");
  if (bitsRaw !== undefined) {
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32 || !toInt(addr)) return null;
    return { addr, bits };
  }
  if (toInt(addr)) return { addr, bits: 32 };
  return partialPrefix(addr);
}

function prefixContains(outer: string, inner: Prefix): boolean {
  const o = parseQueryPrefix(outer);
  if (!o) return false;
  const a = toInt(o.addr);
  const b = toInt(inner.addr);
  if (a === null || b === null) return false;
  if (o.bits > inner.bits) return false;
  const mask = o.bits === 0 ? 0 : (0xffffffff << (32 - o.bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function prefixOverlap(a: Prefix, b: Prefix): boolean {
  const ia = toInt(a.addr);
  const ib = toInt(b.addr);
  if (ia === null || ib === null) return false;
  // Маскируем обе базы общим префиксом (как normPrefix в common.js):
  // значение «10.0.0.5/24» при сравнении трактуется как «10.0.0.0/24».
  const bits = Math.min(a.bits, b.bits);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ia & mask) === (ib & mask);
}

// matchPrefixQuery: адресный запрос ищет по вхождению/пересечению префиксов,
// всё остальное — обычная подстрока (имя подсети, сети, набора).
// Семантика 1:1 с common.js: запрос /32 проверяется вхождением в значение,
// более широкая маска — пересечением префиксов.
export function matchPrefixQuery(value: string, query: string): boolean {
  if (!query) return true;
  const q = parseQueryPrefix(query);
  if (!q) return containsFold(value, query);
  const v = parseQueryPrefix(value);
  if (!v) return containsFold(value, query);
  return q.bits === 32 ? prefixContains(value, q) : prefixOverlap(v, q);
}

export function matchSubnetMembers(
  names: string[] | undefined,
  cidrOf: (name: string) => string,
  query: string,
): boolean {
  if (!query) return true;
  return (names ?? []).some((n) => containsFold(n, query) || matchPrefixQuery(cidrOf(n), query));
}

// ipv4CidrOverlap — подсказка в форме («пересекается с X»), а не авторитет:
// окончательную проверку делает валидатор на бэкенде.
export function ipv4CidrOverlap(a: string, b: string): boolean {
  const pa = parseQueryPrefix(a);
  const pb = parseQueryPrefix(b);
  if (!pa || !pb) return false;
  return prefixOverlap(pa, pb);
}
```

- [x] **Step 6: Написать `frontend/src/lib/validate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseHostAddress, uniqueNameHint, validPortSpec } from "./validate";

describe("uniqueNameHint", () => {
  const names = ["lan", "dmz"];
  it("accepts a free name", () => expect(uniqueNameHint("wan", names)).toBe(""));
  it("rejects a duplicate", () => expect(uniqueNameHint("lan", names)).toBe("Имя уже используется"));
  it("allows the object to keep its own name", () => expect(uniqueNameHint("lan", names, 0)).toBe(""));
  it("rejects empty", () => expect(uniqueNameHint("  ", names)).toBe("Имя обязательно"));
});

describe("parseHostAddress", () => {
  it("accepts a bare IPv4 as /32", () => expect(parseHostAddress("10.0.0.5")).toBe("10.0.0.5/32"));
  it("accepts an explicit /32 and rejects shorter v4 masks", () => {
    expect(parseHostAddress("10.0.0.5/32")).toBe("10.0.0.5/32");
    expect(parseHostAddress("10.0.0.0/24")).toBeNull();
  });
  it("accepts IPv6 only as /128", () => {
    expect(parseHostAddress("2001:db8::1/128")).toBe("2001:db8::1/128");
    expect(parseHostAddress("2001:db8::1")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseHostAddress("office")).toBeNull();
    expect(parseHostAddress("10.0.0.5/32/1")).toBeNull();
  });
});

describe("validPortSpec", () => {
  it("accepts single ports and ranges", () => {
    expect(validPortSpec("80")).toBe(true);
    expect(validPortSpec("1024-2048")).toBe(true);
  });
  it("rejects bad numbers, reversed ranges and junk", () => {
    expect(validPortSpec("0")).toBe(false);
    expect(validPortSpec("70000")).toBe(false);
    expect(validPortSpec("2048-1024")).toBe(false);
    expect(validPortSpec("80,abc")).toBe(false);
  });
});
```

- [x] **Step 7: Реализовать `frontend/src/lib/validate.ts`**

```ts
// Валидация, которая в легаси жила внутри Alpine-компонентов (draftHint).
// Возвращает текст подсказки: "" — валидно, иначе строка показывается
// рядом с полем и блокирует сохранение.

export function uniqueNameHint(name: string, taken: string[], selfIndex = -1): string {
  const trimmed = name.trim();
  if (!trimmed) return "Имя обязательно";
  const clash = taken.findIndex((n) => n === trimmed);
  if (clash !== -1 && clash !== selfIndex) return "Имя уже используется";
  return "";
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

// parseHostAddress приводит адрес к каноническому виду: голый IPv4 → /32,
// IPv4 в маске короче /32 не принимается, IPv6 — только /128.
// Легаси хранил голый IP без маски («10.0.0.5»), здесь нормализуем к /32
// (и /128 для IPv6) — это расхождение сознательное: на бэкенде
// projectdoc.parseHostPrefix всё равно сводит к полной маске, а единый
// канонический вид нужен поиску matchPrefixQuery и дедупликации адресов
// набора. В diff/историю адреса пишутся уже нормализованными.
export function parseHostAddress(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.split("/").length > 2) return null; // мусор вида «10.0.0.5/32/1»
  const [addr, bitsRaw] = v.split("/");
  const v4 = IPV4.exec(addr);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255)) return null;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (bits !== 32) return null;
    return `${addr}/32`;
  }
  if (IPV6.test(addr) && (addr.match(/:/g)?.length ?? 0) >= 2) {
    const bits = bitsRaw === undefined ? null : Number(bitsRaw);
    if (bits !== 128) return null;
    return `${addr}/128`;
  }
  return null;
}

// validPortSpec валидирует один или несколько (через запятую) спецификаций
// портов. Разделитель диапазона — «-», как в легаси rules.js и в
// internal/rules/validate.go (validatePortSpec): «80», «1024-2048».
// Двоеточие — это формат диагностики (handlers.go/compiler), здесь не оно.
export function validPortSpec(spec: string): boolean {
  if (!spec.trim()) return true;
  return spec.split(",").every((part) => {
    const p = part.trim();
    const range = p.split("-");
    if (range.length === 2) {
      const from = Number(range[0]);
      const to = Number(range[1]);
      return ok(from) && ok(to) && from < to;
    }
    if (range.length !== 1) return false;
    return ok(Number(p));
  });
}

const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
```

- [x] **Step 8: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm test
```

Expected: все тесты `lib/` и `api/` зелёные.

- [x] **Step 9: Commit**

```bash
cd /root/repos/firenet && git add frontend/src/lib && git commit -m "feat(frontend): port pure helpers for links, search and validation"
```

---

### Task 4: HTTP-клиент и CAS-ревизия

**Files:**
- Create: `frontend/src/api/revision.ts`, `frontend/src/api/revision.test.ts`, `frontend/src/api/client.ts`, `frontend/src/api/client.test.ts`

**Interfaces:**
- Produces: `ApiError`, `api.get/post/put/patch/del`, `loginRedirectURL`, `redirectToLogin`, `resetApiState()`; `getRevision`, `setRevision`, `resetRevision`, `revisionHeaders`.
- Consumes: типы из Task 2.

- [x] **Step 1: Написать `frontend/src/api/revision.test.ts`**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getRevision, resetRevision, revisionHeaders, setRevision } from "./revision";

describe("revision", () => {
  beforeEach(() => resetRevision());

  it("starts empty and returns no headers", () => {
    expect(getRevision()).toBeNull();
    expect(revisionHeaders()).toEqual({});
  });

  it("returns the CAS header once known", () => {
    setRevision("7");
    expect(revisionHeaders()).toEqual({ "X-Draft-Revision": "7" });
  });

  it("is reset when the draft changes", () => {
    setRevision("7");
    resetRevision();
    expect(getRevision()).toBeNull();
  });
});
```

- [x] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './revision'`.

- [x] **Step 3: Реализовать `frontend/src/api/revision.ts`**

```ts
// CAS-токен драфта: бэкенд выдаёт X-Draft-Revision на каждом чтении и
// сверяет его на каждой записи (409 при расхождении). Модульный стор
// повторяет роль lastDraftRevision из common.js: клиент пишет токен из
// любого ответа и шлёт его со следующей мутацией, вызывающие код об этом
// не думает.
let revision: string | null = null;

export const getRevision = (): string | null => revision;

export function setRevision(value: string | null): void {
  revision = value;
}

export const resetRevision = (): void => {
  revision = null;
};

export function revisionHeaders(): Record<string, string> {
  return revision ? { "X-Draft-Revision": revision } : {};
}
```

- [x] **Step 4: Написать `frontend/src/api/client.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, loginRedirectURL, resetApiState } from "./client";
import { getRevision } from "./revision";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("loginRedirectURL", () => {
  it("preserves a safe absolute path as ?next", () => {
    expect(loginRedirectURL("/ui/rules", "?q=1")).toBe("/login?next=%2Fui%2Frules%3Fq%3D1");
  });
  it("drops an open redirect", () => {
    expect(loginRedirectURL("//evil.example", "")).toBe("/login");
  });
  it("does not nest when already on /login", () => {
    expect(loginRedirectURL("/login", "")).toBe("/login");
  });
});

describe("api", () => {
  beforeEach(() => {
    resetApiState();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses JSON and records the revision header", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: 1 }, 200, { "X-Draft-Revision": "5" }));
    const data = await api.get<{ ok: number }>("/api/drafts/d1/topology");
    expect(data).toEqual({ ok: 1 });
    expect(getRevision()).toBe("5");
  });

  it("sends X-Draft-Revision on mutations", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: 1 }));
    await api.get("/api/x");
    await api.put("/api/y", { a: 1 });
    const [, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect((init!.headers as Record<string, string>)["X-Draft-Revision"]).toBe("5");
  });

  it("raises ApiError with the server message", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "name is required" }, 400));
    await expect(api.get("/api/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "name is required",
    });
  });

  it("redirects to /login on 401 and never resolves", async () => {
    delete (window as { location?: unknown }).location;
    (window as { location?: unknown }).location = { href: "", pathname: "/ui/links", search: "" };
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "authentication required" }, 401));
    const pending = api.get("/api/x");
    await expect(Promise.race([pending, Promise.resolve("resolved")])).resolves.toBe("resolved");
    expect(window.location.href).toBe("/login?next=%2Fui%2Flinks");
  });

  it("surfaces 401 on /login as a catchable ApiError (bad credentials)", async () => {
    delete (window as { location?: unknown }).location;
    (window as { location?: unknown }).location = { href: "", pathname: "/login", search: "" };
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "invalid username or password" }, 401));
    const err = await api.post("/api/login", { username: "admin", password: "wrong" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(window.location.href).toBe("");
  });

  it("surfaces 409 as a catchable ApiError", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "draft was changed" }, 409));
    const err = await api.put("/api/x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });
});
```

- [x] **Step 5: Реализовать `frontend/src/api/client.ts`**

```ts
import { resetRevision, revisionHeaders, setRevision } from "./revision";
import type { ErrorResponse } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

// loginRedirectURL повторяет common.js: без открытых редиректов и без
// вложенных /login?next=, если мы уже на странице логина.
export function loginRedirectURL(pathname: string, search: string): string {
  if (pathname === "/login") return pathname + search;
  const target = pathname + search;
  const safe = target.startsWith("/") && !target.startsWith("//");
  return "/login" + (safe ? "?next=" + encodeURIComponent(target) : "");
}

let loginRedirectPending: Promise<never> | null = null;

// Один общий pending-promise: страница грузит несколько ресурсов
// параллельно, и без него каждый 401 начал бы свою навигацию — следующий
// успел бы обернуть уже изменившийся URL ещё одним слоем ?next=.
function redirectToLogin(): Promise<never> {
  if (!loginRedirectPending) {
    window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
    loginRedirectPending = new Promise(() => {});
  }
  return loginRedirectPending;
}

export function resetApiState(): void {
  loginRedirectPending = null;
  resetRevision();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  if (method !== "GET") {
    Object.assign(init.headers as Record<string, string>, revisionHeaders());
  }

  const res = await fetch(path, init);
  setRevision(res.headers.get("X-Draft-Revision"));
  // На /login 401 — это просто неверные креды, а не потеря сессии: редирект
  // на /login при уже открытом /login бессмыслен и вешает промис. Поэтому
  // пропускаем redirectToLogin и даём странице показать ошибку (см. Task 8).
  if (res.status === 401 && window.location.pathname !== "/login") return redirectToLogin();
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (payload as ErrorResponse | null)?.error ?? res.statusText;
    throw new ApiError(res.status, message, payload);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
```

- [x] **Step 6: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm test
```

Expected: все зелёные (5 тестов `api` + 3 теста `loginRedirectURL` + 3 теста `revision`).

> **Правки относительно кода из плана (выявлены при реализации).**
> 1. Тест «sends X-Draft-Revision on mutations» использовал `mockResolvedValue` с одним `Response` на два запроса — тело `Response` читается один раз, тест падал с «Body is unusable». Заменён на `mockImplementation`, создающий свежий `Response`; в мок добавлен заголовок `X-Draft-Revision: "5"` (без него мутации неоткуда взять токен).
> 2. `client.ts` из плана делал безусловный `setRevision(res.headers.get(...))` — ответ без заголовка (не-драфтовый API) стирал бы CAS-токен драфта. Легаси `common.js` обновляет токен только когда заголовок пришёл (`if (rev) lastDraftRevision = rev`); реализация выровнена с легаси и добавлен тест «keeps the stored revision when a response has no header».

- [x] **Step 7: Commit**

```bash
cd /root/repos/firenet && git add frontend/src/api && git commit -m "feat(frontend): HTTP client with 401 redirect and draft revision CAS"
```

---

### Task 5: Контекст драфта

**Files:**
- Create: `frontend/src/draft/DraftContext.tsx`, `frontend/src/draft/DraftContext.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 4).
- Produces: `DraftProvider`, `useDraft(): { draftId: string | null; setDraftId(id: string | null): void; isReadOnly: boolean; scope: string; apiPath(suffix: string): string }`.

- [x] **Step 1: Написать `frontend/src/draft/DraftContext.test.tsx`**

```tsx
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftProvider, useDraft } from "./DraftContext";

function Probe() {
  const { draftId, isReadOnly, apiPath, setDraftId } = useDraft();
  return (
    <div>
      <span data-testid="draftId">{draftId ?? "-"}</span>
      <span data-testid="readOnly">{String(isReadOnly)}</span>
      <span data-testid="path">{apiPath("topology")}</span>
      <button onClick={() => setDraftId("d9")}>set</button>
      <button onClick={() => setDraftId(null)}>clear</button>
    </div>
  );
}

describe("DraftProvider", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("starts read-only and routes to the current version", () => {
    render(<DraftProvider><Probe /></DraftProvider>);
    expect(screen.getByTestId("readOnly").textContent).toBe("true");
    expect(screen.getByTestId("path").textContent).toBe("/api/versions/current/topology");
  });

  it("routes through the draft once set", async () => {
    render(<DraftProvider><Probe /></DraftProvider>);
    await act(async () => { screen.getByText("set").click(); });
    expect(screen.getByTestId("draftId").textContent).toBe("d9");
    expect(screen.getByTestId("path").textContent).toBe("/api/drafts/d9/topology");
    expect(localStorage.getItem("firenet-last-draft-id")).toBe("d9");
  });

  it("keeps read-only explicit for the tab and forgets the last draft", async () => {
    render(<DraftProvider><Probe /></DraftProvider>);
    await act(async () => { screen.getByText("set").click(); });
    await act(async () => { screen.getByText("clear").click(); });
    expect(screen.getByTestId("readOnly").textContent).toBe("true");
    expect(sessionStorage.getItem("firenet-draft-readonly")).toBe("1");
    expect(localStorage.getItem("firenet-last-draft-id")).toBeNull();
  });

  it("restores the last draft from localStorage in a new tab", () => {
    localStorage.setItem("firenet-last-draft-id", "d5");
    render(<DraftProvider><Probe /></DraftProvider>);
    expect(screen.getByTestId("draftId").textContent).toBe("d5");
  });

  it("throws outside the provider", () => {
    expect(() => renderHook(() => useDraft())).toThrow(/DraftProvider/);
  });
});
```

- [x] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './DraftContext'`.

- [x] **Step 3: Реализовать `frontend/src/draft/DraftContext.tsx`**

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { resetRevision } from "../api/revision";

// Ключи совпадают с common.js: e2e-хелпер openWithDraft пишет их напрямую
// через addInitScript, поэтому менять их нельзя.
const DRAFT_ID_KEY = "firenet-draft-id";
const LAST_DRAFT_ID_KEY = "firenet-last-draft-id";
const READONLY_KEY = "firenet-draft-readonly";

// Активный драфт живёт в sessionStorage (у каждого таба свой), последний —
// в localStorage, чтобы новый таб продолжил в нём же. READONLY_KEY —
// «этот таб сознательно вернулся к текущей версии», иначе sessionStorage
// пуст и мы бы снова подхватили последний драфт.
function readInitialDraft(): string | null {
  const active = sessionStorage.getItem(DRAFT_ID_KEY);
  if (active) return active;
  if (sessionStorage.getItem(READONLY_KEY)) return null;
  const last = localStorage.getItem(LAST_DRAFT_ID_KEY);
  if (last) sessionStorage.setItem(DRAFT_ID_KEY, last);
  return last || null;
}

type DraftContextValue = {
  draftId: string | null;
  setDraftId: (id: string | null) => void;
  isReadOnly: boolean;
  scope: string;
  apiPath: (suffix: string) => string;
};

const Ctx = createContext<DraftContextValue | null>(null);

export function DraftProvider({ children }: { children: ReactNode }) {
  const [draftId, setDraftIdState] = useState<string | null>(readInitialDraft);

  const setDraftId = useCallback((id: string | null) => {
    const previous = draftId; // активный драфт на момент вызова
    resetRevision(); // ревизия принадлежит драфту, к другому она не относится
    if (id) {
      sessionStorage.setItem(DRAFT_ID_KEY, id);
      sessionStorage.removeItem(READONLY_KEY);
      localStorage.setItem(LAST_DRAFT_ID_KEY, id);
    } else {
      sessionStorage.removeItem(DRAFT_ID_KEY);
      sessionStorage.setItem(READONLY_KEY, "1");
      if (localStorage.getItem(LAST_DRAFT_ID_KEY) === previous) {
        localStorage.removeItem(LAST_DRAFT_ID_KEY);
      }
    }
    setDraftIdState(id);
  }, [draftId]);

  const value = useMemo<DraftContextValue>(() => {
    const scope = draftId ? `draft:${draftId}` : "current";
    return {
      draftId,
      setDraftId,
      isReadOnly: !draftId,
      scope,
      apiPath: (suffix: string) =>
        draftId ? `/api/drafts/${draftId}/${suffix}` : `/api/versions/current/${suffix}`,
    };
  }, [draftId, setDraftId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDraft(): DraftContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useDraft must be used inside <DraftProvider>");
  return value;
}
```

- [x] **Step 4: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm test
```

Expected: зелёные.

- [x] **Step 5: Commit**

```bash
cd /root/repos/firenet && git add frontend/src/draft && git commit -m "feat(frontend): draft context with storage-compatible keys"
```

---

### Task 6: Хуки TanStack Query

**Files:**
- Create: `frontend/src/api/queries.ts`, `frontend/src/api/queries.test.tsx`, `frontend/src/test/msw.ts`

**Interfaces:**
- Consumes: `api` (Task 4), `useDraft` (Task 5), типы (Task 2).
- Produces: `projectKeys`, `useProjectResource`, `useProjectSave`, `useTopologyOperations`, `useDrafts`, `useMe`, `useVersions`, `useUsers`, `queryKeys`.

- [x] **Step 1: Создать `frontend/src/test/msw.ts`**

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as fx from "../api/fixtures";

// Один обработчик на ресурс: тесты переопределяют его через
// server.use(...) там, где нужен нестандартный ответ.
export const handlers = [
  http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
  http.get("/api/versions/current/topology", () => HttpResponse.json(fx.topologyFixture)),
  http.get("/api/versions/current/subnets", () => HttpResponse.json(fx.subnetsFixture)),
  http.get("/api/versions/current/rules", () => HttpResponse.json(fx.policyFixture)),
  http.get("/api/versions/current/layout", () => HttpResponse.json(fx.layoutFixture)),
  http.get("/api/drafts/:id/topology", () => HttpResponse.json(fx.topologyFixture)),
  http.get("/api/drafts/:id/subnets", () => HttpResponse.json(fx.subnetsFixture)),
  http.get("/api/drafts/:id/rules", () => HttpResponse.json(fx.policyFixture)),
  http.get("/api/drafts/:id/layout", () => HttpResponse.json(fx.layoutFixture)),
  http.put("/api/drafts/:id/topology", () => HttpResponse.json(fx.topologyFixture)),
  http.post("/api/drafts/:id/topology/operations", () =>
    HttpResponse.json(fx.editorSnapshotFixture, { headers: { "X-Draft-Revision": "2" } })),
  http.post("/api/drafts/:id/topology/operations/batch", () =>
    HttpResponse.json(fx.editorSnapshotFixture, { headers: { "X-Draft-Revision": "2" } })),
];

export const server = setupServer(...handlers);
```

- [x] **Step 2: Написать `frontend/src/api/queries.test.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { DraftProvider } from "../draft/DraftContext";
import * as fx from "./fixtures";
import { projectKeys, useProjectResource, useTopologyOperations } from "./queries";
import type { TopologyDoc } from "./types";

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
// readInitialDraft) и на sessionStorage не подписан, поэтому firenet-draft-id
// нужно выставить ДО renderHook — иначе useDraft() останется на current и
// apiPath не поведёт на /api/drafts/d1/....
function withDraft(id: string) {
  sessionStorage.setItem("firenet-draft-id", id);
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
    const { result } = renderHook(
      () => ({ ops: useTopologyOperations(), topo: useProjectResource<TopologyDoc>("topology") }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.topo.isSuccess).toBe(true));
    await result.current.ops.mutateAsync([{ kind: "set-camera", camera: { x: 1, y: 2, z: 3 } }]);
    await waitFor(() => expect(result.current.topo.data).toEqual(fx.topologyFixture));
  });
});
```

- [x] **Step 3: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './queries'`.

- [x] **Step 4: Реализовать `frontend/src/api/queries.ts`**

```ts
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useDraft } from "../draft/DraftContext";
import { api } from "./client";
import type {
  CompiledDevice, DiagnoseReport, DiagnoseRequest, DraftDiffEntry, DraftResponse,
  EditorSnapshot, LayoutDoc, LintResponse, PolicyDoc, SearchEntry, SpreadRequest,
  SpreadResult, SubnetsDoc, TopologyDoc, TopologyOperation, UserResponse,
  ValidateResponse, VersionInfo,
} from "./types";

// Ресурсы проекта, которые бывают и в драфте, и в текущей версии.
export type ProjectResource =
  | "topology" | "subnets" | "rules" | "layout" | "search-index" | "lint";

export const projectKeys = {
  all: ["project"] as const,
  scope: (scope: string) => ["project", scope] as const,
  resource: (scope: string, resource: ProjectResource) => ["project", scope, resource] as const,
  derived: (scope: string, name: string, args?: unknown) =>
    ["project", scope, "derived", name, args] as const,
};

export const queryKeys = {
  drafts: (all: boolean) => ["drafts", all] as const,
  versions: (limit: number) => ["versions", limit] as const,
  versionDiff: (from: number, to: number) => ["versions", "diff", from, to] as const,
  users: ["users"] as const,
  me: ["me"] as const,
};

export function useProjectResource<T>(resource: ProjectResource) {
  const { scope, apiPath } = useDraft();
  return useQuery({
    queryKey: projectKeys.resource(scope, resource),
    queryFn: () => api.get<T>(apiPath(resource)),
  });
}

type SaveOptions = {
  // Производные ресурсы, которые надо пересчитать после записи:
  // правка rules делает невалидными lint и search-index.
  invalidate?: ProjectResource[];
};

export function useProjectSave<T>(resource: ProjectResource, options: SaveOptions = {}) {
  const { scope, apiPath } = useDraft();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (doc: T) => api.put<T>(apiPath(resource), doc),
    onSuccess: (data) => {
      qc.setQueryData(projectKeys.resource(scope, resource), data);
      for (const derived of options.invalidate ?? []) {
        void qc.invalidateQueries({ queryKey: projectKeys.resource(scope, derived) });
      }
    },
  });
}

// Операции топологии возвращают EditorSnapshot — новый документ и layout
// сразу, без второго чтения. Одна операция уходит сама, несколько — батчем
// (бэкенд валидирует итог один раз).
export function useTopologyOperations() {
  const { scope, apiPath } = useDraft();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ops: TopologyOperation[]) =>
      ops.length === 1
        ? api.post<EditorSnapshot>(apiPath("topology/operations"), ops[0])
        : api.post<EditorSnapshot>(apiPath("topology/operations/batch"), { operations: ops }),
    onSuccess: (snapshot) => {
      qc.setQueryData(projectKeys.resource(scope, "topology"), snapshot.topology);
      qc.setQueryData(projectKeys.resource(scope, "layout"), snapshot.layout);
    },
  });
}

export function useLint() {
  const { scope, apiPath } = useDraft();
  return useQuery({
    queryKey: projectKeys.resource(scope, "lint"),
    queryFn: () => api.get<LintResponse>(apiPath("lint")),
  });
}

export type { UseQueryResult };

export function useCompile() {
  const { scope, apiPath } = useDraft();
  return useMutation({
    mutationFn: () => api.post<CompiledDevice[]>(apiPath("compile"), {}),
    mutationKey: projectKeys.derived(scope, "compile"),
  });
}

export function useValidate() {
  const { scope, apiPath } = useDraft();
  return useMutation({
    mutationFn: () => api.post<ValidateResponse>(apiPath("validate"), {}),
  });
}

export function useDiagnose() {
  const { scope, apiPath } = useDraft();
  return useMutation({
    mutationFn: (req: DiagnoseRequest) => api.post<DiagnoseReport>(apiPath("diagnose"), req),
  });
}

export function useSpread() {
  const { scope, apiPath } = useDraft();
  return useMutation({
    mutationFn: (req: SpreadRequest) => api.post<SpreadResult>(apiPath("diagnose/spread"), req),
  });
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api.get<UserResponse>("/api/me") });
}

export function useDrafts(all: boolean) {
  return useQuery({
    queryKey: queryKeys.drafts(all),
    queryFn: () => api.get<DraftResponse[]>(all ? "/api/drafts?all=1" : "/api/drafts"),
  });
}

export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<DraftResponse>("/api/drafts", { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useDraftDiff(id: string | null) {
  return useQuery({
    queryKey: ["drafts", id, "diff"],
    queryFn: () => api.get<DraftDiffEntry[]>(`/api/drafts/${id}/diff`),
    enabled: !!id,
  });
}

export function useConfirmDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ version: number }>(`/api/drafts/${id}/confirm`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["drafts"] });
      void qc.invalidateQueries({ queryKey: ["versions"] });
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/api/drafts/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useVersions(limit = 50) {
  return useQuery({
    queryKey: queryKeys.versions(limit),
    queryFn: () => api.get<VersionInfo[]>(`/api/versions?limit=${limit}`),
  });
}

export function useVersionDiff(from: number | null, to: number | null) {
  return useQuery({
    queryKey: queryKeys.versionDiff(from ?? 0, to ?? 0),
    queryFn: () => api.get<unknown[]>(`/api/versions/diff?from=${from}&to=${to}`),
    enabled: from !== null && to !== null,
  });
}

export function useRestoreVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (n: number) => api.post<{ version: number }>(`/api/versions/${n}/restore`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["versions"] }),
  });
}

export function useUsers() {
  return useQuery({ queryKey: queryKeys.users, queryFn: () => api.get<UserResponse[]>("/api/users") });
}

export function useSearchIndex() {
  const { scope, apiPath } = useDraft();
  return useQuery({
    queryKey: projectKeys.resource(scope, "search-index"),
    queryFn: () => api.get<SearchEntry[]>(apiPath("search-index")),
  });
}
```

- [x] **Step 5: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm test
```

Expected: зелёные.

- [x] **Step 6: Commit**

```bash
cd /root/repos/firenet && git add frontend/src/api frontend/src/test && git commit -m "feat(frontend): TanStack Query hooks for project resources and mutations"
```

---

### Task 7: Оболочка — тема, уведомления, сайдбар, баннер драфта

**Files:**
- Create: `frontend/src/components/theme.ts`, `frontend/src/components/notify.tsx`, `frontend/src/components/ErrorBoundary.tsx`, `frontend/src/components/Sidebar.tsx`, `frontend/src/components/DraftBanner.tsx`, `frontend/src/components/Layout.tsx`, `frontend/src/components/Layout.test.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `useMe` (Task 6), `useDraft` (Task 5), `api` (Task 4).
- Produces: `<Layout/>` — оболочка всех страниц; `notify()`, `<BannerHost/>`; `useTheme()`; `<Sidebar/>`; `<DraftBanner/>`.

- [x] **Step 1: Написать `frontend/src/components/Layout.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import * as fx from "../api/fixtures";
import { DraftProvider } from "../draft/DraftContext";
import Layout from "./Layout";

beforeAll(() => server.listen());
beforeEach(() => {
  // jsdom не реализует window.matchMedia (только браузеры), а initialTheme
  // из Sidebar вызывает его при монтировании — стабим, чтобы не падал.
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

function renderLayout(route = "/ui/subnets") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          {/* Outlet (в Layout) требует контекст родительского route, поэтому
              Layout оборачиваем в pathless <Route> с дочерней заглушкой. */}
          <Route element={<Layout />}>
            <Route path={route} element={<main data-testid="page" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Layout", () => {
  it("renders the sidebar with all nav links", async () => {
    renderLayout();
    expect(await screen.findByRole("link", { name: "Схема" })).toHaveAttribute("href", "/ui/topology");
    for (const label of ["Устройства", "Сети", "Подсети", "Наборы", "Правила", "Компиляция", "Черновики", "История"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active page", async () => {
    renderLayout("/ui/subnets");
    expect(await screen.findByRole("link", { name: "Подсети" })).toHaveClass("active");
  });

  it("hides Пользователи from non-admins and shows it to admins", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ ...fx.userFixture, role: "user" })));
    renderLayout();
    await screen.findByRole("link", { name: "Схема" });
    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
  });

  it("shows the read-only draft banner with the current version", async () => {
    server.use(http.get("/api/versions", () => HttpResponse.json([{ id: 7, createdAt: "2026-09-01T00:00:00Z" }])));
    renderLayout();
    expect(await screen.findByText(/Только чтение — версия 7/)).toBeInTheDocument();
  });

  it("shows the editing banner for an active draft", async () => {
    sessionStorage.setItem("firenet-draft-id", "d1");
    server.use(http.get("/api/drafts/d1", () => HttpResponse.json(fx.draftFixture)));
    renderLayout();
    expect(await screen.findByText(/Черновик «правки»/)).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './Layout'`.

- [x] **Step 3: Создать `frontend/src/components/theme.ts`**

```ts
// Тема: сохранённый выбор, иначе системная. initialTheme ничего не пишет,
// чтобы невыбранная тема продолжала следовать за системой.
// matchMedia — нативный window-API (в браузерах с 2015), но jsdom его не
// реализует, поэтому защищаемся проверкой typeof — без неё Sidebar упал бы
// в тестах при useState(initialTheme).
export function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem("firenet-theme");
  if (saved === "light" || saved === "dark") return saved;
  const mql = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
  return mql?.matches ? "dark" : "light";
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("firenet-theme", theme);
}
```

- [x] **Step 4: Создать `frontend/src/components/notify.ts`** (стор без React)

```ts
// Глобальные уведомления вместо Alpine-события notify: баннер показывается
// из любого места (мутация, 401, валидация) без проброса колбэков. Стор
// живёт отдельно от компонента, чтобы notify() работал и вне рендера.
export type Notice = { message: string; kind: "error" | "ok" };

let current: Notice | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function notify(message: string, kind: Notice["kind"] = "error"): void {
  current = { message, kind };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { current = null; emit(); }, 6000);
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getNotice = (): Notice | null => current;
```

- [x] **Step 4b: Создать `frontend/src/components/BannerHost.tsx`**

```tsx
import { useSyncExternalStore } from "react";
import { getNotice, subscribe } from "./notify";

export default function BannerHost() {
  const notice = useSyncExternalStore(subscribe, getNotice, () => null);
  if (!notice) return null;
  return (
    <div id="error-banner" className={`banner ${notice.kind}`} role="status" data-testid="banner">
      {notice.message}
    </div>
  );
}
```

- [x] **Step 5: Создать `frontend/src/components/ErrorBoundary.tsx`**

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

// Граница вокруг страницы: падение одной страницы не должно оставлять
// пользователя с белым экраном и без навигации.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("firenet: unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="page">
          <div className="banner error" data-testid="error-boundary">
            Что-то пошло не так: {this.state.error.message}
          </div>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Попробовать снова
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
```

- [x] **Step 6: Создать `frontend/src/components/Sidebar.tsx`**

```tsx
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api/client";
import { useMe } from "../api/queries";
import type { UserResponse } from "../api/types";
import { initialTheme, applyTheme } from "./theme";

// Группы 1:1 с NAV_GROUPS из common.js; состояние раскрытия — в localStorage
// под теми же ключами firenet-nav-<id>.
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

export default function Sidebar({ active }: { active: string }) {
  const { data: me } = useMe();
  const [theme, setTheme] = useState(initialTheme);
  const [collapsed, setCollapsed] = useState(localStorage.getItem("firenet-sidebar") === "collapsed");

  const toggleGroup = (id: string, open: boolean) => {
    localStorage.setItem("firenet-nav-" + id, open ? "open" : "closed");
  };

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    // «open» — ровно как легаси (common.js): развёрнутое состояние пишется
    // этим значением, чтобы ключ firenet-sidebar остался 1:1.
    localStorage.setItem("firenet-sidebar", next ? "collapsed" : "open");
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} data-testid="sidebar">
      <button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-label="Свернуть меню" />
      {NAV_GROUPS.map((group) => (
        <NavGroup key={group.id} group={group} active={active} onToggle={toggleGroup} />
      ))}
      <nav className="side-nav">
        {STANDALONE.filter((l) => !l.adminOnly || isAdmin(me)).map((link) => (
          <NavLink key={link.id} to={link.href} data-testid={`nav-${link.id}`}>
            <span className="label">{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="user-box">
        <span className="user-name">{me?.username ?? ""}</span>
        <button
          type="button"
          id="theme-toggle"
          className="theme-toggle"
          onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
          aria-label="Сменить тему"
        />
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

function NavGroup({ group, active, onToggle }: {
  group: (typeof NAV_GROUPS)[number];
  active: string;
  onToggle: (id: string, open: boolean) => void;
}) {
  const isActive = group.links.some((l) => l.id === active);
  const [open, setOpen] = useState(isActive || localStorage.getItem("firenet-nav-" + group.id) === "open");
  return (
    <div className={`nav-group${open ? "" : " closed"}`}>
      <button
        type="button"
        className="nav-group-header"
        onClick={() => { onToggle(group.id, !open); setOpen(!open); }}
      >
        {group.title}
      </button>
      {open && (
        <nav className="side-nav nav-group-links">
          {group.links.map((link) => (
            <NavLink
              key={link.id}
              to={link.href}
              className={link.id === active ? "active" : undefined}
              data-testid={`nav-${link.id}`}
            >
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

- [x] **Step 7: Создать `frontend/src/components/DraftBanner.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useCreateDraft, useVersions } from "../api/queries";
import type { DraftResponse } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { notify } from "./notify";

// Плашка контекста: что сейчас редактируется и как из этого выйти. Если
// активный драфт исчез (удалён или подтверждён в другом табе) — таб
// возвращается к текущей версии, как это делал renderDraftBanner.
// Расхождение с легаси: легаси при «исчезнувшем» драфте перезагружал
// страницу (window.location.reload()); здесь таб просто переключается на
// текущую версию без перезагрузки — в реактивной модели это то же самое.
export default function DraftBanner() {
  const { draftId, setDraftId } = useDraft();
  const createDraft = useCreateDraft();
  const [name, setName] = useState("");
  const exit = () => setDraftId(null);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    void api
      .get<DraftResponse>(`/api/drafts/${draftId}`)
      .then((draft) => {
        if (cancelled) return;
        if (draft.status === "merged") exit();
        else setName(draft.name);
      })
      .catch(() => { if (!cancelled) exit(); });
    return () => { cancelled = true; };
  }, [draftId]);

  if (!draftId) return <ReadonlyBanner onCreate={createDraft} />;

  return (
    <div className="draft-banner draft-banner-editing" data-testid="draft-banner">
      <span>Черновик «{name}».</span>
      <button type="button" onClick={exit}>Вернуться к текущей версии</button>
    </div>
  );
}

// Имя черновика — отдельный input, а не window.prompt: легаси использовал
// Alpine-хелпер prompt, которого в React-приложении нет (и в стандартных
// браузерах window.prompt не существует).
function ReadonlyBanner({ onCreate }: { onCreate: ReturnType<typeof useCreateDraft> }) {
  const { data: versions } = useVersions(1);
  const version = versions?.[0];
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const draft = await onCreate.mutateAsync(name);
      sessionStorage.setItem("firenet-draft-id", draft.id);
      localStorage.setItem("firenet-last-draft-id", draft.id);
      window.location.reload();
    } catch (error) {
      notify(`Не удалось создать черновик: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-banner draft-banner-readonly" data-testid="draft-banner">
      <span>Только чтение — версия {version ? version.id : "—"}.</span>
      <label>
        Имя черновика
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="button" onClick={() => void submit()} disabled={!name.trim() || busy}>
        Открыть черновик
      </button>
    </div>
  );
}
```

- [x] **Step 8: Создать `frontend/src/components/Layout.tsx`**

```tsx
import { Outlet, useLocation } from "react-router-dom";
import { DraftProvider } from "../draft/DraftContext";
import BannerHost from "./BannerHost";
import DraftBanner from "./DraftBanner";
import ErrorBoundary from "./ErrorBoundary";
import Sidebar from "./Sidebar";

// active = второй сегмент пути (/ui/rules -> rules). Страницы users и search
// работают с данными вне драфта, поэтому баннер им не нужен.
const NO_DRAFT_BANNER = new Set(["users", "search"]);

function activeFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0] ?? "";
}

export default function Layout() {
  const { pathname } = useLocation();
  const active = activeFromPath(pathname);
  const showBanner = !NO_DRAFT_BANNER.has(active);

  return (
    <DraftProvider>
      <div className="app-shell">
        <Sidebar active={active} />
        <main>
          <BannerHost />
          {showBanner && <DraftBanner />}
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </DraftProvider>
  );
}
```


- [x] **Step 9: Подключить `Layout` в `App.tsx`**

Заменить содержимое `frontend/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";

// Пути 1:1 с легаси-страницами Go. Страницы появляются в задачах 8–20;
// до этого рендерятся заглушки с data-testid="page-<name>".
const routes: Array<[string, string]> = [
  ["/ui/topology", "topology"],
  ["/ui/subnets", "subnets"],
  ["/ui/networks", "networks"],
  ["/ui/devices", "devices"],
  ["/ui/sets", "sets"],
  ["/ui/unions", "unions"],
  ["/ui/links", "links"],
  ["/ui/rules", "rules"],
  ["/ui/compile", "compile"],
  ["/ui/diagnose", "diagnose"],
  ["/ui/users", "users"],
  ["/ui/drafts", "drafts"],
  ["/ui/history", "history"],
  ["/ui/search", "search"],
];

function Placeholder({ name }: { name: string }) {
  return <main className="page" data-testid={`page-${name}`}>{name}</main>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/ui/topology" replace />} />
        {routes.map(([path, name]) => (
          <Route key={path} path={path} element={<Placeholder name={name} />} />
        ))}
        <Route path="*" element={<Placeholder name="notfound" />} />
      </Route>
      <Route path="/login" element={<Placeholder name="login" />} />
      <Route path="/invite/:token" element={<Placeholder name="invite" />} />
    </Routes>
  );
}
```

- [x] **Step 10: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные (включая тесты `Layout`).

- [x] **Step 11: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): app shell with sidebar, theme, notifications and draft banner"
```

---

### Task 8: Логин и инвайт

**Files:**
- Create: `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/LoginPage.test.tsx`, `frontend/src/pages/InvitePage.tsx`, `frontend/src/pages/InvitePage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `api` (Task 4).
- Produces: `<LoginPage/>`, `<InvitePage/>`.

- [ ] **Step 1: Написать `frontend/src/pages/LoginPage.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

describe("LoginPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete (window as { location?: unknown }).location;
    (window as { location?: unknown }).location = { href: "", search: "?next=%2Fui%2Frules" };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts credentials and follows ?next on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "1", username: "admin", role: "admin", activated: true, createdAt: "",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // useSearchParams читает ?next из router-контекста (MemoryRouter), а не из
    // window.location, поэтому initialEntries — единственный способ задать next.
    render(<MemoryRouter initialEntries={["/login?next=%2Fui%2Frules"]}><LoginPage /></MemoryRouter>);

    await userEvent.type(screen.getByLabelText("Логин"), "admin");
    await userEvent.type(screen.getByLabelText("Пароль"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/login");
    expect(JSON.parse(init.body as string)).toEqual({ username: "admin", password: "secret" });
    expect(navigate).toHaveBeenCalledWith("/ui/rules");
  });

  it("shows the server error on bad credentials", async () => {
    // 401 от /api/login — это неверные креды, а не потеря сессии: клиент
    // (Task 4) не редиректит, а бросает ApiError с message бэкенда, который
    // LoginPage показывает в #login-error.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid username or password" }), { status: 401 })));
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText("invalid username or password")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './LoginPage'`.

- [ ] **Step 3: Реализовать `frontend/src/pages/LoginPage.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { UserResponse } from "../api/types";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // next из ?next= — единственный источник цели после логина. Путь вида
  // //host отбрасывается, иначе это открытый редирект.
  const nextParam = params.get("next") ?? "";
  const target = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/ui/topology";
  // activated=1 — notice после успешной активации через инвайт (легаси login.js).
  const activated = params.get("activated") === "1";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      // Клиент (Task 4) не редиректит 401 на /login — мы уже здесь, поэтому
      // ошибка приходит как ApiError с message бэкенда и попадает в catch.
      await api.post<UserResponse>("/api/login", { username, password });
      navigate(target, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" data-testid="page-login">
      <form id="login-form" className="modal-grid" onSubmit={submit} data-testid="login-form">
        <h1>firenet</h1>
        {activated && <p className="cell-hint" data-testid="login-notice">Пароль задан. Можно войти.</p>}
        <label>
          Логин
          <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Пароль
          <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="cell-hint" data-testid="login-error">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="primary" disabled={busy || !username || !password}>Войти</button>
        </div>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Написать `frontend/src/pages/InvitePage.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import InvitePage from "./InvitePage";

function renderInvite() {
  return render(
    <MemoryRouter initialEntries={["/invite/tok123"]}>
      <Routes><Route path="/invite/:token" element={<InvitePage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("InvitePage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the invited username", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: "bob" }), { status: 200 })));
    renderInvite();
    expect(await screen.findByText(/bob/)).toBeInTheDocument();
  });

  it("reports an expired invite with its 410 state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invite expired" }), { status: 410 })));
    renderInvite();
    expect(await screen.findByText("invite expired")).toBeInTheDocument();
  });

  it("submits the password and confirms success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ username: "bob" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderInvite();
    await screen.findByText(/bob/);
    await userEvent.type(screen.getByLabelText("Пароль"), "longpassword1");
    await userEvent.type(screen.getByLabelText("Повторите пароль"), "longpassword1");
    await userEvent.click(screen.getByRole("button", { name: "Активировать" }));
    expect(await screen.findByText(/Пароль задан/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/invites/tok123");
    expect(JSON.parse(init.body as string)).toEqual({ password: "longpassword1", confirmPassword: "longpassword1" });
  });

  it("rejects a mismatch without sending it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ username: "bob" }), { status: 200 })));
    renderInvite();
    await screen.findByText(/bob/);
    await userEvent.type(screen.getByLabelText("Пароль"), "longpassword1");
    await userEvent.type(screen.getByLabelText("Повторите пароль"), "other-password");
    await userEvent.click(screen.getByRole("button", { name: "Активировать" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Реализовать `frontend/src/pages/InvitePage.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { InviteInfoResponse } from "../api/types";

export default function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.get<InviteInfoResponse>(`/api/invites/${token}`)
      .then((info) => { if (!cancelled) setUsername(info.username); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Ссылка недоступна");
      });
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Пароли не совпадают");
      return;
    }
    try {
      await api.post<void>(`/api/invites/${token}`, { password, confirmPassword: confirm });
      setDone(true);
      // ?activated=1 — как в легаси invite.js: login.js показывает по нему notice.
      setTimeout(() => navigate("/login?activated=1", { replace: true }), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось задать пароль");
    }
  };

  return (
    <main className="page" data-testid="page-invite">
      <form className="modal-grid" onSubmit={submit}>
        <h1>Активация{username ? `: ${username}` : ""}</h1>
        {done ? (
          <p data-testid="invite-done">Пароль задан. Можно войти.</p>
        ) : (
          <>
            <label>
              Пароль
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              Повторите пароль
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <div className="modal-actions">
              <button type="submit" className="primary" disabled={!password || !confirm}>Активировать</button>
            </div>
          </>
        )}
        {error && <p className="cell-hint" data-testid="invite-error">{error}</p>}
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Зарегистрировать страницы в `App.tsx`**

Добавить импорты и заменить два маршрута вне `Layout`:

```tsx
import InvitePage from "./pages/InvitePage";
import LoginPage from "./pages/LoginPage";
...
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
```

- [ ] **Step 7: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 8: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): login and invite pages"
```

---

### Task 9: Переиспользуемые UI-компоненты таблиц

**Files:**
- Create: `frontend/src/components/ui/Modal.tsx`, `frontend/src/components/ui/DataTable.tsx`, `frontend/src/components/ui/DataTable.test.tsx`, `frontend/src/components/ui/MemberList.tsx`, `frontend/src/components/ui/Combo.tsx`, `frontend/src/components/ui/useDirtyGuard.ts`, `frontend/src/components/ui/useDirtyGuard.test.ts`

**Interfaces:**
- Consumes: `lib/search` (Task 3).
- Produces: `<Modal>`, `<DataTable>` + `Column<T>`, `<MemberList>`, `<Combo>`, `useDirtyGuard`.

Эти компоненты закрывают повторяющуюся часть всех табличных страниц: модалка, таблица с фильтрами, список участников с комбобоксом, защита от потери правок.

- [ ] **Step 1: Написать `frontend/src/components/ui/useDirtyGuard.test.ts`**

```ts
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDirtyGuard } from "./useDirtyGuard";

describe("useDirtyGuard", () => {
  it("is clean right after arming", () => {
    const data = { a: 1 };
    const { result } = renderHook(() => useDirtyGuard(() => data));
    expect(result.current.isDirty()).toBe(false);
  });

  it("becomes dirty once the document changes and clean after markClean", () => {
    const data = { a: 1 };
    const { result } = renderHook(() => useDirtyGuard(() => data));
    data.a = 2;
    expect(result.current.isDirty()).toBe(true);
    result.current.markClean();
    expect(result.current.isDirty()).toBe(false);
  });

  it("blocks unload while dirty", () => {
    const data = { a: 1 };
    renderHook(() => useDirtyGuard(() => data));
    data.a = 2;
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './useDirtyGuard'`.

- [ ] **Step 3: Реализовать `frontend/src/components/ui/useDirtyGuard.ts`**

```ts
import { useEffect, useRef } from "react";

export const DIRTY_MESSAGE = "Есть несохранённые изменения. Покинуть страницу без сохранения?";

// Порт DirtyGuard из common.js: baseline снимается в момент вызова,
// markClean — после успешного сохранения.
export function useDirtyGuard<T>(getData: () => T) {
  const baseline = useRef<string>(JSON.stringify(getData()));

  const isDirty = () => JSON.stringify(getData()) !== baseline.current;
  const markClean = () => { baseline.current = JSON.stringify(getData()); };

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return { isDirty, markClean, MESSAGE: DIRTY_MESSAGE };
}
```

- [ ] **Step 4: Написать `frontend/src/components/ui/DataTable.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import DataTable, { type Column } from "./DataTable";

type Row = { name: string; cidr: string };

const columns: Column<Row>[] = [
  { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => r.name.toLowerCase().includes(q.toLowerCase()) },
  { key: "cidr", title: "CIDR", render: (r) => r.cidr },
];

const rows: Row[] = [
  { name: "lan", cidr: "10.0.0.0/24" },
  { name: "dmz", cidr: "192.168.0.0/24" },
];

describe("DataTable", () => {
  it("renders rows and column titles", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    expect(screen.getByText("lan")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
  });

  it("filters by the searchable column", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    await userEvent.click(screen.getByTitle("Поиск"));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "dm");
    expect(screen.queryByText("lan")).toBeNull();
    expect(screen.getByText("dmz")).toBeInTheDocument();
  });

  it("shows the empty state for no matches", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.name} />);
    await userEvent.click(screen.getByTitle("Поиск"));
    await userEvent.type(screen.getByPlaceholderText("Имя"), "zzz");
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("shows a custom empty state when there is no data at all", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.name} empty="Подсетей нет" />);
    expect(screen.getByText("Подсетей нет")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Реализовать `frontend/src/components/ui/DataTable.tsx`**

```tsx
import { useMemo, useState } from "react";

export type Column<T> = {
  key: string;
  title: string;
  render: (row: T) => React.ReactNode;
  // Без filter колонка не участвует в поиске (например, кнопки действий).
  filter?: (row: T, query: string) => boolean;
  width?: string;
};

type Props<T> = {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
  actions?: React.ReactNode;
  hint?: React.ReactNode;
};

// Таблица страниц: тулбар с поиском, вторая строка заголовка с фильтрами.
// Ширины колонок фиксированные — перенос ресайза из columns.js вынесен
// в отдельную задачу.
export default function DataTable<T>({ columns, rows, rowKey, empty, actions, hint }: Props<T>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});

  const searchable = useMemo(() => columns.filter((c) => c.filter), [columns]);
  const visible = useMemo(
    () => rows.filter((row) => searchable.every((c) => !filters[c.key] || c.filter!(row, filters[c.key]))),
    [rows, filters, searchable],
  );

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <div className="toolbar-text">{hint}</div>
        <div className="toolbar-actions">
          {searchable.length > 0 && (
            <button type="button" className="btn-search" title="Поиск" onClick={() => setSearchOpen(!searchOpen)} />
          )}
          {actions}
        </div>
      </div>
      <table className="data-table" data-testid="data-table">
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.title}</th>)}</tr>
          {searchOpen && (
            <tr className="search-row">
              {columns.map((c) => (
                <th key={c.key}>
                  {c.filter && (
                    <input
                      placeholder={c.title}
                      value={filters[c.key] ?? ""}
                      onChange={(e) => setFilters({ ...filters, [c.key]: e.target.value })}
                    />
                  )}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => <td key={c.key}>{c.render(row)}</td>)}
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={columns.length}>
                {rows.length === 0 ? empty ?? "Ничего не добавлено" : "Ничего не найдено"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Создать `frontend/src/components/ui/Modal.tsx`**

```tsx
import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
};

// Нативный <dialog> — тот же элемент, что в легаси, поэтому стили
// (.modal, ::backdrop, .modal-actions) работают без правок.
export default function Modal({ open, title, onClose, children, footer, wide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className={`modal${wide ? " modal-lg" : ""}`} onCancel={onClose} onClose={onClose}>
      <h3>{title}</h3>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-actions">{footer}</div>}
    </dialog>
  );
}
```

- [ ] **Step 7: Создать `frontend/src/components/ui/Combo.tsx`**

```tsx
import { useState } from "react";

type Props = {
  items: string[];
  placeholder?: string;
  onPick: (value: string) => void;
};

// Комбобокс с клавиатурной навигацией (↑/↓/Enter/Esc) — заменяет
// member-combo из легаси-страниц. Список кандидатов фильтруется на месте.
export default function Combo({ items, placeholder, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const filtered = items.filter((i) => i.toLowerCase().includes(search.toLowerCase()));

  const pick = (value: string) => {
    onPick(value);
    setSearch("");
    setOpen(false);
    setCursor(0);
  };

  return (
    <div className="member-combo">
      <input
        value={search}
        placeholder={placeholder ?? "начните вводить для поиска"}
        onChange={(e) => { setSearch(e.target.value); setOpen(true); setCursor(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(cursor + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(cursor - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (filtered[cursor]) pick(filtered[cursor]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className={`member-combo-toggle${open ? " open" : ""}`} onClick={() => setOpen(!open)} />
      {open && (
        <div className="member-suggestions">
          {filtered.map((item, i) => (
            <button
              type="button"
              key={item}
              className={`member-suggestion${i === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              {item}
            </button>
          ))}
          {filtered.length === 0 && <p className="hint member-empty">Ничего не найдено</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Создать `frontend/src/components/ui/MemberList.tsx`**

```tsx
import Combo from "./Combo";

type Props = {
  members: string[];
  // Подпись справа от имени: CIDR подсети и т.п.
  detailOf?: (name: string) => string;
  onRemove?: (name: string) => void;
  candidates?: string[];
  onAdd?: (name: string) => void;
  addPlaceholder?: string;
  readOnly?: boolean;
  empty?: string;
};

// Список участников с комбобоксом добавления: подсети сети, адреса набора,
// экспорты связи, эндпоинты правила. Одна разметка на все страницы.
export default function MemberList({
  members, detailOf, onRemove, candidates, onAdd, addPlaceholder, readOnly, empty,
}: Props) {
  return (
    <div className="member-list">
      {members.map((name) => (
        <div className="member-row" key={name}>
          <span className="owner-badge">{name}</span>
          {detailOf && <span className="hint">{detailOf(name)}</span>}
          {!readOnly && onRemove && (
            <button type="button" className="icon-btn delete" title="Убрать" onClick={() => onRemove(name)}>×</button>
          )}
        </div>
      ))}
      {members.length === 0 && <p className="hint member-empty">{empty ?? "Ничего не добавлено"}</p>}
      {!readOnly && onAdd && candidates && (
        <div className="member-add">
          <Combo items={candidates} placeholder={addPlaceholder} onPick={onAdd} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 9: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 10: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): shared table, modal, combo and dirty-guard components"
```

---

### Task 10: Страница подсетей и общий тестовый хелпер

**Files:**
- Create: `frontend/src/test/renderPage.tsx`, `frontend/src/pages/SubnetsPage.tsx`, `frontend/src/pages/SubnetsPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useProjectResource`, `useProjectSave` (Task 6), `DataTable`/`Modal` (Task 9), `ipv4CidrOverlap`/`containsFold` (Task 3), `uniqueNameHint` (Task 3).
- Produces: `renderPage()` (используется всеми следующими тестами страниц), `<SubnetsPage/>`.

- [ ] **Step 1: Создать `frontend/src/test/renderPage.tsx`**

```tsx
import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BannerHost from "../components/BannerHost";
import DraftBanner from "../components/DraftBanner";
import { DraftProvider } from "../draft/DraftContext";

// Одна обёртка на все тесты страниц: QueryClient без ретраев (иначе падение
// превращается в три попытки и таймаут), DraftProvider и роутер на нужном
// пути. Активный драфт задаётся через sessionStorage — ровно так, как это
// делает e2e-хелпер openWithDraft.
//
// BannerHost и DraftBanner монтируются здесь, а не внутри страниц: страницы
// выводят уведомления через notify() и не рендерят сам баннер. Без BannerHost
// тесты, ищущие data-testid="banner" (HistoryPage restore, DraftsPage 409,
// TopologyPage/RulesPage в режиме read-only), не нашли бы его и зависли бы в
// waitFor до таймаута.
export function renderPage(ui: ReactNode, path = "/ui/subnets", draftId?: string): RenderResult & {
  user: ReturnType<typeof userEvent.setup>;
} {
  if (draftId) sessionStorage.setItem("firenet-draft-id", draftId);
  else sessionStorage.clear();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <DraftProvider>
          <BannerHost />
          <DraftBanner />
          <Routes><Route path={path} element={<>{ui}</>} /></Routes>
        </DraftProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, user: userEvent.setup() };
}
```

> **Порядок задач и зависимость от Task 7/13:** `renderPage` монтирует `BannerHost` и `DraftBanner` из `frontend/src/components/` (задача 7). Поэтому Task 13 (который определяет `renderPage`) можно выполнять **только после Task 7** — иначе импорты `../components/BannerHost` и `../components/DraftBanner` не найдутся. Если по какой-то причине Task 7 ещё не готов, а тестировать страницы нужно раньше, баннеры временно не включаются, а тесты, ищущие `data-testid="banner"`/`draft-banner`, пропускаются и возвращаются после готовности Task 7. Самый надёжный путь — придерживаться исходной нумерации: Task 7 (`components`) → Task 13 (`renderPage`) → страницы.

- [ ] **Step 2: Написать `frontend/src/pages/SubnetsPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import SubnetsPage from "./SubnetsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("SubnetsPage", () => {
  it("lists subnets with their owning network", async () => {
    renderPage(<SubnetsPage />);
    expect(await screen.findByText("lan")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
    expect(screen.getByText("office")).toBeInTheDocument();
  });

  it("blocks editing without a draft", async () => {
    const { user } = renderPage(<SubnetsPage />);
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Изменить подсеть lan"));
    expect(await screen.findByText(/Только чтение/)).toBeInTheDocument();
  });

  it("rejects a duplicate name in the edit dialog", async () => {
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Изменить подсеть lan"));
    const nameInput = await screen.findByLabelText("Имя");
    await user.clear(nameInput);
    await user.type(nameInput, "lan");
    expect(screen.getByText("Имя уже используется")).toBeInTheDocument();
  });

  it("rejects an overlapping CIDR", async () => {
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Добавить подсеть"));
    await user.type(await screen.findByLabelText("Имя"), "guest");
    await user.type(screen.getByLabelText("CIDR"), "10.0.0.128/25");
    expect(screen.getByText(/Пересекается с lan/)).toBeInTheDocument();
  });

  it("saves the whole list through PUT", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/subnets", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.subnetsFixture);
    }));
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Добавить подсеть"));
    await user.type(await screen.findByLabelText("Имя"), "guest");
    await user.type(screen.getByLabelText("CIDR"), "192.168.5.0/24");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Подсети сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({
      subnets: expect.arrayContaining([{ name: "guest", cidr: "192.168.5.0/24" }]),
    });
  });

  it("asks before deleting", async () => {
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    const { user } = renderPage(<SubnetsPage />, "/ui/subnets", "d1");
    await screen.findByText("lan");
    await user.click(screen.getByTitle("Удалить подсеть lan"));
    expect(confirm).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './SubnetsPage'`.

- [ ] **Step 4: Реализовать `frontend/src/pages/SubnetsPage.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { SubnetDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, ipv4CidrOverlap } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; cidr: string; description: string };

export default function SubnetsPage() {
  const { isReadOnly } = useDraft();
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const topology = useProjectResource<TopologyDoc>("topology");
  const save = useProjectSave<SubnetsDoc>("subnets");
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = subnets.data?.subnets ?? [];

  // Сеть-владелец выводится обратным поиском: привязка хранится на сети,
  // а не на подсети.
  const ownerOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const net of topology.data?.networks ?? []) {
      for (const s of net.subnets ?? []) map.set(s, net.name);
    }
    return map;
  }, [topology.data]);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    setEditing(row
      ? { index, name: row.name, cidr: row.cidr, description: row.description ?? "" }
      : { index: -1, name: "", cidr: "", description: "" });
  };

  const hint = editing ? subnetHint(editing, rows) : "";

  const persist = async (list: SubnetDoc[]) => {
    try {
      await save.mutateAsync({ subnets: list });
      setEditing(null);
      notify("Подсети сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const next: SubnetDoc = { name: editing.name.trim(), cidr: editing.cidr.trim() };
    if (editing.description.trim()) next.description = editing.description.trim();
    const list = rows.slice();
    if (editing.index >= 0) list[editing.index] = next;
    else list.push(next);
    void persist(list);
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить подсеть ${rows[index].name}?`)) return;
    void persist(rows.filter((_, i) => i !== index));
  };

  const columns: Column<SubnetDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    { key: "cidr", title: "CIDR", render: (r) => r.cidr, filter: (r, q) => containsFold(r.cidr, q) },
    {
      key: "owner",
      title: "Сеть",
      render: (r) => ownerOf.get(r.name)
        ? <span className="owner-badge">{ownerOf.get(r.name)}</span>
        : <span className="hint">не входит ни в одну сеть</span>,
      filter: (r, q) => containsFold(ownerOf.get(r.name), q),
    },
    {
      key: "description",
      title: "Описание",
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить подсеть ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить подсеть ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-subnets">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Подсетей нет — добавьте первую"
        hint={<><h3>Подсети</h3><p className="hint">Именованные CIDR-блоки, из которых собираются сети и наборы.</p></>}
        actions={<button type="button" className="primary" title="Добавить подсеть" onClick={() => open(-1)}>+ Подсеть</button>}
      />
      <Modal
        open={!!editing}
        title={editing && editing.index >= 0 ? "Изменить подсеть" : "Новая подсеть"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || save.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="lan" />
            </label>
            <label>
              CIDR
              <input value={editing.cidr} onChange={(e) => setEditing({ ...editing, cidr: e.target.value })} placeholder="10.0.0.0/24" />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}

// Та же последовательность проверок, что в легаси: имя и CIDR обязательны,
// имя уникально, CIDR не пересекается с существующими.
function subnetHint(draft: Draft, rows: SubnetDoc[]): string {
  if (!draft.name.trim()) return "Имя обязательно";
  if (!draft.cidr.trim()) return "CIDR обязателен";
  const nameHint = uniqueNameHint(draft.name, rows.map((r) => r.name), draft.index);
  if (nameHint) return nameHint; // имя уже занято (пустое отсечено выше)
  const clash = rows.find((r, i) => i !== draft.index && ipv4CidrOverlap(r.cidr, draft.cidr));
  if (clash) return `Пересекается с ${clash.name} (${clash.cidr})`;
  return "";
}
```

- [ ] **Step 5: Зарегистрировать маршрут в `App.tsx`**

Добавить импорт `SubnetsPage` и заменить в `routes.map` элемент для `/ui/subnets`: проще всего убрать `["/ui/subnets", "subnets"]` из массива `routes` и добавить явный маршрут рядом:

```tsx
import SubnetsPage from "./pages/SubnetsPage";
...
        <Route path="/ui/subnets" element={<SubnetsPage />} />
```

Остальные пути пока остаются на `Placeholder`.

- [ ] **Step 6: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 7: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): subnets page and shared page test helper"
```

---

### Task 11: Страницы сетей и устройств

**Files:**
- Create: `frontend/src/pages/NetworksPage.tsx`, `frontend/src/pages/NetworksPage.test.tsx`, `frontend/src/pages/DevicesPage.tsx`, `frontend/src/pages/DevicesPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useProjectResource`, `useTopologyOperations` (Task 6), `MemberList`/`DataTable`/`Modal` (Task 9), `matchSubnetMembers` (Task 3).
- Produces: `<NetworksPage/>`, `<DevicesPage/>`.

Обе страницы правят топологию операциями, а не `PUT` всего документа: сети — `update-network`/`delete-network`, устройства — батч `update-device` + `union-remove-device` + `union-add-device`.

- [ ] **Step 1: Написать `frontend/src/pages/NetworksPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import NetworksPage from "./NetworksPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("NetworksPage", () => {
  it("lists networks with their subnets", async () => {
    renderPage(<NetworksPage />, "/ui/networks", "d1");
    expect(await screen.findByText("office")).toBeInTheDocument();
    expect(screen.getByText("lan")).toBeInTheDocument();
  });

  it("saves a rename through the update-network operation", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<NetworksPage />, "/ui/networks", "d1");
    await screen.findByText("office");
    await user.click(screen.getByTitle("Изменить сеть office"));
    const nameInput = await screen.findByLabelText("Имя");
    await user.clear(nameInput);
    await user.type(nameInput, "office2");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Сети сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({
      kind: "update-network",
      networkName: "office",
      network: expect.objectContaining({ name: "office2" }),
    });
  });

  it("offers only free subnets in the add combo", async () => {
    server.use(http.get("/api/drafts/d1/subnets", () => HttpResponse.json({
      subnets: [{ name: "lan", cidr: "10.0.0.0/24" }, { name: "guest", cidr: "192.168.5.0/24" }],
    })));
    const { user } = renderPage(<NetworksPage />, "/ui/networks", "d1");
    await screen.findByText("office");
    await user.click(screen.getByTitle("Изменить сеть office"));
    await screen.findByLabelText("Имя");
    // lan уже в этой сети, guest свободна
    expect(screen.queryByText("lan (10.0.0.0/24)")).toBeNull();
    await user.click(screen.getByPlaceholderText("все подсети — начните вводить для поиска"));
    expect(screen.getByText("guest (192.168.5.0/24)")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './NetworksPage'`.

- [ ] **Step 3: Реализовать `frontend/src/pages/NetworksPage.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useProjectResource, useTopologyOperations } from "../api/queries";
import type { NetworkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; subnets: string[]; description: string };

export default function NetworksPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const ops = useTopologyOperations();
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = topology.data?.networks ?? [];
  const allSubnets = subnets.data?.subnets ?? [];
  const cidrOf = useMemo(() => {
    const map = new Map(allSubnets.map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [allSubnets]);

  // Инвариант легаси: подсеть входит не более чем в одну сеть, поэтому
  // кандидат должен быть свободен либо уже принадлежать этой сети.
  const candidates = (draft: Draft) =>
    allSubnets
      .filter((s) => !rows.some((n, i) => i !== draft.index && (n.subnets ?? []).includes(s.name)))
      .filter((s) => !draft.subnets.includes(s.name))
      .map((s) => `${s.name} (${s.cidr})`);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    if (!row) return;
    setEditing({ index, name: row.name, subnets: [...(row.subnets ?? [])], description: row.description ?? "" });
  };

  const hint = editing ? uniqueNameHint(editing.name, rows.map((r) => r.name), editing.index) : "";

  const run = async (operation: Record<string, unknown>, message: string) => {
    try {
      await ops.mutateAsync([operation as never]);
      setEditing(null);
      notify(message, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const original = rows[editing.index];
    const network: NetworkDoc = {
      name: editing.name.trim(),
      subnets: editing.subnets,
      attach: original?.attach ?? [],
    };
    if (editing.description.trim()) network.description = editing.description.trim();
    void run({ kind: "update-network", networkName: original.name, network }, "Сети сохранены");
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить сеть ${rows[index].name}?`)) return;
    void run({ kind: "delete-network", networkName: rows[index].name }, "Сети сохранены");
  };

  const columns: Column<NetworkDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "subnets",
      title: "Подсети",
      render: (r) => (r.subnets?.length
        ? r.subnets.map((s) => <span className="owner-badge" key={s}>{s}</span>)
        : <span className="hint">нет подсетей</span>),
      filter: (r, q) => matchSubnetMembers(r.subnets, cidrOf, q),
    },
    {
      key: "description",
      title: "Описание",
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить сеть ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить сеть ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-networks">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Сетей нет — создайте их на схеме"
        hint={<><h3>Сети</h3><p className="hint">L2-сегменты: привязка к устройствам и список подсетей.</p></>}
      />
      <Modal
        open={!!editing}
        wide
        title="Изменить сеть"
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || ops.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label>
              Подсети
              <MemberList
                members={editing.subnets}
                detailOf={cidrOf}
                onRemove={(s) => setEditing({ ...editing, subnets: editing.subnets.filter((x) => x !== s) })}
                candidates={candidates(editing)}
                addPlaceholder="все подсети — начните вводить для поиска"
                onAdd={(raw) => setEditing({ ...editing, subnets: [...editing.subnets, raw.split(" (")[0]] })}
                empty="Подсети не добавлены"
              />
            </label>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}
```

- [ ] **Step 4: Написать `frontend/src/pages/DevicesPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import DevicesPage from "./DevicesPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("DevicesPage", () => {
  it("translates kinds to Russian", async () => {
    renderPage(<DevicesPage />, "/ui/devices", "d1");
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("маршрутизатор")).toBeInTheDocument();
    expect(screen.getByText("коммутатор")).toBeInTheDocument();
  });

  it("saves a rename as a single operation when the union is unchanged", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<DevicesPage />, "/ui/devices", "d1");
    await screen.findByText("r1");
    await user.click(screen.getByTitle("Изменить устройство r1"));
    const nameInput = await screen.findByLabelText("Имя");
    await user.clear(nameInput);
    await user.type(nameInput, "r1b");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Устройство сохранено")).toBeInTheDocument();
    // union не менялся (r1 в u1, u1 и остаётся) → только update-device, и он
    // уходит одиночным POST /operations (ops.length === 1 в useTopologyOperations).
    expect(body).toEqual({ kind: "update-device", deviceName: "r1", device: { name: "r1b", kind: "router" } });
  });

  it("moves a device to another union, referring to the new name", async () => {
    // Топология: r1 в u1; переносим в u2, имя не трогаем.
    server.use(http.get("/api/drafts/d1/topology", () =>
      HttpResponse.json({
        ...fx.topologyFixture,
        unions: [{ name: "u1", devices: ["r1"] }, { name: "u2", devices: [] }],
      })));
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations/batch", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<DevicesPage />, "/ui/devices", "d1");
    await screen.findByText("r1");
    await user.click(screen.getByTitle("Изменить устройство r1"));
    await user.selectOptions(await screen.findByLabelText("Объединение"), "u2");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Устройство сохранено")).toBeInTheDocument();
    // Смена union → батч из 2 операций; обе ссылаются на новое имя (каскад
    // update-device на бэкенде уже переименовал устройство во всех union).
    expect(body).toMatchObject({ operations: [
      { kind: "update-device", deviceName: "r1", device: { name: "r1", kind: "router" } },
      { kind: "union-remove-device", unionName: "u1", deviceName: "r1" },
      { kind: "union-add-device", unionName: "u2", deviceName: "r1" },
    ] });
  });

  it("deletes through delete-device", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    window.confirm = vi.fn(() => true);
    const { user } = renderPage(<DevicesPage />, "/ui/devices", "d1");
    await screen.findByText("r1");
    await user.click(screen.getByTitle("Удалить устройство r1"));
    expect(await screen.findByText("Устройство удалено")).toBeInTheDocument();
    expect(body).toEqual({ kind: "delete-device", deviceName: "r1" });
  });
});
```

- [ ] **Step 5: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './DevicesPage'`.

- [ ] **Step 6: Реализовать `frontend/src/pages/DevicesPage.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useProjectResource, useTopologyOperations } from "../api/queries";
import type { DeviceDoc, TopologyDoc, TopologyOperation } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; kind: string; union: string; description: string };

const KIND_LABEL: Record<string, string> = { switch: "коммутатор", router: "маршрутизатор" };

export default function DevicesPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const ops = useTopologyOperations();
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = topology.data?.devices ?? [];
  const unions = topology.data?.unions ?? [];

  // Членство в объединении хранится на объединении, поэтому страница
  // находит его обратным поиском.
  const unionOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of unions) for (const d of u.devices ?? []) map.set(d, u.name);
    return map;
  }, [unions]);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    if (!row) return;
    setEditing({
      index, name: row.name, kind: row.kind,
      union: unionOf.get(row.name) ?? "", description: row.description ?? "",
    });
  };

  const hint = editing ? uniqueNameHint(editing.name, rows.map((r) => r.name), editing.index) : "";

  const run = async (operations: TopologyOperation[], message: string) => {
    try {
      await ops.mutateAsync(operations);
      setEditing(null);
      notify(message, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const original = rows[editing.index];
    const name = editing.name.trim();
    const device: DeviceDoc = { name, kind: original.kind };
    if (editing.description.trim()) device.description = editing.description.trim();

    const previousUnion = unionOf.get(original.name);
    // update-device на бэкенде сам каскадно переименовывает устройство во всех
    // объединениях (topology_operations.go: renameStrings), поэтому операции
    // переноса ссылаются на НОВОЕ имя и добавляются только при смене union —
    // 1:1 с легаси devices.js:saveDraft.
    const operations: TopologyOperation[] = [
      { kind: "update-device", deviceName: original.name, device },
    ];
    if (previousUnion && previousUnion !== editing.union) {
      operations.push({ kind: "union-remove-device", unionName: previousUnion, deviceName: name });
    }
    if (editing.union && editing.union !== previousUnion) {
      operations.push({ kind: "union-add-device", unionName: editing.union, deviceName: name });
    }
    void run(operations, "Устройство сохранено");
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить устройство ${rows[index].name}?`)) return;
    void run([{ kind: "delete-device", deviceName: rows[index].name }], "Устройство удалено");
  };

  const columns: Column<DeviceDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    { key: "kind", title: "Тип", render: (r) => KIND_LABEL[r.kind] ?? r.kind },
    {
      key: "union",
      title: "Объединение",
      render: (r) => unionOf.get(r.name)
        ? <span className="owner-badge">{unionOf.get(r.name)}</span>
        : <span className="hint">без объединения</span>,
      filter: (r, q) => containsFold(unionOf.get(r.name), q),
    },
    {
      key: "description",
      title: "Описание",
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить устройство ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить устройство ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-devices">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Устройств нет — создайте их на схеме"
        hint={<><h3>Устройства</h3><p className="hint">Маршрутизаторы и коммутаторы топологии.</p></>}
      />
      <Modal
        open={!!editing}
        title="Изменить устройство"
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || ops.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Объединение
              <select value={editing.union} onChange={(e) => setEditing({ ...editing, union: e.target.value })}>
                <option value="">— без объединения —</option>
                {unions.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
              </select>
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}
```

- [ ] **Step 7: Зарегистрировать оба маршрута в `App.tsx`**

```tsx
import DevicesPage from "./pages/DevicesPage";
import NetworksPage from "./pages/NetworksPage";
...
        <Route path="/ui/networks" element={<NetworksPage />} />
        <Route path="/ui/devices" element={<DevicesPage />} />
```

- [ ] **Step 8: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 9: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): networks and devices pages"
```

---

### Task 12: Страницы наборов и объединений

**Files:**
- Create: `frontend/src/pages/SetsPage.tsx`, `frontend/src/pages/SetsPage.test.tsx`, `frontend/src/pages/UnionsPage.tsx`, `frontend/src/pages/UnionsPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useProjectResource`, `useProjectSave` (Task 6), `parseHostAddress` (Task 3), `matchPrefixQuery` (Task 3).
- Produces: `<SetsPage/>`, `<UnionsPage/>`.

Обе страницы пишут весь документ топологии через `PUT` (`sets` / `unions`), как в легаси.

- [ ] **Step 1: Написать `frontend/src/pages/SetsPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import SetsPage from "./SetsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("SetsPage", () => {
  it("lists sets with addresses", async () => {
    renderPage(<SetsPage />, "/ui/sets", "d1");
    expect(await screen.findByText("srv")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5/32")).toBeInTheDocument();
  });

  it("rejects a set with neither subnets nor addresses", async () => {
    const { user } = renderPage(<SetsPage />, "/ui/sets", "d1");
    await screen.findByText("srv");
    await user.click(screen.getByTitle("Добавить набор"));
    await user.type(await screen.findByLabelText("Имя"), "empty");
    expect(screen.getByText("Нужна хотя бы одна подсеть или адрес")).toBeInTheDocument();
  });

  it("normalizes a bare IP to /32 and rejects a short mask", async () => {
    const { user } = renderPage(<SetsPage />, "/ui/sets", "d1");
    await screen.findByText("srv");
    await user.click(screen.getByTitle("Изменить набор srv"));
    await user.type(await screen.findByPlaceholderText("10.0.0.5"), "10.0.0.9");
    await user.click(screen.getByTitle("Добавить адрес"));
    expect(screen.getByText("10.0.0.9/32")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("10.0.0.5"), "10.0.0.0/24");
    await user.click(screen.getByTitle("Добавить адрес"));
    expect(screen.getByText("Адрес: голый IP или маска /32 (для IPv6 — /128)")).toBeInTheDocument();
  });

  it("saves the whole topology with the new sets", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/topology", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.topologyFixture);
    }));
    const { user } = renderPage(<SetsPage />, "/ui/sets", "d1");
    await screen.findByText("srv");
    await user.click(screen.getByTitle("Добавить набор"));
    await user.type(await screen.findByLabelText("Имя"), "web");
    // адрес делает набор валидным
    await user.type(screen.getByPlaceholderText("10.0.0.5"), "10.0.0.7");
    await user.click(screen.getByTitle("Добавить адрес"));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Наборы сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({ sets: expect.arrayContaining([{ name: "web" }]) });
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './SetsPage'`.

- [ ] **Step 3: Реализовать `frontend/src/pages/SetsPage.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { SetDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchPrefixQuery, matchSubnetMembers } from "../lib/search";
import { parseHostAddress, uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; subnets: string[]; addresses: string[]; description: string };

export default function SetsPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [addressError, setAddressError] = useState("");

  const rows = topology.data?.sets ?? [];
  const allSubnets = subnets.data?.subnets ?? [];
  const cidrOf = useMemo(() => {
    const map = new Map(allSubnets.map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [allSubnets]);

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    setAddressInput("");
    setAddressError("");
    const row = rows[index];
    setEditing(row
      ? { index, name: row.name, subnets: [...(row.subnets ?? [])], addresses: [...(row.addresses ?? [])], description: row.description ?? "" }
      : { index: -1, name: "", subnets: [], addresses: [], description: "" });
  };

  const addAddress = () => {
    if (!editing) return;
    const parsed = parseHostAddress(addressInput);
    if (!parsed) {
      setAddressError("Адрес: голый IP или маска /32 (для IPv6 — /128)");
      return;
    }
    if (editing.addresses.some((a) => a.split("/")[0] === parsed.split("/")[0])) {
      setAddressError("Адрес уже добавлен");
      return;
    }
    setEditing({ ...editing, addresses: [...editing.addresses, parsed] });
    setAddressInput("");
    setAddressError("");
  };

  const hint = editing ? setHint(editing, rows) : "";

  const persist = async (sets: SetDoc[]) => {
    if (!topology.data) return;
    try {
      await save.mutateAsync({ ...topology.data, sets });
      setEditing(null);
      notify("Наборы сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const set: SetDoc = { name: editing.name.trim(), subnets: editing.subnets, addresses: editing.addresses };
    if (editing.description.trim()) set.description = editing.description.trim();
    const next = rows.slice();
    if (editing.index >= 0) next[editing.index] = set;
    else next.push(set);
    void persist(next);
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить набор ${rows[index].name}?`)) return;
    void persist(rows.filter((_, i) => i !== index));
  };

  const columns: Column<SetDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "subnets",
      title: "Подсети",
      render: (r) => (r.subnets?.length
        ? r.subnets.map((s) => <span className="owner-badge" key={s}>{s}</span>)
        : <span className="hint">нет подсетей</span>),
      filter: (r, q) => matchSubnetMembers(r.subnets, cidrOf, q),
    },
    {
      key: "addresses",
      title: "Адреса",
      render: (r) => (r.addresses?.length
        ? r.addresses.map((a) => <span className="owner-badge" key={a}>{a}</span>)
        : <span className="hint">нет адресов</span>),
      filter: (r, q) => (r.addresses ?? []).some((a) => matchPrefixQuery(a, q)),
    },
    {
      key: "description",
      title: "Описание",
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить набор ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить набор ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-sets">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Наборов нет — добавьте первый"
        hint={<><h3>Наборы</h3><p className="hint">Именованные группы адресов для правил.</p></>}
        actions={<button type="button" className="primary" title="Добавить набор" onClick={() => open(-1)}>+ Набор</button>}
      />
      <Modal
        open={!!editing}
        wide
        title={editing && editing.index >= 0 ? "Изменить набор" : "Новый набор"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || save.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label>
              Подсети
              <MemberList
                members={editing.subnets}
                detailOf={cidrOf}
                onRemove={(s) => setEditing({ ...editing, subnets: editing.subnets.filter((x) => x !== s) })}
                candidates={allSubnets.filter((s) => !editing.subnets.includes(s.name)).map((s) => `${s.name} (${s.cidr})`)}
                onAdd={(raw) => setEditing({ ...editing, subnets: [...editing.subnets, raw.split(" (")[0]] })}
                empty="Подсети не добавлены"
              />
            </label>
            <label>
              Адреса
              <MemberList
                members={editing.addresses}
                onRemove={(a) => setEditing({ ...editing, addresses: editing.addresses.filter((x) => x !== a) })}
                empty="Адреса не добавлены"
              />
              <div className="member-add">
                <input
                  value={addressInput}
                  placeholder="10.0.0.5"
                  onChange={(e) => setAddressInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAddress(); } }}
                />
                <button type="button" title="Добавить адрес" onClick={addAddress}>+</button>
              </div>
              {(addressError || hint) && <p className="cell-hint">{addressError || hint}</p>}
            </label>
          </div>
        )}
      </Modal>
    </main>
  );
}

function setHint(draft: Draft, rows: SetDoc[]): string {
  const nameHint = uniqueNameHint(draft.name, rows.map((r) => r.name), draft.index);
  if (nameHint) return nameHint;
  if (!draft.subnets.length && !draft.addresses.length) return "Нужна хотя бы одна подсеть или адрес";
  return "";
}
```

- [ ] **Step 4: Написать `frontend/src/pages/UnionsPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import UnionsPage from "./UnionsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("UnionsPage", () => {
  it("lists unions and their members", async () => {
    renderPage(<UnionsPage />, "/ui/unions", "d1");
    expect(await screen.findByText("u1")).toBeInTheDocument();
    expect(screen.getByText("r1")).toBeInTheDocument();
  });

  it("says membership is set on the canvas", async () => {
    const { user } = renderPage(<UnionsPage />, "/ui/unions", "d1");
    await screen.findByText("u1");
    await user.click(screen.getByTitle("Изменить объединение u1"));
    expect(await screen.findByText(/назначается на холсте топологии/)).toBeInTheDocument();
  });

  it("creates a union with empty members", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/topology", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.topologyFixture);
    }));
    const { user } = renderPage(<UnionsPage />, "/ui/unions", "d1");
    await screen.findByText("u1");
    await user.click(screen.getByTitle("Добавить объединение"));
    await user.type(await screen.findByLabelText("Имя"), "u2");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Объединения сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({ unions: expect.arrayContaining([{ name: "u2", devices: [], networks: [] }]) });
  });
});
```

- [ ] **Step 5: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './UnionsPage'`.

- [ ] **Step 6: Реализовать `frontend/src/pages/UnionsPage.tsx`**

```tsx
import { useState } from "react";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { TopologyDoc, UnionDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold } from "../lib/search";
import { uniqueNameHint } from "../lib/validate";
import DataTable, { type Column } from "../components/ui/DataTable";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Draft = { index: number; name: string; description: string };

export default function UnionsPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<Draft | null>(null);

  const rows = topology.data?.unions ?? [];

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const row = rows[index];
    setEditing(row
      ? { index, name: row.name, description: row.description ?? "" }
      : { index: -1, name: "", description: "" });
  };

  const hint = editing ? uniqueNameHint(editing.name, rows.map((r) => r.name), editing.index) : "";

  const persist = async (unions: UnionDoc[]) => {
    if (!topology.data) return;
    try {
      await save.mutateAsync({ ...topology.data, unions });
      setEditing(null);
      notify("Объединения сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const submit = () => {
    if (!editing) return;
    const previous = rows[editing.index] as UnionDoc | undefined;
    const union: UnionDoc = {
      name: editing.name.trim(),
      // Состав назначается на холсте: страница его не меняет, но и не
      // затирает при переименовании.
      devices: previous?.devices ?? [],
      networks: previous?.networks ?? [],
    };
    if (editing.description.trim()) union.description = editing.description.trim();
    const next = rows.slice();
    if (editing.index >= 0) next[editing.index] = union;
    else next.push(union);
    void persist(next);
  };

  const remove = (index: number) => {
    if (!window.confirm(`Удалить объединение ${rows[index].name}?`)) return;
    void persist(rows.filter((_, i) => i !== index));
  };

  const columns: Column<UnionDoc>[] = [
    { key: "name", title: "Имя", render: (r) => r.name, filter: (r, q) => containsFold(r.name, q) },
    {
      key: "devices",
      title: "Устройства",
      render: (r) => (r.devices?.length
        ? r.devices.map((d) => <span className="owner-badge" key={d}>{d}</span>)
        : <span className="hint">нет устройств</span>),
      filter: (r, q) => (r.devices ?? []).some((d) => containsFold(d, q)),
    },
    {
      key: "networks",
      title: "Сети",
      render: (r) => (r.networks?.length
        ? r.networks.map((n) => <span className="owner-badge" key={n}>{n}</span>)
        : <span className="hint">нет сетей</span>),
      filter: (r, q) => (r.networks ?? []).some((n) => containsFold(n, q)),
    },
    {
      key: "description",
      title: "Описание",
      render: (r) => r.description || "—",
      filter: (r, q) => containsFold(r.description, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить объединение ${r.name}`} onClick={() => open(rows.indexOf(r))} />
          <button type="button" className="icon-btn delete" title={`Удалить объединение ${r.name}`} onClick={() => remove(rows.indexOf(r))} />
        </>
      ),
    },
  ];

  return (
    <main className="page" data-testid="page-unions">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        empty="Объединений нет — создайте на схеме"
        hint={<><h3>Объединения</h3><p className="hint">Визуальные группы устройств и сетей.</p></>}
        actions={<button type="button" className="primary" title="Добавить объединение" onClick={() => open(-1)}>+ Объединение</button>}
      />
      <Modal
        open={!!editing}
        title={editing && editing.index >= 0 ? "Изменить объединение" : "Новое объединение"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || save.isPending} onClick={submit}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>
              Имя
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label>
              Описание
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <p className="cell-hint">Состав объединения назначается на холсте топологии через контекстное меню.</p>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}
```

- [ ] **Step 7: Зарегистрировать маршруты**

```tsx
import SetsPage from "./pages/SetsPage";
import UnionsPage from "./pages/UnionsPage";
...
        <Route path="/ui/sets" element={<SetsPage />} />
        <Route path="/ui/unions" element={<UnionsPage />} />
```

- [ ] **Step 8: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 9: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): sets and unions pages"
```

---

### Task 13: Страница связей

**Files:**
- Create: `frontend/src/pages/LinksPage.tsx`, `frontend/src/pages/LinksPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useProjectResource`, `useProjectSave` (Task 6), `api` (Task 4), `canonicalLink` (Task 3).
- Produces: `<LinksPage/>`.

Кандидаты экспортов читаются с сервера: `GET {apiPath}link-exports?side=a&a=…&b=…`. Легаси использовало `?link=<index>`; новая страница шлёт пару устройств — бэкенд принимает оба варианта, но пара устойчива к переупорядочиванию массива.

- [ ] **Step 1: Написать `frontend/src/pages/LinksPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import LinksPage from "./LinksPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("LinksPage", () => {
  it("shows the endpoint pair and the mode", async () => {
    renderPage(<LinksPage />, "/ui/links", "d1");
    expect(await screen.findByText("r1 ↔ sw1")).toBeInTheDocument();
    expect(screen.getByText("обычная")).toBeInTheDocument();
  });

  it("makes a link filtered", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/topology", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.topologyFixture);
    }));
    const { user } = renderPage(<LinksPage />, "/ui/links", "d1");
    await screen.findByText("r1 ↔ sw1");
    await user.click(screen.getByTitle("Сделать фильтрованной связь r1 ↔ sw1"));
    expect(await screen.findByText("Связи сохранены")).toBeInTheDocument();
    expect(body).toMatchObject({
      links: [{ a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: [], bExports: [] } }],
    });
  });

  it("loads export candidates for both sides by device pair", async () => {
    const urls: string[] = [];
    server.use(http.get("/api/drafts/d1/link-exports", ({ request }) => {
      urls.push(new URL(request.url).search);
      return HttpResponse.json({ entities: [{ name: "lan", cidr: "10.0.0.0/24" }] });
    }));
    const { user } = renderPage(<LinksPage />, "/ui/links", "d1");
    await screen.findByText("r1 ↔ sw1");
    await user.click(screen.getByTitle("Сделать фильтрованной связь r1 ↔ sw1"));
    await screen.findByText("Связи сохранены");
    await user.click(screen.getByTitle("Изменить фильтр связи r1 ↔ sw1"));
    expect(await screen.findByText("Экспорт")).toBeInTheDocument();
    expect(urls.some((u) => u.includes("side=a") && u.includes("a=r1") && u.includes("b=sw1"))).toBe(true);
    expect(urls.some((u) => u.includes("side=b"))).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './LinksPage'`.

- [ ] **Step 3: Реализовать `frontend/src/pages/LinksPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useProjectResource, useProjectSave } from "../api/queries";
import type { EntityDoc, LinkDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchSubnetMembers } from "../lib/search";
import { canonicalLink } from "../lib/links";
import DataTable, { type Column } from "../components/ui/DataTable";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Row = { key: string; index: number; a: string; b: string; filter: LinkDoc["filter"] };

export default function LinksPage() {
  const { isReadOnly, apiPath } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const save = useProjectSave<TopologyDoc>("topology");
  const [editing, setEditing] = useState<number | null>(null);
  const [exports, setExports] = useState<{ a: EntityDoc[]; b: EntityDoc[] }>({ a: [], b: [] });

  const links = topology.data?.links ?? [];

  // rows пересоздаются только при изменении документа (не на каждом рендере):
  // иначе useEffect ниже, зависящий от rows, повторно дёргал бы link-exports,
  // пока модалка фильтров открыта.
  const rows: Row[] = useMemo(() => links.map((l, index) => {
    const [a, b] = canonicalLink(l.a.device, l.b.device);
    // Экспорты хранятся по сторонам A/B документа; канонический порядок
    // может их переставить, поэтому переносим их вместе с концами.
    const filter = l.filter
      ? (a === l.a.device
        ? { aExports: l.filter.aExports, bExports: l.filter.bExports }
        : { aExports: l.filter.bExports, bExports: l.filter.aExports })
      : undefined;
    return { key: `${a}|${b}`, index, a, b, filter };
  }), [links]);

  const cidrOf = (name: string) => subnets.data?.subnets.find((s) => s.name === name)?.cidr ?? "";

  useEffect(() => {
    if (editing === null) return;
    const row = rows[editing];
    if (!row) return;
    let cancelled = false;
    void Promise.all([
      api.get<{ entities: EntityDoc[] }>(apiPath(`link-exports?side=a&a=${row.a}&b=${row.b}`)),
      api.get<{ entities: EntityDoc[] }>(apiPath(`link-exports?side=b&a=${row.a}&b=${row.b}`)),
    ]).then(([sideA, sideB]) => {
      if (!cancelled) setExports({ a: sideA.entities, b: sideB.entities });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [editing, apiPath, rows]);

  const persist = async (next: LinkDoc[]) => {
    if (!topology.data) return;
    try {
      await save.mutateAsync({ ...topology.data, links: next });
      notify("Связи сохранены", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const setFilter = (row: Row, filter: LinkDoc["filter"]) => {
    const next = links.slice();
    next[row.index] = { ...next[row.index], filter };
    void persist(next);
  };

  const replaceExport = (row: Row, side: "a" | "b", list: string[]) => {
    const current = row.filter ?? { aExports: [], bExports: [] };
    const filter = side === "a" ? { aExports: list, bExports: current.bExports } : { aExports: current.aExports, bExports: list };
    void persist(links.map((l, i) => (i === row.index ? { ...l, filter } : l)));
  };

  const open = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    setEditing(index);
  };

  const columns: Column<Row>[] = [
    {
      key: "pair",
      title: "Устройства",
      render: (r) => `${r.a} ↔ ${r.b}`,
      filter: (r, q) => containsFold(r.a, q) || containsFold(r.b, q),
    },
    {
      key: "mode",
      title: "Режим",
      render: (r) => (r.filter ? <span className="owner-badge">фильтрованная</span> : <span className="hint">обычная</span>),
      filter: (r, q) => containsFold(r.filter ? "фильтрованная" : "обычная", q),
    },
    {
      key: "aExports",
      title: "Экспорт →",
      render: (r) => badges(r.filter?.aExports),
      filter: (r, q) => matchSubnetMembers(r.filter?.aExports, cidrOf, q),
    },
    {
      key: "bExports",
      title: "← Экспорт",
      render: (r) => badges(r.filter?.bExports),
      filter: (r, q) => matchSubnetMembers(r.filter?.bExports, cidrOf, q),
    },
    {
      key: "actions",
      title: "",
      render: (r) => (r.filter ? (
        <>
          <button type="button" className="icon-btn edit" title={`Изменить фильтр связи ${r.a} ↔ ${r.b}`} onClick={() => open(r.index)} />
          <button type="button" className="btn-link" title={`Вернуть обычную связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, undefined)}>Обычная</button>
        </>
      ) : (
        <button type="button" className="btn-link" title={`Сделать фильтрованной связь ${r.a} ↔ ${r.b}`} onClick={() => setFilter(r, { aExports: [], bExports: [] })}>Фильтровать</button>
      )),
    },
  ];

  const row = editing === null ? null : rows[editing];

  return (
    <main className="page" data-testid="page-links">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        empty="Связей нет — создайте их на схеме"
        hint={<><h3>Связи</h3><p className="hint">Логические соединения между устройствами и их фильтры.</p></>}
      />
      <Modal
        open={!!row}
        wide
        title={row ? `Фильтры связи ${row.a} ↔ ${row.b}` : ""}
        onClose={() => setEditing(null)}
        footer={<button type="button" onClick={() => setEditing(null)}>Закрыть</button>}
      >
        {row && (
          <div className="link-panel-grid">
            {(["a", "b"] as const).map((side) => {
              const mine = side === "a" ? row.filter?.aExports ?? [] : row.filter?.bExports ?? [];
              const theirs = side === "a" ? row.filter?.bExports ?? [] : row.filter?.aExports ?? [];
              return (
                <fieldset className={side === "a" ? "link-end-col-a" : "link-end-col-b"} key={side}>
                  <legend>{side === "a" ? row.a : row.b}</legend>
                  <div className="filter-dirs">
                    <div>
                      <p className="filter-dir-title">Экспорт</p>
                      <MemberList
                        members={mine}
                        detailOf={cidrOf}
                        onRemove={(name) => replaceExport(row, side, mine.filter((x) => x !== name))}
                        candidates={exports[side].map((e) => `${e.name} (${e.cidr ?? ""})`)}
                        onAdd={(raw) => {
                          const name = raw.split(" (")[0];
                          if (mine.includes(name)) return;
                          replaceExport(row, side, [...mine, name]);
                        }}
                        empty="Ничего не экспортируется"
                      />
                    </div>
                    <div>
                      <p className="filter-dir-title">Импорт</p>
                      {/* Импорт стороны — это экспорт соседа: read-only, как в легаси. */}
                      <MemberList readOnly members={theirs} detailOf={cidrOf} empty="Ничего не импортируется" />
                    </div>
                  </div>
                </fieldset>
              );
            })}
          </div>
        )}
      </Modal>
    </main>
  );
}

const badges = (list: string[] | undefined) =>
  list?.length ? list.map((n) => <span className="owner-badge" key={n}>{n}</span>) : <span className="hint">—</span>;
```

- [ ] **Step 4: Зарегистрировать маршрут**

```tsx
import LinksPage from "./pages/LinksPage";
...
        <Route path="/ui/links" element={<LinksPage />} />
```

- [ ] **Step 5: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 6: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): links page with filter editor"
```

---

### Task 14: Страница правил

**Files:**
- Create: `frontend/src/pages/RulesPage.tsx`, `frontend/src/pages/RulesPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useProjectResource`, `useProjectSave`, `useLint` (Task 6), `validPortSpec` (Task 3), `containsFold` (Task 3).
- Produces: `<RulesPage/>`.

Самая насыщенная табличная страница: табы цепочек, параметры цепочки, правило с двумя комбобоксами эндпоинтов, перемещение правил, линтер.

- [ ] **Step 1: Написать `frontend/src/pages/RulesPage.test.tsx`**

```tsx
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import RulesPage from "./RulesPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("RulesPage", () => {
  it("shows the primary chain and its rules", async () => {
    renderPage(<RulesPage />, "/ui/rules", "d1");
    expect(await screen.findByText("FORWARD")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("rejects a rule without src or dst", async () => {
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByTitle("Добавить правило"));
    await user.type(await screen.findByLabelText("Имя"), "bad");
    expect(screen.getByText("Нужен хотя бы один источник")).toBeInTheDocument();
    expect(screen.getByText("Нужен хотя бы один получатель")).toBeInTheDocument();
  });

  it("rejects ports on icmp and a bad port spec", async () => {
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByTitle("Добавить правило"));
    await user.type(await screen.findByLabelText("Имя"), "p");
    // src и dst обязательны: проверка портов в ruleHint идёт после концов
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[0]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[1]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.selectOptions(screen.getByLabelText("Протокол"), "icmp");
    await user.type(screen.getByLabelText("Порты получателя"), "80");
    expect(screen.getByText("Порты допустимы только для tcp и udp")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Протокол"), "tcp");
    await user.clear(screen.getByLabelText("Порты получателя"));
    await user.type(screen.getByLabelText("Порты получателя"), "2048-1024");
    expect(screen.getByText("Порты: 1..65535 или диапазон from-to")).toBeInTheDocument();
  });

  it("saves the whole policy", async () => {
    let body: unknown;
    server.use(http.put("/api/drafts/d1/rules", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.policyFixture);
    }));
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByTitle("Добавить правило"));
    await user.type(await screen.findByLabelText("Имя"), "ssh");
    // src и dst через комбобоксы: any доступен первым кандидатом
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[0]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.click(screen.getAllByPlaceholderText("any, подсеть или набор")[1]);
    await user.click(screen.getByText("any", { selector: ".member-suggestion" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(body).toMatchObject({
      chains: [{ rules: expect.arrayContaining([{ name: "ssh" }]) }],
    }));
  });

  it("moves a rule and persists the chain", async () => {
    server.use(
      http.get("/api/drafts/d1/rules", () => HttpResponse.json({
        chains: [{
          name: "FORWARD", defaultAction: "deny", chainPosition: "top",
          rules: [
            { name: "a", src: ["any"], dst: ["any"], action: "allow" },
            { name: "b", src: ["any"], dst: ["any"], action: "allow" },
          ],
        }],
      })),
      http.put("/api/drafts/d1/rules", async ({ request }) =>
        HttpResponse.json(await request.json())),
    );
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("a");
    await user.click(screen.getByTitle("Переместить правило b выше"));
    await waitFor(() => {
      const names = screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
      expect(names[0]).toContain("b");
    });
  });

  it("shows lint findings", async () => {
    server.use(http.get("/api/drafts/d1/lint", () => HttpResponse.json(fx.lintFixture)));
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("web");
    await user.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByText("правило недостижимо")).toBeInTheDocument();
  });

  it("refuses to delete a chain targeted by jump", async () => {
    server.use(http.get("/api/drafts/d1/rules", () => HttpResponse.json({
      chains: [
        { name: "FORWARD", defaultAction: "deny", chainPosition: "top", rules: [
          { name: "j", src: ["any"], dst: ["any"], action: "jump", jumpTo: "sub" },
        ] },
        { name: "sub", defaultAction: "deny", rules: [] },
      ],
    })));
    const { user } = renderPage(<RulesPage />, "/ui/rules", "d1");
    await screen.findByText("j");
    await user.click(screen.getByTitle("Удалить цепочку sub"));
    expect(await screen.findByText(/используется действием jump/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './RulesPage'`.

- [ ] **Step 3: Реализовать `frontend/src/pages/RulesPage.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useLint, useProjectResource, useProjectSave } from "../api/queries";
import type { ChainDoc, PolicyDoc, RuleDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { uniqueNameHint, validPortSpec } from "../lib/validate";
import Combo from "../components/ui/Combo";
import MemberList from "../components/ui/MemberList";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type RuleDraft = {
  index: number; name: string; comment: string; src: string[]; dst: string[];
  proto: string; srcPorts: string; dstPorts: string; action: string; jumpTo: string; mirror: boolean;
};

const PROTOS = ["any", "tcp", "udp", "icmp"];
const ACTIONS = ["allow", "deny", "return", "jump"];

export default function RulesPage() {
  const { isReadOnly } = useDraft();
  const rules = useProjectResource<PolicyDoc>("rules");
  const topology = useProjectResource<TopologyDoc>("topology");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  // Правка правил делает невалидными lint и search-index.
  const save = useProjectSave<PolicyDoc>("rules", { invalidate: ["lint", "search-index"] });
  const lint = useLint();

  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<RuleDraft | null>(null);
  const [chainEditing, setChainEditing] = useState(false);
  const [chainDraft, setChainDraft] = useState<ChainDoc | null>(null);
  const [highlighted, setHighlighted] = useState<string[]>([]);

  const chains = rules.data?.chains ?? [];
  const chain = chains[active];

  const endpoints = useMemo(() => [
    "any",
    ...(subnets.data?.subnets ?? []).map((s) => s.name).sort(),
    ...(topology.data?.sets ?? []).map((s) => s.name).sort(),
  ], [subnets.data, topology.data]);

  const persist = async (next: PolicyDoc) => {
    try {
      await save.mutateAsync(next);
      notify("Правила сохранены", "ok");
      return true;
    } catch (error) {
      notify((error as Error).message);
      return false;
    }
  };

  const openRule = (index: number) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    const r = chain?.rules[index];
    setEditing(r ? {
      index, name: r.name, comment: r.comment ?? "", src: r.src, dst: r.dst,
      proto: r.proto || "any", srcPorts: (r.srcPorts ?? []).join(","), dstPorts: (r.dstPorts ?? []).join(","),
      action: r.action, jumpTo: r.jumpTo ?? "", mirror: r.mirror ?? false,
    } : {
      index: -1, name: "", comment: "", src: [], dst: [], proto: "any",
      srcPorts: "", dstPorts: "", action: "allow", jumpTo: "", mirror: false,
    });
  };

  const hint = editing ? ruleHint(editing, chain) : "";

  const submitRule = () => {
    if (!editing || !rules.data) return;
    const rule: RuleDoc = {
      name: editing.name.trim(),
      src: editing.src,
      dst: editing.dst,
      proto: editing.proto,
      action: editing.action as RuleDoc["action"],
    };
    if (editing.comment.trim()) rule.comment = editing.comment.trim();
    if (editing.srcPorts.trim()) rule.srcPorts = splitPorts(editing.srcPorts);
    if (editing.dstPorts.trim()) rule.dstPorts = splitPorts(editing.dstPorts);
    if (editing.action === "jump") rule.jumpTo = editing.jumpTo;
    if (editing.mirror) rule.mirror = true;

    const nextChains = chains.map((c, i) => {
      if (i !== active) return c;
      const list = c.rules.slice();
      if (editing.index >= 0) list[editing.index] = rule;
      else list.push(rule);
      return { ...c, rules: list };
    });
    void persist({ chains: nextChains }).then((ok) => { if (ok) setEditing(null); });
  };

  const moveRule = (index: number, delta: number) => {
    if (!rules.data || !chain) return;
    const target = index + delta;
    if (target < 0 || target >= chain.rules.length) return;
    const list = chain.rules.slice();
    [list[index], list[target]] = [list[target], list[index]];
    void persist({ chains: chains.map((c, i) => (i === active ? { ...c, rules: list } : c)) });
  };

  const removeRule = (index: number) => {
    if (!rules.data || !chain) return;
    if (!window.confirm(`Удалить правило ${chain.rules[index].name}?`)) return;
    void persist({
      chains: chains.map((c, i) => (i === active ? { ...c, rules: c.rules.filter((_, j) => j !== index) } : c)),
    });
  };

  const addChain = () => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    if (!rules.data) return;
    void persist({ chains: [...chains, { name: "new-chain", defaultAction: "deny", rules: [] }] }).then((ok) => {
      if (!ok) return;
      setActive(chains.length);
      setChainDraft({ name: "new-chain", defaultAction: "deny", rules: [] });
      setChainEditing(true);
    });
  };

  const removeChain = (index: number) => {
    if (!rules.data || index === 0) return;
    const name = chains[index].name;
    if (chains.some((c) => c.rules.some((r) => r.jumpTo === name))) {
      notify(`Цепочка ${name} используется действием jump`);
      return;
    }
    if (!window.confirm(`Удалить цепочку ${name}?`)) return;
    void persist({ chains: chains.filter((_, i) => i !== index) });
    setActive((current) => (current > index ? current - 1 : 0));
  };

  const submitChain = () => {
    if (!chainDraft || !rules.data) return;
    if (!chainDraft.name.trim()) {
      notify("Имя цепочки обязательно");
      return;
    }
    void persist({ chains: chains.map((c, i) => (i === active ? chainDraft : c)) });
    setChainEditing(false);
    setChainDraft(null);
  };

  const jumpToFinding = (rulesNames: string[] | undefined, chainName: string) => {
    const index = chains.findIndex((c) => c.name === chainName);
    if (index >= 0) setActive(index);
    setHighlighted(rulesNames ?? []);
    setTimeout(() => setHighlighted([]), 2000);
  };

  if (!chain) {
    return <main className="page" data-testid="page-rules"><p className="hint">Правила не загружены</p></main>;
  }

  return (
    <main className="page" data-testid="page-rules">
      <div className="chain-tabs" data-testid="chain-tabs">
        {chains.map((c, i) => (
          <span className={`chain-tab${i === active ? " active" : ""}`} key={c.name || i}>
            <button type="button" onClick={() => setActive(i)}>{c.name || "—"}</button>
            {i > 0 && (
              <button type="button" className="chain-tab-remove" title={`Удалить цепочку ${c.name}`} onClick={() => removeChain(i)}>×</button>
            )}
          </span>
        ))}
        <button type="button" className="chain-tab-add" onClick={addChain}>+ цепочка</button>
      </div>

      <div className="rules-settings-group">
        {chainEditing && chainDraft ? (
          <>
            <label>
              Имя
              <input value={chainDraft.name} onChange={(e) => setChainDraft({ ...chainDraft, name: e.target.value })} />
            </label>
            <label>
              Действие по умолчанию
              <select value={chainDraft.defaultAction} onChange={(e) => setChainDraft({ ...chainDraft, defaultAction: e.target.value })}>
                {["deny", "allow", "return"].map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            {active === 0 && (
              <label>
                Позиция
                <select
                  value={chainDraft.chainPosition ?? "top"}
                  onChange={(e) => setChainDraft({ ...chainDraft, chainPosition: e.target.value as "top" | "bottom" })}
                >
                  <option value="top">top</option>
                  <option value="bottom">bottom</option>
                </select>
              </label>
            )}
            <div className="settings-edit-actions">
              <button type="button" onClick={() => { setChainEditing(false); setChainDraft(null); }}>Отмена</button>
              <button type="button" className="primary" onClick={submitChain}>Сохранить</button>
            </div>
          </>
        ) : (
          <>
            <span className="settings-badge">Действие: {chain.defaultAction}</span>
            {active === 0 && <span className="settings-badge">Позиция: {chain.chainPosition ?? "top"}</span>}
            <button type="button" onClick={() => { setChainDraft(chain); setChainEditing(true); }}>⚙ Изменить параметры</button>
          </>
        )}
      </div>

      <div className="table-toolbar">
        <div className="toolbar-text"><h3>Правила</h3></div>
        <div className="toolbar-actions">
          <button type="button" onClick={() => void lint.refetch()}>Проверить</button>
          <button type="button" className="primary" title="Добавить правило" onClick={() => openRule(-1)}>+ Правило</button>
        </div>
      </div>

      {lint.data && lint.data.findings.length > 0 && (
        <div className="lint-panel" data-testid="lint-panel">
          <div className="lint-panel-header">
            <strong>Замечания</strong>
            <button type="button" className="lint-panel-close" onClick={() => void lint.refetch()}>×</button>
          </div>
          <div className="lint-panel-body">
            {lint.data.findings.map((f, i) => (
              <button type="button" className="lint-finding" key={i} onClick={() => jumpToFinding(f.rules, f.chain)}>
                <span className={`badge badge-${f.severity === "warning" ? "warn" : "info"}`}>{f.severity}</span>
                <span className="lint-finding-chain">{f.chain}</span>
                <span className="lint-finding-msg">{f.message}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <table className="data-table" id="rules-table" data-testid="rules-table">
        <thead>
          <tr>
            <th /><th>Имя</th><th>Комментарий</th><th>Src</th><th>Dst</th>
            <th>Proto</th><th>Src Ports</th><th>Dst Ports</th><th>Action</th><th>Зеркало</th><th />
          </tr>
        </thead>
        <tbody>
          {chain.rules.map((r, i) => (
            <tr key={r.name} className={highlighted.includes(r.name) ? "lint-highlighted" : undefined}>
              <td className="row-index-cell">
                <button type="button" className="icon-btn move" title={`Переместить правило ${r.name} выше`} onClick={() => moveRule(i, -1)} disabled={i === 0}>▲</button>
                <button type="button" className="icon-btn move" title={`Переместить правило ${r.name} ниже`} onClick={() => moveRule(i, 1)} disabled={i === chain.rules.length - 1}>▼</button>
              </td>
              <td>{r.name}</td>
              <td>{r.comment || "—"}</td>
              <td>{r.src.join(", ") || "any"}</td>
              <td>{r.dst.join(", ") || "any"}</td>
              <td>{r.proto || "any"}</td>
              <td>{(r.srcPorts ?? []).join(",")}</td>
              <td>{(r.dstPorts ?? []).join(",")}</td>
              <td>{r.action}{r.jumpTo ? ` → ${r.jumpTo}` : ""}</td>
              <td>{r.mirror ? "да" : "—"}</td>
              <td>
                <button type="button" className="icon-btn edit" title={`Изменить правило ${r.name}`} onClick={() => openRule(i)} />
                <button type="button" className="icon-btn delete" title={`Удалить правило ${r.name}`} onClick={() => removeRule(i)} />
              </td>
            </tr>
          ))}
          {chain.rules.length === 0 && (
            <tr><td className="empty-cell" colSpan={11}>Правил нет — добавьте первое</td></tr>
          )}
        </tbody>
      </table>

      <Modal
        open={!!editing}
        wide
        title={editing && editing.index >= 0 ? "Изменить правило" : "Новое правило"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" onClick={() => setEditing(null)}>Отмена</button>
            <button type="button" className="primary" disabled={!!hint || save.isPending} onClick={submitRule}>Сохранить</button>
          </>
        }
      >
        {editing && (
          <div className="modal-grid">
            <label>Имя<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>Комментарий<input value={editing.comment} onChange={(e) => setEditing({ ...editing, comment: e.target.value })} /></label>
            <label>
              Src
              <MemberList
                members={editing.src}
                onRemove={(n) => setEditing({ ...editing, src: editing.src.filter((x) => x !== n) })}
                empty="—"
              />
              <Combo items={endpoints} placeholder="any, подсеть или набор" onPick={(n) => {
                if (editing.src.includes(n)) return;
                setEditing({ ...editing, src: [...editing.src, n] });
              }} />
            </label>
            <label>
              Dst
              <MemberList
                members={editing.dst}
                onRemove={(n) => setEditing({ ...editing, dst: editing.dst.filter((x) => x !== n) })}
                empty="—"
              />
              <Combo items={endpoints} placeholder="any, подсеть или набор" onPick={(n) => {
                if (editing.dst.includes(n)) return;
                setEditing({ ...editing, dst: [...editing.dst, n] });
              }} />
            </label>
            <label>Протокол
              <select value={editing.proto} onChange={(e) => setEditing({ ...editing, proto: e.target.value })}>
                {PROTOS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>Действие
              <select value={editing.action} onChange={(e) => setEditing({ ...editing, action: e.target.value })}>
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            {editing.action === "jump" && (
              <label>Перейти в цепочку
                <select value={editing.jumpTo} onChange={(e) => setEditing({ ...editing, jumpTo: e.target.value })}>
                  <option value="">— выберите —</option>
                  {chains.filter((_, i) => i !== active).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label>Порты источника
              <input value={editing.srcPorts} onChange={(e) => setEditing({ ...editing, srcPorts: e.target.value })} placeholder="1024-2048" />
            </label>
            <label>Порты получателя
              <input value={editing.dstPorts} onChange={(e) => setEditing({ ...editing, dstPorts: e.target.value })} placeholder="80,443" />
            </label>
            <label className="modal-check">
              <input type="checkbox" checked={editing.mirror} onChange={(e) => setEditing({ ...editing, mirror: e.target.checked })} />
              Зеркало
            </label>
            {hint && <p className="cell-hint">{hint}</p>}
          </div>
        )}
      </Modal>
    </main>
  );
}

const splitPorts = (spec: string) => spec.split(",").map((p) => p.trim()).filter(Boolean);

// Та же последовательность, что в легаси: имя, уникальность в цепочке,
// наличие концов, порты только для tcp/udp, корректность спецификации,
// цель jump.
function ruleHint(draft: RuleDraft, chain: ChainDoc | undefined): string {
  if (!draft.name.trim()) return "Имя обязательно";
  if (chain && chain.rules.some((r, i) => i !== draft.index && r.name === draft.name.trim())) {
    return "Имя уже используется";
  }
  if (!draft.src.length) return "Нужен хотя бы один источник";
  if (!draft.dst.length) return "Нужен хотя бы один получатель";
  const hasPorts = draft.srcPorts.trim() || draft.dstPorts.trim();
  if (hasPorts && draft.proto !== "tcp" && draft.proto !== "udp") {
    return "Порты допустимы только для tcp и udp";
  }
  if (!validPortSpec(draft.srcPorts) || !validPortSpec(draft.dstPorts)) {
    return "Порты: 1..65535 или диапазон from-to";
  }
  if (draft.action === "jump") {
    if (!draft.jumpTo) return "Укажите цепочку для jump";
    if (chain && draft.jumpTo === chain.name) return "Цепочка не может переходить в себя";
  }
  return "";
}
```

- [ ] **Step 4: Зарегистрировать маршрут**

```tsx
import RulesPage from "./pages/RulesPage";
...
        <Route path="/ui/rules" element={<RulesPage />} />
```

- [ ] **Step 5: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 6: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): rules page with chains, lint and reordering"
```

---

### Task 15: Страницы компиляции, поиска, истории

**Files:**
- Create: `frontend/src/pages/CompilePage.tsx`, `frontend/src/pages/CompilePage.test.tsx`, `frontend/src/pages/SearchPage.tsx`, `frontend/src/pages/SearchPage.test.tsx`, `frontend/src/pages/HistoryPage.tsx`, `frontend/src/pages/HistoryPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useCompile`, `useSearchIndex`, `useVersions`, `useVersionDiff`, `useRestoreVersion` (Task 6).
- Produces: `<CompilePage/>`, `<SearchPage/>`, `<HistoryPage/>`.

- [ ] **Step 1: Написать `frontend/src/pages/CompilePage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import CompilePage from "./CompilePage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("CompilePage", () => {
  it("renders one section per device with both scripts", async () => {
    server.use(http.post("/api/versions/current/compile", () => HttpResponse.json(fx.compileFixture)));
    const { user } = renderPage(<CompilePage />, "/ui/compile");
    await user.click(screen.getByRole("button", { name: "Скомпилировать" }));
    expect(await screen.findByRole("heading", { name: "r1" })).toBeInTheDocument();
    expect(screen.getByText("create lan hash:net")).toBeInTheDocument();
    expect(screen.getByText("-A FORWARD -j ACCEPT")).toBeInTheDocument();
    expect(screen.getByText("ipset")).toBeInTheDocument();
    expect(screen.getByText("iptables")).toBeInTheDocument();
  });

  it("shows a compile error as a hint", async () => {
    server.use(http.post("/api/versions/current/compile", () =>
      HttpResponse.json({ error: "project is invalid" }, { status: 422 })));
    const { user } = renderPage(<CompilePage />, "/ui/compile");
    await user.click(screen.getByRole("button", { name: "Скомпилировать" }));
    expect(await screen.findByText("project is invalid")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Реализовать `frontend/src/pages/CompilePage.tsx`**

```tsx
import { useCompile } from "../api/queries";
import type { CompiledDevice } from "../api/types";

export default function CompilePage() {
  const compile = useCompile();
  const devices = compile.data ?? [];

  return (
    <main className="page" data-testid="page-compile">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>Компиляция</h3>
          <p className="hint">Правила iptables и ipset для каждого устройства.</p>
        </div>
        <div className="toolbar-actions">
          <button id="compile-run" type="button" className="primary" disabled={compile.isPending} onClick={() => compile.mutate()}>
            {compile.isPending ? "Компиляция…" : "Скомпилировать"}
          </button>
        </div>
      </div>
      {compile.error && <p className="cell-hint">{(compile.error as Error).message}</p>}
      <div id="compile-output">
        {devices.map((device) => <DeviceScripts key={device.Name} device={device} />)}
      </div>
    </main>
  );
}

function DeviceScripts({ device }: { device: CompiledDevice }) {
  return (
    <section className="compile-device">
      <h2>{device.Name}</h2>
      {[
        { title: "ipset", text: device.IPSetsScript, suffix: "ipsets.restore" },
        { title: "iptables", text: device.RulesScript, suffix: "rules.sh" },
      ].map(({ title, text, suffix }) => (
        <div key={title}>
          <h3>{title}</h3>
          <pre>{text}</pre>
          <a download={`${device.Name}.${suffix}`} href={objectURL(text)}>Скачать {title}</a>
        </div>
      ))}
    </section>
  );
}

// Blob-URL, как в легаси: скачивание готового скрипта без отдельного
// эндпоинта на бэкенде.
function objectURL(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: "text/plain" }));
}
```

- [ ] **Step 3: Написать `frontend/src/pages/SearchPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import SearchPage from "./SearchPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("SearchPage", () => {
  it("lists all entries with a type badge", async () => {
    server.use(http.get("/api/versions/current/search-index", () => HttpResponse.json(fx.searchIndexFixture)));
    renderPage(<SearchPage />, "/ui/search");
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
  });

  it("filters by query and reports an empty result", async () => {
    server.use(http.get("/api/versions/current/search-index", () => HttpResponse.json(fx.searchIndexFixture)));
    const { user } = renderPage(<SearchPage />, "/ui/search");
    await screen.findByText("r1");
    await user.type(screen.getByRole("searchbox"), "нетакогообъекта");
    expect(await screen.findByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("links a row to the owning page", async () => {
    server.use(http.get("/api/versions/current/search-index", () => HttpResponse.json(fx.searchIndexFixture)));
    renderPage(<SearchPage />, "/ui/search");
    const row = await screen.findByText("r1");
    expect(row.closest("a")).toHaveAttribute("href", "/ui/devices");
  });
});
```

- [ ] **Step 4: Реализовать `frontend/src/pages/SearchPage.tsx`**

```tsx
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSearchIndex } from "../api/queries";
import type { SearchEntry, SearchEntryType } from "../api/types";
import { containsFold, matchPrefixQuery } from "../lib/search";

const TYPE_LABEL: Record<SearchEntryType, string> = {
  device: "устройство", subnet: "подсеть", network: "сеть",
  set: "набор", union: "объединение", link: "связь", rule: "правило",
};

const HREFS: Record<SearchEntryType, string> = {
  device: "/ui/devices", subnet: "/ui/subnets", network: "/ui/networks",
  set: "/ui/sets", union: "/ui/unions", link: "/ui/links", rule: "/ui/rules",
};

export default function SearchPage() {
  const index = useSearchIndex();
  const [params, setParams] = useSearchParams();
  const [type, setType] = useState<SearchEntryType | "all">("all");
  const query = params.get("q") ?? "";

  const entries = index.data ?? [];

  const visible = useMemo(() => entries.filter((e) => {
    if (type !== "all" && e.type !== type) return false;
    if (!query) return true;
    // Сначала адресный поиск по prefixes, потом обычная подстрока.
    const byPrefix = (e.prefixes ?? []).some((p) => matchPrefixQuery(p, query));
    return byPrefix || containsFold(e.name, query) || containsFold(e.details, query) || containsFold(e.description, query);
  }), [entries, type, query]);

  return (
    <main className="page" data-testid="page-search">
      <div className="search-controls">
        <input
          className="search-input"
          type="search"
          value={query}
          placeholder="имя, CIDR или описание"
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {})}
        />
        <select className="search-type" value={type} onChange={(e) => setType(e.target.value as SearchEntryType | "all")}>
          <option value="all">все</option>
          {(Object.keys(TYPE_LABEL) as SearchEntryType[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
      </div>
      <table className="data-table">
        <thead><tr><th>Тип</th><th>Имя</th><th>Детали</th><th>Описание</th></tr></thead>
        <tbody>
          {visible.map((e) => <SearchRow key={`${e.type}:${e.name}`} entry={e} />)}
          {visible.length === 0 && (
            <tr><td className="empty-cell" colSpan={4}>
              {index.isLoading ? "Загрузка…" : "Ничего не найдено"}
            </td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

function SearchRow({ entry }: { entry: SearchEntry }) {
  return (
    <tr className="search-hit">
      <td><Link to={HREFS[entry.type]}><span className="badge badge-default">{TYPE_LABEL[entry.type]}</span></Link></td>
      <td><Link to={HREFS[entry.type]}>{entry.name}</Link></td>
      <td>{entry.details || "—"}</td>
      <td>{entry.description || "—"}</td>
    </tr>
  );
}
```

- [ ] **Step 5: Написать `frontend/src/pages/HistoryPage.test.tsx`**

```tsx
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import HistoryPage from "./HistoryPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

const VERSIONS = [
  { id: 3, createdAt: "2026-09-03T10:00:00Z", confirmedBy: "admin" },
  { id: 2, createdAt: "2026-09-02T10:00:00Z", confirmedBy: "admin" },
  { id: 1, createdAt: "2026-09-01T10:00:00Z" },
];

describe("HistoryPage", () => {
  it("lists versions newest first", async () => {
    server.use(http.get("/api/versions", () => HttpResponse.json(VERSIONS)));
    renderPage(<HistoryPage />, "/ui/history");
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows the diff against the previous version", async () => {
    server.use(
      http.get("/api/versions", () => HttpResponse.json(VERSIONS)),
      http.get("/api/versions/diff", () => HttpResponse.json([
        { kind: "device", key: "r1", change: "added", after: { name: "r1", kind: "router" } },
      ])),
    );
    const { user } = renderPage(<HistoryPage />, "/ui/history");
    await screen.findByText("3");
    await user.click(screen.getByTitle("Дифф версии 3"));
    expect(await screen.findByText("добавлено")).toBeInTheDocument();
    expect(screen.getByText("r1")).toBeInTheDocument();
  });

  it("restores after confirmation for admins", async () => {
    server.use(
      http.get("/api/versions", () => HttpResponse.json(VERSIONS)),
      http.post("/api/versions/2/restore", () => HttpResponse.json({ version: 4 })),
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
    );
    window.confirm = vi.fn(() => true);
    const { user } = renderPage(<HistoryPage />, "/ui/history");
    await screen.findByText("3");
    await user.click(screen.getByTitle("Восстановить версию 2"));
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toContain("Создана версия 4"));
  });
});
```

- [ ] **Step 6: Реализовать `frontend/src/pages/HistoryPage.tsx`**

> **Внимание:** тест "restores after confirmation" ждёт `data-testid="banner"`, который рендерит `BannerHost`, а не эта страница. Он появляется только потому, что `renderPage` (Task 13) монтирует `BannerHost`. Если `renderPage` ещё не обновлён (импорты `../components/BannerHost`/`../components/DraftBanner`), тест с `getByTestId("banner")` зависнет в `waitFor` — вернись к Task 13 и убедись, что баннеры подключены.

```tsx
import { useState } from "react";
import { useMe, useRestoreVersion, useVersionDiff, useVersions } from "../api/queries";
import type { EntityDiff, VersionInfo } from "../api/types";
import { notify } from "../components/notify";

const CHANGE_LABEL: Record<string, string> = {
  added: "добавлено", modified: "изменено", removed: "удалено",
};

export default function HistoryPage() {
  const versions = useVersions(50);
  const me = useMe();
  const restore = useRestoreVersion();
  const [diffFor, setDiffFor] = useState<number | null>(null);

  const list = versions.data ?? [];
  // Дифф всегда с предыдущей версией в списке (он идёт следующим).
  const previousOf = (id: number) => {
    const index = list.findIndex((v) => v.id === id);
    return index >= 0 ? list[index + 1] : undefined;
  };
  const previous = diffFor === null ? undefined : previousOf(diffFor);
  const diff = useVersionDiff(previous?.id ?? null, diffFor);

  const onRestore = async (id: number) => {
    if (!window.confirm(`Восстановить версию ${id}? Будет создана новая версия.`)) return;
    try {
      const result = await restore.mutateAsync(id);
      notify(`Создана версия ${result.version}`, "ok");
      setDiffFor(null);
      void versions.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const isAdmin = me.data?.role === "admin";

  return (
    <main className="page" data-testid="page-history">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>История версий</h3>
          <p className="hint">Подтверждённые версии проекта.</p>
        </div>
      </div>
      <table className="data-table" id="history-table">
        <thead><tr><th>Версия</th><th>Дата</th><th>Подтвердил</th><th>Заметка</th><th /></tr></thead>
        <tbody>
          {list.map((v: VersionInfo) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td>{new Date(v.createdAt).toLocaleString("ru-RU")}</td>
              <td>{v.confirmedBy || "—"}</td>
              <td>{v.note || "—"}</td>
              <td>
                <button type="button" className="btn-link" title={`Дифф версии ${v.id}`} onClick={() => setDiffFor(diffFor === v.id ? null : v.id)}>Дифф</button>
                {isAdmin && previousOf(v.id) && (
                  <button type="button" className="btn-link" title={`Восстановить версию ${v.id}`} onClick={() => onRestore(v.id)}>Восстановить</button>
                )}
              </td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr><td className="empty-cell" colSpan={5}>Версий нет</td></tr>
          )}
        </tbody>
      </table>

      {diffFor !== null && (
        <div className="page-panel" id="diff-panel" data-testid="diff-panel">
          <div className="lint-panel-header">
            <strong>{`Версия ${diffFor} против ${previous?.id ?? "—"}`}</strong>
            <button type="button" className="lint-panel-close" onClick={() => setDiffFor(null)}>×</button>
          </div>
          <table className="data-table" id="diff-body">
            <thead><tr><th>Тип</th><th>Ключ</th><th>Изменение</th></tr></thead>
            <tbody>
              {(diff.data ?? []).map((d, i) => {
                const item = d as EntityDiff;
                return (
                  <tr key={i} className={item.change === "removed" ? "conflict-row" : undefined}>
                    <td>{item.kind}</td>
                    <td>{item.key}</td>
                    <td>{CHANGE_LABEL[item.change] ?? item.change}</td>
                  </tr>
                );
              })}
              {(diff.data ?? []).length === 0 && (
                <tr><td className="empty-cell" colSpan={3}>Изменений нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 7: Зарегистрировать маршруты**

```tsx
import CompilePage from "./pages/CompilePage";
import HistoryPage from "./pages/HistoryPage";
import SearchPage from "./pages/SearchPage";
...
        <Route path="/ui/compile" element={<CompilePage />} />
        <Route path="/ui/search" element={<SearchPage />} />
        <Route path="/ui/history" element={<HistoryPage />} />
```

- [ ] **Step 8: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 9: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): compile, search and history pages"
```

---

### Task 16: Страницы черновиков и пользователей

**Files:**
- Create: `frontend/src/pages/DraftsPage.tsx`, `frontend/src/pages/DraftsPage.test.tsx`, `frontend/src/pages/UsersPage.tsx`, `frontend/src/pages/UsersPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `useDrafts`, `useCreateDraft`, `useDraftDiff`, `useConfirmDraft`, `useDeleteDraft`, `useUsers`, `useMe` (Task 6), `api` (Task 4).
- Produces: `<DraftsPage/>`, `<UsersPage/>`.

> **Риски и подводные камни (прочитать перед выполнением):**
> 1. **Инвалидация кэша делает тесты чувствительными к таймингу.** `useCreateDraft`/`useDeleteDraft`/`useConfirmDraft` (Task 6) в `onSuccess` зовут `qc.invalidateQueries({queryKey: ["drafts"]})`. Частичный ключ `["drafts"]` инвалидирует и `["drafts", false]`, и `["drafts", true]` — список **refetch-ится** после каждой мутации. MSW-хендлер для GET должен возвращать уже обновлённый список, иначе «созданный» черновик исчезнет из отрисованной таблицы (см. доработанный тест Step 1 «creates a draft», где список растёт внутри хендлера).
> 2. **Незаданные MSW-хендлеры возвращают 404, а не падают.** Любой запрос без `server.use(...)` молча даёт 404, поэтому страница может отрисоваться с пустыми данными вместо ожидаемых. В тестах ниже добавлены хендлеры для **всех** запросов, которые реально запускаются сценарием (включая неявные), чтобы 404 было видно как ошибку, а не как тихий пустой список.
> 3. **`useDrafts(all && me.data?.role === "admin")` читается лениво.** При первом рендере `me.data` ещё `undefined`, поэтому `all` вычисляется как `false` и уходит `GET /api/drafts`; после ответа `/api/me` и клика тумблера — `GET /api/drafts?all=1`. В тесте «shows all drafts» нужны оба хендлера.
> 4. **409 от confirm не роняет страницу, но открывает diff-панель.** `onConfirm` при конфликте делает `setDiffFor(draft.id)`, что запускает `useDraftDiff` → `GET /api/drafts/{id}/diff`. В тесте «surfaces a 409» этот запрос надо тоже замокать, иначе панель отрисует «Изменений нет» (не падение, но рассинхрон с заголовком панели).
> 5. **`navigator.clipboard` в jsdom отсутствует.** В реализации `UsersPage` он вызывается напрямую (`navigator.clipboard.writeText`), поэтому тест «copies the invite link» подменяет его через `Object.assign(navigator, { clipboard: ... })`. Если jsdom/версия изменится — этот трюк надо сохранить.
> 6. **`users.error` в UsersPage — не мгновенный.** Пока `useUsers()` не завершился, `users.error` равен `null`, поэтому баннер «Доступ только для администраторов» появляется только после ответа `/api/users` (403). Проверки баннера должны идти через `findBy...` (polling), а не `getBy...` — так в тестах и сделано.

- [ ] **Step 1: Написать `frontend/src/pages/DraftsPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import DraftsPage from "./DraftsPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

describe("DraftsPage", () => {
  it("lists own drafts", async () => {
    server.use(
      // useMe вызывается всегда; дефолтного хендлера /api/me нет (renderPage
      // его не ставит), поэтому задаём явно — иначе MSW вернёт 404 и isReadOnly
      // тумблер для admin просто не отрисуется.
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
    );
    renderPage(<DraftsPage />, "/ui/drafts");
    expect(await screen.findByText("правки")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("shows all drafts for admins when toggled", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      // useDrafts(all && role==="admin") лениво: первый рендер идёт на /api/drafts
      // (me.data ещё undefined → all=false), после клика — на /api/drafts?all=1.
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
      http.get("/api/drafts?all=1", () => HttpResponse.json([fx.draftFixture, { ...fx.draftFixture, id: "d2", name: "чужой" }])),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    const toggle = await screen.findByLabelText("Показывать все");
    await user.click(toggle);
    expect(await screen.findByText("чужой")).toBeInTheDocument();
  });

  it("creates a draft", async () => {
    let body: unknown;
    const drafts: unknown[] = [];
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      // Список растёт внутри хендлера: useCreateDraft.onSuccess инвалидирует
      // ["drafts"], и после мутации GET /api/drafts вызывается повторно.
      // Если вернуть константу [], созданный черновик исчезнет из таблицы.
      http.get("/api/drafts", () => HttpResponse.json(drafts)),
      http.post("/api/drafts", async ({ request }) => {
        body = await request.json();
        drafts.push(fx.draftFixture);
        return HttpResponse.json(fx.draftFixture, { status: 201 });
      }),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    await user.type(await screen.findByLabelText("Название"), "мой черновик");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByText("правки")).toBeInTheDocument();
    expect(body).toEqual({ name: "мой черновик" });
  });

  it("shows the diff with conflict rows marked", async () => {
    server.use(
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
      http.get("/api/drafts/d1/diff", () => HttpResponse.json([
        { kind: "device", key: "r1", change: "modified", conflict: true },
      ])),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    await screen.findByText("правки");
    await user.click(screen.getByTitle("Изменения черновика правки"));
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(screen.getByText("изменено (конфликт)")).toBeInTheDocument();
  });

  it("surfaces a 409 with conflicts as a banner, not a crash", async () => {
    server.use(
      http.get("/api/drafts", () => HttpResponse.json([fx.draftFixture])),
      http.get("/api/me", () => HttpResponse.json({
        id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-09-01T10:00:00Z",
      })),
      http.post("/api/drafts/d1/confirm", () => HttpResponse.json(
        { conflicts: [{ kind: "device", key: "r1" }] }, { status: 409 })),
      // onConfirm при конфликте делает setDiffFor(d1), что запускает этот запрос.
      http.get("/api/drafts/d1/diff", () => HttpResponse.json([])),
    );
    const { user } = renderPage(<DraftsPage />, "/ui/drafts");
    await screen.findByText("правки");
    await user.click(screen.getByTitle("Подтвердить черновик правки"));
    expect(await screen.findByTestId("banner")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Реализовать `frontend/src/pages/DraftsPage.tsx`**

```tsx
import { useState } from "react";
import {
  useConfirmDraft, useCreateDraft, useDeleteDraft, useDraftDiff, useDrafts, useMe,
} from "../api/queries";
import type { DraftDiffEntry, DraftResponse } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { notify } from "../components/notify";

const CHANGE_LABEL: Record<string, string> = { added: "добавлено", modified: "изменено", removed: "удалено" };

export default function DraftsPage() {
  const me = useMe();
  const { draftId, setDraftId } = useDraft();
  const [all, setAll] = useState(false);
  const [diffFor, setDiffFor] = useState<string | null>(null);

  const drafts = useDrafts(all && me.data?.role === "admin");
  const create = useCreateDraft();
  const remove = useDeleteDraft();
  const confirm = useConfirmDraft();
  const diff = useDraftDiff(diffFor);

  const onCreate = async (name: string) => {
    if (!name.trim()) return;
    try {
      const draft = await create.mutateAsync(name.trim());
      notify(`Черновик «${draft.name}» создан`, "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const onDelete = async (draft: DraftResponse) => {
    if (!window.confirm(`Удалить черновик ${draft.name}?`)) return;
    try {
      await remove.mutateAsync(draft.id);
      if (draftId === draft.id) setDraftId(null);
      setDiffFor((current) => (current === draft.id ? null : current));
      notify("Черновик удалён", "ok");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const onConfirm = async (draft: DraftResponse) => {
    try {
      const result = await confirm.mutateAsync(draft.id);
      notify(`Черновик подтверждён как версия ${result.version}`, "ok");
      if (draftId === draft.id) setDraftId(null);
    } catch (error) {
      // 409 приходит и как текст, и как список конфликтов — в обоих случаях
      // это не ошибка приложения, а состояние, которое надо показать.
      const conflicts = (error as { data?: { conflicts?: unknown[] } }).data?.conflicts;
      notify(conflicts ? "Есть конфликты с текущей версией" : (error as Error).message);
      if (conflicts) setDiffFor(draft.id);
    }
  };

  const rows = drafts.data ?? [];

  return (
    <main className="page" data-testid="page-drafts">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>Черновики</h3>
          <p className="hint">Личные черновики и их подтверждение.</p>
        </div>
        {me.data?.role === "admin" && (
          <label className="modal-check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Показывать все
          </label>
        )}
      </div>

      <form
        id="create-draft-form"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
          void onCreate(input.value);
          input.value = "";
        }}
      >
        <label>
          Название
          <input name="name" required placeholder="правки для офиса" />
        </label>
        <button type="submit">Создать</button>
      </form>

      <table className="data-table" id="drafts-table">
        <thead><tr><th>Название</th><th>Автор</th><th>База</th><th>Статус</th><th /></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>{d.owner}</td>
              <td>{d.baseVersion}</td>
              <td>{d.status}</td>
              <td>
                <button type="button" className="btn-link" title={`Открыть черновик ${d.name}`} onClick={() => setDraftId(d.id)}>Открыть</button>
                <button type="button" className="btn-link" title={`Изменения черновика ${d.name}`} onClick={() => setDiffFor(diffFor === d.id ? null : d.id)}>Изменения</button>
                {me.data?.role === "admin" && d.status !== "merged" && (
                  <button type="button" className="btn-link" title={`Подтвердить черновик ${d.name}`} onClick={() => onConfirm(d)}>Подтвердить</button>
                )}
                <button type="button" className="icon-btn delete" title={`Удалить черновик ${d.name}`} onClick={() => onDelete(d)} />
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="empty-cell" colSpan={5}>Черновиков нет</td></tr>
          )}
        </tbody>
      </table>

      {diffFor && (
        <div className="page-panel" id="diff-panel" data-testid="diff-panel">
          <div className="lint-panel-header">
            <strong>{`Изменения: ${rows.find((d) => d.id === diffFor)?.name ?? diffFor}`}</strong>
            <button type="button" className="lint-panel-close" onClick={() => setDiffFor(null)}>×</button>
          </div>
          <table className="data-table" id="diff-body">
            <thead><tr><th>Тип</th><th>Ключ</th><th>Изменение</th></tr></thead>
            <tbody>
              {(diff.data ?? []).map((item: DraftDiffEntry, i) => (
                <tr key={i} className={item.conflict ? "conflict-row" : undefined}>
                  <td>{item.kind}</td>
                  <td>{item.key}</td>
                  <td>{`${CHANGE_LABEL[item.change] ?? item.change}${item.conflict ? " (конфликт)" : ""}`}</td>
                </tr>
              ))}
              {(diff.data ?? []).length === 0 && (
                <tr><td className="empty-cell" colSpan={3}>Изменений нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Написать `frontend/src/pages/UsersPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import UsersPage from "./UsersPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

const USERS = [
  fx.userFixture,
  { id: "u2", username: "bob", role: "user", activated: false, createdAt: "2026-09-02T10:00:00Z" },
];

describe("UsersPage", () => {
  it("shows the access banner for non-admins", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json({ error: "admin role required" }, { status: 403 })),
      http.get("/api/me", () => HttpResponse.json({ ...fx.userFixture, id: "u9", role: "user" })),
    );
    renderPage(<UsersPage />, "/ui/users");
    expect(await screen.findByText(/Доступ только для администраторов/)).toBeInTheDocument();
  });

  it("lists users with role and activation state", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json(USERS)),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
    );
    renderPage(<UsersPage />, "/ui/users");
    expect(await screen.findByText("bob")).toBeInTheDocument();
    expect(screen.getByText("Ожидает")).toBeInTheDocument();
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });

  it("creates a user and shows the invite link", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json([])),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
      http.post("/api/users", () => HttpResponse.json(
        { user: fx.userFixture, inviteUrl: "http://host/invite/tok" }, { status: 201 })),
    );
    const { user } = renderPage(<UsersPage />, "/ui/users");
    await user.click(await screen.findByTitle("Добавить пользователя"));
    await user.type(await screen.findByLabelText("Логин"), "newbie");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByText("http://host/invite/tok")).toBeInTheDocument();
  });

  it("hides edit and delete for the current user", async () => {
    server.use(
      http.get("/api/users", () => HttpResponse.json(USERS)),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
    );
    renderPage(<UsersPage />, "/ui/users");
    await screen.findByText("bob");
    expect(screen.queryByTitle("Удалить пользователя admin")).toBeNull();
    expect(screen.getByTitle("Удалить пользователя bob")).toBeInTheDocument();
  });

  it("copies the invite link to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    server.use(
      http.get("/api/users", () => HttpResponse.json(USERS)),
      http.get("/api/me", () => HttpResponse.json(fx.userFixture)),
      http.post("/api/users/u2/invite", () => HttpResponse.json({ inviteUrl: "http://host/invite/tok2" })),
    );
    const { user } = renderPage(<UsersPage />, "/ui/users");
    await screen.findByText("bob");
    await user.click(screen.getByTitle("Показать ссылку для bob"));
    await user.click(await screen.findByRole("button", { name: "Копировать" }));
    expect(writeText).toHaveBeenCalledWith("http://host/invite/tok2");
  });
});
```

- [ ] **Step 4: Реализовать `frontend/src/pages/UsersPage.tsx`**

```tsx
import { useState } from "react";
import { api } from "../api/client";
import { useMe, useUsers } from "../api/queries";
import type { UserResponse, UserRole } from "../api/types";
import { containsFold } from "../lib/search";
import Modal from "../components/ui/Modal";
import { notify } from "../components/notify";

type Invite = { username: string; url: string };

export default function UsersPage() {
  const users = useUsers();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("user");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [filter, setFilter] = useState("");

  const forbidden = users.error instanceof Error && (users.error as { status?: number }).status === 403;
  const rows = (users.data ?? []).filter((u) => containsFold(u.username, filter));

  const create = async () => {
    try {
      const result = await api.post<{ user: UserResponse; inviteUrl: string }>("/api/users", {
        username: newName.trim(), role: newRole,
      });
      setInvite({ username: result.user.username, url: result.inviteUrl });
      setCreating(false);
      setNewName("");
      void users.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const changeRole = async (user: UserResponse, role: UserRole) => {
    try {
      await api.patch(`/api/users/${user.id}`, { role });
      void users.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const remove = async (user: UserResponse) => {
    if (!window.confirm(`Удалить пользователя ${user.username}?`)) return;
    try {
      await api.del(`/api/users/${user.id}`);
      void users.refetch();
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const showInvite = async (user: UserResponse) => {
    try {
      const result = await api.post<{ inviteUrl: string }>(`/api/users/${user.id}/invite`, {});
      setInvite({ username: user.username, url: result.inviteUrl });
    } catch (error) {
      notify((error as Error).message);
    }
  };

  if (forbidden) {
    return (
      <main className="page" data-testid="page-users">
        <div className="banner error">Доступ только для администраторов</div>
      </main>
    );
  }

  return (
    <main className="page" data-testid="page-users">
      <div className="table-toolbar">
        <div className="toolbar-text">
          <h3>Пользователи</h3>
          <p className="hint">Учётные записи и ссылки приглашения.</p>
        </div>
        <div className="toolbar-actions">
          <input placeholder="логин" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="primary" title="Добавить пользователя" onClick={() => setCreating(true)}>+ Пользователь</button>
        </div>
      </div>

      <table className="data-table">
        <thead><tr><th>Логин</th><th>Роль</th><th>Статус</th><th>Создан</th><th /></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>
                {u.id === me.data?.id ? u.role : (
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value as UserRole)}>
                    <option value="admin">admin</option>
                    <option value="user">user</option>
                  </select>
                )}
              </td>
              <td>
                <span className={`badge badge-${u.activated ? "ok" : "warn"}`}>{u.activated ? "Активен" : "Ожидает"}</span>
              </td>
              <td>{new Date(u.createdAt).toLocaleDateString("ru-RU")}</td>
              <td>
                {!u.activated && (
                  <button type="button" className="btn-link" title={`Показать ссылку для ${u.username}`} onClick={() => showInvite(u)}>Ссылка</button>
                )}
                {u.id !== me.data?.id && (
                  <button type="button" className="icon-btn delete" title={`Удалить пользователя ${u.username}`} onClick={() => remove(u)} />
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="empty-cell" colSpan={5}>Пользователей нет</td></tr>
          )}
        </tbody>
      </table>

      <Modal
        open={creating}
        title="Новый пользователь"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" onClick={() => setCreating(false)}>Отмена</button>
            <button type="button" className="primary" disabled={!newName.trim()} onClick={create}>Создать</button>
          </>
        }
      >
        <div className="modal-grid">
          <label>
            Логин
            <input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label>
            Роль
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
              <option value="admin">admin</option>
              <option value="user">user</option>
            </select>
          </label>
        </div>
      </Modal>

      <Modal
        open={!!invite}
        title={`Ссылка приглашения: ${invite?.username ?? ""}`}
        onClose={() => setInvite(null)}
        footer={<button type="button" onClick={() => setInvite(null)}>Закрыть</button>}
      >
        <div className="modal-grid">
          <input readOnly value={invite?.url ?? ""} />
          <button
            type="button"
            onClick={() => { if (invite) void navigator.clipboard.writeText(invite.url); }}
          >
            Копировать
          </button>
        </div>
      </Modal>
    </main>
  );
}
```

- [ ] **Step 5: Зарегистрировать маршруты**

```tsx
import DraftsPage from "./pages/DraftsPage";
import UsersPage from "./pages/UsersPage";
...
        <Route path="/ui/drafts" element={<DraftsPage />} />
        <Route path="/ui/users" element={<UsersPage />} />
```

- [ ] **Step 6: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 7: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): drafts and users pages"
```

---

### Task 17: Сцена топологии — чистая сборка узлов и рёбер

**Files:**
- Create: `frontend/src/topology/icons.ts`, `frontend/src/topology/scene.ts`, `frontend/src/topology/scene.test.ts`
- Modify: `frontend/src/test/setup.ts` (добавить ResizeObserver для React Flow)

**Interfaces:**
- Consumes: типы (Task 2), `canonicalLink`/`layoutLinkKey` (Task 3).
- Produces: `buildScene(): { nodes, edges, viewport }`, `DEVICE_SIZE`, `NETWORK_SIZE`, `UNION_COLORS`, `KINDS`, `defaultPoint()`.

Это перенос `topo_scene.js` без тем и твинов: только геометрия и данные. Тестируется без DOM — самая ценная часть топологии.

- [ ] **Step 1: Создать `frontend/src/topology/icons.ts`**

```ts
import type { DeviceKind } from "../api/types";

// Геометрия узлов и глифы типов — перенос констант из netmap.js.
export const DEVICE_W = 140;
export const DEVICE_H = 60;
export const NET_W = 160;
export const NET_H = 60;

// Палитра различимых оттенков; цвет объединения = его порядок в документе.
export const UNION_COLORS = [
  "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
];

type KindStyle = { rx: number; glyph?: string };

// Глифы адаптированы из icons/*.svg (svgrepo.com), сетка 24x24, масштаб x0.5.
export const KINDS: Record<DeviceKind, KindStyle> = {
  router: { rx: 16, glyph: "M6 10.5V6M6 10.5L7.5 9M6 10.5L4.5 9M6 6V1.5M6 6H1.5M6 6H10.5M6 1.5L4.5 3M6 1.5L7.5 3M1.5 6L3 7.5M1.5 6L3 4.5M10.5 6L9 4.5M10.5 6L9 7.5" },
  switch: { rx: 2, glyph: "M9 10L10.5 8.5M10.5 8.5L9 7M10.5 8.5H8.5C7.1193 8.5 6 7.3807 6 6C6 4.61929 4.88071 3.5 3.5 3.5H1.5M9 2L10.5 3.5M10.5 3.5L9 5M10.5 3.5L8.5 3.5C7.9372 3.5 7.41785 3.68597 7 3.999815M1.5 8.5H3.5C4.062805 8.5 4.58217 8.31385 5 8" },
};

export const kindStyle = (kind: string): KindStyle => KINDS[kind as DeviceKind] ?? { rx: 4 };
```

- [ ] **Step 2: Написать `frontend/src/topology/scene.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import { DEVICE_H, DEVICE_W, NET_H, NET_W } from "./icons";
import { buildScene, defaultPoint, unionColor } from "./scene";

const topology: TopologyDoc = {
  devices: [
    { name: "r1", kind: "router" },
    { name: "r2", kind: "router" },
    { name: "sw1", kind: "switch" },
  ],
  links: [
    { a: { device: "r1" }, b: { device: "r2" } },
    { a: { device: "r2" }, b: { device: "r1" } }, // резервная: тот же канонический ключ
    { a: { device: "r1" }, b: { device: "sw1" }, filter: { aExports: ["lan"], bExports: [] } },
  ],
  networks: [{ name: "office", subnets: ["lan"], attach: [{ device: "sw1" }] }],
  sets: [],
  unions: [{ name: "u1", devices: ["r1", "r2"] }],
};

const layout: LayoutDoc = {
  devices: { r1: { x: 0, y: 0 }, r2: { x: 300, y: 0 }, sw1: { x: 0, y: 200 } },
  networks: { office: { x: 0, y: 350 } },
  links: { "r1|sw1": [[{ x: 150, y: 120 }]] },
  camera: { x: 0, y: 0, z: 1 },
};

describe("buildScene", () => {
  it("makes one device node per positioned device", () => {
    const { nodes } = buildScene(topology, layout);
    const r1 = nodes.find((n) => n.id === "device:r1")!;
    expect(r1.position).toEqual({ x: 0, y: 0 });
    expect(r1.data.kind).toBe("router");
    expect(nodes.filter((n) => n.type === "device")).toHaveLength(3);
  });

  it("makes one network node per network", () => {
    const { nodes } = buildScene(topology, layout);
    const office = nodes.find((n) => n.id === "network:office")!;
    expect(office.position).toEqual({ x: 0, y: 350 });
    expect(office.data.kind).toBe("network");
  });

  // id рёбер-связей = `link:<key>#<offset>` (суффикс #<offset> — единственный
  // способ различить резервные связи с одним каноническим ключом). Поэтому
  // здесь и ниже сравниваем по префиксу, а не точным равенством.
  it("creates one edge per link with a stable id from the canonical pair", () => {
    const { edges } = buildScene(topology, layout);
    expect(edges.filter((e) => e.type === "link")).toHaveLength(3);
    expect(edges.filter((e) => e.id.startsWith("link:r1|r2"))).toHaveLength(2);
  });

  it("spreads redundant links so they render as distinct lines", () => {
    const { edges } = buildScene(topology, layout);
    const pair = edges.filter((e) => e.id.startsWith("link:r1|r2"));
    expect(pair[0].data.offset).not.toEqual(pair[1].data.offset);
  });

  it("marks a filtered link and carries its exports", () => {
    const { edges } = buildScene(topology, layout);
    const filtered = edges.find((e) => e.id.startsWith("link:r1|sw1"))!;
    expect(filtered.data.filtered).toBe(true);
    expect(filtered.data.filter.aExports).toEqual(["lan"]);
  });

  it("carries waypoints from the layout for the matching duplicate", () => {
    const { edges } = buildScene(topology, layout);
    const filtered = edges.find((e) => e.id.startsWith("link:r1|sw1"))!;
    expect(filtered.data.waypoints).toEqual([{ x: 150, y: 120 }]);
  });

  it("creates an attach edge for every network attachment", () => {
    const { edges } = buildScene(topology, layout);
    const attach = edges.find((e) => e.type === "attach")!;
    expect(attach.id).toBe("attach:office|sw1");
    expect(attach.source).toBe("device:sw1");
    expect(attach.target).toBe("network:office");
  });

  it("skips links whose endpoints have no position yet", () => {
    const { edges } = buildScene(topology, { devices: { r1: { x: 0, y: 0 } } });
    expect(edges).toHaveLength(0);
    const { nodes } = buildScene(topology, { devices: { r1: { x: 0, y: 0 } } });
    expect(nodes.find((n) => n.id === "device:r2")).toBeUndefined();
  });

  it("returns the saved camera as the viewport when it is sane", () => {
    const { viewport } = buildScene(topology, layout);
    expect(viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("ignores a degenerate camera", () => {
    const { viewport } = buildScene(topology, { ...layout, camera: { x: 0, y: 0, z: 0 } });
    expect(viewport).toBeUndefined();
  });
});

describe("defaultPoint", () => {
  it("lays devices and networks out on separate grids", () => {
    expect(defaultPoint("device", 0)).toEqual({ x: 40, y: 40 });
    expect(defaultPoint("device", 5)).toEqual({ x: 40, y: 200 });
    expect(defaultPoint("network", 0)).toEqual({ x: 40, y: 300 });
  });
});

describe("unionColor", () => {
  it("is stable per union index and wraps around", () => {
    expect(unionColor(0)).toBe(unionColor(0));
    expect(unionColor(8)).toBe(unionColor(0));
  });
});

describe("node sizes", () => {
  it("matches the legacy canvas geometry", () => {
    expect([DEVICE_W, DEVICE_H, NET_W, NET_H]).toEqual([140, 60, 160, 60]);
  });
});
```

- [ ] **Step 3: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './scene'`.

- [ ] **Step 4: Реализовать `frontend/src/topology/scene.ts`**

```ts
import type { LayoutDoc, LayoutPoint, LinkDoc, TopologyDoc } from "../api/types";
import { layoutLinkKey } from "../lib/links";
import { DEVICE_H, DEVICE_W, NET_H, NET_W, UNION_COLORS } from "./icons";

export { DEVICE_H, DEVICE_W, NET_H, NET_W };

export type SceneNode = {
  id: string;
  type: "device" | "network";
  position: { x: number; y: number };
  data: {
    name: string;
    kind: string;
    description?: string;
    unionColor?: string;
    subnets?: string[];
  };
};

export type SceneEdge = {
  id: string;
  type: "link" | "attach";
  source: string;
  target: string;
  data: {
    offset: number;
    filtered: boolean;
    filter?: LinkDoc["filter"];
    waypoints?: LayoutPoint[];
  };
};

export type Scene = { nodes: SceneNode[]; edges: SceneEdge[]; viewport?: { x: number; y: number; zoom: number } };

// Позиция по умолчанию для объекта без записи в layout: устройства и сети
// раскладываются на разные сетки, чтобы не накладываться при первом открытии.
export function defaultPoint(kind: "device" | "network", index: number) {
  const x = 40 + (index % 5) * 200;
  const y = kind === "device" ? 40 + Math.floor(index / 5) * 160 : 300 + Math.floor(index / 5) * 160;
  return { x, y };
}

export const unionColor = (index: number) => UNION_COLORS[index % UNION_COLORS.length];

// linkOffsets разносит резервные связи (одинаковая пара устройств) по
// индексу-дубликату, чтобы они рисовались параллельными линиями.
function linkOffsets(links: LinkDoc[]): number[] {
  const seen = new Map<string, number>();
  return links.map((l) => {
    const key = layoutLinkKey(l.a.device, l.b.device);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}

// buildScene — единственный источник nodes/edges для React Flow. Чистая
// функция: документ и layout на входе, позиции и данные на выходе, никаких
// обращений к DOM и никакого состояния страницы.
export function buildScene(topology: TopologyDoc, layout: LayoutDoc): Scene {
  const devices = topology.devices ?? [];
  const networks = topology.networks ?? [];
  const links = topology.links ?? [];
  const unions = topology.unions ?? [];

  const colorOf = new Map<string, string>();
  unions.forEach((u, i) => {
    const color = unionColor(i);
    for (const d of u.devices ?? []) colorOf.set(`device:${d}`, color);
    for (const n of u.networks ?? []) colorOf.set(`network:${n}`, color);
  });

  // В сцену попадают только объекты с позицией в layout: сервер хранит
  // лишь то, что пользователь реально расставил, а позицию по умолчанию
  // (defaultPoint) страница присваивает при создании нового объекта.
  const nodes: SceneNode[] = [];
  devices.forEach((d) => {
    const position = layout.devices?.[d.name];
    if (!position) return;
    nodes.push({
      id: `device:${d.name}`,
      type: "device",
      position,
      data: {
        name: d.name,
        kind: d.kind,
        description: d.description,
        unionColor: colorOf.get(`device:${d.name}`),
      },
    });
  });
  networks.forEach((n) => {
    const position = layout.networks?.[n.name];
    if (!position) return;
    nodes.push({
      id: `network:${n.name}`,
      type: "network",
      position,
      data: {
        name: n.name,
        kind: "network",
        description: n.description,
        subnets: n.subnets,
        unionColor: colorOf.get(`network:${n.name}`),
      },
    });
  });

  const placed = new Set(nodes.map((n) => n.id));
  const offsets = linkOffsets(links);
  const edges: SceneEdge[] = [];

  links.forEach((l, i) => {
    const source = `device:${l.a.device}`;
    const target = `device:${l.b.device}`;
    // Связь без позиции хотя бы одного конца не рисуется: некуда проводить.
    if (!placed.has(source) || !placed.has(target)) return;
    const key = layoutLinkKey(l.a.device, l.b.device);
    const wps = layout.links?.[key]?.[offsets[i]];
    edges.push({
      id: `link:${key}#${offsets[i]}`,
      type: "link",
      source,
      target,
      data: {
        offset: offsets[i],
        filtered: !!l.filter,
        filter: l.filter,
        waypoints: wps,
      },
    });
  });

  networks.forEach((n) => {
    for (const a of n.attach ?? []) {
      const source = `device:${a.device}`;
      const target = `network:${n.name}`;
      if (!placed.has(source) || !placed.has(target)) continue;
      edges.push({
        id: `attach:${n.name}|${a.device}`,
        type: "attach",
        source,
        target,
        data: { offset: 0, filtered: false },
      });
    }
  });

  const camera = layout.camera;
  const viewport = camera && camera.z > 0 ? { x: camera.x, y: camera.y, zoom: camera.z } : undefined;

  return { nodes, edges, viewport };
}
```

- [ ] **Step 5: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные. Правило, закреплённое тестами: в сцену попадают только объекты с позицией в layout, `defaultPoint` страница вызывает сама при создании нового объекта.

- [ ] **Step 6: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): pure topology scene builder"
```

---

### Task 17.1: Известные подводные камни и проверки

> Секция-памятка для исполнителя. Читать до начала работ по Task 17; не является отдельным шагом исполнения (не создаёт коммит). Сверено с актуальным API `@xyflow/react` (v12).

**Соответствие типам React Flow (сверено с документацией):**
- `SceneNode` (`id`, `position`, `type`, `data`) и `SceneEdge` (`id`, `source`, `target`, `type`, `data`) совместимы с `Node`/`Edge` из `@xyflow/react`: у узла обязательны `id`+`position`+`data`, у ребра — `id`+`source`+`target`. `data` — произвольный объект (`Record<string, unknown>`), поэтому `name/kind/description/unionColor/subnets` валидны. Никаких изменений не требуется.
- `viewport: { x, y, zoom }` — корректная форма для `ReactFlow` (используется в Task 18 через `defaults` / `fitView`).

**Главный грабль — уникальность id рёбер.**
`scene.ts` генерирует id связей как `link:<key>#<offset>` (например `link:r1|r2#0`, `link:r1|r2#1`), потому что у резервных связей (одинаковая пара устройств) один и тот же канонический ключ, а React Flow требует уникальные id. Поэтому:
- в тестах сравнивайте по префиксу: `e.id.startsWith("link:r1|r2")`, а **не** `e.id === "link:r1|r2"` (последнее вернёт пустой массив и упадёт).
- `waypoints` берутся из `layout.links[key][offset]` — индекс совпадает с номером дубликата (`offset`), это гарантирует, что вейпоинты попадают на правильное ребро.
- id узлов (`device:<name>`, `network:<name>`) уникальны по построению; id attach-рёбер (`attach:<net>|<dev>`) тоже уникальны, т.к. у сети один объект.

**Семантические правила, закреплённые тестами (не ломать при рефакторинге):**
- В сцену попадают **только** объекты с позицией в `layout`; `defaultPoint()` страница вызывает сама при создании нового объекта. Ребро без позиции хотя бы одного конца пропускается.
- Вырожденная камера (`z <= 0`) игнорируется → `viewport` = `undefined`.
- `unionColor` стабилен по индексу и зацикливается (`unionColor(8) === unionColor(0)`).
- `defaultPoint` раскладывает устройства и сети на разные сетки (устройства `y = 40..`, сети `y = 300..`), чтобы не накладывались.

**Проверка после Task 17 (обязательна):**
```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```
Ожидается: все тесты `scene.test.ts` зелёные (11 тестов `buildScene` + `defaultPoint` + `unionColor` + размеры). Если какой-то из тестов рёбер падает — сначала проверьте, не сравнение ли это по точному id (см. грабль выше), прежде чем менять реализацию.

---

### Task 18: Узлы, рёбра и канва топологии

**Files:**
- Create: `frontend/src/topology/DeviceNode.tsx`, `frontend/src/topology/NetworkNode.tsx`, `frontend/src/topology/LinkEdge.tsx`, `frontend/src/topology/TopologyCanvas.tsx`, `frontend/src/topology/TopologyCanvas.test.tsx`
- Modify: `frontend/src/test/setup.ts`

**Interfaces:**
- Consumes: `buildScene` (Task 17), `icons.ts` (Task 17), `useTopologyOperations` (Task 6).
- Produces: `<TopologyCanvas>` с пропсами `{ topology, layout, editable, onMoveEnd, onNodeDragStop, onConnect, onNodeClick, markOf }`.

**Известные подводные камни (проверено по источникам @xyflow/react 12.11.6) — читать перед шагами:**

1. **DOM-структура React Flow не совпадает с интуицией.** RF навешивает на обёртку узла `data-testid="rf__node-${id}"`, на обёртку ребра — `data-testid="rf__edge-${id}"`, где `id` — это id из массива nodes/edges (`device:r1`, `link:r1|sw1#0`). Кастомные компоненты (`DeviceNode`, `LinkEdge`) живут *внутри* этих обёрток — их рендерит RF (для узлов — контент обёртки, для рёбер — `<g class="react-flow__edge">`).
2. **`className` из объекта узла/ребра RF кладёт на обёртку, а НЕ на контент кастомного компонента.** Это важно для `markOf`: класс подсветки (`diag-flow-*`, `search-hit`) окажется на обёртке `rf__node-*`, а не на внутреннем div с `node-device:r1`. Поэтому тест на mark должен проверять обёртку `rf__node-${id}`. Так и задумано («узел не знает, кто и зачем его подсвечивает»), но в тесте указывать именно обёртку.
3. **`<Handle>` из `@xyflow/react` рендерится всегда**, `nodesConnectable={false}` лишь делает его неактивным (CSS `pointer-events:none`), но НЕ убирает из DOM. Чтобы в read-only не было хэндлов, их надо условно рендерить в кастомном узле по пропсу `isConnectable` из `NodeProps` (он приходит = `nodesConnectable`, если на узле не задан свой).
4. **Ребро без явного `data-testid` не найдётся** через `getByTestId`: RF ставит на ребро только `rf__edge-*`, чего мало для теста «link:r1|sw1#0». Поэтому `LinkEdge` сам ставит `data-testid` на своём корне (корневой `<g>`).
5. `getSmoothStepPath` принимает `sourcePosition`/`targetPosition` как **опциональные** (есть дефолты), так что код LinkEdge (без них и с `sourcePosition: undefined`) компилируется и работает — это НЕ баг.
6. Реакт `memo` и `useCallback<T>` — валидны; `OnMove`, `NodeMouseHandler`, `Background`, `Controls`, `MiniMap`, `Handle`, `Position`, `BaseEdge` экспортируются из `@xyflow/react`.

**Если при исполнении `npm test` падает на `getByTestId("link:...")` (ребро) или на отсутствии `diag-flow-ok` в классам — это пункты 4 и 2 выше, а не ошибки сборки.**

- [ ] **Step 1: Добавить ResizeObserver в `frontend/src/test/setup.ts`**

React Flow измеряет контейнер; в jsdom нет ResizeObserver, поэтому тесты падают без заглушки.

```ts
import "@testing-library/jest-dom/vitest";

// React Flow измеряет контейнер через ResizeObserver, которого в jsdom нет.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// DOMMatrix нужен для расчёта трансформаций вьюпорта.
if (!("DOMMatrixReadOnly" in globalThis)) {
  // @ts-expect-error минимальная заглушка для React Flow
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\\(([\\d.]+)\\)/);
      if (scale) this.m22 = Number(scale[1]);
    }
  };
}
```

- [ ] **Step 2: Написать `frontend/src/topology/TopologyCanvas.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import * as fx from "../api/fixtures";
import TopologyCanvas from "./TopologyCanvas";

const topology: TopologyDoc = fx.topologyFixture;
const layout: LayoutDoc = {
  devices: { r1: { x: 0, y: 0 }, sw1: { x: 300, y: 0 } },
  networks: { office: { x: 0, y: 200 } },
  links: {},
  camera: { x: 0, y: 0, z: 1 },
};

describe("TopologyCanvas", () => {
  beforeEach(() => {
    // React Flow требует ненулевой размер контейнера; в jsdom он нулевой.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
    });
  });

  it("renders one node per positioned device and network", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-network:office")).toBeInTheDocument();
    expect(screen.getByText("r1")).toBeInTheDocument();
    expect(screen.getByText("office")).toBeInTheDocument();
  });

  it("renders links and attachments as edges", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    // id ребра из buildScene (Task 17): link:<канонический ключ>#<offset>.
    // LinkEdge ставит его как data-testid на корневой <g>.
    expect(await screen.findByTestId("link:r1|sw1#0")).toBeInTheDocument();
    expect(screen.getByTestId("attach:office|sw1")).toBeInTheDocument();
  });

  // Обёртку узла RF маркирует rf__node-<id>, обёртку ребра — rf__edge-<id>.
  // Эту обёртку и используем как якорь, чтобы не зависеть от внутренних div.
  it("does not render drag handles in read-only mode", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable={false} />);
    await screen.findByTestId("rf__node-device:r1");
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("renders handles when editable", async () => {
    render(<TopologyCanvas topology={topology} layout={layout} editable />);
    await screen.findByTestId("rf__node-device:r1");
    expect(document.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0);
  });

  it("applies diagnostic marks as wrapper classes", async () => {
    render(
      <TopologyCanvas
        topology={topology}
        layout={layout}
        editable={false}
        markOf={(id) => (id === "device:r1" ? "diag-flow-ok" : undefined)}
      />,
    );
    // RF кладёт className объекта узла на обёртку rf__node-<id>, а НЕ на
    // внутренний div кастомного компонента (см. «известные подводные камни»).
    const node = await screen.findByTestId("rf__node-device:r1");
    expect(node.className).toContain("diag-flow-ok");
  });
});
```

- [ ] **Step 3: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './TopologyCanvas'`.

- [ ] **Step 4: Создать `frontend/src/topology/DeviceNode.tsx`**

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { DEVICE_H, DEVICE_W, kindStyle } from "./icons";

// Узел устройства: рамка по типу (радиус и цвет), глиф типа перед именем.
// memo — перерисовка нужна только при смене данных или выделения.
// Хэндлы рендерятся только при isConnectable: RF не убирает их из DOM при
// nodesConnectable={false}, а лишь делает pointer-events:none (см. камни).
export const DeviceNode = memo(function DeviceNode({ data, selected, isConnectable }: NodeProps) {
  const { name, kind, unionColor, description } = data as unknown as {
    name: string; kind: string; unionColor?: string; description?: string;
  };
  const style = kindStyle(kind);
  return (
    <div
      className={`topo-node device-node kind-${kind}${selected ? " selected" : ""}`}
      title={description || undefined}
      style={{
        width: DEVICE_W,
        height: DEVICE_H,
        borderRadius: style.rx,
        borderColor: unionColor,
      }}
    >
      {style.glyph && (
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d={style.glyph} fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )}
      <span className="node-label">{name} ({kind})</span>
      {isConnectable && <Handle type="source" position={Position.Right} />}
      {isConnectable && <Handle type="target" position={Position.Left} />}
    </div>
  );
});
```

- [ ] **Step 5: Создать `frontend/src/topology/NetworkNode.tsx`**

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { NET_H, NET_W } from "./icons";

// Узел сети — «облако»: цвет обводки по объединению, внутри имя и состав.
// Хэндл — только при isConnectable (см. камни в шапке Task 18).
export const NetworkNode = memo(function NetworkNode({ data, selected, isConnectable }: NodeProps) {
  const { name, unionColor, subnets, description } = data as unknown as {
    name: string; unionColor?: string; subnets?: string[]; description?: string;
  };
  return (
    <div
      className={`topo-node network-node${selected ? " selected" : ""}`}
      title={description || undefined}
      style={{ width: NET_W, height: NET_H, borderColor: unionColor }}
    >
      <span className="node-label">{name}</span>
      {!!subnets?.length && <span className="node-hint">{subnets.join(", ")}</span>}
      {isConnectable && <Handle type="target" position={Position.Left} />}
    </div>
  );
});
```

- [ ] **Step 6: Создать `frontend/src/topology/LinkEdge.tsx`**

```tsx
import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

// Ребро связи. Резервные (параллельные) связи разносятся по data.offset,
// фильтрованная связь рисуется пунктиром, waypoints добавляют изломы.
// RF не ставит на ребро тестируемого testid (там rf__edge-<id>), а сам id
// ребра (link:r1|sw1#0) известен только здесь — навешиваем data-testid на
// корневой <g>. data-* в тип BaseEdgeProps не входит, поэтому обёртка <g>
// нужна и ради testid (см. камни в шапке Task 18).
export function LinkEdge({
  id, sourceX, sourceY, targetX, targetY, data, selected, markerEnd,
}: EdgeProps) {
  const { offset = 0, filtered = false, waypoints } = (data ?? {}) as {
    offset?: number; filtered?: boolean; waypoints?: Array<{ x: number; y: number }>;
  };
  const spread = offset * 12;
  const points = waypoints?.length
    ? [{ x: sourceX, y: sourceY + spread }, ...waypoints, { x: targetX, y: targetY + spread }]
    : undefined;

  const [path] = getSmoothStepPath({
    sourceX,
    sourceY: sourceY + spread,
    targetX,
    targetY: targetY + spread,
    // getSmoothStepPath принимает sourcePosition/targetPosition опционально.
    ...(points ? { sourcePosition: undefined } : {}),
  });

  // Явные waypoints идут напрямую: getSmoothStepPath их не принимает, поэтому
  // для них собираем ломаную вручную.
  const finalPath = points
    ? `M ${points[0].x} ${points[0].y} ` + points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ")
    : path;

  return (
    <g data-testid={id}>
      <BaseEdge
        id={id}
        path={finalPath}
        markerEnd={markerEnd}
        style={{
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: filtered ? "6 4" : undefined,
        }}
        className={filtered ? "link-edge filtered" : "link-edge"}
      />
    </g>
  );
}
```

- [ ] **Step 7: Создать `frontend/src/topology/TopologyCanvas.tsx`**

```tsx
import {
  Background, Controls, MiniMap, ReactFlow,
  type Connection, type NodeMouseHandler, type OnMove,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import type { LayoutDoc, TopologyDoc } from "../api/types";
import { DeviceNode } from "./DeviceNode";
import { NetworkNode } from "./NetworkNode";
import { LinkEdge } from "./LinkEdge";
import { buildScene } from "./scene";

const nodeTypes = { device: DeviceNode, network: NetworkNode };
const edgeTypes = { link: LinkEdge, attach: LinkEdge };

type Props = {
  topology: TopologyDoc;
  layout: LayoutDoc;
  editable: boolean;
  // Класс подсветки узла/ребра: приходит от диагностики (diag-flow-*) или
  // поиска (search-hit). undefined — обычный вид.
  markOf?: (id: string) => string | undefined;
  onMoveEnd?: (viewport: { x: number; y: number; zoom: number }) => void;
  onNodeDragStop?: (id: string, position: { x: number; y: number }) => void;
  onConnect?: (connection: Connection) => void;
  onNodeClick?: NodeMouseHandler;
};

export default function TopologyCanvas({
  topology, layout, editable, markOf, onMoveEnd, onNodeDragStop, onConnect, onNodeClick,
}: Props) {
  const scene = useMemo(() => buildScene(topology, layout), [topology, layout]);

  // Классы подсветки навешиваются здесь, а не в узле: узел не знает, кто и
  // зачем его подсвечивает.
  const nodes = useMemo(
    () => scene.nodes.map((n) => {
      const mark = markOf?.(n.id);
      return mark ? { ...n, className: mark } : n;
    }),
    [scene.nodes, markOf],
  );

  const edges = useMemo(
    () => scene.edges.map((e) => {
      const mark = markOf?.(e.id);
      return mark ? { ...e, className: mark } : e;
    }),
    [scene.edges, markOf],
  );

  const handleMoveEnd = useCallback<OnMove>(
    (_event, viewport) => onMoveEnd?.(viewport),
    [onMoveEnd],
  );

  return (
    <div className="canvas-wrap" style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={!scene.viewport}
        defaultViewport={scene.viewport}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={(event, node) => onNodeDragStop?.(node.id, node.position)}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 8: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные. Если падает «renders links and attachments» — ребро не нашлось по testid: убедиться, что `LinkEdge` ставит `data-testid={id}` на корневой `<g>`, а id = `link:<ключ>#<offset>` (из `buildScene`). Если падает «applies diagnostic marks» — `className` из `markOf` должен лечь на обёртку `rf__node-<id>`, а не на внутренний div.

- [ ] **Step 9: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): React Flow canvas with custom nodes and edges"
```

---

### Task 19: Страница топологии

**Files:**
- Create: `frontend/src/topology/useTopologyEditor.ts`, `frontend/src/topology/useTopologyEditor.test.ts`, `frontend/src/pages/TopologyPage.tsx`, `frontend/src/pages/TopologyPage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `TopologyCanvas` (Task 18), `useProjectResource`, `useTopologyOperations` (Task 6), `defaultPoint` (Task 17), `useDraft`.
- Produces: `<TopologyPage/>`, `useTopologyEditor`.

- [ ] **Step 1: Написать `frontend/src/topology/useTopologyEditor.test.ts`**

```ts
import { renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { server } from "../test/msw";
import { DraftProvider } from "../draft/DraftContext";
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
    sessionStorage.setItem("firenet-draft-id", "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    result.current.moveDevice("r1", { x: 120, y: 80 });
    expect(result.current.status).toBe("dirty");
    await result.current.flush();

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
    sessionStorage.setItem("firenet-draft-id", "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });

    result.current.createDevice({ x: 10, y: 20 }, "router");
    result.current.moveDevice("r1", { x: 5, y: 5 });
    await result.current.flush();

    expect(url).toContain("/batch");
    const ops = (body as { operations: Array<{ kind: string }> }).operations;
    expect(ops.map((o) => o.kind)).toEqual(["create-device", "set-device-position"]);
  });

  it("does nothing in read-only mode", async () => {
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });
    result.current.moveDevice("r1", { x: 1, y: 1 });
    await result.current.flush();
    expect(result.current.status).toBe("saved");
  });

  it("reports a failed flush", async () => {
    server.use(http.post("/api/drafts/d1/topology/operations", () =>
      HttpResponse.json({ error: "unknown topology operation kind \"x\"" }, { status: 422 })));
    sessionStorage.setItem("firenet-draft-id", "d1");
    const { result } = renderHook(() => useTopologyEditor(), { wrapper });
    result.current.moveDevice("r1", { x: 1, y: 1 });
    await result.current.flush();
    expect(result.current.status).toBe("error");
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './useTopologyEditor'`.

- [ ] **Step 3: Реализовать `frontend/src/topology/useTopologyEditor.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useTopologyOperations } from "../api/queries";
import type { DeviceDoc, LayoutPoint, NetworkDoc, TopologyOperation } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { notify } from "../components/notify";
import { defaultPoint } from "./scene";

export type SyncStatus = "saved" | "dirty" | "saving" | "error";

const FLUSH_DELAY_MS = 400;

// Очередь операций редактора: drag узла, создание устройства, связи и т.п.
// складываются в очередь и улетают одним запросом с дебаунсом — ровно та
// модель, что была в topology_sync.js. Статус нужен для индикатора
// «сохранено/изменено» в тулбаре.
export function useTopologyEditor() {
  const { isReadOnly } = useDraft();
  const ops = useTopologyOperations();
  const queue = useRef<TopologyOperation[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<SyncStatus>("saved");

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!queue.current.length) return;
    if (isReadOnly) {
      queue.current = [];
      setStatus("saved");
      return;
    }
    const batch = queue.current;
    queue.current = [];
    setStatus("saving");
    try {
      await ops.mutateAsync(batch);
      setStatus("saved");
    } catch (error) {
      setStatus("error");
      notify((error as Error).message);
    }
  }, [isReadOnly, ops]);

  const enqueue = useCallback((operation: TopologyOperation) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    queue.current.push(operation);
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }, [isReadOnly, flush]);

  // Незакрытая очередь не должна пропадать при уходе со страницы.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const moveDevice = useCallback((name: string, position: LayoutPoint) => {
    enqueue({ kind: "set-device-position", deviceName: name, position });
  }, [enqueue]);

  const moveNetwork = useCallback((name: string, position: LayoutPoint) => {
    enqueue({ kind: "set-network-position", networkName: name, position });
  }, [enqueue]);

  const createDevice = useCallback((position: LayoutPoint, kind: DeviceDoc["kind"], name?: string) => {
    const device: DeviceDoc = { name: name ?? `device-${Date.now().toString(36)}`, kind };
    enqueue({ kind: "create-device", device });
    enqueue({ kind: "set-device-position", deviceName: device.name, position });
    return device;
  }, [enqueue]);

  const createNetwork = useCallback((position: LayoutPoint, name?: string) => {
    const network: NetworkDoc = { name: name ?? `network-${Date.now().toString(36)}` };
    enqueue({ kind: "create-network", network });
    enqueue({ kind: "set-network-position", networkName: network.name, position });
    return network;
  }, [enqueue]);

  const createLink = useCallback((a: string, b: string) => {
    enqueue({ kind: "create-link", link: { a: { device: a }, b: { device: b } } });
  }, [enqueue]);

  const removeSelected = useCallback((selection: string[]) => {
    for (const id of selection) {
      const [kind, name] = id.split(":");
      if (kind === "device") enqueue({ kind: "delete-device", deviceName: name });
      else if (kind === "network") enqueue({ kind: "delete-network", networkName: name });
    }
  }, [enqueue]);

  const setCamera = useCallback((camera: { x: number; y: number; zoom: number }) => {
    enqueue({ kind: "set-camera", camera: { x: camera.x, y: camera.y, z: camera.zoom } });
  }, [enqueue]);

  return {
    status, flush, moveDevice, moveNetwork, createDevice, createNetwork,
    createLink, removeSelected, setCamera, nextDevicePoint: (index: number) => defaultPoint("device", index),
  };
}
```

- [ ] **Step 4: Написать `frontend/src/pages/TopologyPage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import * as fx from "../api/fixtures";
import TopologyPage from "./TopologyPage";

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); });
afterAll(() => server.close());

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
  });
});

describe("TopologyPage", () => {
  it("renders the canvas with devices and networks", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    // testid на обёртке RF — rf__node-<id> (см. Task 18, «подводные камни»).
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(screen.getByTestId("rf__node-network:office")).toBeInTheDocument();
  });

  it("starts in the select tool", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("tool-select");
    expect(screen.getByTestId("tool-select").className).toContain("active");
  });

  it("warns instead of creating when read-only", async () => {
    renderPage(<TopologyPage />, "/ui/topology");
    await screen.findByTestId("tool-device");
    const { user } = renderPage(<TopologyPage />, "/ui/topology");
    await user.click(screen.getAllByTestId("tool-device")[0]);
    expect(await screen.findByTestId("banner")).toBeInTheDocument();
  });

  it("filters nodes by the search query", async () => {
    renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("rf__node-device:r1");
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    await screen.findByTestId("rf__node-device:r1");
    await user.click(screen.getByTestId("topo-search-toggle"));
    await user.type(screen.getByPlaceholderText(/поиск/), "sw1");
    // Класс подсветки (search-hit/search-dim) RF кладёт на обёртку rf__node-<id>.
    expect(screen.getByTestId("rf__node-device:sw1").className).toContain("search-hit");
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("search-dim");
  });

  it("deletes the selection with Del", async () => {
    let body: unknown;
    server.use(http.post("/api/drafts/d1/topology/operations", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(fx.editorSnapshotFixture);
    }));
    const { user } = renderPage(<TopologyPage />, "/ui/topology", "d1");
    const node = await screen.findByTestId("rf__node-device:r1");
    await user.click(node);
    await user.keyboard("{Delete}");
    expect(await screen.findByTestId("banner")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Реализовать `frontend/src/pages/TopologyPage.tsx`**

```tsx
import { useCallback, useMemo, useState } from "react";
import { useProjectResource } from "../api/queries";
import type { LayoutDoc, SubnetsDoc, TopologyDoc } from "../api/types";
import { useDraft } from "../draft/DraftContext";
import { containsFold, matchPrefixQuery } from "../lib/search";
import { useTopologyEditor } from "../topology/useTopologyEditor";
import TopologyCanvas from "../topology/TopologyCanvas";
import { notify } from "../components/notify";

type Tool = "select" | "connect" | "device" | "network";

const EMPTY_TOPOLOGY: TopologyDoc = { devices: [], links: [], networks: [], sets: [], unions: [] };

export default function TopologyPage() {
  const { isReadOnly } = useDraft();
  const topology = useProjectResource<TopologyDoc>("topology");
  const layoutQuery = useProjectResource<LayoutDoc>("layout");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const editor = useTopologyEditor();

  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const doc = topology.data ?? EMPTY_TOPOLOGY;
  const layout = layoutQuery.data ?? {};

  const cidrOf = useMemo(() => {
    const map = new Map((subnets.data?.subnets ?? []).map((s) => [s.name, s.cidr]));
    return (name: string) => map.get(name) ?? "";
  }, [subnets.data]);

  // Поиск по канве: имя устройства/сети, состав сети и CIDR её подсетей.
  const matches = useMemo(() => {
    if (!query) return null;
    const hit = new Set<string>();
    for (const d of doc.devices) if (containsFold(d.name, query)) hit.add(`device:${d.name}`);
    for (const n of doc.networks) {
      const byName = containsFold(n.name, query);
      const bySubnet = (n.subnets ?? []).some((s) => containsFold(s, query) || matchPrefixQuery(cidrOf(s), query));
      if (byName || bySubnet) hit.add(`network:${n.name}`);
    }
    return hit;
  }, [query, doc, cidrOf]);

  const markOf = useCallback((id: string) => {
    if (!matches) return undefined;
    if (matches.has(id)) return "search-hit";
    return id.includes(":") ? "search-dim" : undefined;
  }, [matches]);

  const guard = (action: () => void) => {
    if (isReadOnly) {
      notify("Только чтение — откройте черновик, чтобы редактировать");
      return;
    }
    action();
  };

  const onPaneClick = useCallback((position: { x: number; y: number }) => {
    if (tool === "device") guard(() => { editor.createDevice(position, "router"); });
    if (tool === "network") guard(() => { editor.createNetwork(position); });
  }, [tool, editor, isReadOnly]);

  const statusLabel = editor.status === "saved" ? "Сохранено" : editor.status === "dirty" ? "Изменено" : editor.status === "saving" ? "Сохранение…" : "Ошибка";

  return (
    <main className="page" data-testid="page-topology">
      <div className="topology-layout">
        <div className="canvas-wrap">
          <div className="topo-toolbar">
            <button
              type="button"
              data-testid="topo-search-toggle"
              className="tool"
              title="Поиск по устройствам, сетям, подсетям"
              onClick={() => setSearchOpen(!searchOpen)}
            />
            <input
              id="topo-search"
              hidden={!searchOpen}
              placeholder="поиск: имя / CIDR / IP"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="toolbar-sep" />
            <button
              type="button"
              className="tool danger"
              title="Удалить выбранное (Del)"
              disabled={!selection.length}
              onClick={() => guard(() => editor.removeSelected(selection))}
            />
            <span className="toolbar-sep" />
            <button
              type="button"
              data-testid="tool-select"
              className={`tool${tool === "select" ? " active" : ""}`}
              title="Выбор и перемещение (V)"
              onClick={() => setTool("select")}
            />
            <button
              type="button"
              data-testid="tool-connect"
              className={`tool${tool === "connect" ? " active" : ""}`}
              title="Соединить устройства/сети (C)"
              onClick={() => setTool("connect")}
            />
            <button
              type="button"
              data-testid="tool-device"
              className={`tool${tool === "device" ? " active" : ""}`}
              title="Добавить устройство (D)"
              onClick={() => guard(() => setTool("device"))}
            />
            <button
              type="button"
              data-testid="tool-network"
              className={`tool${tool === "network" ? " active" : ""}`}
              title="Добавить сеть (N)"
              onClick={() => guard(() => setTool("network"))}
            />
            <span className="toolbar-sep" />
            <span
              id="topo-sync-status"
              className={`sync-status ${editor.status}`}
              role="status"
              aria-live="polite"
              title={statusLabel}
              aria-label={statusLabel}
            />
          </div>

          <TopologyCanvas
            topology={doc}
            layout={layout}
            editable={!isReadOnly}
            markOf={markOf}
            onMoveEnd={(viewport) => editor.setCamera(viewport)}
            onNodeDragStop={(id, position) => {
              const [kind, ...rest] = id.split(":");
              const name = rest.join(":");
              if (kind === "device") editor.moveDevice(name, position);
              if (kind === "network") editor.moveNetwork(name, position);
            }}
            onConnect={(connection) => guard(() => editor.createLink(
              connection.source.replace("device:", ""),
              connection.target.replace("device:", ""),
            ))}
            onNodeClick={(event, node) => setSelection([node.id])}
          />
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Добавить поддержку клика по панели и Del в `TopologyCanvas`**

Дополнить `TopologyCanvas.tsx` пропом `onPaneClick` и клавиатурной обработкой удаления:

```tsx
  onPaneClick?: (position: { x: number; y: number }) => void;
  onDelete?: (ids: string[]) => void;
```

внутри компонента:

```tsx
  const { screenToFlowPosition } = useReactFlow();
  const handlePaneClick = useCallback((event: React.MouseEvent) => {
    if (!onPaneClick) return;
    onPaneClick(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [onPaneClick, screenToFlowPosition]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Delete" || !onDelete) return;
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length) onDelete(ids);
  }, [nodes, onDelete]);
```

и повесить их на контейнер: `<div className="canvas-wrap" onClick={handlePaneClick} onKeyDown={handleKeyDown} tabIndex={0}>`. Импортировать `useReactFlow` из `@xyflow/react`.

- [ ] **Step 7: Передать новые пропсы из страницы**

В `TopologyPage.tsx` добавить к `<TopologyCanvas>`:

```tsx
            onPaneClick={onPaneClick}
            onDelete={(ids) => guard(() => editor.removeSelected(ids))}
```

- [ ] **Step 8: Зарегистрировать маршрут**

```tsx
import TopologyPage from "./pages/TopologyPage";
...
        <Route path="/ui/topology" element={<TopologyPage />} />
```

- [ ] **Step 9: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 10: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): topology editor page on React Flow"
```

---

### Task 20: Страница диагностики

**Files:**
- Create: `frontend/src/pages/DiagnosePage.tsx`, `frontend/src/pages/DiagnosePage.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `TopologyCanvas` (Task 18), `useDiagnose`, `useSpread`, `useProjectResource` (Task 6), `layoutLinkKey` (Task 3).
- Produces: `<DiagnosePage/>`.

Канва — read-only; подсветка путей берётся из `report.mapMark`. Форма диагностики сохраняется в localStorage под ключом `firenet-diag-form-v1`, как в легаси.

- [ ] **Step 1: Написать `frontend/src/pages/DiagnosePage.test.tsx`**

```tsx
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../test/msw";
import { renderPage } from "../test/renderPage";
import DiagnosePage from "./DiagnosePage";

const REPORT = {
  srcSubnet: "lan",
  dstSubnet: "dmz",
  note: "путей: 1",
  paths: [{
    nodes: [{ kind: 0, name: "r1" }, { kind: 1, name: "dmz" }],
    routers: [{ router: "r1", action: "allow", reason: "правило web", matchedRule: "web" }],
    verdict: "allow",
  }],
  returnPathAllowed: true,
  mapMark: {
    hl: ["device:r1"], ok: ["device:r1", "device:sw1"], okE: ["r1\0sw1"],
    denyE: [], half: [], halfE: [], deny: {},
  },
};

beforeAll(() => server.listen());
afterEach(() => { server.resetHandlers(); sessionStorage.clear(); localStorage.clear(); });
afterAll(() => server.close());

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON: () => ({}),
  });
});

describe("DiagnosePage", () => {
  it("renders the read-only map", async () => {
    renderPage(<DiagnosePage />, "/ui/diagnose");
    // testid на обёртке RF — rf__node-<id> (см. Task 18, «подводные камни»):
    // внутренний div кастомного узла testid не несёт.
    expect(await screen.findByTestId("rf__node-device:r1")).toBeInTheDocument();
    expect(document.querySelector(".react-flow__handle")).toBeNull();
  });

  it("runs a diagnose request and shows the verdict", async () => {
    let body: unknown;
    server.use(http.post("/api/versions/current/diagnose", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(REPORT);
    }));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.0.1.5");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));

    expect(await screen.findByText(/путей: 1/)).toBeInTheDocument();
    expect(screen.getByText("разрешено")).toBeInTheDocument();
    expect(body).toMatchObject({ src: "10.0.0.5", dst: "10.0.1.5", proto: "", dstPorts: [] });
  });

  it("marks the path nodes on the map", async () => {
    server.use(http.post("/api/versions/current/diagnose", () => HttpResponse.json(REPORT)));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.0.1.5");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));
    await screen.findByText(/путей: 1/);
    expect(screen.getByTestId("rf__node-device:r1").className).toContain("diag-flow-ok");
  });

  it("reports an unreachable destination", async () => {
    server.use(http.post("/api/versions/current/diagnose", () => HttpResponse.json({
      ...REPORT, paths: [], note: "недостижимо",
    })));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.type(await screen.findByLabelText("Источник"), "10.0.0.5");
    await user.type(screen.getByLabelText("Назначение"), "10.9.9.9");
    await user.click(screen.getByRole("button", { name: "Проверить путь" }));
    expect(await screen.findByText(/недостижимо/)).toBeInTheDocument();
  });

  it("runs a spread request", async () => {
    server.use(http.post("/api/versions/current/diagnose/spread", () => HttpResponse.json({
      sources: [{ IP: "10.0.0.5", SubnetName: "lan" }],
      reports: [{ candidate: "dmz", report: REPORT }],
      mark: REPORT.mapMark,
    })));
    const { user } = renderPage(<DiagnosePage />, "/ui/diagnose");
    await user.click(await screen.findByTitle("Распространение"));
    await user.type(await screen.findByLabelText("Источник (сеть, подсеть или IP)"), "lan");
    await user.click(screen.getByRole("button", { name: "Проверить доступность" }));
    expect(await screen.findByText(/Достижимо 1 из 1/)).toBeInTheDocument();
  });

  it("restores the form from localStorage", async () => {
    localStorage.setItem("firenet-diag-form-v1", JSON.stringify({ src: "10.0.0.5", dst: "10.0.1.5", proto: "tcp", dstPorts: "80" }));
    renderPage(<DiagnosePage />, "/ui/diagnose");
    expect(await screen.findByLabelText("Источник")).toHaveValue("10.0.0.5");
    expect(screen.getByLabelText("Порты назначения")).toHaveValue("80");
  });
});
```

- [ ] **Step 2: Запустить — тест падает**

```bash
cd /root/repos/firenet/frontend && npm test 2>&1 | tail -20
```

Expected: FAIL `Cannot find module './DiagnosePage'`.

- [ ] **Step 3: Реализовать `frontend/src/pages/DiagnosePage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDiagnose, useProjectResource, useSpread } from "../api/queries";
import type { DiagnoseReport, LayoutDoc, MapMark, SpreadResult, SubnetsDoc, TopologyDoc } from "../api/types";
import { layoutLinkKey } from "../lib/links";
import TopologyCanvas from "../topology/TopologyCanvas";
import { notify } from "../components/notify";

const FORM_KEY = "firenet-diag-form-v1";
const EMPTY_TOPOLOGY: TopologyDoc = { devices: [], links: [], networks: [], sets: [], unions: [] };

type Form = { src: string; dst: string; proto: string; dstPorts: string };
type SpreadForm = { src: string };

const VERDICT_LABEL: Record<string, string> = {
  allow: "разрешено", deny: "запрещено", return: "возврат в FORWARD",
};

export default function DiagnosePage() {
  const topology = useProjectResource<TopologyDoc>("topology");
  const layoutQuery = useProjectResource<LayoutDoc>("layout");
  const subnets = useProjectResource<SubnetsDoc>("subnets");
  const diagnose = useDiagnose();
  const spread = useSpread();

  const [form, setForm] = useState<Form>(() => readForm());
  const [spreadForm, setSpreadForm] = useState<SpreadForm>({ src: "" });
  const [panel, setPanel] = useState<"path" | "spread">("path");
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [spreadMark, setSpreadMark] = useState<MapMark | null>(null);
  const [spreadData, setSpreadData] = useState<SpreadResult | null>(null);

  const doc = topology.data ?? EMPTY_TOPOLOGY;
  const layout = layoutQuery.data ?? {};

  // Форма переживает перезагрузку страницы: поля диагностики долго вводить.
  useEffect(() => {
    localStorage.setItem(FORM_KEY, JSON.stringify(form));
  }, [form]);

  const runDiagnose = async () => {
    try {
      const result = await diagnose.mutateAsync({
        src: form.src.trim(),
        dst: form.dst.trim(),
        proto: form.proto as "" | "tcp" | "udp" | "icmp",
        srcPorts: [],
        dstPorts: form.dstPorts.split(",").map((p) => p.trim()).filter(Boolean),
      });
      setReport(result);
      setSpreadMark(null);
      setSpreadData(null);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const runSpread = async () => {
    try {
      const result = await spread.mutateAsync({
        src: spreadForm.src.trim(), proto: "", dstPorts: [],
      });
      setSpreadMark(result.mark);
      setSpreadData(result);
      setReport(null);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const reset = () => {
    setReport(null);
    setSpreadMark(null);
    setSpreadData(null);
  };

  // Ключи okE/halfE/denyE приходят с NUL-разделителем — тот же формат, что
  // использовала самописная канва. Рёбра в канве живут под id
  // link:<канонический ключ>#<offset> (buildScene в Task 17/18), поэтому
  // здесь ключ строится без суффикса, а markOf сопоставляет по префиксу.
  const mark = useMemo(() => buildMark(report?.mapMark ?? spreadMark), [report, spreadMark]);

  // Узлы в канве имеют id ровно device:<имя>/network:<имя>, так что на них
  // mark ставится прямым соответствием. Рёбра же идут с суффиксом
  // «#<offset>» (параллельные связи), поэтому ищем по префиксу
  // link:<ключ>, где <ключ> — из mapMark (NUL-разделитель → layoutLinkKey).
  const markOf = useCallback((id: string) => {
    const direct = mark.get(id);
    if (direct) return direct;
    if (id.startsWith("link:")) {
      const base = id.slice(0, id.lastIndexOf("#"));
      const fromBase = mark.get(base);
      if (fromBase) return fromBase;
      const slash = id.indexOf(":");
      const a = id.slice(slash + 1, id.indexOf("|"));
      const b = id.slice(id.indexOf("|") + 1, id.lastIndexOf("#"));
      return mark.get(`link:${layoutLinkKey(a, b)}`);
    }
    return undefined;
  }, [mark]);

  return (
    <main className="page" data-testid="page-diagnose">
      <div className="topology-layout">
        <div className="canvas-wrap">
          <div className="topo-toolbar">
            <button type="button" data-testid="tool-path" className={`tool${panel === "path" ? " active" : ""}`} title="Диагностика пути" onClick={() => setPanel("path")} />
            <button type="button" data-testid="tool-spread" className={`tool${panel === "spread" ? " active" : ""}`} title="Распространение" onClick={() => setPanel("spread")} />
            <span className="toolbar-sep" />
            <button type="button" className="tool" title="Сбросить" disabled={!report && !spreadMark} onClick={reset} />
          </div>

          <TopologyCanvas topology={doc} layout={layout} editable={false} markOf={markOf} />

          {panel === "path" ? (
            <form
              className="diag-panel floating-panel"
              data-testid="diag-panel"
              onSubmit={(event) => { event.preventDefault(); void runDiagnose(); }}
            >
              <header className="floating-panel-header">
                <strong>Диагностика пути</strong>
              </header>
              <div className="floating-panel-body">
                <label>
                  Источник
                  <input value={form.src} onChange={(e) => setForm({ ...form, src: e.target.value })} placeholder="10.0.0.5" />
                </label>
                <label>
                  Назначение
                  <input value={form.dst} onChange={(e) => setForm({ ...form, dst: e.target.value })} placeholder="10.0.1.5" />
                </label>
                <label>
                  Протокол
                  <select value={form.proto} onChange={(e) => setForm({ ...form, proto: e.target.value })}>
                    <option value="">любой</option>
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                    <option value="icmp">icmp</option>
                  </select>
                </label>
                <label>
                  Порты назначения
                  <input value={form.dstPorts} onChange={(e) => setForm({ ...form, dstPorts: e.target.value })} placeholder="80,443" />
                </label>
                <div className="modal-actions">
                  <button type="submit" className="primary" disabled={diagnose.isPending || !form.src.trim() || !form.dst.trim()}>
                    Проверить путь
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <form
              className="diag-panel floating-panel"
              data-testid="spread-panel"
              onSubmit={(event) => { event.preventDefault(); void runSpread(); }}
            >
              <header className="floating-panel-header">
                <strong>Распространение сети</strong>
              </header>
              <div className="floating-panel-body">
                <label>
                  Источник (сеть, подсеть или IP)
                  <input value={spreadForm.src} onChange={(e) => setSpreadForm({ src: e.target.value })} placeholder="lan" />
                </label>
                <div className="modal-actions">
                  <button type="submit" className="primary" disabled={spread.isPending || !spreadForm.src.trim()}>
                    Проверить доступность
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>

        {report && (
          <div className="page-panel" data-testid="diag-report">
            <p>{`${report.srcSubnet} → ${report.dstSubnet}: путей ${report.paths.length}. ${report.note}`}</p>
            {!report.returnPathAllowed && (
              <p className="diag-halfpath">Доступность только в одну сторону: обратный путь закрыт.</p>
            )}
            {report.paths.map((path, i) => (
              <section className="diag-path" key={i}>
                <span className="badge">{VERDICT_LABEL[path.verdict] ?? path.verdict}</span>
                {path.note && <p className="diag-note">{path.note}</p>}
                <div className="diag-chain">
                  {path.nodes.map((n, j) => (
                    <span key={j}>
                      {j > 0 && <span className="diag-arrow">→</span>}
                      <span className={`diag-chip${n.kind === 0 ? " diag-chip-router" : ""}`}>{n.name}</span>
                    </span>
                  ))}
                </div>
                {path.routers.map((r) => (
                  <details className="diag-verdict" key={r.router}>
                    <summary>{`${r.router}: ${r.action}${r.matchedRule ? ` (${r.matchedRule})` : ""}`}</summary>
                    {r.steps?.length
                      ? <ol className="diag-steps">{r.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
                      : <p>{r.reason}</p>}
                  </details>
                ))}
              </section>
            ))}
            {report.paths.length === 0 && <p className="diag-unreachable">Путей нет.</p>}
          </div>
        )}

        {spreadData && (
          <div className="page-panel" data-testid="spread-report">
            <p>
              {`Источник: ${spreadData.sources.map((s) => s.SubnetName || s.IP).join(", ")}. ` +
                `Достижимо ${spreadData.reports.filter((r) => r.report.paths.length > 0).length} из ${spreadData.reports.length} подсетей.`}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function readForm(): Form {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (!raw) return { src: "", dst: "", proto: "", dstPorts: "" };
    const parsed = JSON.parse(raw) as Partial<Form>;
    return {
      src: parsed.src ?? "", dst: parsed.dst ?? "",
      proto: parsed.proto ?? "", dstPorts: parsed.dstPorts ?? "",
    };
  } catch {
    return { src: "", dst: "", proto: "", dstPorts: "" };
  }
}

// mapMark приходит с сервера в виде списков имён; здесь он превращается в
// соответствие «id узла/ребра → класс подсветки». Узлы индексируются точно
// (device:<имя>, network:<имя>), рёбра — по каноническому ключу без
// суффикса #<offset> (см. markOf выше).
function buildMark(mark: MapMark | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!mark) return result;
  for (const id of mark.ok ?? []) result.set(id, "diag-flow-ok");
  for (const id of mark.half ?? []) result.set(id, "diag-flow-half");
  for (const name of Object.keys(mark.deny ?? {})) result.set(`device:${name}`, "diag-flow-deny");
  for (const key of mark.okE ?? []) {
    const [a, b] = key.split("\0");
    if (a && b) result.set(`link:${layoutLinkKey(a, b)}`, "diag-flow-ok");
  }
  for (const key of mark.halfE ?? []) {
    const [a, b] = key.split("\0");
    if (a && b) result.set(`link:${layoutLinkKey(a, b)}`, "diag-flow-half");
  }
  for (const key of mark.denyE ?? []) {
    const [a, b] = key.split("\0");
    if (a && b) result.set(`link:${layoutLinkKey(a, b)}`, "diag-flow-deny");
  }
  return result;
}
```

- [ ] **Step 4: Согласовать testid узлов с Task 18**

В коде Step 3 узлы канвы рендерит `TopologyCanvas` (Task 18), где RF навешивает на обёртку узла `data-testid="rf__node-<id>"` — а внутренний div кастомного `DeviceNode`/`NetworkNode` никакого testid не несёт (см. Task 18, «известные подводные камни», пункты 1–2). Поэтому в тестах Task 20 (шаги выше) уже используется `rf__node-device:r1`, а НЕ `node-device:r1`.

⚠️ Если вы исполняете Task 20 до того, как Task 18 прошёл проверку, и тесты падают на `getByTestId("rf__node-device:r1")` — значит в `DeviceNode`/`NetworkNode` (Task 18) обёртка не несёт нужного testid. Тогда:
- либо убедиться, что Task 18 корректно рендерит `rf__node-<id>` (обёртку ставит сам RF, а не кастомный узел), и ничего в Task 20 не менять;
- либо, если проект сознательно ставит testid на внутренний div узла, заменить в тестах Task 20 `rf__node-device:r1` обратно на `node-device:r1`.

Предпочтительный путь — ровно тот, что в коде: тесты смотрят на обёртку `rf__node-<id>`, `className` (класс подсветки) тоже на ней (см. Step 3, markOf).

- [ ] **Step 5: Зарегистрировать маршрут**

```tsx
import DiagnosePage from "./pages/DiagnosePage";
...
        <Route path="/ui/diagnose" element={<DiagnosePage />} />
```

- [ ] **Step 6: Запустить тесты**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test
```

Expected: зелёные.

- [ ] **Step 7: Commit**

```bash
cd /root/repos/firenet && git add frontend/src && git commit -m "feat(frontend): diagnose page with read-only map and spread"
```

---

### Task 21: Очистка Go-бэкенда до pure API

**Files:**
- Delete: `internal/httpapi/templates/` (15 файлов), `internal/httpapi/web/` (все файлы), `internal/httpapi/embed.go`, `internal/httpapi/server_test.go` (см. Step 3 — файл целиком)
- Modify: `internal/httpapi/server.go`, `internal/httpapi/handlers.go` (только комментарий), `internal/httpapi/search_index.go` (только комментарий), `README.md`, `Makefile`

**Interfaces:**
- Consumes: ничего.
- Produces: `go build ./...` зелёный, `net/http` отдаёт только `/api/*`.

**Известные подводные камни (прочитать перед началом):**
- В `server.go` после удаления шаблонов/статики остаются мёртвые импорты `crypto/sha256`, `encoding/hex`, `html/template`, `io`, `io/fs`, `path`, `strings` (см. Step 2). `go vet` падает на unused imports, поэтому импорты правим в том же коммите.
- `server_test.go` содержит только тесты статики/шаблонов (см. Step 3) — файл удаляется целиком, а не «до опустения».
- Других ссылок на удаляемые символы нет: `webFiles`/`templateFiles`/`noCache`/`servePage`/`parsePageTemplates`/`mustPageTemplate`/`serveTemplatedPage`/`templatedPages`/`pageData` не встречаются вне `server.go`/`embed.go`/`server_test.go` (проверено grep). `search_index_test.go` и `handlers_test.go` используют только `/api/*`-роуты и `newTestServer`/`doJSON` (определены в `handlers_test.go` и остаются).
- `frontend/` НЕ должен попасть в коммит: он уже лежит в рабочем дереве, но в `git status` его файлы должны остаться непроиндексированными (Step 8).

- [ ] **Step 1: Удалить ассеты и шаблоны**

```bash
cd /root/repos/firenet && git rm -r --quiet internal/httpapi/templates internal/httpapi/web internal/httpapi/embed.go && ls internal/httpapi
```

Expected: в `internal/httpapi` остались только `.go`-файлы (api_cache, auth_handlers, draft_handlers, dto, handlers, invite_handlers, search_index, server, topology_operations, user_handlers, version_handlers + тесты).

- [ ] **Step 2: Переписать `internal/httpapi/server.go`**

Оставить из файла только: `NewServer` с `apiMux` и логин/инвайт-роутами, `withLogging`, `withAPICache`. Удалить `parsePageTemplates`, `mustPageTemplate`, `servePage`, `serveTemplatedPage`, `templatedPages`, `pageData`, `noCache`, все `GET /ui/*`, `GET /login`, `GET /invite/{token}`, `GET /{$}` и `mux.Handle("/", ...)`.

⚠️ **Импорты.** Вместе с кодом удаляются и мёртвые импорты (иначе `go vet` падает на unused): из `import (...)` убрать `crypto/sha256`, `encoding/hex`, `html/template`, `io`, `io/fs`, `path`, `strings`. Остаются только `log/slog`, `net/http`, `internal/auth`, `internal/pgstore` (см. листинг ниже). В листинге ниже заглушка `// ... (все существующие apiMux-регистрации переносятся без изменений)` заменяется на строки 27–71 текущего файла `server.go` 1:1.

```go
// Package httpapi serves firenet's JSON API. It is an adapter, at the same
// tier as the former CLI: it reuses internal/topology, internal/rules and
// internal/app for all domain logic and knows nothing about any UI. The
// web UI is a separate service (frontend/) that talks to this API.
package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/kudes1/firenet/internal/auth"
	"github.com/kudes1/firenet/internal/pgstore"
)

// NewServer builds the HTTP handler for firenet's JSON API.
// Every /api/ route requires a valid session (login/logout/invites
// excepted). Project content lives entirely in projects (internal/pgstore):
// the current confirmed version is read-only everywhere, edits only ever
// happen inside a personal draft.
func NewServer(projects *pgstore.Store, users *auth.Store, log *slog.Logger) http.Handler {
	h := &handlers{projects: projects, users: users, log: log}

	apiMux := http.NewServeMux()
	// ... (все существующие apiMux-регистрации переносятся без изменений)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", h.login)
	mux.HandleFunc("POST /api/logout", h.logout)
	mux.HandleFunc("GET /api/invites/{token}", h.getInvite)
	mux.HandleFunc("POST /api/invites/{token}", h.acceptInvite)
	mux.Handle("/api/", auth.RequireAuth(users)(apiMux))

	return withLogging(log, withAPICache(mux))
}

func withLogging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Debug("http request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
```

В теле `NewServer` сохранить все строки регистрации `apiMux` из текущего файла 1:1 — маркер `// ... (все существующие apiMux-регистрации переносятся без изменений)` заменяется на них.

- [ ] **Step 3: Удалить `server_test.go` целиком**

Файл содержит **только** тесты статики/шаблонов, которых после Step 1–2 не станет, поэтому он удаляется весь, а не «до опустения». Это четыре теста + хелпер:

- `TestStaticAssetsNoCache` — проверяет `noCache` и раздачу `/common.js` и т.п. (статики больше нет);
- `TestParsePageTemplatesRenderDistinctContent` — парсит `parsePageTemplates()`;
- `TestTemplatedPages` — запрашивает все `GET /ui/*`;
- `TestMustPageTemplatePanicsOnUnknownPage` — проверяет `mustPageTemplate`;
- хелпер `assertLayoutInvariants` — используется только в `TestTemplatedPages`.

API-тесты остаются в `handlers_test.go`, `search_index_test.go`, `api_cache_test.go` и др. — там только `/api/*`-роуты и `newTestServer`/`doJSON` (определены в `handlers_test.go`, их не трогаем). Удаление:

```bash
cd /root/repos/firenet && git rm -q internal/httpapi/server_test.go
```

Проверка, что больше нигде не осталось ссылок на удаляемые символы (ожидается пустой вывод):

```bash
cd /root/repos/firenet && grep -rn 'webFiles\|templateFiles\|noCache\|servePage\|parsePageTemplates\|mustPageTemplate\|serveTemplatedPage\|templatedPages\|pageData' --include=*.go internal/ cmd/ || true
```

- [ ] **Step 4: Обновить комментарии, ссылающиеся на страницы**

`internal/httpapi/handlers.go:318` — комментарий про «/ui/links identifies it by array position»:

```go
	// by canonical endpoint pair; the links page still addresses a link by
	// array position in its own URLs, so the legacy index is handed back to
	// keep that working.
```

`internal/httpapi/search_index.go:10` — «served to /ui/search» заменить на:

```go
// searchEntry is one row of the search index served to the search page.
```

- [ ] **Step 5: Собрать и проверить**

```bash
cd /root/repos/firenet && go build ./... && go vet ./... && gofmt -l . && go test ./...
```

Expected: сборка и тесты зелёные, `gofmt` не печатает ничего.

- [ ] **Step 6: Обновить `Makefile`**

```makefile
.PHONY: build run dev test fe-test fe-build test-e2e vet fmt tidy clean

build:
	go build -o $(BIN_DIR)/$(BINARY) ./cmd/firenet

run:
	go run ./cmd/firenet

dev:
	docker compose up -d --build

test:
	go test ./...

fe-test:
	cd frontend && npm test

fe-build:
	cd frontend && npm run build

test-e2e: build
	cd e2e && npx playwright test

vet:
	go vet ./...

fmt:
	gofmt -l -w .

tidy:
	go mod tidy

clean:
	rm -rf $(BIN_DIR)
```

- [ ] **Step 7: Обновить `README.md`**

- В разделе «Структура проекта» заменить `internal/httpapi/  HTTP API и встроенный веб-интерфейс` на `internal/httpapi/  HTTP API (JSON)` и добавить строку `frontend/          веб-интерфейс: React + TypeScript + Vite`;
- В разделе «Разработка» заменить `node --test 'internal/httpapi/web/*.test.js'` на `cd frontend && npm test`;
- Убрать упоминание «После изменения файлов из `internal/httpapi/web/` пересоберите образ».

- [ ] **Step 8: Commit**

⚠️ **Не использовать `git add -A`.** В рабочем дереве уже лежат изменения `frontend/` (результаты задач 1–20: `M frontend/package.json`, `?? frontend/tsconfig.app.json` и т.д.). `git add -A` проиндексирует их в этот коммит. Вместо этого добавьте явно только Go-файлы и документацию:

```bash
cd /root/repos/firenet && git add -A -- internal README.md Makefile && git status --short && git commit -m "refactor(httpapi): drop server-rendered UI, serve JSON API only"
```

В `git status` не должно быть файлов из `frontend/` (они остаются непроиндексированными `M`/`??` и попадут в свои коммиты задач 1–20).

---

### Task 22: Инфраструктура — compose, nginx, dev-режим

**Files:**
- Modify: `docker-compose.yml`, `Makefile`
- Create: `nginx/firenet.conf`

**Interfaces:**
- Consumes: `frontend/Dockerfile`, `frontend/nginx.conf` (Task 1).
- Produces: `make dev` поднимает db + backend + frontend.

- [ ] **Step 1: Переписать `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: firenet
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: firenet
    volumes:
      - firenet-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U firenet -d firenet"]
      interval: 5s
      timeout: 3s
      retries: 10

  backend:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      FIRENET_DATABASE_URL: postgres://firenet:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/firenet?sslmode=disable
      FIRENET_ADMIN_USER: ${FIRENET_ADMIN_USER:?set FIRENET_ADMIN_USER in .env}
      FIRENET_ADMIN_PASSWORD: ${FIRENET_ADMIN_PASSWORD:?set FIRENET_ADMIN_PASSWORD in .env}
    ports:
      - "127.0.0.1:8787:8787"

  frontend:
    build:
      context: ./frontend
      target: ${FRONTEND_TARGET:-runtime}
    restart: unless-stopped
    environment:
      # Таргет прокси /api для Vite (читается loadEnv в vite.config.ts).
      # В runtime-стейдже не используется — там /api проксирует nginx на хосте.
      VITE_API_TARGET: ${VITE_API_TARGET:-http://backend:8787}
    volumes:
      # В dev подменяем собранный dist работающим Vite: правки видны сразу.
      - ./frontend/src:/src/src:ro
    # ВАЖНО: дефолт тут null, а не пустая строка. `${VAR:-null}` при не заданной
    # переменной даёт compose-значение `null` → CMD наследуется из Dockerfile
    # (в runtime — nginx; в dev — заменяется на FRONTEND_CMD=npm run dev).
    # Если поставить `${FRONTEND_CMD:-}`, compose распарсит пустую строку как
    # НЕПУСТОЙ пустой массив `command: []`, который ПЕРЕКРЫВАЕТ CMD образа.
    # Для nginx это работает лишь по случайности (entrypoint сам запускает
    # nginx) и хрупко при изменении образа. Проверено на compose v5.5.1:
    # `command: ${VAR:-}` → `command: []`, `command: ${VAR:-null}` → `command: null`.
    command: ${FRONTEND_CMD:-null}
    ports:
      # dev слушает 5173 (CMD в Dockerfile), runtime — 80. Оба проброшены,
      # иначе в dev-режиме «8080 → 80» некуда стучаться: nginx там нет.
      - "127.0.0.1:5173:5173"
      - "127.0.0.1:8080:80"

volumes:
  firenet-db:
```

- [ ] **Step 2: Добавить dev-стейдж в `frontend/Dockerfile`**

Переписать файл целиком:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci

# dev: Vite dev server с прокси /api на backend — браузер остаётся на одном
# origin, поэтому cookie-сессия работает без CORS.
FROM deps AS dev
# Исходники нужны и здесь: compose монтирует только ./frontend/src поверх,
# а index.html / vite.config.ts / public/* берутся из образа. Без COPY . .
# Vite не находит точку входа и отвечает 404 на /.
COPY . .
# Читается vite.config.ts через loadEnv: та же переменная, что и в .env на хосте.
ENV VITE_API_TARGET=http://backend:8787
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM deps AS build
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`COPY . .` опирается на `frontend/.dockerignore` из задачи 1: без него хостовые `node_modules` затирают установленные в `deps`, а `dist` попадает в контекст. `nginx.conf` в `.dockerignore` не включён — он нужен runtime-стейджу.

`COPY . .` в dev-стейдже — не дубль build-стейджа: `deps` кладёт только `package*.json`, а Vite для dev требует `index.html` (точка входа) и `vite.config.ts`. Проверено: без этой строки контейнер поднимается, но `curl http://127.0.0.1:5199/` отвечает `404`.

**Связка с compose `command:` из Step 1:** CMD dev-стейджа (`npm run dev -- --host 0.0.0.0 --port 5173`) используется только когда compose **не** перекрывает его `command:`. Для dev-режима переменная `FRONTEND_CMD` в compose задаётся как `npm run dev -- --host 0.0.0.0 --port 5173` — она приходит **снаружи** (команда запуска), а не из Dockerfile, поэтому dev-стейдж здесь фактически не обязан нести CMD, но несёт его как страховку на случай запуска образа напрямую (`docker run` без compose). Не дублировать CMD в двух местах нельзя обойтись: compose `command:` перекрывает Dockerfile CMD, а вне compose CMD берётся из образа.

- [ ] **Step 3: Создать `nginx/firenet.conf`** — образец для nginx на хосте

```nginx
# Пример конфига для nginx на хосте: он единственный смотрит наружу,
# контейнеры публикуются только на 127.0.0.1.
upstream firenet_backend { server 127.0.0.1:8787; }
upstream firenet_frontend { server 127.0.0.1:8080; }

server {
  listen 80;
  server_name firenet.example;
  client_max_body_size 1m;

  location /api/ {
    proxy_pass http://firenet_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://firenet_frontend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

- [ ] **Step 4: Добавить `.env`-пример для dev**

Дописать в `.env.example`:

```
# dev: frontend запускает Vite вместо собранного бандла
FRONTEND_TARGET=dev
VITE_API_TARGET=http://backend:8787
```

`FRONTEND_CMD` в `.env.example` **не** добавлять: dev-стейдж уже несёт свой `CMD`, а переменная в `.env` подставляется в compose как `command:`. Её нужно задавать **только при запуске dev-режима** (`FRONTEND_TARGET=dev`), где она подменяет `CMD` на Vite. При `target: runtime` переменная не задаётся, и дефолт `:-null` из compose (см. Step 1) оставляет CMD nginx-образа нетронутым. Важно: НЕ использовать `${FRONTEND_CMD:-}` с пустым дефолтом — пустая строка даёт `command: []`, который перекрывает CMD (подробности в Step 1). Хостовый порт Vite задан `ports:` в compose.

- [ ] **Step 5: Проверить dev-режим**

```bash
cd /root/repos/firenet && FRONTEND_TARGET=dev FRONTEND_CMD="npm run dev -- --host 0.0.0.0 --port 5173" docker compose up -d --build && sleep 20 && curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/ && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/api/login -X POST
```

Expected: `200` для `/` у Vite и `400`/`401` от `/api/login` — то есть прокси до бэкенда работает.

Замечание: в dev-команде переменную `FRONTEND_CMD` **нужно задавать явно** — она приходит в compose как `command:` и подменяет CMD dev-стейджа на запуск Vite. Без неё compose подставит дефолт `null`, и запустится CMD из Dockerfile (`npm run dev ...` тоже) — результат тот же, но явная передача делает намерение прозрачным. В prod (Step 6) `FRONTEND_CMD` не задаётся вовсе..

Проверять именно через `:5173/api/login`, а не `:8787/api/login`: второй вариант стучится в бэкенд напрямую и прокси не проверяет (это была ошибка в предыдущей версии шага). `curl -sf` тоже не годится — на 4xx она молча вернёт 22 и шаг упадёт на несуществующей проблеме.

- [ ] **Step 6: Проверить prod-режим**

```bash
cd /root/repos/firenet && FRONTEND_TARGET=runtime docker compose up -d --build && sleep 15 && curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/ && curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/ui/rules
```

Expected: `200` на обоих — fallback nginx отдаёт `index.html` для глубоких ссылок.

Проверка именно `200` на `/ui/rules` подтверждает, что `try_files $uri $uri/ /index.html` из `nginx.conf` (Task 1) срабатывает. Если вернётся `404`/`403`, первым делом смотри `docker compose ps` и логи: это либо CMD nginx перекрыт (`command: []`, см. Step 1 — должен быть `null`), либо nginx.conf не скопировался в контейнер.

- [ ] **Step 7: Commit**

```bash
cd /root/repos/firenet && docker compose down && git add docker-compose.yml frontend/Dockerfile nginx .env.example && git commit -m "build: split compose into db, backend and frontend with host nginx example"
```

---

### Task 23: E2E против React

**Files:**
- Modify: `e2e/helpers/ui.js`, `e2e/global-setup.js`, `e2e/playwright.config.js`, при необходимости сценарии из `e2e/scenarios/`

**Interfaces:**
- Consumes: все страницы (Task 8–20), `data-testid`, расставленные в них.
- Produces: `make test-e2e` зелёный.

- [ ] **Step 1: Поправить `vite.config.ts` — читать таргет из `process.env`**

> **Блокер, выявлен при контроле.** План задачи 1 использовал `loadEnv(mode, process.cwd(), "")` для чтения `VITE_API_TARGET`. Это **не работает** в Vite 5.4: функция `resolveEnvPrefix` (packages/vite/src/node/config.ts) бросает исключение, если `envPrefix` содержит пустую строку (`envPrefix contains value ''`), поэтому `vite config` упадёт ещё на старте. Случайно `loadEnv(..., "")` «видит» переменные процесса не потому, что их поднимает `loadEnv`, а потому, что `key.startsWith("")` истинно для всех ключей — но до этого цикла код вообще не доходит.

Заменить в `frontend/vite.config.ts` чтение таргета на `process.env.VITE_API_TARGET` (переменные процесса с префиксом `VITE_` имеют высший приоритет — Vite их не игнорирует):

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Таргет прокси: в dev-стейдже и в e2e задаётся ENV-переменной процесса
// (VITE_API_TARGET). process.env имеет высший приоритет над .env-файлами,
// поэтому loadEnv с пустым префиксом не нужен (и в Vite 5.4 запрещён:
// resolveEnvPrefix бросает исключение на пустой префикс).
const apiTarget = process.env.VITE_API_TARGET ?? "http://backend:8787";

export default defineConfig(() => ({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
```

Обратно к задаче 1: поправить там Step 3 и Step 13.1 (сейчас они используют `loadEnv(...,"")`), иначе и задача 1, и e2e упадут. Это единственное место, где правится код фронтенда в рамках Task 23.

- [ ] **Step 2: Добавить `data-testid` туда, где их требуют хелперы**

В `LoginPage` уже есть `data-testid="login-form"` и поля `name=username`/`name=password`. Проверить, что селекторы `e2e/helpers/ui.js` совпадают:

```bash
cd /root/repos/firenet && grep -n 'login-form\|tool-select\|firenet-draft-id' e2e/helpers/ui.js
```

Если хелпер ищет `#tool-select.active` — в `TopologyPage` кнопка имеет `data-testid="tool-select"` и класс `active`; заменить селектор в хелпере на `[data-testid="tool-select"].active`.

> **Недоработка спецификации, закрыта здесь.** Хелперы канвы (`dragNode`, `canvasClick`, `contextMenuItem`, `createNode`, `activateTool`) используют легаси-`#id`: `#topo-canvas`, `#tool-${tool}`, `#topo-context-menu`, `#node-popover`, `#node-name-input`, `#node-kind-select`. В React Flow (задача про редактор топологии) этих `#id` не будет. Прежде чем прогонять e2e, расставить в канвас-компонентах такие `data-testid`:
- `data-testid="topo-canvas"` — на viewport React Flow;
- `data-testid="tool-select"` + класс `active` — на кнопке активного инструмента;
- `data-testid="topo-context-menu"` — на контекстном меню канвы (если оно останется; см. риск «Контекстное меню канвы» — если ПКМ-меню не реализовано, хелпер `contextMenuItem` и сценарии, его использующие, удалить);
- `data-testid="node-popover"` — на попап-форме создания узла; поля `name=name`, `name=kind` и `button[type=submit]` внутри;
- клик по канвасу — через `boundingBox()` на `[data-testid="topo-canvas"]`, как в текущем `dragNode`.

Конкретные имена сверять с реализацией `TopologyPage`/`TopologyCanvas.tsx` (Task 13–16). Если какой-то `data-testid` не реализуем, удалить соответствующий хелпер и сценарий вместо того, чтобы чинить хелпер под несуществующий селектор.

- [ ] **Step 3: Обновить `e2e/helpers/ui.js`**

Заменить селекторы на `data-testid`:

```js
export async function loginViaUI(page, creds) {
  const c = creds || env().admin;
  await page.goto(env().baseURL + "/login");
  await page.locator('[data-testid="login-form"] input[name=username]').fill(c.username);
  await page.locator('[data-testid="login-form"] input[name=password]').fill(c.password);
  await page.locator('[data-testid="login-form"] button[type=submit]').click();
  await page.waitForURL(/\/ui\/topology$/);
}

export async function openWithDraft(page, draftId, path) {
  await page.addInitScript((id) => {
    localStorage.setItem("firenet-last-draft-id", id);
    sessionStorage.setItem("firenet-draft-id", id);
  }, draftId);
  await page.goto(env().baseURL + path);
  await expect(page.locator('[data-testid="tool-select"].active')).toBeVisible();
}
```

Остальные функции — по такому же принципу: `#id` → `[data-testid="..."]` (см. список в Step 2).

- [ ] **Step 4: Научить `global-setup.js` поднимать фронтенд**

После запуска `bin/firenet` добавить запуск Vite и сделать `baseURL` указывающим на него:

```js
    const fePort = await freePort();
    const frontend = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(fePort)], {
      cwd: new URL("../frontend", import.meta.url).pathname,
      env: {
        ...process.env,
        // Прокси Vite должен знать, где бэкенд: dev-режим вне compose.
        VITE_API_TARGET: `http://127.0.0.1:${appPort}`,
      },
      stdio: "inherit",
    });

    const baseURL = `http://127.0.0.1:${fePort}`;
    await waitFor("frontend", async () => {
      const res = await fetch(baseURL + "/");
      return res.ok;
    }, 60_000);

    fs.writeFileSync(ENV_FILE, JSON.stringify({ baseURL, container, admin: ADMIN }));
    fs.writeFileSync(new URL("./.e2e-server.pid", import.meta.url), String(server.pid));
    fs.writeFileSync(new URL("./.e2e-frontend.pid", import.meta.url), String(frontend.pid));
```

Механика `npm run dev -- --host ... --port ...` работает: npm передаёт всё, что после `--`, в скрипт `vite`, а Vite CLI принимает `--host` и `--port`. Проверить, что `vite.config.ts` из Step 1 не задаёт жёстко порт/хост, который конфликтует с CLI: `server.port: 5173` — это лишь дефолт, CLI-аргумент его переопределяет. `stdio: "inherit"` — Vite пишет логи прямо в вывод e2e; если логов слишком много и они мешают, заменить на `stdio: "pipe"`.

Теперь — критично для очистки. Изменить сигнатуру и добавить убийство фронтенда:

```js
export function cleanupSetupResources(container, server, frontend) {
  for (const proc of [frontend, server]) {
    if (proc?.pid) {
      try { process.kill(proc.pid, "SIGTERM"); } catch { /* уже умер */ }
    }
  }
  if (container) {
    try { execSync(`docker rm -f ${container}`, { stdio: "pipe" }); } catch { /* уже удалён */ }
  }
}
```

> Порядок важен: убиваем **сначала** frontend, **потом** server. Если убить backend первым, Vite-прокси начнёт возвращать 502, но сам процесс останется висеть — поэтому оба обязательны, а не только фронтенд. Вызов в `catch` глобального setup тоже обновить: `cleanupSetupResources(container, server, frontend)`.

- [ ] **Step 5: Научить `global-teardown.js` гасить фронтенд**

> **Дыра, закрыта здесь.** План не трогал teardown, а он читает только `.e2e-server.pid` и удаляет контейнер. Если не исправить, Vite останется висеть, а `.e2e-frontend.pid` — не очистится. В `cleanupSetupResources` уже есть общая логика убийства, но teardown её не использует и выполняется всегда (в отличие от `catch` в setup). Добавить чтение `.e2e-frontend.pid` и его убийство:

```js
export default async function globalTeardown() {
  if (!fs.existsSync(ENV_FILE)) return;
  const { container } = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
  for (const file of ["./.e2e-server.pid", "./.e2e-frontend.pid"]) {
    const pidFile = new URL(file, import.meta.url);
    if (!fs.existsSync(pidFile)) continue;
    try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* уже умер */ }
    fs.rmSync(pidFile);
  }
  try { execSync(`docker rm -f ${container}`, { stdio: "pipe" }); } catch { /* уже удалён */ }
  fs.rmSync(ENV_FILE);
}
```

Оба pid-файла очищаются, чтобы повторный прогон не «убивал» процесс со старым pid.

- [ ] **Step 6: Убедиться, что Vite видит `VITE_API_TARGET` из шага 4**

После правки `vite.config.ts` (Step 1) таргет читается напрямую из `process.env.VITE_API_TARGET`. Проверить, что механизм живой (таргет подставился, а не дефолтный `http://backend:8787`):

```bash
cd /root/repos/firenet/frontend && VITE_API_TARGET=http://127.0.0.1:9999 node --input-type=module -e '
const { loadConfigFromFile } = await import("vite");
const res = await loadConfigFromFile({ command: "serve", mode: "development" }, process.cwd() + "/vite.config.ts", process.cwd());
console.log(JSON.stringify((await res.config).server.proxy));
process.exit(0);
'
```

Expected: `{"/api":{"target":"http://127.0.0.1:9999","changeOrigin":true}}`. Если напечатался `http://backend:8787` — `process.env.VITE_API_TARGET` не прочитался; проверить, что в конфиге нет `loadEnv` и переменная передаётся в `spawn`-env (Step 4). `VITE_API_TARGET` в `spawn`-env подставится, потому что переменные процесса с префиксом `VITE_` имеют высший приоритет в Vite.

> Если `vite.config.ts` не был исправлен (Step 1) и там остался `loadEnv(mode, process.cwd(), "")` — команда выше упадёт с ошибкой `envPrefix contains value ''` ещё до вывода. Это первый признак того, что Step 1 не сделан.

- [ ] **Step 7: Прогнать e2e**

```bash
cd /root/repos/firenet && make test-e2e 2>&1 | tail -40
```

Expected: все сценарии зелёные. Падающие сценарии править по одному: сначала убедиться, что страница отдаёт нужный `data-testid`, потом — что селектор в спеке на него указывает.

- [ ] **Step 8: Commit**

```bash
cd /root/repos/firenet && git add e2e frontend && git commit -m "test(e2e): run Playwright against the React frontend"
```

---

### Task 24: Финальная проверка и уборка

**Files:**
- Modify: `README.md`, `AGENTS.md` (при необходимости)
- Возможные правки в любых файлах по результатам проверки

**Предусловия (зависимости).** Task 24 — **конечная точка плана**, его нельзя выполнять
ранее следующих задач, иначе шаги дадут ложный результат или упадут:
- **Task 21** (удаление легаси-фронтенда): Step 3 здесь ожидает, что в `internal/httpapi`
  уже **нет** `web/`, `templates/`, `embed.go` и `go:embed`/Alpine-упоминаний. Пока Task 21
  не сделан, `ls internal/httpapi` и grep будут непустыми, и проверка «легаси не осталось»
  не пройдёт. Это нормально — шаг проверяет результат именно Task 21.
- **Task 22** (compose, nginx, dev-режим): добавляет `docker-compose.yml`, dev-стейдж
  в `frontend/Dockerfile`, `FRONTEND_TARGET=dev`, обновляет `Makefile` и `.env.example`.
  Шаги 4 (e2e) и 5 (gotchas про `frontend/dist/`) опираются на эту инфраструктуру.
- **Task 23** (e2e-сценарии Playwright): Step 4 (`make test-e2e`) имеет смысл, только когда
  e2e-сценарии уже перенесены под новую архитектуру и зелёные. Также именно в Task 23
  задокументирована правка `vite.config.ts` про `VITE_API_TARGET` (см. ссылку в Task 1
  Step 3) — до неё Step 2 здесь мог бы сломаться на `envPrefix`.

> Практическое правило: начинать Task 24 можно, только когда **все** чекбоксы задач 1–23
> отмечены выполненными. В противном случае сначала довести 21–23, потом вернуться сюда.

- [ ] **Step 1: Полная проверка Go**

```bash
cd /root/repos/firenet && go build ./... && go vet ./... && gofmt -l . && go test ./...
```

Expected: всё зелёное, `gofmt` молчит.

- [ ] **Step 2: Полная проверка фронтенда**

```bash
cd /root/repos/firenet/frontend && npm run typecheck && npm test && npm run build
```

Expected: зелёное, `dist/` собран.

- [ ] **Step 3: Проверить, что в репе не осталось легаси-фронтенда**

```bash
cd /root/repos/firenet && ls internal/httpapi && grep -rn "alpine\|x-data\|go:embed" --include=*.go internal/ | grep -v _test
```

Expected: в `internal/httpapi` нет `web/`, `templates/`, `embed.go`; упоминаний Alpine нет; `go:embed` не осталось.

> **Нюанс (зависит от Task 21).** До удаления легаси-кода этот шаг **не пройдёт** — `internal/httpapi`
> всё ещё содержит `web/`, `templates/`, `embed.go`. Это ожидаемо. Если grep в `internal/` находит
> `go:embed` вне `_test`, но легаси-фронтенд уже удалён, проверь, не остались ли `go:embed`
> где-то ещё (например, в `cmd/` или другом месте) — их быть не должно.
>
> Grep здесь — GNU basic regex: `\|` как «или» работает только в GNU grep (Linux). На macOS/mac
> (BSD grep) это **не** сработает — там нужен `grep -E "alpine|x-data|go:embed"`. Окружение по плану — Linux, так что оставляем как есть, но имей в виду при локальном прогоне.

- [ ] **Step 4: Проверить e2e**

```bash
cd /root/repos/firenet && make test-e2e 2>&1 | tail -20
```

Expected: все сценарии зелёные.

- [ ] **Step 5: Обновить `AGENTS.md`**

В раздел «Verification (run in this order after any change)» заменить строку про `node --test 'internal/httpapi/web/*.test.js'` на:

```
5. `cd frontend && npm test` — юнит-тесты React (Vitest + RTL)
6. `make test-e2e` — E2E-сценарии Playwright (нужны docker и chromium)
```

и убрать из «Gotchas» пункт про `go:embed` в `internal/httpapi/web/`, заменив на:

```
 - `frontend/dist/` собирается в контейнер nginx; после правки `frontend/src`
   в prod-режиме нужен `docker compose up -d --build frontend`, в dev
   (`FRONTEND_TARGET=dev`) Vite подхватывает правки сам.
```

> **Нюанс: формулировка не совпадает с актуальным `AGENTS.md`.**
> В текущем файле строка про `node --test 'internal/httpapi/web/*.test.js'` находится **не
> в разделе Verification**, а в отдельном разделе **«Web UI JS tests run outside a browser
> on node:test with DOM stubs:»**. Поэтому при правке:
> 1. **Удалить весь раздел «Web UI JS tests run outside a browser…» целиком** (заголовок +
>    строка про `node --test`) — он теряет смысл, т.к. `node:test`-тесты удаляются в Task 21.
> 2. В **Verification** после пункта 4 (`go test ./...`) **дописать** пункты 5 и 6 (как выше).
> 3. В **Gotchas** заменить пункт про `go:embed` (начинается с `internal/httpapi/web/ assets
>    are embedded at build time…`) на пункт про `frontend/dist/`.
>
> Остальной текст раздела «Web UI JS tests…» (про отсутствие node в рантайме приложения,
> про `make test-e2e` пересобирающий `bin/firenet`) проверь на актуальность — часть его
> относится к e2e/ и уже покрыта пунктом в Gotchas про «e2e/ has its own package.json».
> Противоречия между новым и старым текстом AGENTS.md не должно остаться.

- [ ] **Step 6: Commit**

```bash
cd /root/repos/firenet && git add -A && git status --short && git commit -m "docs: update AGENTS and README for the split frontend"
```

---

## Проблемы и нюансы (Task 24)

Что проверить / где обычно спотыкаются при выполнении:

1. **Порядок задач.** Task 24 нельзя выполнять до задач 21–23 (см. «Предусловия» в шапке
   блока). Если в репо ещё есть `internal/httpapi/web/` — Task 21 не сделан, вернуться к нему.
   Признак, что репо «в середине» плана: `ls internal/httpapi` содержит `web/`, а
   `docker-compose.yml`/`.env.example` ещё не добавлены.

2. **Step 5 — AGENTS.md.** Главная ловушка блока: план описывает правку так, будто строка
   про `node --test` лежит в разделе Verification, а на деле она в отдельном разделе
   «Web UI JS tests run outside a browser…». Нужно удалить раздел целиком и дописать пункты
   5–6 в Verification, а не «заменить строку» по месту. Иначе в AGENTS.md останется мёртвый
   раздел со ссылкой на удалённые тесты.

3. **README.md.** Шаги 1–4 лишь **указывают** «обновить README.md» без конкретики. До правки
   сверь актуальный README: в нём наверняка есть разделы про старый `internal/httpapi/web`
   фронтенд, `serve`-команду и `go:embed`. Убедись, что README описывает новую схему
   (Go-бэкенд JSON API + отдельное React-приложение в `frontend/`, сборка в nginx-контейнер,
   dev-режим через `FRONTEND_TARGET=dev`). Если README уже актуален — ничего не менять.

4. **Step 3 — grep.** `\|` в `grep -rn` — GNU-специфика (Linux). На BSD/mac не работает;
   по плану окружение Linux, так что допустимо, но не стоит на этом спотыкаться при локальном
   прогоне на другой ОС (там — `grep -E "alpine|x-data|go:embed"`).

5. **Step 4 — e2e требует Docker и chromium.** `make test-e2e` пересобирает `bin/firenet`
   через зависимость `build` и запускает Playwright. Если окружение без Docker/браузера —
   шаг упадёт не из-за кода. Первый запуск: `cd e2e && npm install && npx playwright install chromium`.
   До Task 23 e2e-сценарии могут быть не готовы — см. предусловия.

6. **Step 2 — `npm test` / `npm run build`.** Если фронтенд-часть ещё не доведена (задачи
   3–20), `npm run build` (`tsc -b && vite build`) может падать на типовых ошибках незаполненных
   страниц. Это сигнал, что Task 24 преждевременен, а не что шаг сломан.

7. **Context7 / документация.** Новых библиотек Task 24 не вводит — только запускает уже
   настроенные (vitest, playwright, nginx, docker). Единственный конфиг, на который опирается
   проверка, — `try_files $uri $uri/ /index.html` в `nginx.conf` (Task 1), корректность которого
   для глубоких ссылок React Router подтверждена документацией nginx. Если `curl` на `/ui/rules`
   (шаг из Task 22, а не этого блока) вернёт 404/403 — смотреть `docker compose ps` и логи nginx
   (перекрыт ли `CMD` через `command: []`, скопирован ли `nginx.conf`).

---

## Приложение: соответствие легаси-файлов новым

| Легаси-файл | Судьба |
|---|---|
| `web/common.js` | `api/client.ts` + `api/revision.ts` + `draft/DraftContext.tsx` + `components/notify.ts` + `components/Sidebar.tsx` + `components/DraftBanner.tsx` |
| `web/api_cache.go` (Go) | остаётся `internal/httpapi/api_cache.go` |
| `web/table.js`, `columns.js` | `components/ui/DataTable.tsx` (ресайз колонок — не перенесён, см. риски) |
| `web/combo.js` | `components/ui/Combo.tsx` |
| `web/floating_panel.js` | `components/ui/Modal.tsx` (модалки) и inline-панели на страницах |
| `web/camera.js`, `camera_input.js` | React Flow viewport |
| `web/canvas_view.js`, `canvas_theme.js` | React Flow рендер + `styles.css` |
| `web/hit_test.js` | React Flow hit-test |
| `web/minimap.js` | `<MiniMap/>` из `@xyflow/react` |
| `web/netmap.js` | `topology/icons.ts` |
| `web/topo_scene.js` | `topology/scene.ts` |
| `web/tween.js` | CSS-транзишены (анимации появления узлов не переносятся) |
| `web/topology_sync.js` | `topology/useTopologyEditor.ts` |
| `web/topology.js` | `pages/TopologyPage.tsx` + `topology/TopologyCanvas.tsx` |
| `web/diagnose.js` | `pages/DiagnosePage.tsx` |
| `templates/*.html` | React-компоненты в `pages/` |
| `web/style.css` | `frontend/src/styles.css` (перенесён как есть) |

## Риски и известные упрощения

- **Ресайз колонок.** `columns.js` хранит ширины в localStorage под ключами `firenet-<page>-col-widths-v<n>`. В плане он не перенесён: `DataTable` использует фиксированные ширины. Если это важно — отдельная задача после Task 24.
- **Анимации.** `tween.js` (появление узлов, проявление подсветки диагностики) не переносится; подсветка применяется мгновенно через CSS-классы.
- **Waypoints у линков.** `LinkEdge` рисует ломаную по waypoints, но перетаскивание самих waypoint-хэндлов не реализовано (`set-link-waypoints` есть в API, UI — после Task 24).
- **Контекстное меню канвы.** ПКМ-меню (создать связь, изменить, добавить в объединение) в плане не реализовано: создание связи идёт через инструмент «Связь», удаление — через `Del`, редактирование — со страниц-таблиц.
- **Покрытие тестами.** 9106 строк старых `node:test`-тестов удаляются в Task 21 вместе с кодом, который они покрывали; новые тесты пишутся в Task 2–20. Между этими точками основная защита — Playwright (Task 23).
