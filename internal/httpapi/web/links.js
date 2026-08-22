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

    async init() {
      try {
        const [topo, subs] = await Promise.all([Api.get("/api/topology"), Api.get("/api/subnets")]);
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

    entityGroups() {
      return [
        { label: "Сети", names: this.networks.map((n) => n.name) },
        { label: "Подсети", names: this.subnets.map((s) => s.name) },
      ];
    },

    pairLabel(i) {
      const l = this.links[i];
      return l ? `${l.a.device} – ${l.b.device}` : "";
    },

    openEdit(i) {
      const f = this.links[i].filter;
      this.draft = { index: i, aExports: f ? [...f.aExports] : [], bExports: f ? [...f.bExports] : [] };
      this.$refs.dialog.showModal();
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
        const doc = await Api.put("/api/topology", {
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
