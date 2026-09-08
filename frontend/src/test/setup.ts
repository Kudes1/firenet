import "@testing-library/jest-dom/vitest";

// jsdom не реализует URL.createObjectURL (CompilePage делает Blob-ссылки
// для скачивания скриптов): подставляем болтливую заглушку.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:mock";
  URL.revokeObjectURL = () => {};
}

// jsdom не реализует showModal/close у <dialog> (Modal их использует):
// имитируем модальное поведение установкой атрибута open.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
}

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
      const scale = transform?.match(/scale\(([\d.]+)\)/);
      if (scale) this.m22 = Number(scale[1]);
    }
  };
}
