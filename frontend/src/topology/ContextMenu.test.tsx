import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { type MenuItem } from "./ContextMenu";

const at = { x: 100, y: 80 };

function leaf(label: string, extra: Partial<MenuItem> = {}): MenuItem {
  return { label, ...extra };
}

describe("ContextMenu", () => {
  it("renders items at the given position", () => {
    render(<ContextMenu at={at} items={[leaf("Редактировать", { action: () => {} })]} onClose={() => {}} />);
    const menu = screen.getByTestId("topo-context-menu");
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("80px");
    expect(screen.getByRole("button", { name: "Редактировать" })).toBeInTheDocument();
  });

  it("closes after clicking an item and runs its action", () => {
    const action = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu at={at} items={[leaf("Редактировать", { action })]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    expect(action).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders disabled items", () => {
    render(<ContextMenu at={at} items={[leaf("Редактировать")]} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Редактировать" })).toBeDisabled();
  });

  it("marks danger items with the danger class", () => {
    render(<ContextMenu at={at} items={[leaf("Удалить r1", { danger: true, action: () => {} })]} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Удалить r1" }).className).toContain("danger");
  });

  it("opens a submenu on hover with its child items", async () => {
    const action = vi.fn();
    render(
      <ContextMenu
        at={at}
        items={[{ label: "Добавить в объединение", children: [leaf("u1", { action })] }]}
        onClose={() => {}}
      />,
    );
    // Кнопка пункта рендерится сразу, но скрыта CSS-правилом
    // .submenu { display: none } до наведения (jsdom не применяет CSS).
    const child = screen.getByRole("button", { name: "u1" });
    expect(child.closest(".submenu")).not.toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("ctx-sub-Добавить в объединение"));
    fireEvent.click(child);
    expect(action).toHaveBeenCalledOnce();
  });

  it("flips a submenu relative to the canvas shell when it reaches the right edge", () => {
    render(
      <div className="canvas-shell">
        <ContextMenu
          at={at}
          items={[{ label: "Добавить в объединение", children: [leaf("u1", { action: () => {} })] }]}
          onClose={() => {}}
        />
      </div>,
    );
    const shell = document.querySelector(".canvas-shell")!;
    const submenu = document.querySelector(".submenu")!;
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 300));
    vi.spyOn(submenu, "getBoundingClientRect").mockReturnValue(new DOMRect(350, 0, 100, 100));

    fireEvent.mouseEnter(screen.getByTestId("ctx-sub-Добавить в объединение"));

    expect(submenu).toHaveClass("submenu-left");
  });

  it("closes on outside click", () => {
    const onClose = vi.fn();
    render(<div data-testid="outside"><ContextMenu at={at} items={[leaf("x", { action: () => {} })]} onClose={onClose} /></div>);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // Канва RF (d3-zoom) глушит mousedown (stopImmediatePropagation), поэтому
  // клик по полю канвы доходит до document только как click — закрываемся и
  // по нему, иначе меню не закрывается кликом по канве.
  it("closes on outside click even when mousedown was swallowed by the canvas", () => {
    const onClose = vi.fn();
    render(<div data-testid="outside"><ContextMenu at={at} items={[leaf("x", { action: () => {} })]} onClose={onClose} /></div>);
    fireEvent.click(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ContextMenu at={at} items={[leaf("x", { action: () => {} })]} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("topo-context-menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close the menu when clicking the submenu search field", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        at={at}
        items={[{ label: "Добавить в объединение", searchable: true, children: [leaf("u1", { action: () => {} })] }]}
        onClose={onClose}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId("ctx-sub-Добавить в объединение"));
    fireEvent.click(screen.getByPlaceholderText("Поиск..."));
    expect(onClose).not.toHaveBeenCalled();
    // Поиск скрывает несовпавшие пункты (containsFold) через hidden.
    fireEvent.change(screen.getByPlaceholderText("Поиск..."), { target: { value: "нет-такого" } });
    const sub = screen.getByTestId("ctx-sub-Добавить в объединение");
    expect(sub.querySelector(".submenu button[hidden]")).not.toBeNull();
    expect(sub.querySelector(".submenu button")?.textContent).toBe("u1");
  });
});
