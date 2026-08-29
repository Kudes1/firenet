"use strict";

// NetInfo — плавающее окно состава сети на схеме топологии: по клику на сеть
// показывает её подсети (имя и CIDR). Общий для редактора /ui/topology и
// карты диагностики; контейнер #net-info лежит внутри .canvas-wrap обеих страниц.
const NetInfo = (() => {
  // приблизительный размер окна, чтобы удерживать его внутри канваса
  const PLACE = { w: 280, h: 90, margin: 8 };

  const box = () => document.getElementById("net-info");

  // row строит строку «имя … CIDR»
  function row(m) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = m.name;
    const cidr = document.createElement("span");
    cidr.className = "net-info-cidr";
    cidr.textContent = String(m.cidr || "");
    li.append(name, cidr);
    return li;
  }

  // show рисует состав сети net (имена берутся из справочника subnets)
  // в экранных координатах at (правый край облака сети), не выпуская окно
  // за пределы канваса bounds = { w, h }.
  function show(net, subnets, at, bounds) {
    const b = box();
    if (!b) return;
    b.innerHTML = "";
    const title = document.createElement("div");
    title.className = "net-info-title";
    title.textContent = net.name;
    b.append(title);
    const members = (net.subnets || []).map((s) => subnets.find((x) => x.name === s)).filter(Boolean);
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "net-info-empty";
      empty.textContent = "(нет подсетей)";
      b.append(empty);
    } else {
      const list = document.createElement("ul");
      members.forEach((m) => list.append(row(m)));
      b.append(list);
    }
    b.style.left = Math.min(Math.max(at.x + 14, PLACE.margin), Math.max(PLACE.margin, bounds.w - PLACE.w)) + "px";
    b.style.top = Math.min(Math.max(at.y + 10, PLACE.margin), Math.max(PLACE.margin, bounds.h - PLACE.h)) + "px";
    b.hidden = false;
  }

  function hide() {
    const b = box();
    if (b) b.hidden = true;
  }

  // attach закрывает окно при зуме/панораме (колесо и средняя кнопка),
  // клике по фону канваса и Escape; узловые обработчики гасят его сами.
  function attach(canvas) {
    canvas.addEventListener("wheel", hide);
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target === canvas) hide();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  }

  return Object.freeze({ show, hide, attach });
})();

export { NetInfo };
globalThis.NetInfo = NetInfo; // TODO(Task 28): remove once every classic-script consumer imports NetInfo directly
