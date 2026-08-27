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

// --- draft context ---
// sessionStorage (not localStorage) so each browser tab can hold a
// different draft: a user editing draft A in one tab and draft B in
// another must not clobber each other's context.
const DRAFT_ID_KEY = "firenet-draft-id";

function currentDraftID() {
  return sessionStorage.getItem(DRAFT_ID_KEY) || null;
}

function setCurrentDraftID(id) {
  lastDraftRevision = null;
  if (id) sessionStorage.setItem(DRAFT_ID_KEY, id);
  else sessionStorage.removeItem(DRAFT_ID_KEY);
}

function isReadOnly() {
  return !currentDraftID();
}

// renderDraftBanner shows a persistent, page-wide indicator of whether
// this tab is viewing the read-only current version or editing inside a
// draft, with the action to switch. If the active draft no longer exists
// (deleted or confirmed from another tab), the tab drops back to read-only.
async function renderDraftBanner() {
  const banner = document.createElement("div");
  banner.className = "draft-banner";
  const draftID = currentDraftID();

  if (draftID) {
    let draft;
    try {
      draft = await Api.get(`/api/drafts/${draftID}`);
    } catch {
      setCurrentDraftID(null);
      window.location.reload();
      return;
    }
    banner.classList.add("draft-banner-editing");
    const text = document.createElement("span");
    text.textContent = `Черновик «${draft.name}» (${draft.status}).`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Вернуться к текущей версии";
    closeBtn.addEventListener("click", () => {
      setCurrentDraftID(null);
      window.location.reload();
    });
    banner.append(text, closeBtn);
  } else {
    const [version] = await Api.get("/api/versions?limit=1");
    banner.classList.add("draft-banner-readonly");
    const text = document.createElement("span");
    text.textContent = `Только чтение — версия ${version ? version.id : "—"}.`;
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "Открыть черновик";
    openBtn.addEventListener("click", async () => {
      const name = window.prompt("Имя черновика:");
      if (!name) return;
      try {
        const draft = await Api.post("/api/drafts", { name });
        setCurrentDraftID(draft.id);
        window.location.reload();
      } catch (e) {
        showBanner("Не удалось создать черновик: " + e.message);
      }
    });
    banner.append(text, openBtn);
  }

  document.body.prepend(banner);
}

// apiPath builds the URL for one project-data resource (e.g. "topology",
// or "link-exports?link=0&side=a"), routed through the active draft in
// this tab, or the read-only current version otherwise. Every page that
// reads/writes project data goes through this instead of a literal
// "/api/..." string, so there is exactly one place that knows the
// draft-vs-current routing rule.
function apiPath(suffix) {
  const draftID = currentDraftID();
  return draftID ? `/api/drafts/${draftID}/${suffix}` : `/api/versions/current/${suffix}`;
}

class ReadOnlyError extends Error {
  constructor() {
    super("Только чтение — откройте черновик, чтобы редактировать");
  }
}

// assertEditable is the one-line guard every save path calls first.
function assertEditable() {
  if (isReadOnly()) throw new ReadOnlyError();
}

// lastDraftRevision is the CAS token from the most recent draft response
// (GET or PUT) in this page load — attached to the next PUT automatically
// so callers never have to thread X-Draft-Revision through by hand.
let lastDraftRevision = null;

// loginRedirectURL builds the /login target for an unauthenticated
// request, preserving where the user was so they land back there after
// logging in. Guards against open redirects: only same-origin, absolute
// paths are honored as the "next" target.
function loginRedirectURL(pathname, search) {
  const target = pathname + search;
  const safe = target.startsWith("/") && !target.startsWith("//");
  return "/login" + (safe ? "?next=" + encodeURIComponent(target) : "");
}

async function redirectToLogin() {
  window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
  return new Promise(() => {}); // navigation is underway; never resolve
}

