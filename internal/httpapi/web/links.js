"use strict";

// Links page: table over topology.yaml links. A regular link can convert
// to a filtered one (per-side export lists of networks/subnets) and back.
// The canvas creates plain links only; conversion lives here. The server
// re-validates authoritatively on save.

document.addEventListener("alpine:init", () => {
  Alpine.data("linksPage", () => ({
    links: [], // {a:{device}, b:{device}, filter?:{aExports:[], bExports:[]}}
    networks: [],
    subnets: [],
    loaded: false,
    saving: false,
    draft: { index: -1, aExports: [], bExports: [] },
    combo: { side: "", search: "", cursor: 0 },
    // Export candidates per side, served by /api/link-exports with the
    // edited link excluded: only entities reachable from that device.
    candidates: { a: [], b: [] },
    filters: { devices: "", mode: "", aExports: "", bExports: "" },
    searchOpen: false,

    async init() {
      try {
        const [topo, subs] = await Promise.all([Api.get(apiPath("topology")), Api.get(apiPath("subnets"))]);
        this._topo = topo;
        this.subnets = subs.subnets || [];
        this.networks = topo.networks || [];
        this.links = (topo.links || []).map((l) => ({
          a: { device: l.a.device },
          b: { device: l.b.device },
          ...(l.filter ? { filter: { aExports: [...(l.filter.aExports || [])], bExports: [...(l.filter.bExports || [])] } } : {}),
        }));
        this.loaded = true;
      } catch (e) {
        showBanner("Не удалось загрузить связи: " + e.message);
      }
    },

    pairLabel(i) {
      const l = this.links[i];
      return l ? `${l.a.device} ↔ ${l.b.device}` : "";
    },

    resetFilters() {
      this.filters = { devices: "", mode: "", aExports: "", bExports: "" };
    },

    // exportMembers expands network exports into their subnet members, so
    // IP/partial-IP/CIDR queries match a network through its subnets too.
    exportMembers(list) {
      return (list || []).flatMap((e) => [e, ...(this.networks.find((n) => n.name === e)?.subnets || [])]);
    },

    // filteredLinks keeps the original index so row actions still target
    // the right link. Export columns match entity names as substrings and
    // IP/partial-IP/CIDR queries semantically against the subnets' CIDRs.
    get filteredLinks() {
      const f = this.filters;
      return this.links
        .map((link, index) => ({ index, link }))
        .filter(
          ({ link }) =>
            (containsFold(link.a.device, f.devices) || containsFold(link.b.device, f.devices)) &&
            containsFold(link.filter ? "фильтрованная" : "обычная", f.mode) &&
            matchSubnetMembers(this.exportMembers(link.filter?.aExports), (s) => this.cidrOf(s), f.aExports) &&
            matchSubnetMembers(this.exportMembers(link.filter?.bExports), (s) => this.cidrOf(s), f.bExports)
        );
    },

    // BIRD-like view helpers: each link side has an editable export list
    // and a read-only import list mirrored from the peer's exports.
    draftDevice(side) {
      const l = this.links[this.draft.index];
      return l ? l[side].device : "";
    },

    draftPeer(side) {
      return this.draftDevice(side === "a" ? "b" : "a");
    },

    importOf(side) {
      return side === "a" ? this.draft.bExports : this.draft.aExports;
    },

    cidrOf(name) {
      const s = this.subnets.find((s) => s.name === name);
      return s ? s.cidr : "";
    },

    // availableEntities lists the reachable candidates for one side:
    // already exported names are hidden and the search box, if active,
    // filters by name or CIDR substring (case-insensitive).
    availableEntities(side) {
      const q = this.combo.search.trim().toLowerCase();
      const taken = this.draft[side + "Exports"];
      return this.candidates[side].filter((e) => !taken.includes(e.name) && (!q || e.name.toLowerCase().includes(q) || (e.cidr || "").toLowerCase().includes(q)));
    },

    async loadCandidates(i) {
      try {
        const [a, b] = await Promise.all([Api.get(apiPath(`link-exports?link=${i}&side=a`)), Api.get(apiPath(`link-exports?link=${i}&side=b`))]);
        this.candidates = { a: a.entities || [], b: b.entities || [] };
      } catch (e) {
        this.candidates = { a: [], b: [] };
        showBanner("Не удалось загрузить доступные сети: " + e.message);
      }
    },

    openCombo(side) {
      if (this.combo.side === side) return; // refocus must keep the typed query
      this.combo = { side, search: "", cursor: 0 };
    },

    closeCombo() {
      this.combo = { side: "", search: "", cursor: 0 };
    },

    closeOther(side) {
      if (this.combo.side !== side) return;
      this.closeCombo();
    },

    moveCursor(delta) {
      const max = this.availableEntities(this.combo.side).length - 1;
      if (!this.combo.side || max < 0) return;
      this.combo.cursor = Math.min(Math.max(this.combo.cursor + delta, 0), max);
    },

    pickEntity() {
      const e = this.availableEntities(this.combo.side)[this.combo.cursor];
      if (e) this.addExport(this.combo.side, e.name);
    },

    addExport(side, name) {
      const key = side + "Exports";
      if (!name || this.draft[key].includes(name)) return;
      this.draft[key] = [...this.draft[key], name];
      this.closeCombo();
    },

    removeExport(side, name) {
      const key = side + "Exports";
      this.draft[key] = this.draft[key].filter((n) => n !== name);
    },

    async openEdit(i) {
      const f = this.links[i].filter;
      this.draft = { index: i, aExports: f ? [...f.aExports] : [], bExports: f ? [...f.bExports] : [] };
      this.closeCombo();
      this.$refs.dialog.showModal();
      await this.loadCandidates(i);
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    async saveDraft() {
      if (this.saving || this.draft.index < 0) return;
      const next = this.links.slice();
      next[this.draft.index] = { ...next[this.draft.index], filter: { aExports: [...this.draft.aExports], bExports: [...this.draft.bExports] } };
      this.saving = true;
      try {
        if (await this.persist(next)) this.closeModal();
      } finally {
        this.saving = false;
      }
    },

    async makeFiltered(i) {
      const next = this.links.slice();
      next[i] = { ...next[i], filter: { aExports: [], bExports: [] } };
      await this.persist(next);
    },

    async makePlain(i) {
      const next = this.links.map((l, j) => {
        if (j !== i) return l;
        const { filter, ...rest } = l;
        return rest;
      });
      await this.persist(next);
    },

    async persist(next) {
      try {
        assertEditable();
        const doc = await Api.put(apiPath("topology"), {
          devices: this._topo.devices || [],
          links: next.map((l) => ({
            a: { device: l.a.device },
            b: { device: l.b.device },
            ...(l.filter ? { filter: { aExports: [...l.filter.aExports], bExports: [...l.filter.bExports] } } : {}),
          })),
          networks: this._topo.networks || [],
          sets: this._topo.sets || [],
          unions: this._topo.unions || [],
        });
        this._topo = doc;
        this.links = (doc.links || []).map((l) => ({
          a: { device: l.a.device },
          b: { device: l.b.device },
          ...(l.filter ? { filter: { aExports: [...(l.filter.aExports || [])], bExports: [...(l.filter.bExports || [])] } } : {}),
        }));
        showBanner("Связи сохранены", "ok");
        return true;
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
        return false;
      }
    },
  }));
});
