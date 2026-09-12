import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  items: string[];
  placeholder?: string;
  onPick: (value: string) => void;
};

// Комбобокс с клавиатурной навигацией (↑/↓/Enter/Esc) — заменяет
// member-combo из легаси-страниц. Список кандидатов фильтруется на месте.
// Список рендерится порталом за пределами скролл-контейнера участников, но
// остаётся в ближайшем label/fieldset для сохранения связи с полем. Если их
// нет, используются открытый <dialog>, .canvas-panel или body.
export default function Combo({ items, placeholder, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ dialog: boolean; top: number; left: number; width: number } | null>(null);

  const filtered = items.filter((i) => i.toLowerCase().includes(search.toLowerCase()));

  const pick = (value: string) => {
    onPick(value);
    setSearch("");
    setOpen(false);
    setCursor(0);
  };

  // Координаты списка фиксируем при открытии; дальше они не «плавают»
  // при скролле содержимого модалки.
  const measure = () => {
    const input = inputRef.current;
    if (!input) return setRect(null);
    const r = input.getBoundingClientRect();
    // Портал кладёт список в открытый <dialog>, а dialog.modal всегда несёт
    // inline translate (даже 0px 0px) — он становится containing block для
    // позиционированных потомков. Поэтому внутри диалога клиентские
    // координаты пересчитываются относительно его коробки, а вне него
    // используется обычный fixed.
    const dialog = input.closest("dialog[open], .canvas-panel");
    if (dialog) {
      const d = dialog.getBoundingClientRect();
      setRect({ dialog: true, top: r.bottom - d.top + 4, left: r.left - d.left, width: r.width });
    } else {
      setRect({ dialog: false, top: r.bottom + 4, left: r.left, width: r.width });
    }
  };
  useLayoutEffect(measure, [open]);

  // Закрытие по клику вне (теперь список живёт вне DOM-дерева инпута).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t)) return;
      if ((e.target as HTMLElement).closest?.(".member-suggestions")) return;
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
        onFocus={() => { measure(); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(cursor + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(cursor - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (filtered[cursor]) pick(filtered[cursor]); }
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
          }}
        >
          {filtered.map((item, i) => (
            <button
              type="button"
              key={item}
              className={`member-suggestion${i === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              {item}
            </button>
          ))}
          {filtered.length === 0 && <p className="hint member-empty">Ничего не найдено</p>}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