const Api = {
  async get(path) {
    const res = await fetch(path);
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    const rev = res.headers?.get("X-Draft-Revision");
    if (rev) lastDraftRevision = rev;
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
  async put(path, body) {
    const headers = { "Content-Type": "application/json" };
    if (lastDraftRevision) headers["X-Draft-Revision"] = lastDraftRevision;
    const res = await fetch(path, { method: "PUT", headers, body: JSON.stringify(body) });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    const rev = res.headers?.get("X-Draft-Revision");
    if (rev) lastDraftRevision = rev;
    return res.status === 204 ? null : res.json();
  },
  async delete(path) {
    const res = await fetch(path, { method: "DELETE" });
    if (res.status === 401) return redirectToLogin();
    if (!res.ok) throw await apiError(res);
    return res.status === 204 ? null : res.json();
  },
};

async function apiError(res) {
  let data = {};
  try { data = await res.json(); } catch {}
  const err = new Error(data.error || `HTTP ${res.status}`);
  err.status = res.status;
  err.data = data;
  return err;
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

// NAV_GROUPS defines the sidebar layout: collapsible sections with links
// plus standalone entries appended after the groups. Group ids double as
// localStorage keys ("firenet-nav-<id>"), link ids match <body data-nav>.
const NAV_GROUPS = [
  {
    id: "topology",
    label: "Топология",
    links: [
      { id: "topology", href: "/ui/topology", label: "Схема" },
      { id: "networks", href: "/ui/networks", label: "Сети" },
      { id: "unions", href: "/ui/unions", label: "Объединения" },
      { id: "links", href: "/ui/links", label: "Связи" },
    ],
  },
  {
    id: "firewall",
    label: "Firewall",
    links: [
      { id: "subnets", href: "/ui/subnets", label: "Подсети" },
      { id: "sets", href: "/ui/sets", label: "Наборы" },
      { id: "rules", href: "/ui/rules", label: "Правила" },
      { id: "compile", href: "/ui/compile", label: "Компиляция" },
    ],
  },
];

const NAV_STANDALONE = [
  { id: "diagnose", href: "/ui/diagnose", label: "Диагностика" },
  { id: "users", href: "/ui/users", label: "Пользователи" },
  { id: "drafts", href: "/ui/drafts", label: "Черновики" },
  { id: "history", href: "/ui/history", label: "История" },
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
  diagnose: svgOpen + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  users: svgOpen + '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 8a3 3 0 1 1 0 6"/><path d="M21 20c0-2.5-1.6-4.6-4-5.5"/></svg>',
  drafts: svgOpen + '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  history: svgOpen + '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 3"/></svg>',
};

// buildNav renders the shared sidebar shell (brand, collapsible nav with
// icons, theme toggle, banner host). The collapsed state is kept in
// localStorage so it survives reloads and page switches.
async function buildNav(active) {
  const me = await fetch("/api/me")
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);

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
  const makeLink = (l) => {
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
    return a;
  };
  NAV_GROUPS.forEach((g) => {
    const wrap = document.createElement("div");
    wrap.className = "nav-group";
    // The active page forces its group open; otherwise a group is open only
    // if it was explicitly expanded before.
    const open = g.links.some((l) => l.id === active)
      ? true
      : localStorage.getItem("firenet-nav-" + g.id) === "open";
    wrap.classList.toggle("closed", !open);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "nav-group-header";
    header.title = g.label;
    header.setAttribute("aria-label", "Свернуть/развернуть раздел «" + g.label + "»");
    const chev = document.createElement("span");
    chev.className = "icon chevron";
    chev.innerHTML = svgOpen + '<polyline points="9 18 15 12 9 6"/></svg>';
    const lb = document.createElement("span");
    lb.className = "label";
    lb.textContent = g.label;
    header.append(chev, lb);
    header.addEventListener("click", () => {
      const closed = !wrap.classList.contains("closed");
      wrap.classList.toggle("closed", closed);
      localStorage.setItem("firenet-nav-" + g.id, closed ? "closed" : "open");
    });
    wrap.append(header);

    const body = document.createElement("div");
    body.className = "nav-group-links";
    g.links.forEach((l) => body.append(makeLink(l)));
    wrap.append(body);
    nav.append(wrap);
  });
  NAV_STANDALONE
    .filter((l) => l.id !== "users" || me?.role === "admin")
    .forEach((l) => nav.append(makeLink(l)));
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

  const userBox = document.createElement("div");
  userBox.className = "user-box";
  const userName = document.createElement("span");
  userName.className = "user-name";
  const logoutBtn = document.createElement("button");
  logoutBtn.type = "button";
  logoutBtn.className = "logout-btn";
  logoutBtn.textContent = "Выйти";
  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  });
  userBox.append(userName, logoutBtn);
  aside.append(userBox);

  if (me) userName.textContent = me.username + (me.role === "admin" ? " · admin" : "");

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
  if (!document.body.dataset.noDraftBanner) {
    void renderDraftBanner().catch((e) => showBanner("Не удалось загрузить статус версии: " + e.message));
  }
});
