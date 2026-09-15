import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CanvasPanel from "./CanvasPanel";
import { ViewportContext } from "./viewport";

function renderPanel(props: Partial<Parameters<typeof CanvasPanel>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <div className="canvas-wrap">
      <CanvasPanel title="Изменить устройство r1" onClose={onClose} {...props}>
        <label>
          Имя
          <input />
        </label>
      </CanvasPanel>
    </div>,
  );
  return { onClose, ...utils };
}

function mockRects(panelRect: DOMRect, canvasRect: DOMRect) {
  const panel = document.querySelector(".canvas-panel")!;
  const canvas = document.querySelector(".canvas-wrap")!;
  Object.defineProperty(panel, "getBoundingClientRect", { value: () => panelRect, configurable: true });
  Object.defineProperty(canvas, "getBoundingClientRect", { value: () => canvasRect, configurable: true });
}

describe("CanvasPanel", () => {
  it("renders header, close button and body at the given point", () => {
    renderPanel({ at: { x: 120, y: 80 } });
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    expect(screen.getByText("Изменить устройство r1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Имя/)).toBeInTheDocument();
    expect(panel.style.left).toBe("120px");
    expect(panel.style.top).toBe("80px");
  });

  it("centers in the canvas when no at is given", () => {
    // useLayoutEffect центрирования выполняется внутри render(), поэтому
    // rect-моки ставим на прототип ДО render (после render уже поздно).
    // jsdom держит getBoundingClientRect own-свойством прототипа, поэтому
    // delete снимет и оригинал — сохраняем дескриптор и возвращаем его.
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
    const proto = Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      value: function (this: Element) {
        if (this.classList.contains("canvas-wrap")) return new DOMRect(0, 0, 800, 600);
        if (this.classList.contains("canvas-panel")) return new DOMRect(0, 0, 300, 200);
        return new DOMRect(0, 0, 0, 0);
      },
      configurable: true,
    });
    renderPanel();
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    // Канва 800x600, панель 300x200 → центр (250, 200).
    expect(panel.style.left).toBe("250px");
    expect(panel.style.top).toBe("200px");
    delete (Element.prototype as any).getBoundingClientRect;
    if (original) Object.defineProperty(Element.prototype, "getBoundingClientRect", original);
    void proto;
  });

  it("closes on Escape outside inputs", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps open on Escape inside an input", () => {
    const { onClose } = renderPanel();
    const input = screen.getByLabelText(/Имя/);
    input.focus();
    // keydown рождается на сфокусированном элементе и всплывает до document —
    // эмулируем именно так, иначе target события будет document, не input.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a dragged panel inside the canvas", () => {
    renderPanel({ at: { x: 100, y: 100 } });
    // Канва 800x600, панель 300x200, внутренний отступ границы — 12px.
    mockRects(new DOMRect(100, 100, 300, 200), new DOMRect(0, 0, 800, 600));
    const header = screen.getByText("Изменить устройство r1").closest(".canvas-panel-header")!;
    fireEvent.mouseDown(header, { clientX: 150, clientY: 120 });
    fireEvent.mouseMove(window, { clientX: 1200, clientY: -400 });
    fireEvent.mouseUp(window);
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    expect(panel.style.left).toBe("488px");
    expect(panel.style.top).toBe("12px");
  });

  it("keeps a panel inside the canvas when the camera moves", () => {
    const { rerender } = render(
      <ViewportContext.Provider value={[0, 0, 1]}>
        <div className="canvas-shell">
          <CanvasPanel title="Изменить устройство r1" onClose={vi.fn()} at={{ x: 100, y: 100 }}>
            <input />
          </CanvasPanel>
        </div>
      </ViewportContext.Provider>,
    );
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    const surface = document.querySelector(".canvas-shell") as HTMLElement;
    Object.defineProperty(panel, "getBoundingClientRect", {
      value: () => new DOMRect(100, 100, 300, 200), configurable: true,
    });
    Object.defineProperty(surface, "getBoundingClientRect", {
      value: () => new DOMRect(0, 0, 800, 600), configurable: true,
    });

    rerender(
      <ViewportContext.Provider value={[-500, -400, 1]}>
        <div className="canvas-shell">
          <CanvasPanel title="Изменить устройство r1" onClose={vi.fn()} at={{ x: 100, y: 100 }}>
            <input />
          </CanvasPanel>
        </div>
      </ViewportContext.Provider>,
    );

    expect(panel.style.left).toBe("12px");
    expect(panel.style.top).toBe("12px");
  });

  // Панель привязана к координатам сцены: экранная позиция = якорь × zoom +
  // transform камеры. При transform [200, 100, 2] якорь (120, 80) даёт
  // экран (440, 260).
  it("maps the scene anchor through the camera transform", () => {
    render(
      <ViewportContext.Provider value={[200, 100, 2]}>
        <div className="canvas-wrap">
          <CanvasPanel title="Изменить устройство r1" onClose={vi.fn()} at={{ x: 120, y: 80 }}>
            <input />
          </CanvasPanel>
        </div>
      </ViewportContext.Provider>,
    );
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    expect(panel.style.left).toBe("440px");
    expect(panel.style.top).toBe("260px");
  });

  it("repositions when the camera moves", () => {
    const { rerender } = render(
      <ViewportContext.Provider value={[0, 0, 1]}>
        <div className="canvas-wrap">
          <CanvasPanel title="Изменить устройство r1" onClose={vi.fn()} at={{ x: 120, y: 80 }}>
            <input />
          </CanvasPanel>
        </div>
      </ViewportContext.Provider>,
    );
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    expect(panel.style.left).toBe("120px");
    rerender(
      <ViewportContext.Provider value={[-70, 40, 1]}>
        <div className="canvas-wrap">
          <CanvasPanel title="Изменить устройство r1" onClose={vi.fn()} at={{ x: 120, y: 80 }}>
            <input />
          </CanvasPanel>
        </div>
      </ViewportContext.Provider>,
    );
    expect(panel.style.left).toBe("50px");
    expect(panel.style.top).toBe("120px");
  });

  // Драг при zoom = 2: экранные 60px = 30px сцены. Якорь (120, 80),
  // transform [0, 0, 2] → экран (240, 160); мышь +60 → экран (300, 220).
  it("divides the drag delta by zoom", () => {
    render(
      <ViewportContext.Provider value={[0, 0, 2]}>
        <div className="canvas-wrap">
          <CanvasPanel title="Изменить устройство r1" onClose={vi.fn()} at={{ x: 120, y: 80 }}>
            <input />
          </CanvasPanel>
        </div>
      </ViewportContext.Provider>,
    );
    mockRects(new DOMRect(240, 160, 300, 200), new DOMRect(0, 0, 800, 600));
    const header = screen.getByText("Изменить устройство r1").closest(".canvas-panel-header")!;
    fireEvent.mouseDown(header, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 130 });
    fireEvent.mouseUp(window);
    const panel = document.querySelector(".canvas-panel") as HTMLElement;
    // Якорь 120 + 60/2 = 150 сцены → экран 150 × 2 = 300.
    expect(panel.style.left).toBe("300px");
    // 80 + 30/2 = 95 сцены → экран 190.
    expect(panel.style.top).toBe("190px");
  });
});
