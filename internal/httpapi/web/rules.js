"use strict";

// Rules page: client-side table over rules.yaml, mirroring the networks
// page. One <dialog> modal serves both create (draft.index === -1) and edit;
// every mutation persists the whole policy doc via PUT /api/rules, the
// server re-validates authoritatively. Column search ports the server-side
// semantics of internal/rules/filter.go: Src/Dst accept endpoint name
// substrings or IP/CIDR values matched against resolved subnet prefixes.

const RULES_COL_WIDTHS_KEY = "firenet-rules-col-widths-v4";
const RULES_COL_WIDTHS_VERSION = 4;

function formatChainPosition(pos) {
  return pos === "bottom" ? "в конец FORWARD" : "в начало FORWARD";
}

function formatChainName(name) {
  return name && name.trim() ? name.trim() : "FIRENET-FWD";
}

function splitPorts(s) {
  return (s || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function containsFold(s, sub) {
  return !sub || String(s || "").toLowerCase().includes(sub.toLowerCase());
}

// --- IPv4 prefix matching (best-effort, IPv4 only, like common.js helpers) ---

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((v) => v > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function normPrefix(base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, bits };
}

function parsePrefix(s) {
  const i = s.indexOf("/");
  if (i < 0) return null;
  const base = parseIPv4(s.slice(0, i));
  const bits = Number(s.slice(i + 1));
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return normPrefix(base, bits);
}

// partialPrefix turns a partially typed address ("10.", "10.0", "10.0.0")
// into the implied CIDR block, so search matches before the full address
// is entered.
function partialPrefix(q) {
  let parts = q.split(".");
  if (parts.length > 4 || parts[0] === "") return null;
  if (parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  if (!parts.length) return null;
  const octets = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p) || Number(p) > 255 || (p.startsWith("0") && p.length > 1)) return null;
    octets.push(Number(p));
  }
  while (octets.length < 4) octets.push(0);
  return normPrefix(((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0, parts.length * 8);
}

function parseQueryPrefix(q) {
  if (!q.includes("/")) {
    const addr = parseIPv4(q);
    if (addr !== null) return normPrefix(addr, 32);
    return partialPrefix(q);
  }
  return parsePrefix(q);
}

const prefixContains = (p, addr) => (addr & p.mask) === p.base;
const prefixOverlap = (a, b) => {
  const common = a.mask & b.mask;
  return (a.base & common) === (b.base & common);
};

function registerRulesPage() {
  document.addEventListener("alpine:init", () => {
    Alpine.data("rulesPage", () => ({
    doc: { defaultAction: "deny", chainName: "", chainPosition: "top", rules: [] },
    subnets: [], // {name, cidr}
    networks: [], // {name, subnets}
    settings: { defaultAction: "deny", chainName: "", chainPosition: "top" },
    filters: { name: "", comment: "", src: "", dst: "", proto: "", srcPorts: "", dstPorts: "", action: "" },
    draft: { index: -1, name: "", comment: "", src: [], dst: [], proto: "any", action: "deny", srcPorts: "", dstPorts: "", mirror: false },
    srcSearch: "",
    srcOpen: false,
    srcCursor: 0,
    dstSearch: "",
    dstOpen: false,
    dstCursor: 0,
    modalError: "",
    loaded: false,
    saving: false,
    editing: false,
    searchOpen: false,

    async init() {
      try {
        const [doc, topo, subnets] = await Promise.all([Api.get("/api/rules"), Api.get("/api/topology"), Api.get("/api/subnets")]);
        this._applyDoc(doc);
        this.networks = topo.networks || [];
        this.subnets = subnets.subnets || [];
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить правила: " + e.message);
      }
    },

    _applyDoc(doc) {
      this.doc = {
        defaultAction: doc.defaultAction || "deny",
        chainName: doc.chainName || "",
        chainPosition: doc.chainPosition || "top",
        rules: (doc.rules || []).map((r) => ({ ...r })),
      };
      this.settings = {
        defaultAction: this.doc.defaultAction,
        chainName: this.doc.chainName,
        chainPosition: this.doc.chainPosition,
      };
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, RULES_COL_WIDTHS_KEY, RULES_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, RULES_COL_WIDTHS_KEY, RULES_COL_WIDTHS_VERSION);
    },

    get endpoints() {
      // Same ordering as the former server-side endpointNames(): "any",
      // then subnets sorted, then networks sorted.
      return ["any", ...this.subnets.map((s) => s.name).sort(), ...this.networks.map((n) => n.name).sort()];
    },

    resetFilters() {
      this.filters = { name: "", comment: "", src: "", dst: "", proto: "", srcPorts: "", dstPorts: "", action: "" };
    },

    resolvePrefixes(name) {
      const cidrs = [];
      const s = this.subnets.find((x) => x.name === name);
      if (s) cidrs.push(s.cidr);
      const n = this.networks.find((x) => x.name === name);
      if (n) for (const sn of n.subnets || []) {
        const x = this.subnets.find((y) => y.name === sn);
        if (x) cidrs.push(x.cidr);
      }
      return cidrs.map(parsePrefix).filter(Boolean);
    },

    matchEndpoints(names, q) {
      const query = (q || "").trim();
      if (!query) return true;
      const prefix = parseQueryPrefix(query);
      for (const n of names || []) {
        if (prefix) {
          if (n === "any") return true;
          const prefixes = this.resolvePrefixes(n);
          const hit =
            prefix.bits === 32 // exact address: containment
              ? prefixes.some((p) => prefixContains(p, prefix.base))
              : prefixes.some((p) => prefixOverlap(p, prefix));
          if (hit) return true;
        } else if (containsFold(n, query)) {
          return true;
        }
      }
      return false;
    },

    get filteredRules() {
      const f = this.filters;
      return this.doc.rules
        .map((rule, index) => ({ index, rule }))
        .filter(
          ({ rule }) =>
            containsFold(rule.name, f.name) &&
            containsFold(rule.comment, f.comment) &&
            containsFold(rule.proto, f.proto) &&
            containsFold((rule.srcPorts || []).join(","), f.srcPorts) &&
            containsFold((rule.dstPorts || []).join(","), f.dstPorts) &&
            containsFold(rule.action, f.action) &&
            this.matchEndpoints(rule.src, f.src) &&
            this.matchEndpoints(rule.dst, f.dst)
        );
    },

    // --- unified create/edit modal ---

    emptyDraft() {
      return { index: -1, name: "", comment: "", src: [], dst: [], proto: "any", action: "deny", srcPorts: "", dstPorts: "", mirror: false };
    },

    openAdd() {
      this.draft = this.emptyDraft();
      this.modalError = "";
      this.resetEndpointSearch();
      this.$refs.dialog.showModal();
    },

    openEdit(i) {
      const r = this.doc.rules[i];
      this.draft = {
        index: i,
        name: r.name,
        comment: r.comment || "",
        src: [...(r.src || [])],
        dst: [...(r.dst || [])],
        proto: r.proto || "any",
        action: r.action || "deny",
        srcPorts: (r.srcPorts || []).join(","),
        dstPorts: (r.dstPorts || []).join(","),
        mirror: !!r.mirror,
      };
      this.modalError = "";
      this.resetEndpointSearch();
      this.$refs.dialog.showModal();
    },

    // Endpoint combobox state per field ("src"/"dst"): <field>Search,
    // <field>Open, <field>Cursor — mirrors the networks member-combo.

    resetEndpointSearch() {
      for (const f of ["src", "dst"]) {
        this[f + "Search"] = "";
        this[f + "Open"] = false;
        this[f + "Cursor"] = 0;
      }
    },

    availableEndpoints(field) {
      const q = this[field + "Search"].trim().toLowerCase();
      const selected = this.draft[field];
      return this.endpoints.filter((e) => !selected.includes(e) && (!q || e.toLowerCase().includes(q)));
    },

    moveCursor(field, delta) {
      const max = this.availableEndpoints(field).length - 1;
      if (max < 0) return;
      const key = field + "Cursor";
      this[key] = Math.min(Math.max(this[key] + delta, 0), max);
    },

    pickCursor(field) {
      const e = this.availableEndpoints(field)[this[field + "Cursor"]];
      if (e) this.addEndpoint(field, e);
    },

    addEndpoint(field, name) {
      if (!name || this.draft[field].includes(name)) return;
      this.draft[field].push(name);
      this[field + "Search"] = ""; // keep the dropdown open for consecutive picks
      this[field + "Cursor"] = 0;
    },

    removeEndpoint(field, name) {
      this.draft[field] = this.draft[field].filter((e) => e !== name);
    },

    closeModal() {
      this.$refs.dialog.close();
    },

    get modalTitle() {
      return this.draft.index >= 0 ? "Изменить правило" : "Новое правило";
    },

    validPortSpec(spec) {
      const parts = spec.split("-");
      if (parts.length > 2) return false;
      const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
      if (nums.some((n) => !(n >= 1 && n <= 65535))) return false;
      return nums.length !== 2 || nums[0] < nums[1];
    },

    get draftHint() {
      const d = this.draft;
      if (!d.name.trim()) return "Укажите имя правила";
      if (this.doc.rules.some((r, i) => i !== d.index && r.name === d.name.trim())) {
        return `Имя ${d.name.trim()} уже используется`;
      }
      if (!d.src.length) return "Выберите хотя бы один Src";
      if (!d.dst.length) return "Выберите хотя бы один Dst";
      if ((d.srcPorts.trim() || d.dstPorts.trim()) && d.proto !== "tcp" && d.proto !== "udp") {
        return "Порты допустимы только для tcp/udp";
      }
      for (const spec of splitPorts(d.srcPorts).concat(splitPorts(d.dstPorts))) {
        if (!this.validPortSpec(spec)) return `Порты: неверный формат «${spec}» (ожидается порт или диапазон from-to)`;
      }
      return "";
    },

    async saveDraft() {
      if (this.draftHint || this.saving) return;
      const d = this.draft;
      const rule = {
        name: d.name.trim(),
        comment: d.comment.trim(),
        src: [...d.src],
        dst: [...d.dst],
        proto: d.proto,
        srcPorts: splitPorts(d.srcPorts),
        dstPorts: splitPorts(d.dstPorts),
        action: d.action,
        mirror: d.mirror,
      };
      const rules = this.doc.rules.slice();
      if (d.index >= 0) rules[d.index] = rule;
      else rules.push(rule);
      this.saving = true;
      try {
        await this.persist({ ...this.doc, rules });
        this.modalError = "";
        this.closeModal();
      } catch (e) {
        this.modalError = e.message; // keep the user's input for fixing
      } finally {
        this.saving = false;
      }
    },

    async removeRule(i) {
      if (!confirm(`Удалить правило «${this.doc.rules[i].name}»?`)) return;
      try {
        await this.persist({ ...this.doc, rules: this.doc.rules.filter((_, j) => j !== i) });
      } catch (e) {
        showBanner("Ошибка удаления правила: " + e.message);
      }
    },

    async moveRule(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= this.doc.rules.length) return;
      const rules = this.doc.rules.slice();
      [rules[i], rules[j]] = [rules[j], rules[i]];
      try {
        await this.persist({ ...this.doc, rules });
      } catch (e) {
        showBanner("Ошибка перемещения правила: " + e.message);
      }
    },

    // --- toolbar settings ---

    startEdit() {
      this.settings = { defaultAction: this.doc.defaultAction, chainName: this.doc.chainName, chainPosition: this.doc.chainPosition };
      this.editing = true;
    },

    cancelEdit() {
      this.editing = false;
    },

    async saveSettings() {
      try {
        await this.persist({ ...this.doc, ...this.settings });
        this.editing = false;
      } catch (e) {
        showBanner("Ошибка сохранения параметров: " + e.message);
      }
    },

    async persist(next) {
      const doc = await Api.put("/api/rules", {
        defaultAction: next.defaultAction,
        chainName: next.chainName,
        chainPosition: next.chainPosition,
        rules: next.rules,
      });
      this._applyDoc(doc);
      showBanner("Правила сохранены", "ok");
    },
  }));
  });
}

if (typeof document !== "undefined") registerRulesPage();
if (typeof module !== "undefined") module.exports = { formatChainPosition, formatChainName };
