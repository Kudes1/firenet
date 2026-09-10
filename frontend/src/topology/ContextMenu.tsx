import { useEffect, useRef, useState } from "react";
import { containsFold } from "../lib/search";

export type MenuItem = {
  label: string;
  // undefined — неактивный пункт (disabled), как action === null в легаси.
  action?: () => void;
  danger?: boolean;
  // Пункт-подменю: дети раскрываются по hover/focus.
  children?: MenuItem[];
  // Поиск в подменю (список объединений может быть длинным).
  searchable?: boolean;
};

type Props = {
  at: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
};

// Подменю: поиск фильтрует пункты по containsFold, клик по инпуту не
// закрывает меню (menu button onMouseDown глушится точечно).
function Submenu({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const subRef = useRef<HTMLDivElement>(null);

  // Не хватило места справа до края .canvas-wrap — переоткрываем влево
  // (легаси flipIfClipped): mouseenter стреляет после применения :hover,
  // поэтому размеры уже актуальны.
  const flipIfClipped = () => {
    const sub = subRef.current;
    if (!sub) return;
    sub.classList.remove("submenu-left");
    const bound = sub.closest(".canvas-wrap")?.getBoundingClientRect();
    if (bound && sub.getBoundingClientRect().right > bound.right) {
      sub.classList.add("submenu-left");
    }
  };

  return (
    <div
      className="ctx-sub"
      data-testid={`ctx-sub-${item.label}`}
      onMouseEnter={flipIfClipped}
    >
      <button type="button">{item.label}</button>
      <div className="submenu" ref={subRef}>
        {item.searchable && (
          <input
            type="text"
            className="ctx-search"
            placeholder="Поиск..."
            value={query}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {item.children?.map((child) => (
          <ContextButton
            key={child.label}
            item={child}
            hidden={item.searchable ? !containsFold(child.label, query) : undefined}
            onClose={onClose}
          />
        ))}
      </div>
    </div>
  );
}

function ContextButton({ item, hidden, onClose }: { item: MenuItem; hidden?: boolean; onClose?: () => void }) {
  return (
    <button
      type="button"
      className={item.danger ? "danger" : undefined}
      disabled={!item.action}
      hidden={hidden}
      onClick={(e) => {
        e.stopPropagation();
        item.action?.();
        onClose?.();
      }}
    >
      {item.label}
    </button>
  );
}

// Контекстное меню канвы: позиционируется в точке ПКМ, закрывается по клику
// вне (mousedown + click — d3-zoom канвы глушит mousedown), по Escape и
// по выбору пункта. Стили — .context-menu/.ctx-sub/.submenu из styles.css.
export default function ContextMenu({ at, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Закрытие по клику снаружи. Слушаем и mousedown, и click: d3-zoom канвы
    // глушит mousedown (stopImmediatePropagation), и клик по полю канвы доходит
    // до document только как click. Клик внутри меню до document не доходит
    // (кнопки глушат его через stopPropagation), так что двойного onClose нет.
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("click", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" data-testid="topo-context-menu" style={{ left: at.x, top: at.y }}>
      {items.map((item) => (
        item.children
          ? <Submenu key={item.label} item={item} onClose={onClose} />
          : <ContextButton key={item.label} item={item} onClose={onClose} />
      ))}
    </div>
  );
}
