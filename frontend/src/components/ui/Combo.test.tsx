import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Combo from "./Combo";
import Modal from "./Modal";

describe("Combo", () => {
  it("opens the suggestions list on focus", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan", "guest"]} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "guest" })).toBeInTheDocument();
  });

  it("renders the suggestions list outside the combo container (portal to body)", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan"]} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    const combo = document.querySelector(".member-combo")!;
    const list = document.querySelector(".member-suggestions")!;
    expect(list).toBeTruthy();
    expect(combo.contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
  });

  it("renders the list inside the dialog when used in a modal (top layer)", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Сеть" onClose={vi.fn()}>
        <Combo items={["lan"]} onPick={vi.fn()} />
      </Modal>,
    );
    await user.click(screen.getByRole("textbox"));
    const list = document.querySelector(".member-suggestions")!;
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(list)).toBe(true);
    expect(document.body.contains(list)).toBe(true);
  });

  it("positions the list relative to the dialog box (translate makes it a containing block)", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Сеть" onClose={vi.fn()}>
        <Combo items={["lan"]} onPick={vi.fn()} />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    // Диалог в центре (200,150) и сдвинут через translate (это его обычное
    // состояние): translate создаёт containing block для fixed-потомков.
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 150, 300, 200),
      configurable: true,
    });
    const input = screen.getByRole("textbox");
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(300, 200, 200, 30),
      configurable: true,
    });
    await user.click(input);
    const list = document.querySelector(".member-suggestions") as HTMLElement;
    // Координаты — относительно коробки диалога, а не вьюпорта.
    expect(list.style.position).toBe("absolute");
    expect(list.style.top).toBe("84px"); // (200 + 30 + 4) - 150
    expect(list.style.left).toBe("100px"); // 300 - 200
  });

  it("portals suggestions into a canvas panel when used inside one", async () => {
    const user = userEvent.setup();
    render(
      <div className="canvas-wrap">
        <div className="canvas-panel" style={{ position: "absolute", left: 50, top: 50 }}>
          <Combo items={["alpha", "beta"]} onPick={() => {}} />
        </div>
      </div>,
    );
    await user.click(screen.getByRole("textbox"));
    const suggestions = document.querySelector(".canvas-panel .member-suggestions");
    expect(suggestions).not.toBeNull();
    // absolute внутри панели, не fixed в body
    expect((suggestions as HTMLElement).style.position).toBe("absolute");
  });

  it("positions the list under the input (fixed coordinates)", async () => {
    const user = userEvent.setup();
    const { container } = render(<Combo items={["lan"]} onPick={vi.fn()} />);
    const input = screen.getByRole("textbox");
    // jsdom: rect инпута задаём вручную, портал должен использовать его.
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(120, 90, 200, 30),
      configurable: true,
    });
    await user.click(input);
    const list = document.querySelector(".member-suggestions") as HTMLElement;
    expect(list.style.top).toBe("124px"); // 90 + 30 + 4 отступ
    expect(list.style.left).toBe("120px");
    expect(list.style.width).toBe("200px");
    expect(container).toBeTruthy();
  });

  it("picks an item on click", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Combo items={["lan", "guest"]} onPick={onPick} />);
    await user.click(screen.getByRole("textbox"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "guest" }));
    expect(onPick).toHaveBeenCalledWith("guest");
  });

  it("closes the list on outside click", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan"]} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
  });
});
