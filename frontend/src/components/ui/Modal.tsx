import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  compact?: boolean;
  resizable?: boolean;
  resizeStorageKey?: string;
  modal?: boolean;
};

type Size = { width: number; height: number };
type ResizeState = { startX: number; startY: number; left: number; top: number; startSize: Size; size: Size };

const MIN_WIDTH = 240;
const MIN_HEIGHT = 180;
const VIEWPORT_MARGIN = 16;

// Плавающая панель на нативном <dialog>: модальные панели получают Esc,
// ловушку фокуса и ::backdrop, немодальные остаются интерактивными вместе с
// остальной страницей. Панель перетаскивается за хедер.
export default function Modal({
  open, title, onClose, children, footer, wide, compact, resizable, resizeStorageKey, modal = true,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Перетаскивание: база фиксируется на mousedown (текущий сдвиг + rect до
  // сдвига), дальше offset считается от неё с зажимом «панель в кадре».
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; rect: DOMRect } | null>(null);
  const resize = useRef<ResizeState | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState<Size | null>(() => readSize(resizeStorageKey));

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (modal) dialog.showModal();
      else dialog.show();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, modal]);

  // Переоткрытие панели возвращает её в центр.
  useEffect(() => {
    if (open) setOffset({ x: 0, y: 0 });
  }, [open]);

  useEffect(() => {
    setSize(readSize(resizeStorageKey));
  }, [resizeStorageKey]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const dialog = ref.current;
    if (!dialog) return;
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y, rect: dialog.getBoundingClientRect() };
  };

  const onResizeMouseDown = (e: React.MouseEvent) => {
    if (!resizable || e.button !== 0) return;
    const dialog = ref.current;
    if (!dialog) return;
    e.preventDefault();
    const rect = dialog.getBoundingClientRect();
    const startSize = { width: rect.width, height: rect.height };
    resize.current = {
      startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top,
      startSize, size: startSize,
    };
  };

  useEffect(() => {
    if (!open) return;
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (d) {
        const x = Math.min(Math.max(d.baseX + e.clientX - d.startX, d.baseX - d.rect.left), d.baseX + window.innerWidth - d.rect.right);
        const y = Math.min(Math.max(d.baseY + e.clientY - d.startY, d.baseY - d.rect.top), d.baseY + window.innerHeight - d.rect.bottom);
        setOffset({ x, y });
        return;
      }
      const r = resize.current;
      if (!r) return;
      const next = {
        width: clamp(r.startSize.width + e.clientX - r.startX, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - r.left - VIEWPORT_MARGIN)),
        height: clamp(r.startSize.height + e.clientY - r.startY, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - r.top - VIEWPORT_MARGIN)),
      };
      r.size = next;
      setSize(next);
    };
    const up = () => {
      drag.current = null;
      const r = resize.current;
      if (r) saveSize(resizeStorageKey, r.size);
      resize.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [open, resizeStorageKey]);

  const onBackdropClick = (e: React.MouseEvent) => {
    if (!modal) return;
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
      className={`modal${wide ? " modal-lg" : ""}${compact ? " modal-compact" : ""}${resizable ? " modal-resizable" : ""}`}
      style={{
        translate: `${offset.x}px ${offset.y}px`,
        ...(size ? { width: `${size.width}px`, height: `${size.height}px` } : {}),
      }}
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
      {resizable && (
        <div className="modal-resize-corner">
          <span className="modal-resize-handle" aria-hidden="true" onMouseDown={onResizeMouseDown} />
        </div>
      )}
    </dialog>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readSize(key?: string): Size | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Size>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    return {
      width: clamp(parsed.width, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 2 * VIEWPORT_MARGIN)),
      height: clamp(parsed.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 2 * VIEWPORT_MARGIN)),
    };
  } catch {
    return null;
  }
}

function saveSize(key: string | undefined, size: Size): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(size));
  } catch {
    // Storage can be unavailable in private browsing or a restricted iframe.
  }
}
