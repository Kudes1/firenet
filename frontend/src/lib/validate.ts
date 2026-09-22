// Валидация, которая в легаси жила внутри Alpine-компонентов (draftHint).
// Возвращает текст подсказки: "" — валидно, иначе строка показывается
// рядом с полем и блокирует сохранение.

const NAME_FORBIDDEN = /[|#]/;

export function uniqueNameHint(name: string, taken: string[], selfIndex = -1): string {
  const trimmed = name.trim();
  if (!trimmed) return "Имя обязательно";
  if (NAME_FORBIDDEN.test(trimmed)) return "Недопустимые символы в имени: | #";
  const clash = taken.findIndex((n) => n === trimmed);
  if (clash !== -1 && clash !== selfIndex) return "Имя уже используется";
  return "";
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

// parseHostAddress приводит адрес к каноническому виду: голый IPv4 → /32,
// IPv4 в маске короче /32 не принимается, IPv6 — только /128.
// Легаси хранил голый IP без маски («10.0.0.5»), здесь нормализуем к /32
// (и /128 для IPv6) — это расхождение сознательное: на бэкенде
// projectdoc.parseHostPrefix всё равно сводит к полной маске, а единый
// канонический вид нужен поиску matchPrefixQuery и дедупликации адресов
// набора. В diff/историю адреса пишутся уже нормализованными.
export function parseHostAddress(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.split("/").length > 2) return null; // мусор вида «10.0.0.5/32/1»
  const [addr, bitsRaw] = v.split("/");
  const v4 = IPV4.exec(addr);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255)) return null;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (bits !== 32) return null;
    return `${addr}/32`;
  }
  if (IPV6.test(addr) && (addr.match(/:/g)?.length ?? 0) >= 2) {
    const bits = bitsRaw === undefined ? null : Number(bitsRaw);
    if (bits !== 128) return null;
    return `${addr}/128`;
  }
  return null;
}

// parseRuleLiteral принимает литеральный src/dst правила так же, как бэкенд
// (topology.ParseEndpointPrefix): голый IPv4 → /32, IPv4 CIDR (маскируется
// к границе сети, как netip.ParsePrefix.Masked). IPv6 и прочее — null.
export function parseRuleLiteral(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const [addr, bitsRaw, ...extra] = v.split("/");
  if (extra.length) return null;
  const m = IPV4.exec(addr);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const bytes = m.slice(1).map(Number);
  const masked = bytes.map((byte, i) => (bits >= (i + 1) * 8 ? byte : Math.max(0, bits - i * 8) > 0 ? (byte >> (8 - (bits - i * 8))) << (8 - (bits - i * 8)) : 0));
  return `${masked.join(".")}/${bits}`;
}

// validPortSpec валидирует один или несколько (через запятую) спецификаций
// портов. Разделитель диапазона — «-», как в легаси rules.js и в
// internal/rules/validate.go (validatePortSpec): «80», «1024-2048».
// Двоеточие — это формат диагностики (handlers.go/compiler), здесь не оно.
export function validPortSpec(spec: string): boolean {
  if (!spec.trim()) return true;
  return spec.split(",").every((part) => {
    const p = part.trim();
    const range = p.split("-");
    if (range.length === 2) {
      const from = Number(range[0]);
      const to = Number(range[1]);
      return ok(from) && ok(to) && from < to;
    }
    if (range.length !== 1) return false;
    return ok(Number(p));
  });
}

const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
