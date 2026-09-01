"use strict";

import { Api, showBanner, apiPath, assertEditable, containsFold, matchSubnetMembers } from "./common.js";
import * as Table from "./table.js";
import * as Combo from "./combo.js";

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
      return this.networks
        .map((net, index) => ({ index, net }))
        .filter(({ net }) => Table.matchAll(net, this.filters, {
          name: (n, q) => containsFold(n.name, q),
          description: (n, q) => containsFold(n.description, q),
          subnets: (n, q) => this.matchMembers(n.subnets, q),
        }));
    },

    // matchMembers searches the network's subnet badges like the rules
    // page does: IP/partial-IP/CIDR queries match the members' CIDRs,
    // anything else is a name/CIDR substring.
    matchMembers(subnets, q) {
      return matchSubnetMembers(subnets, (s) => this.cidrOf(s), q);
    },

    initTable(tableEl) {
      Table.initTable(tableEl, NETWORKS_COL_WIDTHS_KEY, NETWORKS_COL_WIDTHS_VERSION);
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

    // openNetworkEdit открывает плавающее окно редактирования сети на холсте
    // топологии (ПКМ по сети → «Редактировать»). Поведение дублирует openEdit
    // страницы «Сети»: тот же draft, те же подсети и saveDraft. Отличие —
    // открытие/позиционирование окна делегировано this._panel (см.
    // devicesPage.openDeviceEdit — тот же приём). На холсте topology.js
    // обновляет this.networks/this.subnets из текущего State перед вызовом,
    // так что черновик всегда строится по свежим данным.
    openNetworkEdit(name, at) {
      const i = this.networks.findIndex((n) => n.name === name);
      if (i < 0) return;
      this.draft = { index: i, name: this.networks[i].name, subnets: [...this.networks[i].subnets], description: this.networks[i].description };
      this.resetMemberSearch();
      this._panel.open(at);
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
      this.memberCursor = Combo.clampCursor(this.memberCursor, delta, this.availableSubnets.length);
    },

    pickCursor() {
      const s = Combo.pickAt(this.availableSubnets, this.memberCursor);
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

    // closeEditor закрывает открытый редактор: модальный диалог страницы
    // «Сети» или плавающее окно на холсте топологии — что из них примонтировано.
    closeEditor() {
      if (this.$refs.dialog) this.closeModal();
      else this._panel.close();
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const previous = this.networks[this.draft.index];
      const network = { name: this.draft.name.trim(), subnets: [...this.draft.subnets].sort(), ...(this.draft.description ? { description: this.draft.description.trim() } : {}) };
      this.saving = true;
      try {
        assertEditable();
        // Порт сохранения (холст топологии) уводит операцию в общую очередь
        // TopologySync канвы вместо отдельного POST — иначе канва не узнала бы
        // о переименовании до перезагрузки. Без порта (страница «Сети») —
        // прямой POST, как и раньше.
        const op = { kind: "update-network", networkName: previous.name, network };
        const snapshot = this._savePort ? await this._savePort(op) : await Api.post(apiPath("topology/operations"), op);
        this._topo = snapshot.topology;
        this.networks = (snapshot.topology.networks || []).map((n) => ({ name: n.name, subnets: [...(n.subnets || [])], description: n.description || "" }));
        showBanner("Сети сохранены", "ok");
        this.closeEditor();
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
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
