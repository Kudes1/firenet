import "@testing-library/jest-dom/vitest";

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
