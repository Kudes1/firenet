import type { TopologyOperation, TopologyDoc } from "../api/types";
import { canonicalLink } from "./links";

// Объект, выбранный кликом в инструменте «Соединить». kind повторяет
// префикс id узла канвы (device:<name> / network:<name>).
export type ConnectTarget = { kind: "device" | "network"; name: string };

// Исход второго клика: операция в очередь редактора, предупреждение
// (паритет с легаси showBanner) или молчаливый сброс выбора.
export type ConnectOutcome =
  | { operation: TopologyOperation }
  | { warning: string }
  | { cancel: true };

// connectOutcome — чистая логика connect-инструмента (легаси
// onDeviceConnect/onNetworkClick): что делать со вторым выбранным
// объектом, когда первый уже ждёт пару. Порядок кликов не важен —
// пара приводится к каноническому виду.
export function connectOutcome(pending: ConnectTarget, next: ConnectTarget, doc: TopologyDoc): ConnectOutcome {
  if (pending.kind === "device" && next.kind === "device") {
    if (pending.name === next.name) return { cancel: true };
    const [a, b] = canonicalLink(pending.name, next.name);
    const exists = (doc.links ?? []).some((l) => {
      const [x, y] = canonicalLink(l.a.device, l.b.device);
      return x === a && y === b;
    });
    if (exists) return { warning: `Устройства ${a} и ${b} уже соединены` };
    return { operation: { kind: "create-link", link: { a: { device: pending.name }, b: { device: next.name } } } };
  }
  if (pending.kind === "network" && next.kind === "network") {
    const [a, b] = canonicalLink(pending.name, next.name);
    if (a === b) return { cancel: true };
    return { warning: `Сети ${a} и ${b} не могут быть соединены напрямую` };
  }
  const net = pending.kind === "network" ? pending.name : next.name;
  const dev = pending.kind === "device" ? pending.name : next.name;
  const attached = (doc.networks ?? []).find((n) => n.name === net);
  if (attached && (attached.attach ?? []).some((e) => e.device === dev)) {
    return { warning: `Сеть ${net} уже подключена к ${dev}` };
  }
  return { operation: { kind: "attach-network", networkName: net, attach: { device: dev } } };
}
