"use strict";

// Rules page: client-side table over rules.yaml, mirroring the networks
// page. One <dialog> modal serves both create (draft.index === -1) and edit;
// every mutation persists the whole policy doc via PUT /api/rules, the
// server re-validates authoritatively. Column search ports the server-side
// semantics of internal/rules/filter.go: Src/Dst accept endpoint name
// substrings or IP/CIDR values matched against resolved subnet prefixes.

const RULES_COL_WIDTHS_KEY = "firenet-rules-col-widths-v4";
const RULES_COL_WIDTHS_VERSION = 4;

function splitPorts(s) {
  return (s || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// --- table search: IPv4 helpers live in common.js, shared with the
// subnets/networks/sets pages; only name resolution stays page-specific ---

function splitPorts(s) {
  return (s || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// parseEndpointPrefix validates a manually typed rule endpoint: an IPv4
// address (→ /32) or CIDR. Returns its canonical "addr[/bits]" form or null.
function parseEndpointPrefix(s) {
  s = (s || "").trim();
  const i = s.indexOf("/");
  if (i >= 0) {
    const p = parsePrefix(s);
    return p ? `${formatIPv4(p.base)}/${p.bits}` : null;
  }
  const addr = parseIPv4(s);
  return addr === null ? null : `${formatIPv4(addr)}/32`;
}

function registerRulesPage() {
  document.addEventListener("alpine:init", () => {
    Alpine.data("rulesPage", () => ({
    doc: { chains: [] },
    active: 0,
    subnets: [], // {name, cidr}
    networks: [], // {name, subnets}
    sets: [], // {name, subnets, addresses}
    settings: { name: "", defaultAction: "deny", chainPosition: "top" },
    filters: { name: "", comment: "", src: "", dst: "", proto: "", srcPorts: "", dstPorts: "", action: "" },
    draft: { index: -1, name: "", comment: "", src: [], dst: [], proto: "any", action: "deny", jumpTo: "", srcPorts: "", dstPorts: "", mirror: false },
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
    linting: false,
    lintOpen: false,
    lintFindings: [],
    highlightedRules: [],

    async init() {
      try {
        const [doc, topo, subnets] = await Promise.all([Api.get("/api/rules"), Api.get("/api/topology"), Api.get("/api/subnets")]);
        this._applyDoc(doc);
        this.networks = topo.networks || [];
        this.sets = topo.sets || [];
        this.subnets = subnets.subnets || [];
        this.loaded = true;
        this.$nextTick(() => this.initTable(this.$refs.table));
      } catch (e) {
        showBanner("Не удалось загрузить правила: " + e.message);
      }
    },

    get activeChain() { return this.doc.chains[this.active]; },
    get isPrimary() { return this.active === 0; },

    _applyDoc(doc) {
      this.doc = { chains: (doc.chains || []).map((c) => ({ ...c, rules: (c.rules || []).map((r) => ({ ...r })) })) };
      this._syncSettings();
    },

    _syncSettings() {
      const c = this.doc.chains[this.active];
      if (!c) return;
      this.settings = { name: c.name, defaultAction: c.defaultAction, chainPosition: c.chainPosition || "top" };
    },

    initTable(tableEl) {
      if (!tableEl || tableEl.dataset.columnsReady) return;
      tableEl.dataset.columnsReady = "1";
      initializeColumns(tableEl, RULES_COL_WIDTHS_KEY, RULES_COL_WIDTHS_VERSION);
      makeColumnsResizable(tableEl, RULES_COL_WIDTHS_KEY, RULES_COL_WIDTHS_VERSION);
    },

    get endpoints() {
      // "any", then subnets sorted, then sets sorted. Networks are
      // deliberately not offered (rules target subnets/sets/addresses);
      // they stay resolvable below for legacy rules and filtering.
      return [
        "any",
        ...this.subnets.map((s) => s.name).sort(),
        ...this.sets.map((s) => s.name).sort(),
      ];
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
      // A set contributes its member subnets' CIDRs plus its host addresses
      // as /32 entries, mirroring what the compiled ipset contains.
      const set = this.sets.find((x) => x.name === name);
      if (set) {
        for (const sn of set.subnets || []) {
          const x = this.subnets.find((y) => y.name === sn);
          if (x) cidrs.push(x.cidr);
        }
        for (const a of set.addresses || []) {
          const addr = a.split("/")[0];
          if (parseIPv4(addr) !== null) cidrs.push(`${addr}/32`);
        }
      }
      // A literally written endpoint matches by its own CIDR.
      if (!cidrs.length) {
        const lit = parseEndpointPrefix(name);
        if (lit) cidrs.push(lit);
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
      const chain = this.activeChain;
      if (!chain) return [];
      const f = this.filters;
      return chain.rules
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
      return { index: -1, name: "", comment: "", src: [], dst: [], proto: "any", action: "deny", jumpTo: "", srcPorts: "", dstPorts: "", mirror: false };
    },

    openAdd() {
      this.draft = this.emptyDraft();
      this.modalError = "";
      this.resetEndpointSearch();
      this.$refs.dialog.showModal();
    },

    openEdit(i) {
      const r = this.activeChain.rules[i];
      this.draft = {
        index: i,
        name: r.name,
        comment: r.comment || "",
        src: [...(r.src || [])],
        dst: [...(r.dst || [])],
        proto: r.proto || "any",
        action: r.action || "deny",
        jumpTo: r.jumpTo || "",
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
      const raw = this[field + "Search"].trim();
      const q = raw.toLowerCase();
      const selected = this.draft[field];
      const rest = this.endpoints.filter((e) => !selected.includes(e) && (!q || e.toLowerCase().includes(q)));
      // A fully typed address/CIDR is always addable for quick edits; it
      // leads the list so it is the first thing to see and pick.
      const lit = parseEndpointPrefix(raw);
      if (!lit || selected.includes(lit)) return rest;
      return [lit, ...rest.filter((e) => e !== lit)];
    },

    isLiteralEndpoint(e) {
      return parseEndpointPrefix(e) !== null;
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
      this[field + "Search"] = "";
      this[field + "Cursor"] = 0;
      this[field + "Open"] = false;
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
      if (this.activeChain.rules.some((r, i) => i !== d.index && r.name === d.name.trim())) {
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
      if (d.action === "jump") {
        if (!d.jumpTo) return "Выберите цепочку для перехода";
        if (d.jumpTo === this.activeChain.name) return "Цель перехода должна отличаться от текущей цепочки";
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
        jumpTo: d.action === "jump" ? d.jumpTo : "",
        mirror: d.mirror,
      };
      const rules = this.activeChain.rules.slice();
      if (d.index >= 0) rules[d.index] = rule;
      else rules.push(rule);
      const chains = this.doc.chains.slice();
      chains[this.active] = { ...chains[this.active], rules };
      this.saving = true;
      try {
        await this.persist({ chains });
        this.modalError = "";
        this.closeModal();
      } catch (e) {
        this.modalError = e.message; // keep the user's input for fixing
      } finally {
        this.saving = false;
      }
    },

    async removeRule(i) {
      if (!confirm(`Удалить правило «${this.activeChain.rules[i].name}»?`)) return;
      const chains = this.doc.chains.slice();
      chains[this.active] = { ...chains[this.active], rules: this.activeChain.rules.filter((_, j) => j !== i) };
      try {
        await this.persist({ chains });
      } catch (e) {
        showBanner("Ошибка удаления правила: " + e.message);
      }
    },

    async moveRule(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= this.activeChain.rules.length) return;
      const rules = this.activeChain.rules.slice();
      [rules[i], rules[j]] = [rules[j], rules[i]];
      const chains = this.doc.chains.slice();
      chains[this.active] = { ...chains[this.active], rules };
      try {
        await this.persist({ chains });
      } catch (e) {
        showBanner("Ошибка перемещения правила: " + e.message);
      }
    },

    addChain() {
      this.doc.chains.push({ name: "", defaultAction: "deny", rules: [] });
      this.active = this.doc.chains.length - 1;
      this.startEdit();
    },

    async removeChain(i) {
      if (i === 0) return;
      const name = this.doc.chains[i]?.name;
      const referenced = this.doc.chains.some((c) => c.rules.some((r) => r.action === "jump" && r.jumpTo === name));
      if (referenced) { showBanner("Цепочка используется действием jump — сначала уберите ссылки"); return; }
      if (!confirm(`Удалить цепочку «${name}»?`)) return;
      try {
        await this.persist({ chains: this.doc.chains.filter((_, j) => j !== i) });
        if (i < this.active) this.active -= 1;
        else if (this.active >= this.doc.chains.length) this.active = this.doc.chains.length - 1;
      } catch (e) {
        showBanner("Ошибка удаления цепочки: " + e.message);
      }
    },

    switchChain(i) { this.active = i; this.editing = false; this._syncSettings(); },

    // --- toolbar settings ---

    startEdit() {
      this._syncSettings();
      this.editing = true;
    },

    cancelEdit() {
      this.editing = false;
    },

    async saveSettings() {
      try {
        const chains = this.doc.chains.slice();
        chains[this.active] = { ...chains[this.active], name: this.settings.name.trim(), defaultAction: this.settings.defaultAction };
        if (this.isPrimary) chains[this.active].chainPosition = this.settings.chainPosition;
        await this.persist({ chains });
        this.editing = false;
      } catch (e) {
        showBanner("Ошибка сохранения параметров: " + e.message);
      }
    },

    async persist(next) {
      const doc = await Api.put("/api/rules", { chains: next.chains });
      this._applyDoc(doc);
      showBanner("Правила сохранены", "ok");
    },

    // --- lint ---

    async runLint() {
      this.linting = true;
      try {
        const res = await Api.get("/api/lint");
        this.lintFindings = res.findings || [];
        this.lintOpen = true;
      } catch (e) {
        showBanner("Ошибка проверки правил: " + e.message);
      } finally {
        this.linting = false;
      }
    },

    jumpToFinding(f) {
      const idx = this.doc.chains.findIndex((c) => c.name === f.chain);
      if (idx >= 0) this.switchChain(idx);
      this.highlightedRules = f.rules || [];
      clearTimeout(this._lintHighlightTimer);
      this._lintHighlightTimer = setTimeout(() => { this.highlightedRules = []; }, 2000);
    },
  }));
  });
}

if (typeof document !== "undefined") registerRulesPage();
