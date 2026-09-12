import type { MapMark } from "../api/types";
import { layoutLinkKey } from "./links";

type Element = {
  kind: "node" | "edge" | "union";
  name?: string;
  names: string[];
  edgeKey?: string;
};

const flowClass = (name: string, sets: {
  deny: Set<string>;
  half: Set<string>;
  ok: Set<string>;
}) => {
  if (hasNode(sets.deny, name)) return "diag-flow-deny";
  if (hasNode(sets.half, name)) return "diag-flow-half";
  if (hasNode(sets.ok, name)) return "diag-flow-ok";
  return undefined;
};

const hasNode = (values: Set<string>, name: string) =>
  values.has(name) || values.has(`device:${name}`) || values.has(`network:${name}`);

const edgeSet = (keys: string[]) => new Set(
  keys.flatMap((key) => {
    const separator = key.includes("\0") ? "\0" : key.includes("|") ? "|" : undefined;
    if (!separator) return [];
    const [a, b] = key.split(separator);
    return a && b ? [layoutLinkKey(bareName(a), bareName(b))] : [];
  }),
);

const bareName = (value: string) =>
  value.startsWith("device:") || value.startsWith("network:") ? value.slice(value.indexOf(":") + 1) : value;

const parseElement = (id: string): Element | undefined => {
  if (id.startsWith("device:") || id.startsWith("network:")) {
    const name = id.slice(id.indexOf(":") + 1);
    return name ? { kind: "node", name, names: [name] } : undefined;
  }
  if (id.startsWith("union:")) {
    const name = id.slice("union:".length);
    return name ? { kind: "union", name, names: [name] } : undefined;
  }
  if (id.startsWith("link:") || id.startsWith("attach:")) {
    const raw = id.slice(id.indexOf(":") + 1).split("#", 1)[0];
    const separator = raw.indexOf("|");
    if (separator < 1 || separator === raw.length - 1) return undefined;
    const a = raw.slice(0, separator);
    const b = raw.slice(separator + 1);
    return {
      kind: "edge",
      names: [a, b],
      edgeKey: layoutLinkKey(bareName(a), bareName(b)),
    };
  }
  return undefined;
};

const edgeFlowClass = (key: string, sets: {
  deny: Set<string>;
  half: Set<string>;
  ok: Set<string>;
}) => {
  if (sets.deny.has(key)) return "diag-flow-deny";
  if (sets.half.has(key)) return "diag-flow-half";
  if (sets.ok.has(key)) return "diag-flow-ok";
  return undefined;
};

// Преобразует серверную карту диагностики в функцию классов React Flow.
// Поддерживает и wire-имена сервера, и квалифицированные id старых фикстур.
export function diagnosticMarkOf(mark: MapMark | null | undefined) {
  if (!mark) return (_id: string): string | undefined => undefined;

  const nodes = {
    hl: new Set(mark.hl ?? []),
    deny: new Set(Object.keys(mark.deny ?? {})),
    half: new Set(mark.half ?? []),
    ok: new Set(mark.ok ?? []),
  };
  const edges = {
    deny: edgeSet(mark.denyE ?? []),
    half: edgeSet(mark.halfE ?? []),
    ok: edgeSet(mark.okE ?? []),
  };

  return (id: string): string | undefined => {
    const element = parseElement(id);
    if (!element) return undefined;

    const flow = element.kind === "edge"
      ? edgeFlowClass(element.edgeKey!, edges)
      : element.kind === "node"
        ? flowClass(element.name!, nodes)
        : undefined;
    const dim = element.names.some((name) => !hasNode(nodes.hl, bareName(name)));
    return [flow, dim ? "diag-dim" : undefined].filter(Boolean).join(" ") || undefined;
  };
}
