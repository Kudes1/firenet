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

type Point = { x: number; y: number };

const PANEL_EDGE_GAP = 12;

function clampAnchor(point: Point, panel: DOMRect, surface: DOMRect, tx: number, ty: number, zoom: number): Point {
  if (surface.width <= 0 || surface.height <= 0) return point;
  const minX = (PANEL_EDGE_GAP - tx) / zoom;
  const minY = (PANEL_EDGE_GAP - ty) / zoom;
  const maxX = Math.max(minX, (surface.width - panel.width - PANEL_EDGE_GAP - tx) / zoom);
  const maxY = Math.max(minY, (surface.height - panel.height - PANEL_EDGE_GAP - ty) / zoom);
  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

function samePoint(a: Point | null, b: Point): boolean {
  return a?.x === b.x && a.y === b.y;
}

// Плавающая панель редактирования на канве: absolute внутри canvas-shell
// (рендерится overlay-слоем TopologyCanvas, как ContextMenu). Привязана к
// координатам сцены: при движении камеры уезжает вместе с сеткой, размер
// не масштабируется (панель всегда 1:1). Немодальная: фокуса не ловим,
// канва остаётся доступной; Esc закрывает, если фокус не в текстовом поле
// (Esc внутри Combo гасится им самим и закрывает только подсказки).
export default function CanvasPanel({ title, onClose, children, wide, compact, testId, at }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; tx: number; ty: number; zoom: number } | null>(null);
  const [tx, ty, zoom] = useContext(ViewportContext);
  // Якорь в координатах сцены. Позиция известна после измерения
  // (центрирование) — до этого панель скрыта.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(at ?? null);

  useLayoutEffect(() => {
    if (at || !ref.current) return;
    const surface = ref.current.closest(".canvas-shell, .canvas-wrap");
    if (!surface) return;
    const canvas = surface.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    // Центр канвы в экранных координатах переводим в координаты сцены:
    // anchor = (screen - transform) / zoom.
    const centered = {
      x: (canvas.width - r.width) / 2 / zoom - tx / zoom,
      y: (canvas.height - r.height) / 2 / zoom - ty / zoom,
    };
    setAnchor(clampAnchor(centered, r, canvas, tx, ty, zoom));
    // Центрируем один раз при открытии; дальше панель двигают вручную.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const surface = ref.current.closest(".canvas-shell, .canvas-wrap");
    if (!surface) return;
    const canvas = surface.getBoundingClientRect();
    const next = clampAnchor(at, ref.current.getBoundingClientRect(), canvas, tx, ty, zoom);
    setAnchor((current) => samePoint(current, next) ? current : next);
  }, [at?.x, at?.y, tx, ty, zoom]);

  useLayoutEffect(() => {
    if (!ref.current || !anchor || at) return;
    const surface = ref.current.closest(".canvas-shell, .canvas-wrap");
    if (!surface) return;
    const canvas = surface.getBoundingClientRect();
    const next = clampAnchor(anchor, ref.current.getBoundingClientRect(), canvas, tx, ty, zoom);
    setAnchor((current) => samePoint(current, next) ? current : next);
  }, [anchor, at, tx, ty, zoom]);

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
    drag.current = {
      startX: e.clientX, startY: e.clientY, baseX: anchor.x, baseY: anchor.y, tx, ty, zoom,
    };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const next = {
        x: d.baseX + (e.clientX - d.startX) / d.zoom,
        y: d.baseY + (e.clientY - d.startY) / d.zoom,
      };
      const surface = ref.current?.closest(".canvas-shell, .canvas-wrap");
      if (!surface || !ref.current) return;
      setAnchor(clampAnchor(next, ref.current.getBoundingClientRect(), surface.getBoundingClientRect(), d.tx, d.ty, d.zoom));
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
