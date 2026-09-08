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
