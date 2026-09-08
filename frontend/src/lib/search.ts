// Поисковые помощники страниц — порт common.js (containsFold, parseQueryPrefix,
// prefixContains/prefixOverlap, matchPrefixQuery, matchSubnetMembers,
// ipv4CidrOverlap). Чистые функции: ни DOM, ни состояния.

export function containsFold(value: string | undefined | null, query: string): boolean {
  if (!query) return true;
  return String(value ?? "").toLowerCase().includes(query.toLowerCase());
}

const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toInt(addr: string): number | null {
  const m = IPV4_OCTETS.exec(addr);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export type Prefix = { addr: string; bits: number };

// partialPrefix превращает частично набранный адрес («10.», «10.0», «10.0.0»,
// «10.0.0.5») в подразумеваемый CIDR-блок — порт partialPrefix из common.js:
// неполные октеты добиваются нулями, битовая маска = заполненным октетам.
// Отвергает октеты > 255 и ведущие нули («010.»), как легаси.
function partialPrefix(q: string): Prefix | null {
  let parts = q.split(".");
  if (parts.length > 4 || parts[0] === "") return null;
  if (parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  if (!parts.length) return null;
  for (const p of parts) {
    if (!/^\d+$/.test(p) || Number(p) > 255 || (p.startsWith("0") && p.length > 1)) return null;
  }
  const octets = parts.map(Number);
  while (octets.length < 4) octets.push(0);
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const bits = parts.length * 8;
  return { addr: `${(base >>> 24) & 255}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${base & 255}`, bits };
}

// parseQueryPrefix разбирает пользовательский запрос: голый IP → /32,
// неполный адрес («10.0», «10.0.0») → префикс по заполненным октетам,
// CIDR — как есть. Порт common.js parseQueryPrefix.
export function parseQueryPrefix(query: string): Prefix | null {
  const q = query.trim();
  if (!q) return null;
  const [addr, bitsRaw] = q.split("/");
  if (bitsRaw !== undefined) {
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32 || !toInt(addr)) return null;
    return { addr, bits };
  }
  if (toInt(addr)) return { addr, bits: 32 };
  return partialPrefix(addr);
}

function prefixContains(outer: string, inner: Prefix): boolean {
  const o = parseQueryPrefix(outer);
  if (!o) return false;
  const a = toInt(o.addr);
  const b = toInt(inner.addr);
  if (a === null || b === null) return false;
  if (o.bits > inner.bits) return false;
  const mask = o.bits === 0 ? 0 : (0xffffffff << (32 - o.bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function prefixOverlap(a: Prefix, b: Prefix): boolean {
  const ia = toInt(a.addr);
  const ib = toInt(b.addr);
  if (ia === null || ib === null) return false;
  // Маскируем обе базы общим префиксом (как normPrefix в common.js):
  // значение «10.0.0.5/24» при сравнении трактуется как «10.0.0.0/24».
  const bits = Math.min(a.bits, b.bits);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ia & mask) === (ib & mask);
}

// matchPrefixQuery: адресный запрос ищет по вхождению/пересечению префиксов,
// всё остальное — обычная подстрока (имя подсети, сети, набора).
// Запрос /32 проверяется вхождением в значение,
// более широкая маска — пересечением префиксов.
export function matchPrefixQuery(value: string, query: string): boolean {
  if (!query) return true;
  const q = parseQueryPrefix(query);
  if (!q) return containsFold(value, query);
  const v = parseQueryPrefix(value);
  if (!v) return containsFold(value, query);
  return q.bits === 32 ? prefixContains(value, q) : prefixOverlap(v, q);
}

export function matchSubnetMembers(
  names: string[] | undefined,
  cidrOf: (name: string) => string,
  query: string,
): boolean {
  if (!query) return true;
  return (names ?? []).some((n) => containsFold(n, query) || matchPrefixQuery(cidrOf(n), query));
}

// ipv4CidrOverlap — подсказка в форме («пересекается с X»), а не авторитет:
// окончательную проверку делает валидатор на бэкенде.
export function ipv4CidrOverlap(a: string, b: string): boolean {
  const pa = parseQueryPrefix(a);
  const pb = parseQueryPrefix(b);
  if (!pa || !pb) return false;
  return prefixOverlap(pa, pb);
}
