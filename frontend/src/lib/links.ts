// Идентичность связи не зависит от того, какая сторона названа A.
// Формат ключа совпадает с internal/httpapi/topology_operations.go
// (layoutLinkKey) и с pgstore.linkKey — позиции в массиве не используются.
export function canonicalLink(a: string, b: string): [string, string] {
  return a > b ? [b, a] : [a, b];
}

export function layoutLinkKey(a: string, b: string): string {
  return canonicalLink(a, b).join("|");
}
