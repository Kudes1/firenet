"use strict";

// CameraControls — общая обвязка ввода бесконечного холста: зум колесом,
// привязанный к курсору, и пан перетаскиванием. Чистый ввод поверх
// математики Camera (которая остаётся без DOM); что делать с камерой,
// решает страница через колбэки.
const CameraControls = (() => {
  // wire(svg, opts) подписывает холст на ввод:
  //   getCam/setCam — чтение и запись камеры страницы;
  //   buttons       — кнопки мыши, запускающие пан (по умолчанию левая и средняя);
  //   onChange      — вызывается после каждой мутации камеры (например,
  //                   отложенное сохранение раскладки);
  //   onDragEnd     — (moved, button) по отпускании кнопки; moved — было ли
  //                   реальное перетаскивание (сдвиг больше порога).
  // Возвращает { isRightDown } — зажата ли ПКМ (страницы используют это,
  // чтобы отличить правый клик от правого перетаскивания).
  function wire(svg, { getCam, setCam, buttons = [0, 1], onChange, onDragEnd }) {
    let rightDown = false;
    // Ввод (mousemove до 1000 Гц) приходит чаще кадров дисплея, а каждая
    // смена transform перерисовывает сцену. Обновления копятся в pending
    // и применяются одним setCam на кадр; где rAF нет (тесты) — сразу.
    const raf = typeof requestAnimationFrame === "function"
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => fn();
    let pending = null;
    let scheduled = false;
    const schedule = () => {
      if (scheduled || !pending) return;
      scheduled = true;
      raf(() => {
        scheduled = false;
        if (!pending) return;
        let c = getCam();
        if (pending.dx || pending.dy) c = { ...c, x: c.x + pending.dx, y: c.y + pending.dy };
        if (pending.zoom) c = Camera.zoomAt(c, pending.zoom.x, pending.zoom.y, pending.zoom.f);
        pending = null;
        setCam(c);
        onChange && onChange();
      });
    };
    const screenPoint = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = screenPoint(e);
      const f = Math.exp(-e.deltaY * 0.002);
      pending = { ...pending, zoom: { x: p.x, y: p.y, f: (pending?.zoom?.f || 1) * f } };
      schedule();
    });
    if (buttons.includes(2)) {
      // RMB is the pan drag: kill the native browser menu on the canvas
      // (node menus are custom and still receive the event)
      svg.addEventListener("contextmenu", (e) => e.preventDefault());
    }
    svg.addEventListener("mousedown", (e) => {
      if (!buttons.includes(e.button)) return;
      e.preventDefault();
      if (e.button === 2) rightDown = true;
      const start = screenPoint(e);
      let last = start;
      let moved = false;
      const onMove = (ev) => {
        const p = screenPoint(ev);
        if (!moved && Math.abs(p.x - start.x) ** 2 + Math.abs(p.y - start.y) ** 2 > 16) moved = true;
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        last = p;
        if (!dx && !dy) return;
        pending = { ...pending, dx: (pending?.dx || 0) + dx, dy: (pending?.dy || 0) + dy };
        schedule();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (e.button === 2) rightDown = false;
        onDragEnd && onDragEnd(moved, e.button);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    return Object.freeze({ isRightDown: () => rightDown });
  }

  return Object.freeze({ wire });
})();
