"use strict";

// Subnets page: read-only table over subnets.yaml via /api/subnets;
// editing happens one record at a time in a native <dialog> modal.

const SUBNETS_COL_WIDTHS_KEY = "firenet-subnets-col-widths-v1";
const SUBNETS_COL_WIDTHS_VERSION = 1;

document.addEventListener("alpine:init", () => {
  Alpine.data("subnetsPage", () => ({
    rows: [], // {name, cidr, description, owner}
    loaded: false,
    saving: false,
    draft: { index: -1, name: "", cidr: "", description: "" },
    filters: { name: "", cidr: "", owner: "", description: "" },
    searchOpen: false,

    async init() {
      try {
        const [doc, topo] = await Promise.all([Api.get("/api/subnets"), Api.get("/api/topology")]);
        const owner = {};
        (topo.networks || []).forEach((n) => (n.subnets || []).forEach((s) => (owner[s] = n.name)));
        this.rows = (doc.subnets || []).map((s) => ({ name: s.name, cidr: s.cidr, description: s.description || "", owner: owner[s.name] || "" }));
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить подсети: " + e.message);
      }
    },

    resetFilters() {
      this.filters = { name: "", cidr: "", owner: "", description: "" };
    },

    get filteredRows() {
      const f = this.filters;
      return this.rows
        .map((row, index) => ({ index, row }))
        .filter(
          ({ row }) =>
            containsFold(row.name, f.name) &&
            containsFold(row.cidr, f.cidr) &&
            containsFold(row.owner, f.owner) &&
            containsFold(row.description, f.description)
        );
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, SUBNETS_COL_WIDTHS_KEY, SUBNETS_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, SUBNETS_COL_WIDTHS_KEY, SUBNETS_COL_WIDTHS_VERSION);
    },

    openAdd() {
      this.draft = { index: -1, name: "", cidr: "", description: "" };
      this.$refs.dialog.showModal();
    },

    openEdit(i) {
      this.draft = { index: i, name: this.rows[i].name, cidr: this.rows[i].cidr, description: this.rows[i].description };
      this.$refs.dialog.showModal();
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    get draftHint() {
      const { index, name, cidr } = this.draft;
      if (!name.trim() || !cidr.trim()) return "Заполните имя и CIDR";
      if (this.rows.some((r, i) => i !== index && r.name === name.trim())) return `Имя ${name.trim()} уже используется`;
      const overlap = this.rows.find((r, i) => i !== index && ipv4CidrOverlap(r.cidr, cidr.trim()));
      if (overlap) return `Пересекается с ${overlap.name} (${overlap.cidr})`;
      return "";
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const entry = { name: this.draft.name.trim(), cidr: this.draft.cidr.trim(), description: (this.draft.description || "").trim() };
      const next = this.rows.slice();
      if (this.draft.index >= 0) next[this.draft.index] = { ...entry, owner: next[this.draft.index].owner };
      else next.push({ ...entry, owner: "" });
      this.saving = true;
      try {
        await this.persist(next);
        this.closeModal();
      } finally {
        this.saving = false;
      }
    },

    async removeRow(i) {
      if (!confirm(`Удалить подсеть «${this.rows[i].name}»?`)) return;
      await this.persist(this.rows.filter((_, j) => j !== i));
    },

    async persist(next) {
      try {
        const doc = await Api.put("/api/subnets", { subnets: next.map(({ name, cidr, description }) => ({ name, cidr, ...(description ? { description } : {}) })) });
        const owner = {};
        const topo = await Api.get("/api/topology");
        (topo.networks || []).forEach((n) => (n.subnets || []).forEach((s) => (owner[s] = n.name)));
        this.rows = doc.subnets.map((s) => ({ name: s.name, cidr: s.cidr, description: s.description || "", owner: owner[s.name] || "" }));
        showBanner("Подсети сохранены", "ok");
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      }
    },
  }));
});
