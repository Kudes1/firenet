import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Modal from "./Modal";

function renderModal(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <Modal open title="Изменить устройство sw1" onClose={onClose} {...props}>
      <label>
        Имя
        <input />
      </label>
      {props.children}
    </Modal>,
  );
  return { onClose, ...utils };
}

describe("Modal", () => {
  it("renders a dialog with header, close button and body", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("Изменить устройство sw1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Имя/)).toBeInTheDocument();
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape (cancel event)", () => {
    const { onClose } = renderModal();
    // Нативный <dialog> превращает Esc в событие cancel.
    fireEvent(screen.getByRole("dialog"), new Event("cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on backdrop click", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    // Клик в левый верхний угол вьюпорта — заведомо вне центрированного
    // диалога: событие всплывает до <dialog> с target = сам <dialog>,
    // как реальный клик по ::backdrop.
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 150, 300, 200),
    });
    fireEvent.click(dialog, { clientX: 5, clientY: 5 });
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores clicks inside the dialog", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 150, 300, 200),
    });
    fireEvent.click(screen.getByLabelText(/Имя/), { clientX: 350, clientY: 250 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("drags by the header and clamps to the viewport", () => {
    renderModal();
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    const header = screen.getByText("Изменить устройство sw1").closest(".modal-header")!;
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(350, 250, 300, 200),
    });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    fireEvent.mouseDown(header, { clientX: 400, clientY: 260 });
    // Панель целиком в кадре: rect.left=350, min-сдвиг = -350px (левый край к 0)
    fireEvent.mouseMove(window, { clientX: 20, clientY: 300 });
    fireEvent.mouseUp(window);
    expect(dialog.style.translate).toBe("-350px 40px");
  });

  it("resets position when reopened", () => {
    const { rerender } = render(<Modal open title="T" onClose={() => {}}>x</Modal>);
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    const header = screen.getByText("T").closest(".modal-header")!;
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(350, 250, 300, 200),
    });
    // Сдвигаем панель, закрываем и открываем заново — позиция в центре.
    fireEvent.mouseDown(header, { clientX: 400, clientY: 260 });
    fireEvent.mouseMove(window, { clientX: 300, clientY: 210 });
    fireEvent.mouseUp(window);
    expect(dialog.style.translate).not.toBe("0px 0px");
    rerender(<Modal open={false} title="T" onClose={() => {}}>x</Modal>);
    rerender(<Modal open title="T" onClose={() => {}}>x</Modal>);
    expect(dialog.style.translate).toBe("0px 0px");
  });
});
