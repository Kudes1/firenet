"use strict";

// Networks page: table over topology.yaml networks; creation and deletion
// happen on the topology page, here one network at a time is edited in a
// native <dialog> modal. A subnet may belong to at most one network — the
// UI enforces that client-side, the server re-validates authoritatively
// on save.

const NETWORKS_COL_WIDTHS_KEY = "firenet-networks-col-widths-v1";
const NETWORKS_COL_WIDTHS_VERSION = 1;

document.addEventListener("alpine:init", () => {
  Alpine.data("networksPage", () => ({
    networks: [], // {name, subnets: [], description}
    subnets: [],
    loaded: false,
    saving: false,
    draft: { index: -1, name: "", subnets: [], description: "" },
    memberSearch: "",
    memberOpen: false,
    memberCursor: 0,
    filters: { name: "", subnets: "", description: "" },
    searchOpen: false,

    async init() {
      try {
        const [topo, doc] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
        this._topo = topo; // devices/links/attach are preserved verbatim on save
        this.networks = (topo.networks || []).map((n) => ({ name: n.name, subnets: [...(n.subnets || [])], description: n.description || "" }));
        this.subnets = doc.subnets || [];
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить сети: " + e.message);
      }
    },

    resetFilters() {
      this.filters = { name: "", subnets: "", description: "" };
    },

    get filteredNetworks() {
      const f = this.filters;
      return this.networks
        .map((net, index) => ({ index, net }))
        .filter(
          ({ net }) =>
            containsFold(net.name, f.name) &&
            containsFold(net.description, f.description) &&
            this.matchMembers(net.subnets, f.subnets)
        );
    },

    // matchMembers searches the network's subnet badges like the rules
    // page does: IP/partial-IP/CIDR queries match the members' CIDRs,
    // anything else is a name/CIDR substring.
    matchMembers(subnets, q) {
      return matchSubnetMembers(subnets, (s) => this.cidrOf(s), q);
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, NETWORKS_COL_WIDTHS_KEY, NETWORKS_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, NETWORKS_COL_WIDTHS_KEY, NETWORKS_COL_WIDTHS_VERSION);
    },

    ownerOf(subnetName, exceptIndex = -1) {
      const net = this.networks.find((n, i) => i !== exceptIndex && n.subnets.includes(subnetName));
      return net ? net.name : "";
    },

    cidrOf(subnetName) {
      const s = this.subnets.find((s) => s.name === subnetName);
      return s ? s.cidr : "";
    },

    openEdit(i) {
      this.draft = { index: i, name: this.networks[i].name, subnets: [...this.networks[i].subnets], description: this.networks[i].description };
      this.resetMemberSearch();
      this.$refs.dialog.showModal();
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    get draftHint() {
      if (!this.draft.name.trim()) return "Укажите имя сети";
      if (this.networks.some((n, i) => i !== this.draft.index && n.name === this.draft.name.trim())) {
        return `Имя ${this.draft.name.trim()} уже используется`;
      }
      return "";
    },

    // availableSubnets lists subnets that can be added to the network being
    // edited: not already in it, not owned by another network (single-segment
    // invariant) and matching the search box, if one is active.
    get availableSubnets() {
      const q = this.memberSearch.trim().toLowerCase();
      return this.subnets.filter(
        (s) =>
          !this.draft.subnets.includes(s.name) &&
          this.ownerOf(s.name, this.draft.index) === "" &&
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
      if (!subnetName || this.draft.subnets.includes(subnetName)) return;
      this.draft.subnets.push(subnetName);
      this.resetMemberSearch();
    },

    removeMember(subnetName) {
      this.draft.subnets = this.draft.subnets.filter((s) => s !== subnetName);
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const next = this.networks.slice();
      next[this.draft.index] = { name: this.draft.name.trim(), subnets: [...this.draft.subnets], description: (this.draft.description || "").trim() };
      this.saving = true;
      try {
        await this.persist(next);
        this.closeModal();
      } finally {
        this.saving = false;
      }
    },

    async removeNetwork(i) {
      if (!confirm(`Удалить сеть «${this.networks[i].name}»?`)) return;
      await this.persist(this.networks.filter((_, j) => j !== i));
    },

    async persist(next) {
      try {
        assertEditable();
        const doc = await Api.put(apiPath("topology"), {
          devices: this._topo.devices || [],
          links: this._topo.links || [],
          networks: next.map((n) => {
            const prev = (this._topo.networks || []).find((x) => x.name === n.name) || {};
            return { name: n.name, subnets: [...n.subnets].sort(), attach: prev.attach || [], ...(n.description ? { description: n.description } : {}) };
          }),
          sets: this._topo.sets || [],
          unions: this._topo.unions || [],
        });
        this._topo = doc;
        this.networks = (doc.networks || []).map((n) => ({ name: n.name, subnets: [...(n.subnets || [])], description: n.description || "" }));
        showBanner("Сети сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
  }));
});
