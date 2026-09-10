import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  // Без затемнения фона: модалки поверх канвы — подсветка на ней остаётся видна.
  undimmed?: boolean;
};

// Плавающая панель на нативном <dialog>: из коробки получаем Esc и ловушку
// фокуса, ::backdrop стилизуем на светлом затемнении. Панель перетаскивается
// за хедер (как в легаси), клик по затемнению закрывает.
export default function Modal({ open, title, onClose, children, footer, wide, undimmed }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Перетаскивание: база фиксируется на mousedown (текущий сдвиг + rect до
  // сдвига), дальше offset считается от неё с зажимом «панель в кадре».
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; rect: DOMRect } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Переоткрытие панели возвращает её в центр.
  useEffect(() => {
    if (open) setOffset({ x: 0, y: 0 });
  }, [open]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const dialog = ref.current;
    if (!dialog) return;
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y, rect: dialog.getBoundingClientRect() };
  };

  useEffect(() => {
    if (!open) return;
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const x = Math.min(Math.max(d.baseX + e.clientX - d.startX, d.baseX - d.rect.left), d.baseX + window.innerWidth - d.rect.right);
      const y = Math.min(Math.max(d.baseY + e.clientY - d.startY, d.baseY - d.rect.top), d.baseY + window.innerHeight - d.rect.bottom);
      setOffset({ x, y });
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [open]);

  const onBackdropClick = (e: React.MouseEvent) => {
    // Реальный клик по ::backdrop приходит с target === <dialog> и
    // координатами вне rect диалога; клики внутри имеют target-потомков.
    const dialog = ref.current;
    if (!dialog || e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      onClose();
    }
  };

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " modal-lg" : ""}${undimmed ? " modal-undimmed" : ""}`}
      style={{ translate: `${offset.x}px ${offset.y}px` }}
      onCancel={onClose}
      onClose={onClose}
      onClick={onBackdropClick}
    >
      <header className="modal-header" onMouseDown={onHeaderMouseDown}>
        <h3>{title}</h3>
        <button type="button" className="modal-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-actions modal-footer">{footer}</div>}
    </dialog>
  );
}
