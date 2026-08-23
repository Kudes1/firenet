"use strict";

// Shared page plumbing: Alpine app state, API helpers and the sidebar shell
// injected into every standalone UI page.

function appData() {
  return {
    theme: localStorage.getItem("firenet-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    banner: { show: false, message: "", kind: "error", timer: null },
    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = this.theme;
      localStorage.setItem("firenet-theme", this.theme);
    },
    showBanner(message, kind) {
      this.banner.message = message;
      this.banner.kind = kind || "error";
      this.banner.show = true;
      clearTimeout(this.banner.timer);
      this.banner.timer = setTimeout(() => { this.banner.show = false; }, 6000);
    },
  };
}

function showBanner(message, kind) {
  window.dispatchEvent(new CustomEvent("notify", { detail: { message, kind: kind || "error" } }));
}

// DirtyGuard warns the user before leaving a page with unsaved edits.
// A page arms it with a getter for its editable document and marks the
// clean baseline after load/save; nav clicks and tab close then compare
// against that baseline.
const DirtyGuard = (() => {
  const MESSAGE = "Есть несохранённые изменения. Покинуть страницу без сохранения?";
  let getData = null;
  let clean = null;

  function arm(getter) {
    getData = getter;
    clean = JSON.stringify(getData()); // baseline: state at arm time
    window.addEventListener("beforeunload", (e) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  const markClean = () => { if (getData) clean = JSON.stringify(getData()); };
  const isDirty = () => !!getData && clean !== null && JSON.stringify(getData()) !== clean;

  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("nav.side-nav a");
    if (!a || !isDirty()) return;
    e.preventDefault();
    if (confirm(MESSAGE)) window.location.href = a.href;
  });

  return { arm, markClean, isDirty };
})();

const Api = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw await apiError(res);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
};

