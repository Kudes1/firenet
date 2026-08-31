"use strict";

import { Api, showBanner, apiPath, assertEditable, containsFold } from "./common.js";
import { makeColumnsResizable, initializeColumns } from "./columns.js";

// Devices page: table over topology.yaml devices; creation and deletion
// of the device itself still start on the topology canvas (a device needs
// a layout position), but here one device at a time can be renamed, moved
// between unions or given a description, and deleted outright. Union
// membership is exclusive, mirroring the canvas's own drag-into-union
// behavior (setUnion in topology.js): assigning a device to a union first
// removes it from whichever union currently lists it.

const DEVICES_COL_WIDTHS_KEY = "firenet-devices-col-widths-v1";
const DEVICES_COL_WIDTHS_VERSION = 1;

document.addEventListener("alpine:init", () => {
  Alpine.data("devicesPage", () => ({
    devices: [], // {name, kind, description, union}
    unions: [], // raw topology unions, for the union <select> options
    loaded: false,
    saving: false,
    draft: { index: -1, name: "", description: "", union: "" },
    filters: { name: "", union: "", description: "" },
    searchOpen: false,

    async init() {
      try {
        const topo = await Api.get(apiPath("topology"));
        this._topo = topo; // links/networks/sets preserved verbatim on save
        this.unions = topo.unions || [];
        this.devices = (topo.devices || []).map((d) => ({
          name: d.name,
          kind: d.kind,
          description: d.description || "",
          union: this.unionOf(d.name),
        }));
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить устройства: " + e.message);
      }
    },

    unionOf(deviceName) {
      const u = this.unions.find((u) => (u.devices || []).includes(deviceName));
      return u ? u.name : "";
    },

    resetFilters() {
      this.filters = { name: "", union: "", description: "" };
    },

    get filteredDevices() {
      const f = this.filters;
      return this.devices
        .map((device, index) => ({ index, device }))
        .filter(
          ({ device }) =>
            containsFold(device.name, f.name) &&
            containsFold(device.union, f.union) &&
            containsFold(device.description, f.description)
        );
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, DEVICES_COL_WIDTHS_KEY, DEVICES_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, DEVICES_COL_WIDTHS_KEY, DEVICES_COL_WIDTHS_VERSION);
    },

    openEdit(i) {
      const d = this.devices[i];
      this.draft = { index: i, name: d.name, description: d.description, union: d.union };
      this.$refs.dialog.showModal();
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    get draftHint() {
      if (!this.draft.name.trim()) return "Укажите имя устройства";
      if (this.devices.some((d, i) => i !== this.draft.index && d.name === this.draft.name.trim())) {
        return `Имя ${this.draft.name.trim()} уже используется`;
      }
      return "";
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const previous = this.devices[this.draft.index];
      const name = this.draft.name.trim();
      const description = this.draft.description.trim();
      const target = this.draft.union;

      const operations = [
        { kind: "update-device", deviceName: previous.name, device: { name, kind: previous.kind, ...(description ? { description } : {}) } },
      ];
      if (previous.union && previous.union !== target) {
        operations.push({ kind: "union-remove-device", unionName: previous.union, deviceName: name });
      }
      if (target && target !== previous.union) {
        operations.push({ kind: "union-add-device", unionName: target, deviceName: name });
      }

      this.saving = true;
      try {
        assertEditable();
        const snapshot = await Api.post(apiPath("topology/operations/batch"), { operations });
        this._topo = snapshot.topology;
        this.unions = snapshot.topology.unions || [];
        this.devices = (snapshot.topology.devices || []).map((d) => ({
          name: d.name,
          kind: d.kind,
          description: d.description || "",
          union: this.unionOf(d.name),
        }));
        showBanner("Устройство сохранено", "ok");
        this.closeModal();
      } catch (e) {
        showBanner("Ошибка сохранения: " + e.message);
      } finally {
        this.saving = false;
      }
    },

    async removeDevice(i) {
      if (!confirm(`Удалить устройство «${this.devices[i].name}»?`)) return;
      try {
        assertEditable();
        const snapshot = await Api.post(apiPath("topology/operations"), { kind: "delete-device", deviceName: this.devices[i].name });
        this._topo = snapshot.topology;
        this.unions = snapshot.topology.unions || [];
        this.devices = (snapshot.topology.devices || []).map((d) => ({
          name: d.name,
          kind: d.kind,
          description: d.description || "",
          union: this.unionOf(d.name),
        }));
        showBanner("Устройство удалено", "ok");
      } catch (e) {
        showBanner("Ошибка удаления: " + e.message);
      }
    },
  }));
});
