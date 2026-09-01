"use strict";

import { Camera } from "./camera.js";

// createFloatingPanel — общий "хром" панелей, плавающих над канвасом
// (топология: net-edit/device-edit/link-panel; диагностика: diag-panel/
// spread-panel): открытие/закрытие, перетаскивание за заголовок, клэмп в
// границах контейнера (margin с обеих сторон) и мировая привязка (position()
// проецирует anchor текущей камерой — без клэмпа, панель едет вместе с
// картой, в т.ч. за пределы видимой области при панорамировании/зуме).
// Персист позиции/открытости в localStorage — опционален (posKey/openKey).
// Наполнение (форма, бизнес-логика) остаётся у вызывающей стороны — фабрика
// не трогает содержимое panel-body.
function createFloatingPanel({
  panelId,
  headerId,
  closeId,
  viewportEl,
  getCamera,
  posKey = null,
  openKey = null,
  defaultOpen = false,
  margin = 8,
  fallbackW = 320,
  fallbackH = 240,
  onOpenChange = null,
  onClose = null,
  closeOnEscape = false,
  closeOnCanvasClick = null,
}) {
  const panelEl = () => document.getElementById(panelId);
  let anchor = null; // мировая точка {x, y}, к которой привязана панель
  let drag = null; // {x, y, boxX, boxY} — экранные координаты старта драга

  function setOpen(open, persist = true) {
    panelEl().hidden = !open;
    if (persist && openKey) localStorage.setItem(openKey, open ? "1" : "0");
    if (onOpenChange) onOpenChange(open);
  }

  function position() {
    if (!anchor) return;
    const p = Camera.worldToScreen(getCamera(), anchor.x, anchor.y);
    panelEl().style.left = `${p.x}px`;
    panelEl().style.top = `${p.y}px`;
  }

  // clampAndPin подтягивает панель внутрь видимой области viewportEl() (с
  // margin по всем сторонам) и переопределяет anchor по уже кламп-нутой
  // позиции — иначе следующий position() (после пана/зума) вернул бы панель
  // туда, где она была бы без клэмпа, дав видимый скачок.
  function clampAndPin() {
    const wrap = viewportEl().getBoundingClientRect();
    const b = panelEl();
    const w = b.offsetWidth || fallbackW;
    const h = b.offsetHeight || fallbackH;
    const maxLeft = Math.max(margin, wrap.width - w - margin);
    const maxTop = Math.max(margin, wrap.height - h - margin);
    const left = Math.min(Math.max(parseFloat(b.style.left) || 0, margin), maxLeft);
    const top = Math.min(Math.max(parseFloat(b.style.top) || 0, margin), maxTop);
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
    anchor = Camera.screenToWorld(getCamera(), left, top);
    if (posKey) localStorage.setItem(posKey, JSON.stringify(anchor));
  }

  // open показывает панель. at (экранная точка, например курсор правого
  // клика) переносит anchor в эту точку; без at панель открывается на
  // прежнем месте (тулбар-тумблер вроде diag-panel/spread-panel).
  function open(at) {
    if (at) anchor = Camera.screenToWorld(getCamera(), at.x, at.y);
    setOpen(true);
    position();
    clampAndPin();
  }

  function endDrag() {
    drag = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  function close() {
    if (drag) endDrag();
    setOpen(false);
    if (onClose) onClose();
  }

  // reflow переклэмпивает панель на месте — вызывается вызывающей стороной,
  // когда содержимое меняет размер панели (например link-panel переключился
  // в фильтрованный режим и стал выше), чтобы панель не вылезла за канвас.
  function reflow() {
    if (panelEl().hidden) return;
    position();
    clampAndPin();
  }

  function onDragMove(e) {
    if (!drag) return;
    const wrap = viewportEl().getBoundingClientRect();
    const b = panelEl();
    const w = b.offsetWidth || fallbackW;
    const h = b.offsetHeight || fallbackH;
    const x = drag.boxX + (e.clientX - drag.x);
    const y = drag.boxY + (e.clientY - drag.y);
    const maxLeft = Math.max(margin, wrap.width - w - margin);
    const maxTop = Math.max(margin, wrap.height - h - margin);
    b.style.left = `${Math.min(Math.max(x, margin), maxLeft)}px`;
    b.style.top = `${Math.min(Math.max(y, margin), maxTop)}px`;
  }

  function onDragEnd() {
    clampAndPin(); // пересчитывает anchor от места, где драг оставил панель
    endDrag();
  }

  function isOpen() {
    return !panelEl().hidden;
  }

  const header = document.getElementById(headerId);
  const closeBtn = document.getElementById(closeId);
  closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", close);
  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const b = panelEl();
    drag = { x: e.clientX, y: e.clientY, boxX: parseFloat(b.style.left) || 0, boxY: parseFloat(b.style.top) || 0 };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  });
  if (closeOnEscape) {
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }
  if (closeOnCanvasClick) {
    closeOnCanvasClick().addEventListener("mousedown", (e) => { if (e.button === 0) close(); });
  }

  const storedOpen = openKey ? localStorage.getItem(openKey) : null;
  const openAtStart = storedOpen === null ? defaultOpen : storedOpen === "1";
  try {
    const saved = posKey ? JSON.parse(localStorage.getItem(posKey)) : null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) anchor = saved;
  } catch {}
  if (!anchor) {
    const wrap = viewportEl().getBoundingClientRect();
    anchor = Camera.screenToWorld(getCamera(), wrap.width / 2 - fallbackW / 2, wrap.height / 2 - fallbackH / 2);
  }
  setOpen(openAtStart, false);
  position();
  if (openAtStart) clampAndPin();

  return { open, close, position, reflow, isOpen };
}

export { createFloatingPanel };
