import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Props = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  at?: { x: number; y: number };
};

// Плавающая панель редактирования на канве: absolute внутри .canvas-wrap
// (рендерится children'ом TopologyCanvas, как ContextMenu), поэтому координаты
// канвовые и панель обрезается рамкой канвы. Немодальная: фокуса не ловим,
// канва остаётся доступной; Esc закрывает, если фокус не в текстовом поле
// (Esc внутри Combo гасится им самим и закрывает только подсказки).
export default function CanvasPanel({ title, onClose, children, wide, at }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; max: { x: number; y: number } } | null>(null);
  // Позиция известна после измерения (центрирование) — до этого панель скрыта.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(at ?? null);

  useLayoutEffect(() => {
    if (at || !ref.current) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    setPos({ x: (canvas.width - r.width) / 2, y: (canvas.height - r.height) / 2 });
    // Центрируем один раз при открытии; дальше панель двигают вручную.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !ref.current || !pos) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    drag.current = {
      startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y,
      max: { x: canvas.width - r.width, y: canvas.height - r.height },
    };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const x = Math.min(Math.max(d.baseX + e.clientX - d.startX, 0), d.max.x);
      const y = Math.min(Math.max(d.baseY + e.clientY - d.startY, 0), d.max.y);
      setPos({ x, y });
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`canvas-panel${wide ? " canvas-panel-lg" : ""}`}
      style={{ left: pos?.x, top: pos?.y, visibility: pos ? undefined : "hidden" }}
    >
      <header className="canvas-panel-header" onMouseDown={onHeaderMouseDown}>
        <h3>{title}</h3>
        <button type="button" className="modal-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="canvas-panel-body">{children}</div>
    </div>
  );
}
