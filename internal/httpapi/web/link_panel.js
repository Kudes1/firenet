"use strict";

import { showBanner } from "./common.js";
import { createFloatingPanel } from "./floating_panel.js";

// LinkPanel — плавающая панель редактирования фильтра одной связи, открываемая
// с холста топологии (ПКМ по связи → «Редактировать», недоступно пока
// create-link этой связи не подтверждён — см. Topology.openLinkPanel).
// Дублирует часть /ui/links (переключение обычная/фильтрованная,
// экспорт/импорт по сторонам); правки применяет onApply(filter|null), которое
// ставит set-link-filter/clear-link-filter в очередь операций немедленно —
// не общей кнопкой «Сохранить». Хром (открытие/закрытие/drag/мировая
// привязка/клэмп) — floating_panel.js; render() наполняет только
// #link-panel-title/#link-panel-body.
const LinkPanel = (() => {
  // OFFSET сдвигает панель от точки ПКМ, чтобы курсор не оказывался ровно
  // на её углу — как и раньше.
  const OFFSET = { x: 14, y: 10 };

  let s = null; // {link, filter: {aExports,bExports}|null, subnets, candidates, deps}
  let panel = null;

  const titleEl = () => document.getElementById("link-panel-title");
  const bodyEl = () => document.getElementById("link-panel-body");

  function cidrOf(name) {
    const sn = (s.subnets || []).find((x) => x.name === name);
    return sn ? sn.cidr : "";
  }

  // row строит строку «бейдж имени + CIDR», опционально с кнопкой удаления
  function row(name, onRemove) {
    const el = document.createElement("div");
    el.setAttribute("class", "member-row");
    const badge = document.createElement("span");
    badge.setAttribute("class", "owner-badge");
    badge.textContent = name;
    const hint = document.createElement("span");
    hint.setAttribute("class", "hint");
    hint.textContent = cidrOf(name);
    el.append(badge, hint);
    if (onRemove) {
      const del = document.createElement("button");
      del.setAttribute("class", "icon-btn delete");
      del.setAttribute("title", "Убрать из экспорта");
      del.textContent = "✕";
      del.addEventListener("click", onRemove);
      el.append(del);
    }
    return el;
  }

  function list(names, onRemove) {
    const el = document.createElement("div");
    el.setAttribute("class", "member-list" + (onRemove ? "" : " import-list"));
    if (!names.length) {
      const empty = document.createElement("p");
      empty.setAttribute("class", "hint member-empty");
      empty.textContent = onRemove ? "Экспорт не выбран" : "Сосед ничего не экспортирует";
      el.append(empty);
    } else {
      names.forEach((n) => el.append(row(n, onRemove && (() => {
        s.filter[onRemove] = s.filter[onRemove].filter((x) => x !== n);
        render();
      }))));
    }
    return el;
  }

  // addRow — селект доступных кандидатов (уже выбранные скрыты), выбор
  // сразу добавляет запись в экспорт этой стороны.
  function addRow(side, key) {
    const el = document.createElement("div");
    el.setAttribute("class", "member-add");
    const select = document.createElement("select");
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "добавить…";
    select.append(opt0);
    (s.candidates[side] || [])
      .filter((e) => !s.filter[key].includes(e.name))
      .forEach((e) => {
        const opt = document.createElement("option");
        opt.value = e.name;
        opt.textContent = e.cidr ? `${e.name} (${e.cidr})` : e.name;
        select.append(opt);
      });
    select.addEventListener("change", () => {
      const name = select.value;
      if (name && !s.filter[key].includes(name)) s.filter[key] = [...s.filter[key], name];
      render();
    });
    el.append(select);
    return el;
  }

  function sideColumn(side) {
    const key = side + "Exports";
    const peerKey = (side === "a" ? "b" : "a") + "Exports";
    const device = s.link[side].device;
    const peer = s.link[side === "a" ? "b" : "a"].device;
    const wrap = document.createElement("div");
    const legend = document.createElement("h4");
    legend.setAttribute("class", "filter-dir-title");
    legend.textContent = `${device} → ${peer}`;
    const exTitle = document.createElement("div");
    exTitle.setAttribute("class", "hint");
    exTitle.textContent = "Экспорт";
    const imTitle = document.createElement("div");
    imTitle.setAttribute("class", "hint");
    imTitle.textContent = `Импорт (из ${peer})`;
    wrap.append(legend, exTitle, list(s.filter[key], key), addRow(side, key), imTitle, list(s.filter[peerKey], null));
    return wrap;
  }

  function actions() {
    const el = document.createElement("div");
    el.setAttribute("class", "modal-actions");
    const cancel = document.createElement("button");
    cancel.setAttribute("type", "button");
    cancel.textContent = "Отмена";
    cancel.addEventListener("click", () => panel.close());
    const apply = document.createElement("button");
    apply.setAttribute("type", "button");
    apply.setAttribute("class", "primary");
    apply.textContent = "Применить";
    apply.addEventListener("click", () => {
      const filter = s.filter ? { aExports: [...s.filter.aExports], bExports: [...s.filter.bExports] } : null;
      s.deps.onApply(filter);
      panel.close();
    });
    el.append(cancel, apply);
    return el;
  }

  // render наполняет заголовок и тело панели содержимым текущего состояния
  // s; вызывается после каждого изменения (переключение фильтра, добавление/
  // удаление экспорта) — reflow() в конце переклэмпивает панель под новый
  // размер (высота растёт при переключении в фильтрованную связь).
  function render() {
    const b = bodyEl();
    if (!b || !s) return;
    titleEl().textContent = `Связь ${s.link.a.device} ↔ ${s.link.b.device}`;
    b.innerHTML = "";
    const toggle = document.createElement("button");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("class", "secondary btn-sm");
    toggle.textContent = s.filter ? "Вернуть обычную" : "Сделать фильтрованной";
    toggle.addEventListener("click", () => {
      if (s.filter) s.filter = null;
      else {
        s.filter = { aExports: [], bExports: [] };
        loadCandidates();
      }
      render();
    });
    b.append(toggle);
    if (s.filter) {
      const grid = document.createElement("div");
      grid.setAttribute("class", "link-panel-grid");
      grid.append(sideColumn("a"), sideColumn("b"));
      b.append(grid);
    } else {
      const hint = document.createElement("p");
      hint.setAttribute("class", "hint");
      hint.textContent = "Обычная связь даёт полную связность между устройствами.";
      b.append(hint);
    }
    b.append(actions());
    panel.reflow();
  }

  // loadCandidates fetches export candidates for both sides of the link
  // currently open. token captures the specific `s` object this fetch was
  // started for: if the panel gets closed/reopened (for the same or a
  // different link) before the fetch settles, `s` is reassigned or nulled,
  // so `s !== token` discards the now-stale response instead of writing it
  // into whatever is open now.
  async function loadCandidates() {
    const token = s;
    const { deps } = s;
    try {
      const [a, b] = await Promise.all([deps.fetchExports("a"), deps.fetchExports("b")]);
      if (s === token) s.candidates = { a, b };
    } catch (e) {
      if (s === token) s.candidates = { a: [], b: [] };
      if (typeof showBanner === "function") showBanner("Не удалось загрузить доступные сети: " + e.message);
    }
    render();
  }

  // show открывает панель для связи link (deps.fetchExports(side) уже
  // замкнут на конкретную пару link.a/link.b — см. Topology.openLinkPanel)
  // рядом с экранной точкой at (правый клик), со сдвигом OFFSET.
  function show(link, deps, at) {
    s = {
      link, deps,
      filter: link.filter ? { aExports: [...link.filter.aExports], bExports: [...link.filter.bExports] } : null,
      subnets: deps.subnets || [],
      candidates: { a: [], b: [] },
    };
    panel.open({ x: at.x + OFFSET.x, y: at.y + OFFSET.y });
    render();
    if (s.filter) loadCandidates();
  }

  function hide() {
    panel.close();
  }

  // attach создаёт панель поверх канваса: getCamera — геттер камеры холста
  // (topology.js's State.camera), нужен для мировой привязки — та же логика,
  // что и у net-edit/device-edit (см. Topology.applyCamera). onClose чистит
  // s, чтобы дальнейший render() (например от уже летящего loadCandidates)
  // не писал в закрытую панель.
  function attach(canvasEl, getCamera) {
    panel = createFloatingPanel({
      panelId: "link-panel",
      headerId: "link-panel-header",
      closeId: "link-panel-close",
      viewportEl: () => canvasEl,
      getCamera,
      fallbackW: 380,
      fallbackH: 320,
      closeOnEscape: true,
      closeOnCanvasClick: () => canvasEl,
      onClose: () => { s = null; },
    });
  }

  function position() {
    if (panel) panel.position();
  }

  return Object.freeze({ show, hide, attach, position });
})();

export { LinkPanel };
