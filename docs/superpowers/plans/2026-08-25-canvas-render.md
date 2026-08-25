# Canvas Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить SVG-рендер холстов топологии и диагностики на Canvas2D-движок в стиле tldraw (display list + полный redraw в rAF с culling, геометрический хит-тест, твины камеры и состояний).

**Architecture:** `TopoScene.buildScene` выдаёт чистый display list примитивов; `CanvasView` рисует его в `<canvas>` по invalidate через rAF; интерактив — один набор событий указателя + геометрический `HitTest`; стили резолвятся из `CanvasTheme`; анимации через мини-`Tween`. HTML-оверлеи (меню, popover, NetInfo, тултипы) остаются DOM.

**Tech Stack:** Vanilla JS (без node_modules/сборки), node:test + DOM/canvas-стабы, Go-embed ассетов.

**Spec:** `docs/superpowers/specs/2026-08-25-canvas-render-design.md`

## Global Constraints

- Никаких новых зависимостей: только vanilla JS и встроенные модули Node в тестах.
- Тесты запускаются строго как `node --test 'internal/httpapi/web/*.test.js'` (glob обязателен).
- Верификация после каждой задачи: `go build ./... && go vet ./... && gofmt -l . && go test ./...` + node-тесты.
- Веб-ассеты встроены через `go:embed`: после правок веба нужен `make build`, иначе `serve` показывает старый UI (в финальной задаче).
- Стиль кода: компактный, без лишних комментариев, заголовочный комментарий модуля как у соседних файлов (на русском, как принято в репо).
- Строки UI — на русском.
- Во время перехода (задачи 7–10) старый SVG-рендер остаётся рабочим параллельно; удаляется в задаче 12.

## Интерпретации спеки (зафиксировано для ревью)

- «Переходы состояний ~150 мс» реализуются как групповые факторы затухания: fade приглушения поиска и fade окраски потока диагностики (лерп цвета/толщины/alpha). Выделение — мгновенно (как в tldraw).
- Появление нового узла — scale-fade («pop») через `opts.popOf`.
- Кнопка «вписать» (fit view) добавляется на оба канваса.

---

### Task 1: Модуль Tween

**Files:**
- Create: `internal/httpapi/web/tween.js`
- Test: `internal/httpapi/web/tween.test.js`

**Interfaces:**
- Produces: `Tween.create() -> { to(obj, props, ms?, ease?), tick(now) -> bool, active() -> bool }`; `Tween.easeOutCubic(t)`. `to` стартует твин числовых свойств `obj` к `props` за `ms`; `tick(now)` применяет прогресс, возвращает true, пока есть активные твины.

- [ ] **Step 1: Write the failing test**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "tween.js"), "utf8"), sandbox);
const Tween = vm.runInContext("Tween", sandbox);

test("tick interpolates numeric props and reports activity", () => {
  const tw = Tween.create();
  const o = { x: 0, y: 0 };
  tw.to(o, { x: 100, y: 50 }, 100, (t) => t);
  assert.equal(tw.active(), true);
  assert.equal(tw.tick(50), true);
  assert.equal(o.x, 50);
  assert.equal(o.y, 25);
  assert.equal(tw.tick(100), false, "finished at t>=ms");
  assert.equal(o.x, 100);
});

test("later tween wins for repeated props", () => {
  const tw = Tween.create();
  const o = { x: 0 };
  tw.to(o, { x: 10 }, 100, (t) => t);
  tw.to(o, { x: 20 }, 100, (t) => t);
  assert.equal(tw.tick(50), true, "starts on first tick");
  assert.equal(tw.tick(100), false, "finished");
  assert.equal(o.x, 20, "late tween displaced the earlier one");
});

test("easeOutCubic decelerates", () => {
  assert.ok(Tween.easeOutCubic(0.5) > 0.5);
  assert.equal(Tween.easeOutCubic(1), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/tween.test.js'`
Expected: FAIL (tween.js не существует / Tween undefined)

- [ ] **Step 3: Write minimal implementation**

```js
"use strict";

// Tween — мини-аниматор числовых свойств: to() ставит твин, tick(now)
// продвигает все активные и возвращает признак активности. Чистая
// математика, без DOM; страницы сами решают, когда перерисовывать кадр.
const Tween = (() => {
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;

  function create() {
    let items = [];
    return {
      to(obj, props, ms = 150, ease = easeOutCubic) {
        const from = {};
        for (const k in props) from[k] = obj[k];
        // поздний твин вытесняет ранние твины тех же свойств того же объекта
        items = items.filter((it) => it.obj !== obj || Object.keys(props).every((k) => !(k in it.props)));
        items.push({ obj, props, from, t0: null, ms, ease });
      },
      active: () => items.length > 0,
      tick(now) {
        items = items.filter((it) => {
          if (it.t0 === null) it.t0 = now;
          const p = Math.min(1, (now - it.t0) / it.ms);
          const e = it.ease(p);
          for (const k in it.props) it.obj[k] = it.from[k] + (it.props[k] - it.from[k]) * e;
          return p < 1;
        });
        return items.length > 0;
      },
    };
  }

  return Object.freeze({ create, easeOutCubic });
})();

if (typeof module !== "undefined") module.exports = Tween;
```

Примечание: строка `module.exports` — для удобства тестов, в браузере игнорируется; остальные модули канвы подключаются так же.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/tween.test.js'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/tween.js internal/httpapi/web/tween.test.js
git commit -m "feat(web): tween animator for canvas transitions"
```

---

### Task 2: Модуль CanvasTheme

**Files:**
- Create: `internal/httpapi/web/canvas_theme.js`
- Test: `internal/httpapi/web/canvas_theme.test.js`

**Interfaces:**
- Consumes: `NetMap.UNION_COLORS` (существует).
- Produces: `CanvasTheme.fromComputed(styleObj)` — читает CSS-переменные из объекта с `getPropertyValue(name)`; `CanvasTheme.create(vars)` — принимает plain-object `{"--accent": "...", ...}`. Обе возвращают замороженную тему:

```js
{
  panel, border, accent, muted, text,
  kind: { router, switch, network },   // цвета обводки по видам
  radius: { router: 16, switch: 2, default: 6 },
  unionColors: [...],
  filteredColor: "#d29922",
  flowOk: "#10b981", flowDeny: "#ef4444",
  dimAlpha: 0.35, hitWidth: 14, textHideZoom: 0.5,
  fonts: { label: "12px system-ui, sans-serif", sub: "11px system-ui, sans-serif" },
  lerpHex(a, b, t) -> "#rrggbb",
}
```

- [ ] **Step 1: Write the failing test**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
for (const f of ["netmap.js", "canvas_theme.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox);
const CanvasTheme = vm.runInContext("CanvasTheme", sandbox);

const VARS = {
  "--panel-bg": "#f6f6f8", "--border": "#d8d8dc", "--accent": "#2563eb",
  "--muted": "#6b6b6b", "--text": "#1a1a1a",
  "--kind-router": "#d97706", "--kind-switch": "#7c3aed", "--kind-network": "#16a34a",
};

test("create maps css vars onto theme fields", () => {
  const t = CanvasTheme.create(VARS);
  assert.equal(t.panel, "#f6f6f8");
  assert.equal(t.kind.router, "#d97706");
  assert.equal(t.radius.router, 16);
  assert.equal(t.radius.default, 6);
  assert.equal(t.hitWidth, 14);
  assert.equal(t.unionColors.length >= 2, true);
});

test("fromComputed reads css variables via getPropertyValue", () => {
  const t = CanvasTheme.fromComputed({ getPropertyValue: (n) => VARS[n] ?? "" });
  assert.equal(t.accent, "#2563eb");
  assert.equal(t.kind.network, "#16a34a");
});

test("lerpHex blends colors and clamps t", () => {
  const t = CanvasTheme.create(VARS);
  assert.equal(t.lerpHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(t.lerpHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(t.lerpHex("#000000", "#ffffff", 2), "#ffffff");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/canvas_theme.test.js'`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```js
"use strict";

// CanvasTheme — палитра и метрики канвасного рендера топологии. Значения
// приходят из CSS-переменных страницы (create/fromComputed), поэтому тема
// не рассинхронизируется со стилями. lerpHex нужен для переходов состояний.
const CanvasTheme = (() => {
  const NAMES = ["--panel-bg", "--border", "--accent", "--muted", "--text",
    "--kind-router", "--kind-switch", "--kind-network"];

  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  function create(v) {
    const g = (n, fb) => v[n] || fb;
    return Object.freeze({
      panel: g("--panel-bg", "#f6f6f8"),
      border: g("--border", "#d8d8dc"),
      accent: g("--accent", "#2563eb"),
      muted: g("--muted", "#6b6b6b"),
      text: g("--text", "#1a1a1a"),
      kind: {
        router: g("--kind-router", "#d97706"),
        switch: g("--kind-switch", "#7c3aed"),
        network: g("--kind-network", "#16a34a"),
      },
      radius: { router: 16, switch: 2, default: 6 },
      unionColors: NetMap.UNION_COLORS,
      filteredColor: "#d29922",
      flowOk: "#10b981",
      flowDeny: "#ef4444",
      dimAlpha: 0.35,
      hitWidth: 14,
      textHideZoom: 0.5,
      fonts: { label: "12px system-ui, sans-serif", sub: "11px system-ui, sans-serif" },
      lerpHex(a, b, t) {
        const ca = hex(a), cb = hex(b);
        const k = Math.min(1, Math.max(0, t));
        const mix = (i) => Math.round(ca[i] + (cb[i] - ca[i]) * k);
        return "#" + mix(0).toString(16).padStart(2, "0") + mix(1).toString(16).padStart(2, "0") + mix(2).toString(16).padStart(2, "0");
      },
    });
  }

  const fromComputed = (style) =>
    create(Object.fromEntries(NAMES.map((n) => [n, style.getPropertyValue(n).trim()])));

  return Object.freeze({ create, fromComputed });
})();

if (typeof module !== "undefined") module.exports = CanvasTheme;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/canvas_theme.test.js'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/canvas_theme.js internal/httpapi/web/canvas_theme.test.js
git commit -m "feat(web): canvas theme resolved from css variables"
```

---

### Task 3: NetMap.cloudSegs — облако как квадратичные сегменты

**Files:**
- Modify: `internal/httpapi/web/netmap.js`
- Test: `internal/httpapi/web/netmap.test.js` (новый)

**Interfaces:**
- Produces: `NetMap.cloudSegs(x, y, w, h) -> [{x1,y1,cx,cy,x2,y2}, ...]` — замкнутый контур облака (по часовой, последний сегмент смыкается с началом первого). `cloudPath` остаётся (до задачи 12) и строит SVG-строку из `cloudSegs`.

- [ ] **Step 1: Write the failing test**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "netmap.js"), "utf8"), sandbox);
const NetMap = vm.runInContext("NetMap", sandbox);

