import type { DeviceKind } from "../api/types";

// Геометрия узлов и глифы типов — перенос констант из netmap.js.
export const DEVICE_W = 140;
export const DEVICE_H = 60;
export const NET_W = 160;
export const NET_H = 60;

type KindStyle = { rx: number; glyph?: string };

// Глифы адаптированы из icons/*.svg (svgrepo.com), сетка 24x24, масштаб x0.5.
export const KINDS: Record<DeviceKind, KindStyle> = {
  router: { rx: 16, glyph: "M6 10.5V6M6 10.5L7.5 9M6 10.5L4.5 9M6 6V1.5M6 6H1.5M6 6H10.5M6 1.5L4.5 3M6 1.5L7.5 3M1.5 6L3 7.5M1.5 6L3 4.5M10.5 6L9 4.5M10.5 6L9 7.5" },
  switch: { rx: 2, glyph: "M9 10L10.5 8.5M10.5 8.5L9 7M10.5 8.5H8.5C7.1193 8.5 6 7.3807 6 6C6 4.61929 4.88071 3.5 3.5 3.5H1.5M9 2L10.5 3.5M10.5 3.5L9 5M10.5 3.5L8.5 3.5C7.9372 3.5 7.41785 3.68597 7 3.999815M1.5 8.5H3.5C4.062805 8.5 4.58217 8.31385 5 8" },
};

export const kindStyle = (kind: string): KindStyle => KINDS[kind as DeviceKind] ?? { rx: 4 };

// Палитра различимых оттенков; цвет объединения = его порядок в документе.
export const UNION_COLORS = [
  "#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
];
