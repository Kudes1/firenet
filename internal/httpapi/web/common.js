"use strict";

// Shared page plumbing: Alpine app state, API helpers and the site header
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

const NAV_LINKS = [
  { id: "topology", href: "/ui/topology", label: "Топология" },
  { id: "subnets", href: "/ui/subnets", label: "Подсети" },
  { id: "networks", href: "/ui/networks", label: "Сети" },
  { id: "rules", href: "/ui/rules", label: "Правила" },
  { id: "compile", href: "/ui/compile", label: "Компиляция" },
];

// buildNav renders the shared header (brand, nav links, theme toggle,
// banner host) into #site-header. Call after DOM is parsed; Alpine binds
// via the body's x-data.
function buildNav(active) {
  document.documentElement.dataset.theme =
    localStorage.getItem("firenet-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const header = document.createElement("header");
  header.innerHTML = "<strong>firenet</strong>";

  const nav = document.createElement("nav");
  nav.className = "tabs";
  NAV_LINKS.forEach((l) => {
    const a = document.createElement("a");
    a.href = l.href;
    a.textContent = l.label;
    if (l.id === active) a.className = "active";
    nav.append(a);
  });
  header.append(nav);

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
  header.append(btn);

  const banner = document.createElement("div");
  banner.id = "error-banner";
  banner.className = "banner";
  banner.setAttribute(":class", "banner.kind");
  banner.setAttribute("x-show", "banner.show");
  banner.setAttribute("x-text", "banner.message");
  banner.setAttribute("x-cloak", "");
  document.body.append(banner);
  document.body.prepend(header);
}

// Auto-init: every page declares its active nav item via <body data-nav="...">,
// so no page-specific script needs to remember to build the header.
document.addEventListener("DOMContentLoaded", () => {
  const active = document.body.dataset.nav;
  if (active) buildNav(active);
});
