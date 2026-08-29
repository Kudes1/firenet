"use strict";

// Tween — мини-аниматор числовых свойств: to() ставит твин, tick(now)
// продвигает все активные и возвращает признак активности. Чистая
// математика, без DOM; страницы сами решают, когда перерисовывать кадр.
export const Tween = (() => {
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;

  function create() {
    let items = [];
    return {
      to(obj, props, ms = 150, ease = easeOutCubic) {
        const from = {};
        for (const k in props) from[k] = obj[k];
        // поздний твин вытесняет ранние твины тех же свойств того же объекта;
        // твин якорится временем первого tick() — совместимо с performance.now()
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

