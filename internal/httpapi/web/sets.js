"use strict";

import { Api, showBanner, apiPath, assertEditable, containsFold, matchPrefixQuery, matchSubnetMembers } from "./common.js";
import { makeColumnsResizable, initializeColumns } from "./columns.js";

// Sets page: read-only table over topology.yaml sets; editing happens one
// set at a time in a native <dialog> modal. A set mixes subnet references
// and individual host addresses into one ipset at compile time; the same
// subnet may appear in many sets. The server re-validates authoritatively
// on save.

const SETS_COL_WIDTHS_KEY = "firenet-sets-col-widths-v1";
const SETS_COL_WIDTHS_VERSION = 1;

// parseHostAddress accepts a bare IP or a host prefix (full-length mask)
// and returns its normalized string form, or "" if invalid.
function parseHostAddress(input) {
  const s = (input || "").trim();
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  if (slash < 0) return normalizeIP(s, isIPv4(s) ? 32 : 128) ? s : "";
  const bits = Number(s.slice(slash + 1));
  if (!Number.isInteger(bits)) return "";
  const addr = s.slice(0, slash);
  return normalizeIP(addr, bits) ? `${addr}/${bits}` : "";
}

function isIPv4(addr) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(addr);
}

function normalizeIP(addr, bits) {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    return bits === 32 && m.slice(1).every((oct) => Number(oct) <= 255) ? addr : "";
  }
  // Loose IPv6 check: hex groups and colons only, at least two colons.
  return bits === 128 && /^[0-9A-Fa-f:]+$/.test(addr) && (addr.match(/:/g) || []).length >= 2 ? addr : "";
}

