import { NET_H, NET_W } from "./icons";

export { NET_H, NET_W };

// Контур L2-облака: периметр прямоугольника с наружными выпуклостями,
// каждая точка соединена квадратичной дугой (порт легаси cloudSegs).
type Seg = { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number };

function cloudSegs(x: number, y: number, w: number, h: number): Seg[] {
  const depth = 6, HB = 7, VB = 3;
  const pts = [[x, y]];
  const edge = (x1: number, y1: number, x2: number, y2: number, n: number) => {
    for (let i = 1; i <= n + 1; i++) pts.push([x1 + ((x2 - x1) * i) / (n + 1), y1 + ((y2 - y1) * i) / (n + 1)]);
  };
  edge(x, y, x + w, y, HB);
  edge(x + w, y, x + w, y + h, VB);
  edge(x + w, y + h, x, y + h, HB);
  for (let i = VB; i >= 1; i--) pts.push([x, y + (h * i) / (VB + 1)]);
  return pts.map((p, i) => {
    const [ax, ay] = p;
    const [bx, by] = pts[(i + 1) % pts.length];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    return { x1: ax, y1: ay, cx: ax + dx / 2 + (dy / len) * depth, cy: ay + dy / 2 + (-dx / len) * depth, x2: bx, y2: by };
  });
}

// cloudPath сериализует контур в атрибут d: замкнутая цепочка Q-сегментов.
export function cloudPath(x: number, y: number, w: number, h: number): string {
  const segs = cloudSegs(x, y, w, h);
  const [first] = segs;
  const d = [`M ${first.x1} ${first.y1}`];
  for (const s of segs) d.push(`Q ${s.cx} ${s.cy} ${s.x2} ${s.y2}`);
  return `${d.join(" ")} Z`;
}

export const NET_CLOUD_PATH = cloudPath(0, 0, NET_W, NET_H);
