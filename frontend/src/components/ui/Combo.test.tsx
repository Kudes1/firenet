import { act, render, screen, fireEvent } from "@testing-library/react";
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

  it("renders the suggestions list outside a scrollable member list", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Связь" onClose={vi.fn()}>
        <fieldset>
          <legend>r1</legend>
          <div className="member-list">
            <Combo items={["lan"]} onPick={vi.fn()} />
          </div>
        </fieldset>
      </Modal>,
    );
    await user.click(screen.getByRole("textbox"));
    const list = document.querySelector(".member-suggestions")!;
    const memberList = document.querySelector(".member-list")!;
    const fieldset = document.querySelector("fieldset")!;
    expect(list).toBeTruthy();
    expect(memberList.contains(list)).toBe(false);
    expect(fieldset.contains(list)).toBe(true);
    expect(screen.getByRole("dialog").contains(list)).toBe(true);
  });

  it("renders the list inside the dialog when used in a modal", async () => {
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

  it("keeps the list anchored to the input when the dialog itself is scrolled", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Правило" onClose={vi.fn()}>
        <Combo items={["lan"]} onPick={vi.fn()} />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 150, 300, 200),
      configurable: true,
    });
    const input = screen.getByRole("textbox");
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(300, 200, 200, 30),
      configurable: true,
    });
    // Прокручен сам <dialog> (в модалке правил длинное тело скроллит диалог,
    // а не .modal-body). Абсолютный список живёт в content-координатах, и без
    // поправки на scrollTop он уезжал вверх, перекрывая поле ввода.
    Object.defineProperty(dialog, "scrollTop", { value: 50, configurable: true });
    await user.click(input);
    const list = document.querySelector(".member-suggestions") as HTMLElement;
    expect(list.style.top).toBe("134px"); // (200 + 30 + 4) - (150 - 50)
  });

  it("opens the list upward when the visible area has no room below the input", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Сеть" onClose={vi.fn()}>
        <Combo items={["lan"]} onPick={vi.fn()} />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 100, 300, 500),
      configurable: true,
    });
    const input = screen.getByRole("textbox");
    // Инпут у нижнего края видимой области (вьюпорт усечён до 620px):
    // ниже поля видно только 26px, список открывается над ним.
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 620, configurable: true, writable: true });
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(300, 560, 200, 30),
      configurable: true,
    });
    try {
      await user.click(input);
      const list = document.querySelector(".member-suggestions") as HTMLElement;
      expect(list.style.top).toBe("456px"); // 560 - 100 - 4 (список над инпутом, диалог-относительно)
      expect(list.style.transform).toBe("translateY(-100%)");
      expect(list.style.maxHeight).toBe("220px");
    } finally {
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true, writable: true });
    }
  });

  it("clamps the list height to the visible space below the input", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Сеть" onClose={vi.fn()}>
        <Combo items={["lan", "guest"]} onPick={vi.fn()} />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 100, 300, 500),
      configurable: true,
    });
    const input = screen.getByRole("textbox");
    // Внизу видно 176px, сверху меньше (146px) — список открывается вниз,
    // но его высота ограничена видимым местом снизу.
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 360, configurable: true, writable: true });
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(300, 150, 200, 30),
      configurable: true,
    });
    try {
      await user.click(input);
      const list = document.querySelector(".member-suggestions") as HTMLElement;
      expect(list.style.maxHeight).toBe("176px");
      expect(list.style.transform).toBe("");
    } finally {
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true, writable: true });
    }
  });

  it("remeasures the list position when the modal body scrolls", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Сеть" onClose={vi.fn()}>
        <Combo items={["lan"]} onPick={vi.fn()} />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
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
    expect(list.style.top).toBe("84px");
    // Инпут уехал вверх вместе с контентом модалки при прокрутке.
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(300, 120, 200, 30),
      configurable: true,
    });
    // Перезамер происходит по событию scroll от .modal-body (capture, bubbling).
    act(() => {
      document.querySelector(".modal-body")!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(list.style.top).toBe("4px");
  });

  it("follows the input on the next frame without any scroll event", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Сеть" onClose={vi.fn()}>
        <Combo items={["lan"]} onPick={vi.fn()} />
      </Modal>,
    );
    let offsetY = 0;
    const dialog = screen.getByRole("dialog");
    Object.defineProperty(dialog, "getBoundingClientRect", {
      value: () => new DOMRect(200, 100 + offsetY, 300, 500),
      configurable: true,
    });
    const input = screen.getByRole("textbox");
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(300, 200 + offsetY, 200, 30),
      configurable: true,
    });
    await user.click(input);
    const list = document.querySelector(".member-suggestions") as HTMLElement;
    expect(list.style.top).toBe("134px"); // (200 + 30 + 4) - 100
    // Диалог перетащили вниз (обе коробки уехали на 60px): на следующем
    // кадре список пересчитывается сам, без события scroll.
    offsetY = 60;
    await act(async () => {
      await new Promise((r) =>
        typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r(null)) : setTimeout(r, 20),
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(list.style.top).toBe("134px");
  });

  it("renders the list inside a canvas panel when used in one", async () => {
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
    render(<Combo items={["lan"]} onPick={vi.fn()} />);
    const input = screen.getByRole("textbox");
    // jsdom: rect инпута задаём вручную, список должен использовать его.
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => new DOMRect(120, 90, 200, 30),
      configurable: true,
    });
    await user.click(input);
    const list = document.querySelector(".member-suggestions") as HTMLElement;
    expect(list.style.top).toBe("124px"); // 90 + 30 + 4 отступ
    expect(list.style.left).toBe("120px");
    expect(list.style.width).toBe("200px");
    expect(list.style.maxHeight).toBe("220px");
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

  it("reopens the list when clicking the input after an outside click closed it", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan"]} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
    // В браузере клик вне поля блюрит инпут; в jsdom фокус остаётся.
    screen.getByRole("textbox").blur();
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
  });

  it("reopens the list when clicking the already-focused input", async () => {
    const user = userEvent.setup();
    render(
      <label>
        Подсети
        <Combo items={["lan"]} onPick={vi.fn()} />
      </label>,
    );
    await user.click(screen.getByRole("textbox"));
    // Клик по лейблу закрывает список и возвращает фокус в инпут.
    await user.click(screen.getByText("Подсети"));
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
    // Инпут уже в фокусе — focus не сработает, но клик по полю должен
    // снова открыть список.
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
  });

  it("stays closed when clicking the wrapping label re-focuses the input", async () => {
    const user = userEvent.setup();
    render(
      <label>
        Подсети
        <Combo items={["lan"]} onPick={vi.fn()} />
      </label>,
    );
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
    // Клик по тексту лейбла: браузер гасит список по pointerdown, но
    // пробрасывает клик на инпут — фокус не должен переоткрыть список.
    await user.click(screen.getByText("Подсети"));
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
  });

  it("does not open the list when clicking the wrapping label from a closed state", async () => {
    const user = userEvent.setup();
    render(
      <label>
        Подсети
        <Combo items={["lan"]} onPick={vi.fn()} />
      </label>,
    );
    // Клик по тексту лейбла фокусирует инпут, но список открыть не должен.
    await user.click(screen.getByText("Подсети"));
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
  });

  it("opens the list with ArrowDown after keyboard focus", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan"]} onPick={vi.fn()} />);
    await user.tab();
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
  });

  it("closes the list via the toggle button", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan"]} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "lan" })).toBeInTheDocument();
    await user.click(document.querySelector(".member-combo-toggle")!);
    expect(screen.queryByRole("button", { name: "lan" })).toBeNull();
  });

  it("shows item hints next to the names and filters by them", async () => {
    const user = userEvent.setup();
    render(<Combo items={["office"]} hint={(i) => (i === "office" ? "10.0.0.0/24" : undefined)} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
    // Поиск матчит и CIDR, и имя.
    await user.type(screen.getByRole("textbox"), "10.0.0");
    expect(screen.getByRole("button", { name: /office/ })).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "office");
    expect(screen.getByRole("button", { name: /office/ })).toBeInTheDocument();
  });

  it("offers a parsed literal when the search matches no item", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Combo items={["lan"]} parse={(raw) => (/^\d/.test(raw) ? `${raw}` : null)} onPick={onPick} />);
    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "10.0.0.0/24");
    expect(screen.getByRole("button", { name: /Добавить «10\.0\.0\.0\/24»/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("10.0.0.0/24");
    // После добавления поле очищено, список закрыт.
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Добавить/ })).toBeNull();
  });

  it("does not offer a literal when parse rejects the search", async () => {
    const user = userEvent.setup();
    render(<Combo items={["lan"]} parse={() => null} onPick={vi.fn()} />);
    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "10.0.0.999");
    expect(screen.queryByRole("button", { name: /Добавить/ })).toBeNull();
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });
});
