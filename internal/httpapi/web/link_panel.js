"use strict";

// LinkPanel — плавающая панель редактирования фильтра одной связи, открываемая
// с холста топологии (ПКМ по связи → «Редактировать», недоступно пока
// create-link этой связи не подтверждён — см. Topology.openLinkPanel).
// Дублирует часть /ui/links (переключение обычная/фильтрованная,
// экспорт/импорт по сторонам); правки применяет onApply(filter|null), которое
// ставит set-link-filter/clear-link-filter в очередь операций немедленно —
// не общей кнопкой «Сохранить».
const LinkPanel = (() => {
  const PLACE = { w: 380, h: 320, margin: 8 };

  let s = null; // {link, filter: {aExports,bExports}|null, subnets, candidates, deps, at, bounds}

  const box = () => document.getElementById("link-panel");

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
    cancel.addEventListener("click", hide);
    const apply = document.createElement("button");
    apply.setAttribute("type", "button");
    apply.setAttribute("class", "primary");
    apply.textContent = "Применить";
    apply.addEventListener("click", () => {
      const filter = s.filter ? { aExports: [...s.filter.aExports], bExports: [...s.filter.bExports] } : null;
      s.deps.onApply(filter);
      hide();
    });
    el.append(cancel, apply);
    return el;
  }

  // place пересчитывает позицию панели по её фактическому размеру (высота
  // растёт при переключении в фильтрованную связь), не выпуская её за
  // границы канваса bounds. Вызывается после каждого render — фиксированной
  // высоты панели не существует, а измерять её надо уже с новым содержимым.
  function place() {
    const b = box();
    if (!b || !s) return;
    const w = b.offsetWidth || PLACE.w;
    const h = b.offsetHeight || PLACE.h;
    b.style.left = Math.min(Math.max(s.at.x + 14, PLACE.margin), Math.max(PLACE.margin, s.bounds.w - w)) + "px";
    b.style.top = Math.min(Math.max(s.at.y + 10, PLACE.margin), Math.max(PLACE.margin, s.bounds.h - h)) + "px";
  }

  // drag тащит панель за заголовок: держит смещение курсора от исходной
  // s.at, чтобы дальнейшие render() (переключение фильтра и т.п.) двигали
  // панель через тот же place(), а не сбрасывали её к точке открытия.
  let drag = null; // {x, y, atX, atY}

  function onDragMove(e) {
    if (!drag || !s) return;
    s.at = { x: drag.atX + (e.clientX - drag.x), y: drag.atY + (e.clientY - drag.y) };
    place();
  }

  function onDragEnd() {
    drag = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  // onDragStart привязывает драг к фактически отрисованной позиции панели
  // (b.style.left/top), а не к сырому s.at: если панель открылась прижатой
  // к краю канваса place()'ом, s.at.x при этом остаётся некламплен-ным
  // значением, из-за которого начало перетаскивания «съедало» бы несколько
  // пикселей курсора вхолостую, прежде чем панель трогалась с места.
  function onDragStart(e) {
    if (!s || e.button !== 0) return;
    e.preventDefault();
    const b = box();
    const left = parseFloat(b.style.left);
    const top = parseFloat(b.style.top);
    drag = {
      x: e.clientX, y: e.clientY,
      atX: Number.isFinite(left) ? left - 14 : s.at.x,
      atY: Number.isFinite(top) ? top - 10 : s.at.y,
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }

  function render() {
    const b = box();
    if (!b || !s) return;
    b.innerHTML = "";
    const title = document.createElement("div");
    title.setAttribute("class", "link-panel-title");
    title.textContent = `Связь ${s.link.a.device} ↔ ${s.link.b.device}`;
    title.addEventListener("mousedown", onDragStart);
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
    b.append(title, toggle);
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
    place();
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
  // в экранной точке at, не выпуская окно за границы канваса bounds = {w, h}.
  function show(link, deps, at, bounds) {
    const b = box();
    if (!b) return;
    s = {
      link, deps, at, bounds,
      filter: link.filter ? { aExports: [...link.filter.aExports], bExports: [...link.filter.bExports] } : null,
      subnets: deps.subnets || [],
      candidates: { a: [], b: [] },
    };
    b.hidden = false;
    render();
    if (s.filter) loadCandidates();
  }

  function hide() {
    const b = box();
    if (b) b.hidden = true;
    if (drag) onDragEnd();
    s = null;
  }

  // attach закрывает панель при зуме/панораме (колесо и средняя кнопка),
  // клике по фону канваса и Escape — как NetInfo.
  function attach(canvas) {
    canvas.addEventListener("wheel", hide);
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target === canvas) hide();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  }

  return Object.freeze({ show, hide, attach });
})();

if (typeof module !== "undefined") module.exports = LinkPanel;
