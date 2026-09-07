import { useState } from "react";

type Props = {
  items: string[];
  placeholder?: string;
  onPick: (value: string) => void;
};

// Комбобокс с клавиатурной навигацией (↑/↓/Enter/Esc) — заменяет
// member-combo из легаси-страниц. Список кандидатов фильтруется на месте.
export default function Combo({ items, placeholder, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const filtered = items.filter((i) => i.toLowerCase().includes(search.toLowerCase()));

  const pick = (value: string) => {
    onPick(value);
    setSearch("");
    setOpen(false);
    setCursor(0);
  };

  return (
    <div className="member-combo">
      <input
        value={search}
        placeholder={placeholder ?? "начните вводить для поиска"}
        onChange={(e) => { setSearch(e.target.value); setOpen(true); setCursor(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(cursor + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(cursor - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (filtered[cursor]) pick(filtered[cursor]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className={`member-combo-toggle${open ? " open" : ""}`} onClick={() => setOpen(!open)} />
      {open && (
        <div className="member-suggestions">
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
        </div>
      )}
    </div>
  );
}