test("cloudSegs outlines the bbox with quadratic segments", () => {
  const segs = NetMap.cloudSegs(0, 0, 160, 60);
  assert.ok(segs.length >= 18, "enough bumps on the perimeter");
  const xs = segs.flatMap((s) => [s.x1, s.x2]);
  const ys = segs.flatMap((s) => [s.y1, s.y2]);
  assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) <= 160 + 7, "within bbox + bump depth");
  assert.ok(Math.min(...ys) <= 0 && Math.max(...ys) <= 60 + 7);
  // контур замкнут: конец последнего совпадает с началом первого
  const first = segs[0], last = segs[segs.length - 1];
  assert.equal(last.x2, first.x1);
  assert.equal(last.y2, first.y1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/netmap.test.js'`
Expected: FAIL (cloudSegs нет)

- [ ] **Step 3: Implement**

В `netmap.js` добавить функцию и переключить на неё `cloudPath` (логика выпуклостей уже есть в `topo_scene.js#cloudPath` — переносится в netmap и переписывается на сегменты):

```js
  // cloudSegs выдаёт контур L2-облака как замкнутый список квадратичных
  // сегментов: прямоугольный периметр с наружными выпуклостями (глубина 6).
  function cloudSegs(x, y, w, h) {
    const depth = 6, HB = 7, VB = 3;
    const pts = [[x, y]];
    const edge = (x1, y1, x2, y2, n) => {
      for (let i = 1; i <= n + 1; i++) pts.push([x1 + ((x2 - x1) * i) / (n + 1), y1 + ((y2 - y1) * i) / (n + 1)]);
    };
    edge(x, y, x + w, y, HB);
    edge(x + w, y, x + w, y + h, VB);
    edge(x + w, y + h, x, y + h, HB);
    for (let i = VB; i >= 1; i--) pts.push([x, y + (h * i) / (VB + 1)]);
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      segs.push({ x1: ax, y1: ay, cx: ax + dx / 2 + (dy / len) * depth, cy: ay + dy / 2 + (-dx / len) * depth, x2: bx, y2: by });
    }
    return segs;
  }
```

Вернуть `cloudSegs` из модуля. `cloudPath` в `topo_scene.js` пока оставить как есть (удалится в задаче 12 вместе с SVG-рендером) — дублирование временное и осознанное.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/netmap.test.js'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/netmap.js internal/httpapi/web/netmap.test.js
git commit -m "feat(web): cloud outline as quadratic segments for canvas"
```

---

### Task 4: HitTest — геометрические проверки по display list

**Files:**
- Create: `internal/httpapi/web/hit_test.js`
- Test: `internal/httpapi/web/hit_test.test.js`

**Interfaces:**
- Consumes: формат примитивов display list (см. Task 6/7):
  - `{kind:"rect"|"rrect", geom:{x,y,w,h,r}, pick?, nodeType?}`
  - `{kind:"path", geom:{segs:[{x1,y1,cx,cy,x2,y2}], closed?}, pick?}`
  - `{kind:"text", geom:{x,y,w}, pick отсутствует}` — никогда не pickable
- Produces:
  - `HitTest.bbox(item) -> {x,y,w,h}` (мировой bbox с запасом на обводку 4px)
  - `HitTest.pick(list, p, z) -> item|null` — верхний pickable элемент под точкой; для путей порог `hitWidth/z` от кривой (сэмпл 8 точек на сегмент); обход с конца списка
  - `HitTest.pickNodes(list, rect) -> item[]` — pickable элементы с `nodeType`, чей bbox пересекает прямоугольник

- [ ] **Step 1: Write the failing test**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// самодостаточный запуск кода модуля без vm: hit_test не зависит ни от чего
const src = require("fs").readFileSync(require("path").join(__dirname, "hit_test.js"), "utf8");
const HitTest = new Function(src + "\n;return HitTest;")();

test("bbox covers rect and path extremes", () => {
  assert.deepEqual(HitTest.bbox({ kind: "rrect", geom: { x: 10, y: 20, w: 140, h: 60 } }),
    { x: 6, y: 16, w: 148, h: 68 });
  const path = { kind: "path", geom: { segs: [
    { x1: 0, y1: 0, cx: 50, cy: -30, x2: 100, y2: 0 },
  ] } };
  const b = HitTest.bbox(path);
  assert.equal(b.x, -4);
  assert.ok(b.y < -20, "control point pulls bbox up");
});

test("pick returns topmost pickable item under the point", () => {
  const list = [
    { kind: "rrect", geom: { x: 0, y: 0, w: 140, h: 60 }, pick: true, nodeType: "device", name: "back" },
    { kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 70, cy: 0, x2: 300, y2: 0 }] }, pick: true, name: "wire" },
    { kind: "rrect", geom: { x: 0, y: 0, w: 140, h: 60 }, pick: true, nodeType: "device", name: "front" },
    { kind: "text", geom: { x: 400, y: 0, w: 100 }, name: "label" },
  ];
  assert.equal(HitTest.pick(list, { x: 70, y: 30 }, 1).name, "front", "nodes beat wires");
  assert.equal(HitTest.pick(list, { x: 250, y: 1 }, 1).name, "wire", "wire within hitWidth");
  assert.equal(HitTest.pick(list, { x: 250, y: 40 }, 1), null, "too far from the curve");
  assert.equal(HitTest.pick(list, { x: 450, y: 5 }, 1), null, "text is never picked");
});

test("pick widens with zoom-out", () => {
  const wire = { kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 50, cy: 0, x2: 100, y2: 0 }] }, pick: true };
  assert.equal(HitTest.pick([wire], { x: 50, y: 20 }, 0.5), wire, "farther tolerance at z=0.5");
});

test("pickNodes intersects bboxes with the marquee rect", () => {
  const a = { kind: "rrect", geom: { x: 0, y: 0, w: 140, h: 60 }, pick: true, nodeType: "device" };
  const b = { kind: "rrect", geom: { x: 500, y: 0, w: 140, h: 60 }, pick: true, nodeType: "network" };
  const w = { kind: "path", geom: { segs: [] }, pick: true };
  assert.deepEqual(HitTest.pickNodes([a, b, w], { x: -10, y: -10, w: 200, h: 100 }), [a]);
  assert.deepEqual(HitTest.pickNodes([a, b], { x: -10, y: -10, w: 700, h: 100 }), [a, b]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/hit_test.test.js'`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```js
"use strict";

// HitTest — геометрическая проверка попадания по display list канваса.
// Заменяет per-element SVG-хуки: один вызов отвечает «что под курсором».
const HitTest = (() => {
  const PAD = 4; // запас на толщину обводки

  function bbox(item) {
    const g = item.geom;
    if (g.segs) {
      if (!g.segs.length) return { x: 0, y: 0, w: 0, h: 0 };
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      g.segs.forEach((s) => {
        x1 = Math.min(x1, s.x1, s.cx, s.x2); y1 = Math.min(y1, s.y1, s.cy, s.y2);
        x2 = Math.max(x2, s.x1, s.cx, s.x2); y2 = Math.max(y2, s.y1, s.cy, s.y2);
      });
      return { x: x1 - PAD, y: y1 - PAD, w: x2 - x1 + 2 * PAD, h: y2 - y1 + 2 * PAD };
    }
    return { x: g.x - PAD, y: g.y - PAD, w: (g.w || 0) + 2 * PAD, h: (g.h || 0) + 2 * PAD };
  }

  const hits = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  const overlap = (b, r) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;

  // расстояние от точки до отрезка
  function distSeg(p, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
    return Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
  }

  // расстояние до пути: квадратичные сегменты сэмплируются в линии
  function distPath(p, segs) {
    let best = Infinity;
    for (const s of segs) {
      for (let i = 0; i < 8; i++) {
        const q = (i + 1) / 8, r = i / 8;
        const px = (1 - q) ** 2 * s.x1 + 2 * (1 - q) * q * s.cx + q * q * s.x2;
        const py = (1 - q) ** 2 * s.y1 + 2 * (1 - q) * q * s.cy + q * q * s.y2;
        const qx = (1 - r) ** 2 * s.x1 + 2 * (1 - r) * r * s.cx + r * r * s.x2;
        const qy = (1 - r) ** 2 * s.y1 + 2 * (1 - r) * r * s.cy + r * r * s.y2;
        best = Math.min(best, distSeg(p, qx, qy, px, py));
      }
    }
    return best;
  }

  function pick(list, p, z) {
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it.pick) continue;
      if (it.geom.segs) {
        if (distPath(p, it.geom.segs) <= 14 / z) return it;
      } else if (hits(bbox(it), p)) return it;
    }
    return null;
  }

  const pickNodes = (list, r) => list.filter((it) => it.pick && it.nodeType && overlap(bbox(it), r));

  return Object.freeze({ bbox, pick, pickNodes });
})();

if (typeof module !== "undefined") module.exports = HitTest;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/hit_test.test.js'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/hit_test.js internal/httpapi/web/hit_test.test.js
git commit -m "feat(web): geometric hit testing over canvas display list"
```

---

### Task 5: Camera.fitView

**Files:**
- Modify: `internal/httpapi/web/camera.js`
- Test: `internal/httpapi/web/camera.test.js` (дописать тесты)

**Interfaces:**
- Consumes: существующий `Camera` API (не меняется).
- Produces: `Camera.fitView(cam, bounds, vw, vh, pad) -> {x,y,z}` — камера, вписывающая мировой bbox `bounds={minX,minY,maxX,maxY}` в вьюпорт `vw×vh` с полем `pad`.

- [ ] **Step 1: Write the failing test** — дописать в конец `camera.test.js` (стиль файла сохранить: чистые функции без vm-обвязки; если файл использует vm — по его образцу):

```js
test("fitView centers bounds with padding", () => {
  const b = { minX: 0, minY: 0, maxX: 400, maxY: 200 };
  const cam = Camera.fitView(Camera.create(), b, 800, 400, 50);
  // масштаб ограничен меньшей стороной: (800-100)/400 = 1.75, (400-100)/200 = 1.5
  assert.equal(cam.z, 1.5);
  // центр мира (200,100) оказывается в центре вьюпорта
  const c = Camera.worldToScreen(cam, 200, 100);
  assert.equal(c.x, 400);
  assert.equal(c.y, 200);
});

test("fitView never zooms in beyond 1", () => {
  const cam = Camera.fitView(Camera.create(), { minX: 0, minY: 0, maxX: 100, maxY: 50 }, 800, 400, 50);
  assert.equal(cam.z, 1, "tiny scenes are centered, not magnified");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/camera.test.js'`
Expected: новый тест FAIL (fitView не существует), старые PASS

- [ ] **Step 3: Implement** — в `camera.js` перед `return`:

```js
  // fitView подбирает зум и центр так, чтобы bbox мира (с полем pad)
  // целиком поместился во вьюпорт; мелкие сцены центрируются без увеличения.
  function fitView(cam, b, vw, vh, pad) {
    const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
    const z = clamp(Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h, 1));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return { x: vw / 2 - cx * z, y: vh / 2 - cy * z, z };
  }
```

Добавить `fitView` в возвращаемый объект модуля.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/camera.test.js'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/camera.js internal/httpapi/web/camera.test.js
git commit -m "feat(web): Camera.fitView for fit-to-scene"
```

---

### Task 6: CanvasView — рендерер display list

**Files:**
- Create: `internal/httpapi/web/canvas_view.js`
- Test: `internal/httpapi/web/canvas_view.test.js`

**Interfaces:**
- Consumes: `HitTest.bbox` (Task 4); примитивы видов `rrect|path|text|glyph` со `style` вида `{fill, fillAlpha, stroke, strokeAlpha, lineWidth, dash, alpha, glow:{color,blur}, font}`.
- Produces:
    - `CanvasView.create(canvas, { getList, getCam, getOverlay, textHideZoom? }) -> view`
      - `getList() -> item[]` (мировые координаты), `getCam() -> {x,y,z}`, `getOverlay() -> item[] | undefined` (рисуется поверх)
      - `textHideZoom` — порог скрытия подписей (по умолчанию 0.5; страница передаёт `theme.textHideZoom`)
    - `view.invalidate()` — запросить кадр (не более одного на rAF; при отсутствии `requestAnimationFrame` рисует синхронно — режим тестов)
    - `view.draw()` — принудительный кадр (для тестов)
    - ресайз: слушает `window.resize`; размер буфера = `clientWidth/clientHeight × devicePixelRatio`
- Рендер: очистка → `ctx.setTransform(z*dpr,0,0,z*dpr,cam.x*dpr,cam.y*dpr)` → culling по `HitTest.bbox` против видимого мирового прямоугольника → отрисовка. При `z < textHideZoom` тексты пропускаются (признак передаётся: элементы `text` имеют `text:true`). Глифы — `kind:"glyph"`, `geom:{d,x,y}`: `ctx.translate(x,y)` + `ctx.stroke(new Path2D(d))`; в node-тестах в sandbox кладётся стаб `Path2D`.

- [ ] **Step 1: Write the failing test**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// recorder: ctx-стаб, записывающий вызовы методов canvas 2d context
function makeCtx() {
  const calls = [];
  const handler = {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => calls.push([prop, args]);
    },
    set(t, prop, v) { t[prop] = v; calls.push(["set:" + prop, [v]]); return true; },
  };
  const ctx = new Proxy({}, handler);
  ctx.calls = calls;
  return ctx;
}

function boot(list, cam, getOverlay) {
  const canvas = {
    clientWidth: 1200, clientHeight: 800, style: {},
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    getContext: () => makeCtx(),
  };
  const sandbox = {
    console, canvas,
    window: { addEventListener() {}, devicePixelRatio: 1 },
    Path2D: class {},               // стаб для kind:"glyph"
    requestAnimationFrame: undefined, // синхронный режим тестов
  };
  vm.createContext(sandbox);
  for (const f of ["hit_test.js", "canvas_view.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox);
  const CanvasView = vm.runInContext("CanvasView", sandbox);
  const view = CanvasView.create(canvas, { getList: () => list, getCam: () => cam, getOverlay });
  return { view, canvas, lastCtx: () => view._ctxForTest() };
}

const CAM = { x: 0, y: 0, z: 1 };

test("draw applies camera transform and paints primitives", () => {
  const list = [
    { kind: "rrect", geom: { x: 10, y: 10, w: 140, h: 60, r: 6 }, style: { stroke: "#111", lineWidth: 1.5, fill: "#fff" } },
    { kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 50, cy: 0, x2: 100, y2: 0 }] }, style: { stroke: "#222", lineWidth: 1.5 } },
    { kind: "glyph", geom: { d: "M2.5 6a3.5 3.5 0 1 1 0 .01", x: 20, y: 30 }, style: { stroke: "#111" } },
    { kind: "text", geom: { x: 10, y: 20, w: 90 }, text: "hello", text: true, style: { font: "12px x", fill: "#333" } },
  ];
  const { view, lastCtx } = boot(list, { x: 100, y: 50, z: 2 });
  view.draw();
  const calls = lastCtx().calls;
  const names = calls.map((c) => c[0]);
  // draw() вызывает setTransform дважды (сброс dpr + камера); проверяем последний
  const tf = calls.filter((c) => c[0] === "setTransform").pop();
  assert.deepEqual(tf[1], [2, 0, 0, 2, 100, 50], "camera transform is the final one");
  assert.ok(names.includes("roundRect") || names.includes("rect"), "shape traced");
  assert.ok(names.includes("quadraticCurveTo"), "curve traced");
  assert.ok(calls.some((c) => c[0] === "stroke" && c[1][0] && typeof c[1][0] === "object"), "glyph stroked via Path2D");
  assert.ok(names.some((c) => c[0] === "fillText" && c[1][0] === "hello"), "text painted");
});

test("offscreen primitives are culled", () => {
  const far = { kind: "rrect", geom: { x: 90000, y: 90000, w: 140, h: 60, r: 6 }, style: {} };
  const near = { kind: "rrect", geom: { x: 10, y: 10, w: 140, h: 60, r: 6 }, style: {} };
  const { view, lastCtx } = boot([far, near], { x: 0, y: 0, z: 1 });
  view.draw();
  const names = lastCtx().calls.map((c) => c[0]);
  assert.ok(names.includes("roundRect") || names.includes("rect"));
  const traceCalls = lastCtx().calls.filter((c) => c[0] === "roundRect" || c[0] === "rect");
  assert.equal(traceCalls.length, 1, "only the visible shape traced");
});

test("overlay draws after the scene", () => {
  const scene = [{ kind: "rrect", geom: { x: 0, y: 0, w: 10, h: 10, r: 0 }, style: {} }];
  const over = [{ kind: "path", geom: { segs: [{ x1: 0, y1: 0, cx: 5, cy: 5, x2: 10, y2: 10 }] }, style: {} }];
  const { view, lastCtx } = boot(scene, CAM, () => over);
  view.draw();
  const names = lastCtx().calls.map((c) => c[0]);
  assert.ok(names.lastIndexOf("quadraticCurveTo") > names.indexOf("roundRect"), "overlay last");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/canvas_view.test.js'`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```js
"use strict";

// CanvasView — рендерер display list в Canvas2D: полный redraw кадра по
// invalidate (≤1 на rAF), камера через setTransform, culling вне вьюпорта.
// Рендерер ничего не знает о топологии — только примитивы и стили.
const CanvasView = (() => {
  const raf = typeof requestAnimationFrame === "function"
    ? (fn) => requestAnimationFrame(fn)
    : (fn) => fn();

  function trace(ctx, item) {
    const g = item.geom;
    if (g.segs) {
      ctx.beginPath();
      ctx.moveTo(g.segs[0].x1, g.segs[0].y1);
      g.segs.forEach((s) => ctx.quadraticCurveTo(s.cx, s.cy, s.x2, s.y2));
      if (g.closed) ctx.closePath();
    } else {
      ctx.beginPath();
      const r = g.r || 0;
      if (typeof ctx.roundRect === "function") ctx.roundRect(g.x, g.y, g.w, g.h, r);
      else ctx.rect(g.x, g.y, g.w, g.h);
    }
  }

  function paint(ctx, item) {
    const s = item.style || {};
    ctx.save();
    ctx.globalAlpha = s.alpha ?? 1;
    if (s.glow) { ctx.shadowColor = s.glow.color; ctx.shadowBlur = s.glow.blur; }
    if (item.kind === "text") {
      ctx.font = s.font;
      ctx.fillStyle = s.fill;
      ctx.fillText(item.text, item.geom.x, item.geom.y);
    } else if (item.kind === "glyph") {
      ctx.translate(item.geom.x, item.geom.y);
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.lineWidth || 1.6;
      ctx.stroke(new Path2D(item.geom.d));
    } else {
      trace(ctx, item);
      if (s.fill) {
        ctx.globalAlpha = (s.alpha ?? 1) * (s.fillAlpha ?? 1);
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      if (s.stroke) {
        ctx.globalAlpha = (s.alpha ?? 1) * (s.strokeAlpha ?? 1);
        ctx.strokeStyle = s.stroke;
        ctx.lineWidth = s.lineWidth || 1;
        if (s.dash) ctx.setLineDash(s.dash);
        ctx.lineCap = "round";
        ctx.stroke();
        if (s.dash) ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  function create(canvas, { getList, getCam, getOverlay, textHideZoom = 0.5 }) {
    let dirty = true;
    let scheduled = false;
    let ctx = null;
    let cw = 0, ch = 0;

    function resizeIfNeeded() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (w === cw && h === ch && ctx) return;
      cw = w; ch = h;
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx = canvas.getContext("2d");
    }

    function draw() {
      resizeIfNeeded();
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const cam = getCam();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.setTransform(cam.z * dpr, 0, 0, cam.z * dpr, cam.x * dpr, cam.y * dpr);
      // видимый мировой прямоугольник
      const view0 = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: cw / cam.z, h: ch / cam.z };
      const hideText = cam.z < textHideZoom;
      for (const it of [...(getList() || []), ...(getOverlay ? getOverlay() || [] : [])]) {
        if (it.text && hideText) continue;
        const b = HitTest.bbox(it);
        if (b.x > view0.x + view0.w || b.x + b.w < view0.x || b.y > view0.y + view0.h || b.y + b.h < view0.y) continue;
        paint(ctx, it);
      }
    }

    function schedule() {
      if (!dirty || scheduled) return;
      scheduled = true;
      raf(() => { scheduled = false; if (dirty) { dirty = false; draw(); } });
    }

    window.addEventListener("resize", () => { dirty = true; schedule(); });

    return {
      invalidate() { dirty = true; schedule(); },
      draw,
      _ctxForTest: () => ctx,
    };
  }

  return Object.freeze({ create });
})();

if (typeof module !== "undefined") module.exports = CanvasView;
```

Замечания к имплементации:
- Тесты: `window.addEventListener` уже включён в sandbox стаба.
- `_ctxForTest` — единственная тестовая лазейка; допустимо.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'internal/httpapi/web/canvas_view.test.js'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/canvas_view.js internal/httpapi/web/canvas_view.test.js
git commit -m "feat(web): CanvasView renderer with culling and rAF scheduling"
```

---

### Task 7: TopoScene.buildScene — display list сцены

**Files:**
- Modify: `internal/httpapi/web/topo_scene.js` (добавить `buildScene`, SVG `render` остаётся до задачи 12)
- Modify: `internal/httpapi/web/netmap.js` — перенести `cloudSegs` уже сделано (Task 3)
- Test: `internal/httpapi/web/topo_scene.test.js` (новый)

**Interfaces:**
- Consumes: `NetMap` константы и `cloudSegs`; `CanvasTheme` (структура из Task 2); классовые токены страниц: `"selected"`, `"pending"`, `"search-hit"`, `"search-dim"`, `"diag-flow-ok"`, `"diag-flow-deny"`, `"diag-dim"`.
- Produces:
  - `TopoScene.buildScene(scene, opts) -> { list }`
    - `scene = { topology, subnets, layout }` (как у `render`)
    - `opts = { theme, classes?, mark?, dim?, fade?, popOf?, item? }`
      - `classes(obj, part)` / `mark(obj)` / `dim(obj)` — те же колбэки, что у текущего `render`; их строки токенизируются в множество состояний
      - `fade` — `{ dim?: 0..1, flow?: 0..1 }` групповые коэффициенты переходов
      - `popOf(id) -> p|undefined` — прогресс появления узла (0..1), масштабирует геометрию вокруг центра
      - `item(kind, it)` — хук обогащения (тултипы диагностики)
  - Элементы списка: `{kind, id, ref, pick?, nodeType?, geom, style, text?, meta?}`
    - union: `kind:"rrect"`, `id:"union:<name>"`, `ref:union`, `style:{fill, fillAlpha:.07, stroke, strokeAlpha:.5}`
    - link: `kind:"path"`, `id:"link:<min>|<max>"`, `ref:link`, `pick:true`, `geom:{segs}`, `meta:{tooltip}` для фильтрованных
    - attach: `kind:"path"`, `id:"attach:<net>|<dev>"`, `ref:{type:"attach",net,device}`, `pick:true`
    - device: `kind:"rrect"`, `nodeType:"device"`, `ref:device`, `pick:true`, затем `glyph` и `text`
    - network: `kind:"path"` (замкнутое облако `geom:{segs, closed:true}`), `nodeType:"network"`, `ref:network`, `pick:true`, затем подписи
  - `TopoScene.bounds(topology, layout) -> bbox|null` — для fitView
  - `ensureLayout` остаётся как есть

Правила стилей (резолв в `buildScene`, значения — из темы):
- базово: устройство `fill:theme.panel, stroke:theme.kind[kind]||theme.border, lineWidth:1.5, r:theme.radius[kind]||default`; сеть — `fill:theme.panel, stroke:theme.kind.network`; связь/привязка — `stroke:theme.muted, lineWidth:1.5`; фильтрованная связь — `stroke:theme.filteredColor, dash:[6,4]` + `meta.tooltip`; глиф — `stroke:цвета вида, lineWidth:1.6`; union — цвет из `theme.unionColors[i%len]`; подписи — `fill:theme.text` / подзаголовок сети `fill:theme.muted`.
- состояния: `selected → stroke:accent,width:2.5`; `pending → stroke:accent,width:3`; `search-hit → glow:{accent,8}` (на форме узла/связи); `diag-flow-ok/deny → лерп цвета/ширины (связь 1.5→4, узел 1.5→2.5) по fade.flow (по умолчанию 1) + мягкое свечение`; `search-dim|diag-dim → alpha *= lerp(1, theme.dimAlpha, fade.dim ?? 1)`.
- `popOf`: если `p<1`, геометрия rrect/облака масштабируется вокруг центра с `s = 0.7 + 0.3*easeOutCubic(p)` и `alpha *= p`.

- [ ] **Step 1: Write the failing test**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { console };
vm.createContext(sandbox);
for (const f of ["netmap.js", "canvas_theme.js", "topo_scene.js"])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox);
const { TopoScene, CanvasTheme } = sandbox;

const theme = CanvasTheme.create({
  "--panel-bg": "#f6f6f8", "--border": "#d8d8dc", "--accent": "#2563eb",
  "--muted": "#6b6b6b", "--text": "#1a1a1a",
  "--kind-router": "#d97706", "--kind-switch": "#7c3aed", "--kind-network": "#16a34a",
});

const scene = () => ({
  topology: {
    devices: [{ name: "r1", kind: "router" }],
    links: [],
    networks: [{ name: "lan", subnets: [], attach: [{ device: "r1" }] }],
    unions: [],
  },
  subnets: [],
  layout: { devices: { r1: { x: 40, y: 40 } }, networks: { lan: { x: 40, y: 300 } } },
});

test("buildScene emits ordered primitives with refs", () => {
  const { list } = TopoScene.buildScene(scene(), { theme });
  const kinds = list.map((i) => i.kind);
  assert.deepEqual(kinds.filter((k, i) => true), kinds); // sanity
  const dev = list.find((i) => i.id === "device:r1");
  assert.equal(dev.nodeType, "device");
  assert.equal(dev.pick, true);
  assert.equal(dev.style.stroke, "#d97706", "router stroke from kind palette");
  const att = list.find((i) => i.id === "attach:lan|r1");
  assert.ok(att && att.pick, "attachment is pickable");
  const net = list.find((i) => i.id === "network:lan");
  assert.equal(net.geom.closed, true, "network cloud is a closed path");
  const label = list.find((i) => i.kind === "text" && i.text === "r1 (router)");
  assert.ok(label, "device label emitted");
  // порядок: сеть-узлы после связей
  assert.ok(list.indexOf(net) > list.indexOf(att), "network above attachments");
});

test("states resolve into resolved styles", () => {
  const opts = {
    theme,
    classes: (obj) => (obj.name === "r1" ? " selected" : ""),
    dim: () => false,
  };
  const { list } = TopoScene.buildScene(scene(), opts);
  const dev = list.find((i) => i.id === "device:r1");
  assert.equal(dev.style.stroke, "#2563eb", "selected stroke");
  assert.equal(dev.style.lineWidth, 2.5);
});

test("filtered link carries dash and tooltip meta", () => {
  const s = scene();
  s.topology.links = [{ a: { device: "r1" }, b: { device: "r1" }, filter: { aExports: ["N1"], bExports: [] } }];
  const { list } = TopoScene.buildScene(s, { theme });
  const link = list.find((i) => i.id === "link:r1|r1");
  assert.deepEqual(link.style.dash, [6, 4]);
  assert.match(link.meta.tooltip, /N1/);
});

test("fade.dim scales dimming progress", () => {
  // дефолт fade.dim = 1: без переданного fade состояние применено полностью
  // (та же семантика, что у flow — страницы без анимации не передают fade)
  const full = TopoScene.buildScene(scene(), { theme, mark: () => "search-dim" }).list;
  const dev = full.find((i) => i.id === "device:r1");
  assert.ok(dev.style.alpha < 0.5, "no fade means fully dimmed");
  const start = TopoScene.buildScene(scene(), { theme, mark: () => "search-dim", fade: { dim: 0 } }).list;
  const dev2 = start.find((i) => i.id === "device:r1");
  assert.equal(dev2.style.alpha, 1, "dim=0 keeps full alpha");
});

test("popOf scales node geometry around center", () => {
  const { list } = TopoScene.buildScene(scene(), { theme, popOf: (id) => (id === "device:r1" ? 0 : undefined) });
  const dev = list.find((i) => i.id === "device:r1");
  assert.ok(dev.geom.w < 140, "shrunk at p=0");
  assert.ok(dev.style.alpha < 1, "transparent at p=0");
});

test("bounds covers all layout positions", () => {
  const s = scene();
  const b = TopoScene.bounds(s.topology, s.layout);
  assert.equal(b.minX, 40);
  assert.ok(b.maxX >= 200, "includes network width");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'internal/httpapi/web/topo_scene.test.js'`
Expected: FAIL (buildScene/bounds отсутствуют)

- [ ] **Step 3: Implement buildScene** — добавить в `topo_scene.js` (рядом с существующим `render`; переиспользовать `unionBox`, `nameSummary`, `ensureLayout`, `linkOffsets/spreadOffset/pointAt` из NetMap):

Ключевой каркас (полная версия — по правилам стилей из интерфейсов выше):

```js
  const TOKENS = (str) => String(str || "").split(/\s+/).filter(Boolean);
  const statesOf = (opts) => (obj, part) => new Set([
    ...TOKENS(opts.classes && opts.classes(obj, part)),
    ...TOKENS(opts.mark && opts.mark(obj)),
    ...(opts.dim && opts.dim(obj) ? ["diag-dim"] : []),
  ]);

  // resolveStyles превращает базовый стиль + состояния в итоговый стиль
  // (цвет/ширина/дэш/glow/alpha) по правилам спецификации.
  function styled(base, states, theme, fade) {
    const st = { ...base };
    if (states.has("selected")) { st.stroke = theme.accent; st.lineWidth = 2.5; }
    if (states.has("pending")) { st.stroke = theme.accent; st.lineWidth = 3; }
    if (states.has("search-hit")) st.glow = { color: theme.accent, blur: 8 };
    const flow = states.has("diag-flow-ok") ? theme.flowOk : states.has("diag-flow-deny") ? theme.flowDeny : null;
    if (flow) {
      const k = fade?.flow ?? 1;
      st.stroke = theme.lerpHex(base.stroke, flow, k);
      st.lineWidth = base.lineWidth + ((base.wire ? 4 : 2.5) - base.lineWidth) * k;
      if (k > 0.05) st.glow = { color: flow, blur: 4 * k };
    }
    // дефолты fade.* = 1: если страница не анимирует переход, эффект
    // состояния применён полностью; fade:{dim:0} — стартовая точка твина
    if (states.has("search-dim") || states.has("diag-dim"))
      st.alpha = (st.alpha ?? 1) * (1 + (theme.dimAlpha - 1) * (fade?.dim ?? 1));
    return st;
  }
```

Далее `buildScene` собирает список в порядке: unions → links → attaches → devices (+glyph+label) → networks (+labels), каждый элемент проходит через `styled(...)`, получает `id/ref/pick/nodeType/meta`, опционально масштабируется через `popOf`, и вызывает `opts.item && opts.item(kind, it)`. Геометрия связей — те же формулы, что в текущем `render` (`linkOffsets/spreadOffset/pointAt`, квадратичная кривая через mid), но в виде сегментов `{x1,y1,cx,cy,x2,y2}` вместо SVG-строки. Подписи получают `geom.w = text.length * 6.5` для culling. `bounds` переиспользует логику `worldBounds` из diagnose.js (min/max по устройствам и сетям).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test 'internal/httpapi/web/topo_scene.test.js' && node --test 'internal/httpapi/web/topology_render.test.js'`
Expected: новый PASS; старые SVG-тесты topology_render — PASS (SVG-render не сломан)

- [ ] **Step 5: Commit**

```bash
git add internal/httpapi/web/topo_scene.js internal/httpapi/web/topo_scene.test.js
git commit -m "feat(web): TopoScene.buildScene display list for canvas rendering"
```

---

### Task 8: Страница диагностики на Canvas

**Files:**
- Modify: `internal/httpapi/web/diagnose.html` (svg → canvas, скрипты, кнопка fit)
- Modify: `internal/httpapi/web/diagnose.js` (view, удаление стейдж-модели, клик/тултипы, fly-анимация результата)
- Test: адаптировать `internal/httpapi/web/diagnose_page.test.js`

**Interfaces:**
- Consumes: `CanvasView.create/invalidate/draw`, `TopoScene.buildScene/bounds`, `HitTest.pick`, `CanvasTheme.fromComputed`, `Camera.fitView`, `Tween`.
- Produces: страница `diagnose` работает на `<canvas id="diag-canvas">`; экспортируемый API `Diagnose` сохраняется (`boot/renderReport/run/state/expandHighlight/expandFlow/flowMark/clampFormWidth`).

Изменения в `diagnose.js`:
1. Удалить: `sizeStage`, `applyCamera` (CSS-версию), `fitOrigin`, `rebase`, `scheduleRebase`, `WORLD_PAD`, `origin`, `stageM`, `worldBounds` (заменяется `TopoScene.bounds`). `svgEl()` → `canvasEl()` (тот же id `diag-canvas`). Убрать `rectEl` из CameraControls (канвас сам даёт правильный rect).
2. Boot создаёт: `theme = CanvasTheme.fromComputed(getComputedStyle(document.documentElement))`; `view = CanvasView.create(canvas, { getList: () => state.list, getCam: () => state.camera, getOverlay: () => [] })`; `renderMap()` становится:

```js
  function render() {
    TopoScene.ensureLayout(state.topology, state.layout);
    state.list = TopoScene.buildScene(state, {
      theme,
      dim: pathDim(state.hl),
      mark: flowMark(state.flow),
      fade: { flow: state.flowFade },
      item: (kind, it) => {
        if (kind === "device" && state.flow && state.flow.deny.has(it.ref.name))
          it.meta = { tooltip: denyTooltip(state.flow.deny.get(it.ref.name)) };
      },
    });
    view.invalidate();
  }
```

(`denyTooltip(info)` — та же строка, что раньше в `<title>`: `(правило X: )reason`; `state.hl/flow/flowFade` заполняются в `renderReport` вместо локальной `flow`.)
3. Переход потока: в `renderReport` после вычисления flow — `Tween.to(state, { flowFade: 1 }, 200)` с rAF-циклом `tw.tick(now); render();` до завершения; перед стартом `state.flowFade = 0`.
4. Клики: обработчик `click` на канвасе — `HitTest.pick(state.list, toWorld(p), z)`; если `ref.type !== "attach" && ref.name && nodeType === "network"` → `showNetInfo(ref)` (позиция NetInfo считается как прежде через `Camera.worldToScreen`).
5. Тултип deny: div `#diag-tooltip` в `diagnose.html`; показ по hover (mousemove → pick → meta.tooltip, задержка 300 мс через таймер), позиция у курсора, скрытие на leave/pan.
6. Кнопка fit: в `diagnose.html` рядом с картой `<button id="diag-fit" title="Вписать карту">`; обработчик — `flyCam(Camera.fitView(camera, TopoScene.bounds(...), w, h, 60))`.
7. `flyCam(to, ms=250)` — общий помощник страницы: твин копии камеры + `view.invalidate()` на каждый кадр (реализовать локально в diagnose.js; topology получит свою копию в задаче 10 — дублирование ~12 строк осознанное, чтобы не создавать общий файл ради двух использований; при ревью можно вынести в camera.js).

Адаптация `diagnose_page.test.js`:
- стаб `<canvas>`: `{ getContext: () => recorder, clientWidth: 1200, clientHeight: 800, style: {}, addEventListener, classList }`, `recorder` — Proxy-рекордер как в Task 6;
- sandbox: `requestAnimationFrame: undefined` (синхронно), `performance` глобальный Node доступен внутри vm? Нет — прокинуть `performance` в sandbox явно;
- загрузить скрипты: `common, camera, camera_input, netmap, net_info, tween, canvas_theme, hit_test, canvas_view, topo_scene, diagnose`;
- тесты рендера: вместо поиска SVG-элементов — ассерты по `Diagnose.state.list` (после `renderReport` есть подсвеченные `diag-flow-ok` стили: `assert.equal(okWire.style.stroke, theme.flowOk)` — тему сравнивать через `vm.runInContext("CanvasTheme.create({...})")` с теми же vars);
- тесты камеры (wheel/пан) — по аналогии со старыми: менять `state.camera`, проверять `Camera.screenToWorld`-инвариант, transform-строк больше нет;
- тест splitter/формы — без изменений.

- [ ] **Step 1:** Адаптировать стабы и первые 2–3 теста `diagnose_page.test.js` под новый boot (ожидаемо падают).
- [ ] **Step 2:** Запустить `node --test 'internal/httpapi/web/diagnose_page.test.js'` — убедиться в падении по причине отсутствия нового кода.
- [ ] **Step 3:** Реализовать правки `diagnose.html`/`diagnose.js` (перечислены выше; SVG-рендер `TopoScene.render` больше не вызывается этой страницей).
- [ ] **Step 4:** `node --test 'internal/httpapi/web/diagnose_page.test.js'` — PASS; `node --test 'internal/httpapi/web/*.test.js'` — остальные PASS (topology ещё на SVG).
- [ ] **Step 5:** Commit: `git commit -m "feat(web): diagnostic map rendered on canvas"`

---

### Task 9: Редактор топологии на Canvas — рендер, выбор, drag, удаление

**Files:**
- Modify: `internal/httpapi/web/topology.html` (svg → canvas, скрипты)
- Modify: `internal/httpapi/web/topology.js` (этап 1: view-рендер, выбор/drag/marquee/Del/trash, поиск)
- Test: адаптировать `internal/httpapi/web/topology_render.test.js` (часть), `topology_search.test.js`

**Interfaces:**
- Consumes: те же модули, что в Task 8.
- Produces: `Topology.render/boot` сохраняются; `State.list` — актуальный display list; `State.tool/selection/layout` без изменений.

Правки `topology.js` (этап 1):
1. `viewportG`, `el(...)`, `svg.innerHTML=""` — удалить; `render()`:

```js
  function render() {
    ensureLayout();
    State.list = TopoScene.buildScene(State, { theme, classes: nodeClasses });
    view.invalidate();
    document.getElementById("topo-delete").disabled = !State.selection.size;
  }
```

`nodeClasses` сохраняется как есть (те же токены). `pending`-подсветка: `classes` уже выдаёт `pending` — работает через токены.
2. Boot: theme/view как в Task 8; скрипты в `topology.html` дополнить `tween/canvas_theme/hit_test/canvas_view` (порядок: после `netmap.js`, до `topo_scene.js`).
3. Выбор и drag узлов: единый `mousedown` (button 0) на канвасе:

```js
  canvas().addEventListener("mousedown", (e) => {
    if (e.button !== 0 || State.tool !== "select") return;
    const hit = HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z);
    if (!hit) { startMarquee(e); return; }
    if (hit.nodeType) startNodeDrag(hit.ref, e);
    else if (hit.id.startsWith("link:") || hit.id.startsWith("attach:")) selectNode(hit.ref, e.shiftKey);
  });
```

`startNodeDrag(obj, e)` — перенос тела текущего `makeDraggable` (group-drag всей selection, порог 3px, `moved` флаг, `scheduleLayoutSave`), но вместо `render()` на каждый mousemove — обновление позиций в `layout` + `render()` (теперь это дешёвый invalidate). Plain-click поведение прежнее: connect/select/NetInfo — вызвать те же колбэки `onPlainClick`.
4. Marquee: тело текущего `setupSelection.mousedown`-ветки; прямоугольник хранится в мировых координатах в переменной `marqueeRect`; отрисовка — overlay-элементом:

```js
  const getOverlay = () => [
    ...(previewWire ? [previewWire] : []),
    ...(marqueeRect ? [{ kind: "path", geom: { segs: rectSegs(marqueeRect) }, style: { stroke: theme.accent, lineWidth: 1, dash: [4, 3], fill: "rgba(37,99,235,0.08)", fillAlpha: 1 }, fill: true }] : []),
  ];
```

(Для заливочного path добавить в `CanvasView.paint` ветку `if (s.fill && item.kind === "path") { trace; fill }` — либо представить marquee как `rrect` с нормализованными x/y — проще, выбрать rrect.) По `mouseup` — `marqueeSelect` через `HitTest.pickNodes(State.list, worldRect)` вместо ручного `hit()`; `marqueeEnded` флаг сохранить.
5. Del/Backspace, trash-button, DirtyGuard, формы, layout-save — без изменений (они оперируют State).
6. Поиск (`computeSearchHits/focusHit/updateSearch/clearSearch`) — без изменений; `focusHit` продолжает двигать камеру и вызывать `applyCamera()`; `applyCamera()` теперь `view.invalidate()` + позиционирование popover.

Адаптация тестов `topology_render.test.js`:
- стаб canvas — как в Task 8; `getElementById("topo-canvas")` возвращает его;
- скрипты — как в Task 8 + `topology.js`;
- ассерты «что отрисовано» переводятся на `get("State.list")`: например, «r1 (router)» → `list.some(i => i.text === "r1 (router)")`; rx-тест → `dev.geom.r === 16`; cloud → `net.geom.closed`; camera-from-layout → проверить `Camera.screenToWorld` инвариант или `view._ctxForTest().calls` setTransform; wheel/pan — через `fire(canvas,"wheel"/"mousedown"…)`, затем ассерт по `get("State.camera")`;
- drag-тест: fire mousedown на координатах внутри bbox r1 (элементов больше нет — координаты считаются от layout: r1 в (100,100) при z=2 → экран (200,200)), mousemove (+40,+40), mouseup → ассерт `State.layout.devices.r1 == {x:120,y:...}` и что list перестроен (`dev.geom.x===120`);
- выбор/удаление/marquee/trash/контекстное меню — в задаче 9 адаптировать только те, что зависят от рендера; меню — в задаче 10.

- [ ] **Step 1:** Перевести стаб и статические рендер-тесты (падают).
- [ ] **Step 2:** Запустить — убедиться в ожидаемом падении.
- [ ] **Step 3:** Реализовать этап 1 в `topology.html`/`topology.js`.
- [ ] **Step 4:** `node --test 'internal/httpapi/web/*.test.js'` — PASS.
- [ ] **Step 5:** Commit: `feat(web): topology editor renders on canvas`

---

### Task 10: Редактор — инструменты, контекстное меню, превью связи, hover-тултипы

**Files:**
- Modify: `internal/httpapi/web/topology.js` (этап 2)
- Test: адаптировать оставшиеся тесты `topology_render.test.js` (tools/connect/popover/context menu/wire-select)

Правки:
1. Инструменты device/network: `click` по фону определяется как `!HitTest.pick(...)` (учесть `marqueeEnded`); дальше прежняя логика popover (`openNodePopover/createNode`), `popoverWorld` — без изменений. После создания — `render()`.
2. Connect: `pending` остаётся; клик по устройству приходит из `startNodeDrag` plain-click (`onDeviceConnect`) и сетей (`onNetworkClick`) как раньше. Превью: вместо SVG `previewWire` — overlay-примитив `path` (мир. координаты, `style:{stroke:theme.accent, lineWidth:1.5, dash:[6,4]}`), пересчитывается в `mousemove` + `invalidate()`.
3. Контекстное меню: `contextDelete(elem,…)` → `contextMenuFor(obj, kindLabel)`; общий обработчик `contextmenu` на канвасе:

```js
  canvas().addEventListener("contextmenu", (e) => {
    if (State.tool !== "select") return;
    e.preventDefault();
    const hit = HitTest.pick(State.list, toWorld(screenPoint(e)), State.camera.z);
    if (!hit || !(hit.nodeType || hit.id.startsWith("link:") || hit.id.startsWith("attach:"))) return;
    const items = menuItemsFor(hit.ref, hit.nodeType); // бывшее тело contextDelete
    const at = screenPoint(e);
    if (camControls && camControls.isRightDown()) ctxPending = { items, at };
    else showContextMenu(at, items);
  });
```

(Нативное меню фона гасится в CameraControls как раньше.) Тесты «clean right-click» адаптируются: `contextmenu` файрится на canvas с координатами узла.
4. Hover: `mousemove` → pick → `cursor` (`grab` для nodeType, `pointer` для связей, иначе default) + тултип `meta.tooltip` (div `#topo-tooltip`, задержка 300 мс; содержимое — exports фильтрованной связи).
5. Кнопка fit: `<button id="topo-fit">` в `topo-toolbar`; `flyCam` как в Task 8; поиск: `focusHit` + Enter — заменить мгновенный прыжок на `flyCam(fitTarget)` (короткий, 180 мс).
6. Pop появление узла: в `createNode` — `pops.set(id, performance.now())`; rAF-цикл пересчитывает `popOf(id)` (0..1 за 180 мс) и вызывает `render()`; по завершении удаляет из `pops`. `buildScene` получает `popOf: (id) => pops.has(id) ? Math.min(1,(now-pops.get(id))/180) : undefined`.

- [ ] **Step 1:** Адаптировать оставшиеся тесты (tools/connect/popover/menu/wire-select/hover) — падают.
- [ ] **Step 2:** Запустить — убедиться в причине.
- [ ] **Step 3:** Реализовать этап 2.
- [ ] **Step 4:** `node --test 'internal/httpapi/web/*.test.js'` — PASS.
- [ ] **Step 5:** Commit: `feat(web): canvas editor tools, context menu and hover hints`

---

### Task 11: Анимация камеры и переходы состояний (сквозная полировка)

**Files:**
- Modify: `internal/httpapi/web/diagnose.js`, `internal/httpapi/web/topology.js` (если что-то осталось за задачами 8–10), `internal/httpapi/web/style.css` (курсоры/тултипы)

Содержание (проверить наличие, доделать недостающее):
- flyTo при наведении поиском и fit-кнопках (Tasks 8/10);
- fade потока диагностики при новом отчёте (Task 8);
- fade search-dim: в `updateSearch` — твин `state.searchFade` 0→1 (и обратно при очистке), `buildScene` получает `fade:{dim:searchFade}`;
- pop новых узлов (Task 10);
- курсоры и тултипы оформляются в CSS (`#topo-tooltip`, `#diag-tooltip` — позиционируются JS, стиль — CSS).

- [ ] **Step 1:** Проверочный прогон всех node-тестов; составить список незакрытых пунктов выше.
- [ ] **Step 2:** Доделать каждый пункт минимальным дифом (каждый — с тестом там, где проверяемо чисто: например, `updateSearch` выставляет `state.searchFade` и запускает твин — ассерт по `state.searchFade > 0` после `tick`).
- [ ] **Step 3:** Полный прогон: `go build ./... && go vet ./... && gofmt -l . && go test ./... && node --test 'internal/httpapi/web/*.test.js'` — всё зелёное.
- [ ] **Step 4:** Commit: `feat(web): camera fly, state fades and node pop polish`

---

### Task 12: Зачистка SVG-ветвей

**Files:**
- Modify: `internal/httpapi/web/topo_scene.js` (удалить `render`, `cloudPath`, `SVG-el`-хелперы)
- Modify: `internal/httpapi/web/netmap.js` (удалить `SVG_NS`, `el`, `KINDS.glyph`-строки оставить — они нужны глифам; удалить только неиспользуемое)
- Modify: `internal/httpapi/web/camera.js` (удалить `stageTransform` и ставший мёртвым `transform` — SVG-строка; проверить grep'ом)
- Modify: `internal/httpapi/web/style.css` (удалить мёртвые правила: `.wire`, `.wire-hit`, `.wire-preview`, `.wire-filtered`, `.node-rect*`, `.subnet-rect`, `.union-frame`, `.marquee`, `.search-hit/.search-dim`, `.diag-flow-*`, `.diag-flow-pulse`, `#diag-canvas` стейдж-правила, `.panning` правило; добавить `#topo-canvas,#diag-canvas { touch-action: none; }` и стили тултипов, если не добавлены)
- Modify: тесты, ссылавшиеся на удалённое (grep по `TopoScene.render`, `stageTransform`, `SVG_NS`)

- [ ] **Step 1:** Grep: `grep -rn "TopoScene.render\|stageTransform\|Camera.transform\|SVG_NS\|cloudPath\|NetMap.el" internal/httpapi/web --include='*.js'` — все использования либо удалены, либо легитимны (глифы, тесты).
- [ ] **Step 2:** Удалить мёртвый код и CSS (см. список выше).
- [ ] **Step 3:** Прогон: `go build ./... && go vet ./... && gofmt -l . && go test ./...` + `node --test 'internal/httpapi/web/*.test.js'` + `make build` (go:embed!).
- [ ] **Step 4:** Ручная smoke-проверка `./bin/firenet serve` при желании: открыть `/ui/topology` и `/ui/diagnose` (не автоматизируется playwright'ем по правилам проекта).
- [ ] **Step 5:** Commit: `chore(web): drop svg canvas branches and dead styles`

---

## Самопроверка плана

- Спек-покрытие: display list (T7), рендер+culling+dpr+rAF (T6), хит-тест (T4), тема (T2), твины (T1), fitView/fly (T5,8,10,11), переходы состояний и pop (T7,10,11), обе страницы (T8,9,10), удаление стейджа (T8), зачистка (T12), тестовая стратегия — во всех задачах. Анимация потока по рёбрам — вне скоупа по спеке.
- Типы/имена согласованы: `buildScene(scene, opts) -> {list}`, `HitTest.pick(list,p,z)`, `CanvasView.create(canvas,{getList,getCam,getOverlay,textHideZoom})`, `CanvasTheme.create(vars)/fromComputed(style)`, `Tween.create()`, `Camera.fitView(cam,b,vw,vh,pad)`, `TopoScene.bounds(topology,layout)`.
- Известные упрощения: `flyCam` дублируется в diagnose.js/topology.js (~12 строк) вместо общего файла; marquee-overlay — `rrect`, а не path.
- Глифы устройств рисуются через `new Path2D(KINDS.glyph)` (ветка `kind:"glyph"` в CanvasView); в node-тестах в sandbox кладётся стаб `class {}` — проверяется сам факт вызова stroke с объектом, не геометрия.
- Дефолты `fade.* = 1`: без переданного fade эффект состояния применён полностью; анимация стартует с `fade:{dim:0}` / `flowFade = 0`.
