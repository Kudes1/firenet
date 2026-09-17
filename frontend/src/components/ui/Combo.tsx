import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  items: string[];
  placeholder?: string;
  // hint подписывает элемент в списке (например, CIDR подсети); подпись
  // участвует в фильтрации поиска. parse превращает свободный ввод в новое
  // значение (например, литеральный IP/CIDR): когда ввод не совпал ни с
  // одним элементом и parse вернул значение, оно предлагается как «Добавить …».
  hint?: (item: string) => string | undefined;
  parse?: (raw: string) => string | null;
  onPick: (value: string) => void;
};

// Комбобокс с клавиатурной навигацией (↑/↓/Enter/Esc) — заменяет
// member-combo из легаси-страниц. Список кандидатов фильтруется на месте.
// Список рендерится порталом за пределами скролл-контейнера участников, но
// остаётся в ближайшем label/fieldset для сохранения связи с полем. Если их
// нет, используются открытый <dialog>, .canvas-panel или body.
export default function Combo({ items, placeholder, hint, parse, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Позиция списка: вершина крепится к полю (вниз или вверх), высота
  // ограничена видимой областью, чтобы список не перекрывал поле ввода.
  const [rect, setRect] = useState<{ dialog: boolean; top: number; left: number; width: number; up: boolean; maxHeight: number } | null>(null);

  const filtered = items.filter((i) => `${i} ${hint?.(i) ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  // Свободный ввод становится значением только через parse; курсор 0 —
  // это «Добавить …», существующие элементы сдвигаются на 1.
  const literal = search.trim() && filtered.length === 0 && parse ? parse(search) : null;

  const pick = (value: string) => {
    onPick(value);
    setSearch("");
    setOpen(false);
    setCursor(0);
  };

  // Направление и высота списка определяются видимой областью: вьюпорт,
  // пересечённый с реально скроллящимися предками ненулевого размера. Так
  // список не пытается открыться в невидимую зону скролл-контейнера модалки.
  const visibleClip = (): { top: number; bottom: number } => {
    const clip = { top: 0, bottom: window.innerHeight };
    const intersect = (top: number, bottom: number) => {
      clip.top = Math.max(clip.top, top);
      clip.bottom = Math.min(clip.bottom, bottom);
    };
    intersect(0, window.innerHeight);
    let el = inputRef.current?.parentElement;
    while (el && el !== document.body) {
      const b = el.getBoundingClientRect();
      const scrolls = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
      if (scrolls && b.height > 0 && b.width > 0) intersect(b.top, b.bottom);
      el = el.parentElement;
    }
    return clip;
  };

  // Список открывается под полем (или над ним, если снизу видимого места
  // меньше, чем сверху) и следует за полем, пока открыт — как нативный
  // dropdown: без перекрытия поля и без лага при скролле.
  const measure = () => {
    const input = inputRef.current;
    if (!input) return setRect(null);
    const r = input.getBoundingClientRect();
    // Портал кладёт список в открытый <dialog>, а dialog.modal всегда несёт
    // inline translate (даже 0px 0px) — он становится containing block для
    // позиционированных потомков. Поэтому внутри диалога клиентские
    // координаты пересчитываются относительно его коробки, а вне него
    // используется обычный fixed.
    const anchor = input.closest("dialog[open], .canvas-panel");
    const MAX_LIST = 220;
    const GAP = 4;
    const clip = visibleClip();
    const below = Math.max(0, clip.bottom - r.bottom - GAP);
    const above = Math.max(0, r.top - clip.top - GAP);
    const up = below < MAX_LIST && above > below;
    const room = up ? above : below;
    const common = { width: r.width, up, maxHeight: room >= MAX_LIST ? MAX_LIST : Math.max(120, room) };
    if (anchor) {
      const d = anchor.getBoundingClientRect();
      // Абсолютный список живёт в content-координатах скролл-контейнера:
      // его visual-координаты смещены на scrollTop/scrollLeft (в модалке
      // правил скроллится сам <dialog>, а не .modal-body). Без поправки
      // список уезжает вверх вместе со скроллом и перекрывает поле ввода.
      const baseTop = d.top - anchor.scrollTop;
      const baseLeft = d.left - anchor.scrollLeft;
      setRect({ dialog: true, top: up ? r.top - baseTop - GAP : r.bottom - baseTop + GAP, left: r.left - baseLeft, ...common });
    } else {
      setRect({ dialog: false, top: up ? r.top - GAP : r.bottom + GAP, left: r.left, ...common });
    }
  };
  useLayoutEffect(measure, [open]);

  // Пока список открыт, позиция догоняет поле каждый кадр (перетаскивание
  // диалога, анимации) и мгновенно по событию скролла — до отрисовки,
  // поэтому лага нет.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      measure();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onScroll = () => measure();
    document.addEventListener("scroll", onScroll, true);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Закрытие по клику вне (теперь список живёт вне DOM-дерева инпута).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t)) return;
      if ((e.target as HTMLElement).closest?.(".member-combo-toggle, .member-suggestions")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const portalTarget = inputRef.current?.closest("label, fieldset, dialog[open], .canvas-panel") ?? document.body;

  return (
    <div className="member-combo">
      <input
        ref={inputRef}
        value={search}
        placeholder={placeholder ?? "начните вводить для поиска"}
        onChange={(e) => { setSearch(e.target.value); setOpen(true); setCursor(0); }}
        // Список открывает только явное намерение: клик по полю или
        // стрелка вниз. Фокус от label (клик по «Подсети») список
        // не открывает — пробрасывать фокус в поле можно без побочек.
        onPointerDown={() => setOpen(true)}
        onFocus={measure}
        onKeyDown={(e) => {
          const count = filtered.length + (literal ? 1 : 0);
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setCursor(Math.min(cursor + 1, count - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(cursor - 1, 0)); }
          else if (e.key === "Enter") {
            e.preventDefault();
            if (literal && cursor === 0) pick(literal);
            else if (filtered[cursor - (literal ? 1 : 0)]) pick(filtered[cursor - (literal ? 1 : 0)]);
          }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className={`member-combo-toggle${open ? " open" : ""}`} onClick={() => setOpen(!open)} />
      {open && rect && createPortal(
        <div
          className="member-suggestions"
          style={{
            position: rect.dialog ? "absolute" : "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            maxHeight: rect.maxHeight,
            // В режиме «над полем» top указывает на нижний край списка.
            transform: rect.up ? "translateY(-100%)" : undefined,
          }}
        >
          {literal && (
            <button
              type="button"
              className={`member-suggestion member-suggestion-literal${cursor === 0 ? " active" : ""}`}
              onMouseEnter={() => setCursor(0)}
              onMouseDown={(e) => { e.preventDefault(); pick(literal); }}
            >
              Добавить «{literal}»
            </button>
          )}
          {filtered.map((item, i) => (
            <button
              type="button"
              key={item}
              className={`member-suggestion${i + (literal ? 1 : 0) === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(i + (literal ? 1 : 0))}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              {item}
              {hint?.(item) && <span className="member-suggestion-hint">{hint(item)}</span>}
            </button>
          ))}
          {filtered.length === 0 && !literal && <p className="hint member-empty">Ничего не найдено</p>}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
