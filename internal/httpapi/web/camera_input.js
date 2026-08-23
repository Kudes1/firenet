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
  //                   отложенное сохранение раскладки).
  function wire(svg, { getCam, setCam, buttons = [0, 1], onChange }) {
    const screenPoint = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = screenPoint(e);
      setCam(Camera.zoomAt(getCam(), p.x, p.y, Math.exp(-e.deltaY * 0.002)));
      onChange && onChange();
    });
    svg.addEventListener("mousedown", (e) => {
      if (!buttons.includes(e.button)) return;
      e.preventDefault();
      let last = screenPoint(e);
      const onMove = (ev) => {
        const p = screenPoint(ev);
        const c = getCam();
        setCam({ ...c, x: c.x + p.x - last.x, y: c.y + p.y - last.y });
        last = p;
        onChange && onChange();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  return Object.freeze({ wire });
})();
