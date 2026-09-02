"use strict";

import { Api, showBanner, apiPath, containsFold, parseQueryPrefix, parsePrefix, prefixContains, prefixOverlap } from "./common.js";

// Search page: one client-side query across every project entity. The
// server (/api/.../search-index) provides the flat entry list; this module
// only filters it. An IP/partial-IP/CIDR query is matched semantically
// against each entry's prefixes (same rules as the per-table searches);
// anything else as a case-insensitive substring over name/details/
// description.

const TYPE_LABELS = {
  device: "Устройство",
  subnet: "Подсеть",
  network: "Сеть",
  set: "Набор",
  union: "Объединение",
  link: "Связь",
  rule: "Правило",
};

const HREFS = {
  device: "/ui/devices",
  subnet: "/ui/subnets",
  network: "/ui/networks",
  set: "/ui/sets",
  union: "/ui/unions",
  link: "/ui/links",
  rule: "/ui/rules",
};

// matchEntry applies one query to one index entry: parsed IP/partial-IP/
// CIDR queries against the entry's prefixes, everything else as a fold
// substring over its text fields.
function matchEntry(e, qp, q) {
  if (qp) {
    const prefixes = (e.prefixes || []).map(parsePrefix).filter(Boolean);
    return qp.bits === 32 // exact address: containment
      ? prefixes.some((p) => prefixContains(p, qp.base))
      : prefixes.some((p) => prefixOverlap(p, qp));
  }
  return containsFold(e.name, q) || containsFold(e.details, q) || containsFold(e.description, q);
}

document.addEventListener("alpine:init", () => {
  Alpine.data("searchPage", () => ({
    q: "",
    type: "all",
    loaded: false,
    entries: [],

    async init() {
      this.q = new URLSearchParams(window.location.search).get("q") || "";
      try {
        this.entries = await Api.get(apiPath("search-index"));
        this.loaded = true;
      } catch (e) {
        showBanner("Не удалось загрузить данные для поиска: " + e.message);
      }
    },

    get results() {
      const q = this.q.trim();
      const qp = q ? parseQueryPrefix(q) : null;
      const matched = !q ? this.entries : this.entries.filter((e) => matchEntry(e, qp, q));
      const type = this.type;
      return (type === "all" ? matched : matched.filter((e) => e.type === type)).map((e) => ({
        ...e,
        typeLabel: TYPE_LABELS[e.type],
        href: HREFS[e.type],
      }));
    },
  }));
});