async function apiError(res) {
  try {
    const data = await res.json();
    return new Error(data.error || `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}

// ipv4CidrOverlap is a best-effort client-side hint for the same check
// internal/topology.Validate() performs authoritatively on save; it only
// understands IPv4 and silently skips anything else.
function ipv4CidrOverlap(a, b) {
  const parse = (cidr) => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
    if (!m) return null;
    const [, o1, o2, o3, o4, bits] = m.map(Number);
    const addr = (o1 << 24) | (o2 << 16) | (o3 << 8) | o4;
    const mask = bits === 0 ? 0 : ~0 << (32 - bits);
    return { base: addr & mask, mask };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  const commonMask = pa.mask & pb.mask;
  return (pa.base & commonMask) === (pb.base & commonMask);
}

// --- shared table-search helpers ---
// Client-side column search, ported from the rules page (which mirrors
// internal/rules/filter.go). Best-effort IPv4 only, like ipv4CidrOverlap.

function containsFold(s, sub) {
  return !sub || String(s || "").toLowerCase().includes(sub.toLowerCase());
}

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((v) => v > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function normPrefix(base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, bits };
}

function parsePrefix(s) {
  const i = s.indexOf("/");
  if (i < 0) return null;
  const base = parseIPv4(s.slice(0, i));
  const bits = Number(s.slice(i + 1));
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return normPrefix(base, bits);
}

// partialPrefix turns a partially typed address ("10.", "10.0", "10.0.0")
// into the implied CIDR block, so search matches before the full address
// is entered.
function partialPrefix(q) {
  let parts = q.split(".");
  if (parts.length > 4 || parts[0] === "") return null;
  if (parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  if (!parts.length) return null;
  const octets = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p) || Number(p) > 255 || (p.startsWith("0") && p.length > 1)) return null;
    octets.push(Number(p));
  }
  while (octets.length < 4) octets.push(0);
  return normPrefix(((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0, parts.length * 8);
}

function parseQueryPrefix(q) {
  if (!q.includes("/")) {
    const addr = parseIPv4(q);
    if (addr !== null) return normPrefix(addr, 32);
    return partialPrefix(q);
  }
  return parsePrefix(q);
}

function formatIPv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

const prefixContains = (p, addr) => (addr & p.mask) === p.base;
const prefixOverlap = (a, b) => {
  const common = a.mask & b.mask;
  return (a.base & common) === (b.base & common);
};

// matchPrefixQuery searches a table cell's values ("subnet-name", "cidr",
// "address") for a filter value: an IP/partial-IP/CIDR query is matched
// semantically against the parsed prefixes, anything else as a
// case-insensitive substring over the raw values.
function matchPrefixQuery(entries, q) {
  const query = (q || "").trim();
  if (!query) return true;
  const qp = parseQueryPrefix(query);
  if (!qp) return entries.some((e) => containsFold(e, query));
  const prefixes = entries.map(parsePrefix).filter(Boolean);
  return qp.bits === 32 // exact address: containment
    ? prefixes.some((p) => prefixContains(p, qp.base))
    : prefixes.some((p) => prefixOverlap(p, qp));
}

// matchSubnetMembers searches a subnet-membership cell (networks/sets
// pages) for a filter value: member names and their CIDRs as substrings,
// IP/partial-IP/CIDR queries semantically against the members' CIDRs.
function matchSubnetMembers(subnets, cidrOf, q) {
  const names = subnets || [];
  return matchPrefixQuery([...names, ...names.map((s) => cidrOf(s))], q);
}

const NAV_LINKS = [
  { id: "topology", href: "/ui/topology", label: "Топология" },
  { id: "subnets", href: "/ui/subnets", label: "Подсети" },
  { id: "networks", href: "/ui/networks", label: "Сети" },
  { id: "sets", href: "/ui/sets", label: "Наборы" },
  { id: "unions", href: "/ui/unions", label: "Объединения" },
  { id: "links", href: "/ui/links", label: "Связи" },
  { id: "rules", href: "/ui/rules", label: "Правила" },
  { id: "compile", href: "/ui/compile", label: "Компиляция" },
];

const svgOpen = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const NAV_ICONS = {
  topology: svgOpen + '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 7l3.5 9M17 7l-3.5 9M7 6h10"/></svg>',
  subnets: svgOpen + '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  networks: svgOpen + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/></svg>',
  sets: svgOpen + '<path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  unions: svgOpen + '<rect x="3" y="3" width="12" height="12" rx="1"/><rect x="9" y="9" width="12" height="12" rx="1"/></svg>',
  links: svgOpen + '<path d="M10 14a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 5.93"/><path d="M14 10a5 5 0 0 0-7.07 0l-2.12 2.12a5 5 0 0 0 7.07 7.07L13 18.07"/></svg>',
  rules: svgOpen + '<path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z"/></svg>',
  compile: svgOpen + '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
};

// buildNav renders the shared sidebar shell (brand, collapsible nav with
// icons, theme toggle, banner host). The collapsed state is kept in
// localStorage so it survives reloads and page switches.
function buildNav(active) {
  document.documentElement.dataset.theme =
    localStorage.getItem("firenet-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const aside = document.createElement("aside");
  aside.className = "sidebar";
  if (localStorage.getItem("firenet-sidebar") === "collapsed") aside.classList.add("collapsed");

  const brand = document.createElement("strong");
  const full = document.createElement("span");
  full.className = "brand-full";
  full.textContent = "firenet";
  const short = document.createElement("span");
  short.className = "brand-short";
  short.textContent = "F";
  brand.append(full, short);
  aside.append(brand);

  const nav = document.createElement("nav");
  nav.className = "side-nav";
  NAV_LINKS.forEach((l) => {
    const a = document.createElement("a");
    a.href = l.href;
    a.title = l.label;
    if (l.id === active) a.className = "active";
    const ic = document.createElement("span");
    ic.className = "icon";
    ic.innerHTML = NAV_ICONS[l.id] || "";
    const lb = document.createElement("span");
    lb.className = "label";
    lb.textContent = l.label;
    a.append(ic, lb);
    nav.append(a);
  });
  aside.append(nav);

  const toggle = document.createElement("button");
  toggle.className = "sidebar-toggle";
  toggle.type = "button";
  toggle.title = "Свернуть/развернуть меню";
  toggle.setAttribute("aria-label", "Свернуть/развернуть меню");
  toggle.innerHTML =
    svgOpen + '<polyline points="15 18 9 12 15 6"/></svg>';
  toggle.addEventListener("click", () => {
    const collapsed = !aside.classList.contains("collapsed");
    aside.classList.toggle("collapsed", collapsed);
    localStorage.setItem("firenet-sidebar", collapsed ? "collapsed" : "open");
  });
  aside.append(toggle);

  const btn = document.createElement("button");
  btn.id = "theme-toggle";
  btn.className = "theme-toggle";
  btn.type = "button";
  btn.title = "Переключить тему";
  btn.setAttribute("aria-label", "Переключить тему");
  btn.innerHTML =
    '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="4"></circle>' +
    '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>' +
    '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("firenet-theme", next);
  });
  aside.append(btn);

  const banner = document.createElement("div");
  banner.id = "error-banner";
  banner.className = "banner";
  banner.setAttribute(":class", "banner.kind");
  banner.setAttribute("x-show", "banner.show");
  banner.setAttribute("x-text", "banner.message");
  banner.setAttribute("x-cloak", "");
  document.body.append(banner);
  document.body.prepend(aside);
}

// Auto-init: every page declares its active nav item via <body data-nav="...">,
// so no page-specific script needs to remember to build the sidebar.
document.addEventListener("DOMContentLoaded", () => {
  const active = document.body.dataset.nav;
  if (active) buildNav(active);
});
