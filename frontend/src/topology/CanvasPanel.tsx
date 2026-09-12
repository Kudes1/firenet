import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ViewportContext } from "./viewport";

type Props = {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  compact?: boolean;
  testId?: string;
  // Якорь в координатах сцены (flow): экранная позиция пересчитывается
  // через transform камеры, поэтому панель «плавает» вместе с сеткой.
  // undefined — панель центрируется по канве при открытии.
  at?: { x: number; y: number };
};

// Плавающая панель редактирования на канве: absolute внутри .canvas-wrap
// (рендерится children'ом TopologyCanvas, как ContextMenu). Привязана к
// координатам сцены: при движении камеры уезжает вместе с сеткой, размер
// не масштабируется (панель всегда 1:1). Немодальная: фокуса не ловим,
// канва остаётся доступной; Esc закрывает, если фокус не в текстовом поле
// (Esc внутри Combo гасится им самим и закрывает только подсказки).
export default function CanvasPanel({ title, onClose, children, wide, compact, testId, at }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; max: { x: number; y: number }; zoom: number } | null>(null);
  const [tx, ty, zoom] = useContext(ViewportContext);
  // Якорь в координатах сцены. Позиция известна после измерения
  // (центрирование) — до этого панель скрыта.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(at ?? null);

  useLayoutEffect(() => {
    if (at || !ref.current) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    // Центр канвы в экранных координатах переводим в координаты сцены:
    // anchor = (screen - transform) / zoom.
    setAnchor({
      x: (canvas.width - r.width) / 2 / zoom - tx / zoom,
      y: (canvas.height - r.height) / 2 / zoom - ty / zoom,
    });
    // Центрируем один раз при открытии; дальше панель двигают вручную.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!compact || !at || !ref.current) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const panel = ref.current.getBoundingClientRect();
    const minX = -tx / zoom;
    const minY = -ty / zoom;
    const maxX = Math.max(minX, (canvas.width - panel.width - tx) / zoom);
    const maxY = Math.max(minY, (canvas.height - panel.height - ty) / zoom);
    setAnchor({
      x: Math.min(Math.max(at.x, minX), maxX),
      y: Math.min(Math.max(at.y, minY), maxY),
    });
  }, [at, compact, tx, ty, zoom]);

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
    if (e.button !== 0 || !ref.current || !anchor) return;
    const canvas = ref.current.closest(".canvas-wrap")!.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    drag.current = {
      startX: e.clientX, startY: e.clientY, baseX: anchor.x, baseY: anchor.y, zoom,
      // Зажим ручного драга — в экранной системе канвы.
      max: {
        x: anchor.x + (canvas.width - r.width - (anchor.x * zoom + tx)) / zoom,
        y: anchor.y + (canvas.height - r.height - (anchor.y * zoom + ty)) / zoom,
      },
    };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const x = Math.min(Math.max(d.baseX + (e.clientX - d.startX) / d.zoom, 0), d.max.x);
      const y = Math.min(Math.max(d.baseY + (e.clientY - d.startY) / d.zoom, 0), d.max.y);
      setAnchor({ x, y });
    };
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const screen = anchor && { x: anchor.x * zoom + tx, y: anchor.y * zoom + ty };

  return (
    <div
      ref={ref}
      className={`canvas-panel${wide ? " canvas-panel-lg" : ""}${compact ? " canvas-panel-compact" : ""}`}
      data-testid={testId}
      style={{ left: screen?.x, top: screen?.y, visibility: anchor ? undefined : "hidden" }}
    >
      <header className="canvas-panel-header" onMouseDown={compact ? undefined : onHeaderMouseDown}>
        <h3>{title}</h3>
        <button type="button" className="modal-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="canvas-panel-body">{children}</div>
    </div>
  );
}
