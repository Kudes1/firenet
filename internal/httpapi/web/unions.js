"use strict";

import { Api, showBanner, apiPath, assertEditable, containsFold, matchPrefixQuery } from "./common.js";
import { makeColumnsResizable, initializeColumns } from "./columns.js";

// Unions page: table over topology.yaml unions; editing happens one union
// at a time in a native <dialog> modal covering only name and description.
// Membership (devices/networks) is assigned exclusively on the topology
// canvas via its context menu, so this page renders member badges
// read-only. The server re-validates authoritatively on save.

const UNIONS_COL_WIDTHS_KEY = "firenet-unions-col-widths-v1";
const UNIONS_COL_WIDTHS_VERSION = 1;

document.addEventListener("alpine:init", () => {
  Alpine.data("unionsPage", () => ({
    unions: [], // {name, devices: [], networks: [], description}
    subnets: [], // {name, cidr} for IP/CIDR search over member networks
    loaded: false,
    saving: false,
    draft: { index: -1, name: "", description: "" },
    filters: { name: "", devices: "", networks: "", description: "" },
    searchOpen: false,

    async init() {
      try {
        const [topo, subnetsDoc] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
        this._topo = topo; // devices/links/networks/sets are preserved verbatim on save
        this.subnets = subnetsDoc.subnets || [];
        this.unions = (topo.unions || []).map((u) => ({ name: u.name, devices: [...(u.devices || [])], networks: [...(u.networks || [])], description: u.description || "" }));
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить объединения: " + e.message);
      }
    },

    resetFilters() {
      this.filters = { name: "", devices: "", networks: "", description: "" };
    },

    get filteredUnions() {
      const f = this.filters;
      // an empty member list only fails a non-empty search: a freshly
      // created union without devices/networks must stay visible
      const matchesAny = (list, q) => !q || (list || []).some((d) => containsFold(d, q));
      return this.unions
        .map((union, index) => ({ index, union }))
        .filter(
          ({ union }) =>
            containsFold(union.name, f.name) &&
            containsFold(union.description, f.description) &&
            matchesAny(union.devices, f.devices) &&
            (!f.networks || this.matchNetworks(union.networks, f.networks))
        );
    },

    // matchNetworks searches the union's network badges like the networks
    // page does for subnet badges: network names and their subnets' CIDRs
    // as substrings, IP/partial-IP/CIDR queries semantically against the
    // CIDRs (a network contributes the CIDRs of all its subnets).
    matchNetworks(networks, q) {
      const entries = [];
      for (const n of networks || []) {
        entries.push(n);
        const net = (this._topo.networks || []).find((x) => x.name === n);
        for (const sn of net?.subnets || []) {
          const s = this.subnets.find((x) => x.name === sn);
          if (s) entries.push(s.cidr);
        }
      }
      return matchPrefixQuery(entries, q);
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, UNIONS_COL_WIDTHS_KEY, UNIONS_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, UNIONS_COL_WIDTHS_KEY, UNIONS_COL_WIDTHS_VERSION);
    },

    openAdd() {
      this.draft = { index: -1, name: "", description: "" };
      this.$refs.dialog.showModal();
    },

    openEdit(i) {
      const u = this.unions[i];
      this.draft = { index: i, name: u.name, description: u.description };
      this.$refs.dialog.showModal();
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    get draftHint() {
      if (!this.draft.name.trim()) return "Укажите имя объединения";
      if (this.unions.some((u, i) => i !== this.draft.index && u.name === this.draft.name.trim())) {
        return `Имя ${this.draft.name.trim()} уже используется`;
      }
      return "";
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const entry = {
        name: this.draft.name.trim(),
        devices: [],
        networks: [],
        description: (this.draft.description || "").trim(),
      };
      const next = this.unions.slice();
      if (this.draft.index >= 0) next[this.draft.index] = { ...next[this.draft.index], name: entry.name, description: entry.description };
      else next.push(entry);
      this.saving = true;
      try {
        await this.persist(next);
        this.closeModal();
      } finally {
        this.saving = false;
      }
    },

    async removeUnion(i) {
      if (!confirm(`Удалить объединение «${this.unions[i].name}»?`)) return;
      await this.persist(this.unions.filter((_, j) => j !== i));
    },

    async persist(next) {
      try {
        assertEditable();
        const doc = await Api.put(apiPath("topology"), {
          devices: this._topo.devices || [],
          links: this._topo.links || [],
          networks: this._topo.networks || [],
          sets: this._topo.sets || [],
          unions: next.map((u) => ({ name: u.name, devices: [...u.devices], networks: [...u.networks], ...(u.description ? { description: u.description } : {}) })),
        });
        this._topo = doc;
        this.unions = (doc.unions || []).map((u) => ({ name: u.name, devices: [...(u.devices || [])], networks: [...(u.networks || [])], description: u.description || "" }));
        showBanner("Объединения сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
  }));
});