document.addEventListener("alpine:init", () => {
  Alpine.data("setsPage", () => ({
    sets: [], // {name, subnets: [], addresses: [], description}
    subnets: [],
    loaded: false,
    saving: false,
    draft: { index: -1, name: "", subnets: [], addresses: [], description: "" },
    addressInput: "",
    memberSearch: "",
    memberOpen: false,
    memberCursor: 0,
    filters: { name: "", subnets: "", addresses: "", description: "" },
    searchOpen: false,

    async init() {
      try {
        const [topo, doc] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
        this._topo = topo; // devices/links/networks are preserved verbatim on save
        this.sets = (topo.sets || []).map((s) => ({ name: s.name, subnets: [...(s.subnets || [])], addresses: [...(s.addresses || [])], description: s.description || "" }));
        this.subnets = doc.subnets || [];
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить наборы: " + e.message);
      }
    },

    resetFilters() {
      this.filters = { name: "", subnets: "", addresses: "", description: "" };
    },

    get filteredSets() {
      const f = this.filters;
      return this.sets
        .map((set, index) => ({ index, set }))
        .filter(
          ({ set }) =>
            containsFold(set.name, f.name) &&
            containsFold(set.description, f.description) &&
            this.matchMembers(set.subnets, f.subnets) &&
            this.matchAddresses(set, f.addresses)
        );
    },

    // matchMembers searches the set's subnet badges like on the networks
    // page; matchAddresses does the same for the address badges.
    matchMembers(subnets, q) {
      return matchSubnetMembers(subnets, (s) => this.cidrOf(s), q);
    },

    // matchAddresses searches the set's address badges like the rules page
    // does: IP/partial-IP/CIDR queries are expanded and matched against
    // the addresses, anything else is a substring.
    matchAddresses(set, q) {
      const addrs = (set.addresses || []).map((a) => (a.includes("/") ? a : `${a.split("/")[0]}/32`));
      return matchPrefixQuery(addrs, q);
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, SETS_COL_WIDTHS_KEY, SETS_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, SETS_COL_WIDTHS_KEY, SETS_COL_WIDTHS_VERSION);
    },

    cidrOf(subnetName) {
      const s = this.subnets.find((s) => s.name === subnetName);
      return s ? s.cidr : "";
    },

    openAdd() {
      this.draft = { index: -1, name: "", subnets: [], addresses: [], description: "" };
      this.addressInput = "";
      this.resetMemberSearch();
      this.$refs.dialog.showModal();
    },

    openEdit(i) {
      const s = this.sets[i];
      this.draft = { index: i, name: s.name, subnets: [...s.subnets], addresses: [...s.addresses], description: s.description };
      this.addressInput = "";
      this.resetMemberSearch();
      this.$refs.dialog.showModal();
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    get draftHint() {
      if (!this.draft.name.trim()) return "Укажите имя набора";
      if (this.sets.some((s, i) => i !== this.draft.index && s.name === this.draft.name.trim())) {
        return `Имя ${this.draft.name.trim()} уже используется`;
      }
      if (!this.draft.subnets.length && !this.draft.addresses.length) {
        return "Добавьте минимум одну подсеть или адрес";
      }
      return "";
    },

    // availableSubnets lists subnets that can be added to the set being
    // edited: not already in it (the same subnet may belong to many sets)
    // and matching the search box, if one is active.
    get availableSubnets() {
      const q = this.memberSearch.trim().toLowerCase();
      return this.subnets.filter(
        (s) =>
          !this.draft.subnets.includes(s.name) &&
          (!q || s.name.toLowerCase().includes(q) || (s.cidr || "").toLowerCase().includes(q))
      );
    },

    resetMemberSearch() {
      this.memberSearch = "";
      this.memberOpen = false;
      this.memberCursor = 0;
    },

    moveCursor(delta) {
      const max = this.availableSubnets.length - 1;
      if (max < 0) return;
      this.memberCursor = Math.min(Math.max(this.memberCursor + delta, 0), max);
    },

    pickCursor() {
      const s = this.availableSubnets[this.memberCursor];
      if (s) this.addMember(s.name);
    },

    addMember(subnetName) {
      if (!subnetName || this.draft.subnets.includes(subnetName)) return false;
      this.draft.subnets.push(subnetName);
      this.resetMemberSearch();
      return true;
    },

    removeMember(subnetName) {
      this.draft.subnets = this.draft.subnets.filter((s) => s !== subnetName);
    },

    // addAddress parses the address box; on success the normalized value
    // joins the draft. Returns whether it was accepted so the input can
    // flash invalid state.
    addAddress() {
      const normalized = parseHostAddress(this.addressInput);
      if (!normalized) return false;
      const bare = normalized.split("/")[0];
      if (this.draft.addresses.some((a) => a.split("/")[0] === bare)) return false;
      this.draft.addresses.push(normalized);
      this.addressInput = "";
      return true;
    },

    removeAddress(address) {
      this.draft.addresses = this.draft.addresses.filter((a) => a !== address);
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const entry = {
        name: this.draft.name.trim(),
        subnets: [...this.draft.subnets].sort(),
        addresses: [...this.draft.addresses],
        description: (this.draft.description || "").trim(),
      };
      const next = this.sets.slice();
      if (this.draft.index >= 0) next[this.draft.index] = entry;
      else next.push(entry);
      this.saving = true;
      try {
        await this.persist(next);
        this.closeModal();
      } finally {
        this.saving = false;
      }
    },

    async removeSet(i) {
      if (!confirm(`Удалить набор «${this.sets[i].name}»?`)) return;
      await this.persist(this.sets.filter((_, j) => j !== i));
    },

    async persist(next) {
      try {
        assertEditable();
        const doc = await Api.put(apiPath("topology"), {
          devices: this._topo.devices || [],
          links: this._topo.links || [],
          networks: this._topo.networks || [],
          unions: this._topo.unions || [],
          sets: next.map((s) => ({ name: s.name, subnets: [...s.subnets], addresses: [...s.addresses], ...(s.description ? { description: s.description } : {}) })),
        });
        this._topo = doc;
        this.sets = (doc.sets || []).map((s) => ({ name: s.name, subnets: [...(s.subnets || [])], addresses: [...(s.addresses || [])], description: s.description || "" }));
        showBanner("Наборы сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
  }));
});
