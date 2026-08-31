"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Minimal DOM stub to run common.js outside a browser and exercise the
// sidebar shell built by buildNav.
function makeEl(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    className: "",
    classList: {
      add(c) { if (!el.className.split(" ").includes(c)) el.className += (el.className ? " " : "") + c; },
      remove(c) { el.className = el.className.split(" ").filter((x) => x !== c).join(" "); },
      contains(c) { return el.className.split(" ").includes(c); },
      toggle(c, force) {
        const has = this.contains(c);
        if (force === undefined ? !has : force) this.add(c);
        else this.remove(c);
      },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...cs) { cs.forEach((c) => { c.parent = this; this.children.push(c); }); },
    prepend(...cs) { cs.reverse().forEach((c) => { c.parent = this; this.children.unshift(c); }); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
  };
  return el;
}

async function loadCommon(store, me) {
  const doc = makeEl("#document");
  doc.body = makeEl("body");
  doc.documentElement = { dataset: {} };
  doc.createElement = (tag) => makeEl(tag);
  global.document = doc;
  global.window = { addEventListener() {}, location: { href: "" } };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class {};
  global.confirm = () => false;
  global.fetch = () => Promise.resolve(me ? { ok: true, json: () => Promise.resolve(me) } : { ok: false });
  const { buildNav } = await import(path.join(__dirname, "common.js") + `?t=${Date.now()}-${Math.random()}`);
  return { buildNav, doc };
}

(async () => {

function fire(target, type, ev = {}) {
  ev.type = type;
  ev.target = ev.target || target;
  (target.listeners[type] || []).forEach((fn) => fn(ev));
}

const byTag = (root, tag) => root.children.filter((c) => c.tag === tag);

const label = (a) => a.children[a.children.length - 1].textContent;

test("buildNav renders an aside.sidebar with brand, groups and nav links", async () => {
  const { buildNav, doc } = await loadCommon({}, { username: "root", role: "admin" });
  await buildNav("rules");

  const aside = doc.body.children[0];
  assert.equal(aside.tag, "aside", "shell is an aside element");
  assert.ok(aside.classList.contains("sidebar"), "aside has .sidebar class");

  const nav = byTag(aside, "nav")[0];
  assert.ok(nav, "sidebar contains a nav");

  const groups = byTag(nav, "div").filter((d) => String(d.className).split(" ").includes("nav-group"));
  assert.equal(groups.length, 2, "two groups: Топология and Firewall");
  const header = (g) => byTag(g, "button").find((b) => b.classList.contains("nav-group-header"));
  assert.equal(label(header(groups[0])), "Топология");
  assert.equal(label(header(groups[1])), "Firewall");

  const links = (root) => {
    const acc = [];
    const walk = (n) => n.children.forEach((c) => (c.tag === "a" ? acc.push(c) : walk(c)));
    walk(root);
    return acc;
  };
  const navLinks = links(nav);
  assert.equal(navLinks.length, 13, "all sections are linked");
  const groupLinks = (g) => links(g).map(label);
  assert.deepEqual(groupLinks(groups[0]), ["Схема", "Устройства", "Сети", "Объединения", "Связи"]);
  assert.deepEqual(groupLinks(groups[1]), ["Подсети", "Наборы", "Правила", "Компиляция"]);
  assert.deepEqual(
    navLinks.slice(-4).map(label),
    ["Диагностика", "Пользователи", "Черновики", "История"],
    "standalone links after the groups",
  );

  assert.equal(
    label(navLinks.find((a) => String(a.className).split(" ").includes("active"))),
    "Правила",
    "active section is highlighted",
  );

  assert.ok(byTag(aside, "button").some((b) => b.classList.contains("sidebar-toggle")), "collapse toggle exists");
});

test("buildNav hides the users link for a non-admin", async () => {
  const { buildNav, doc } = await loadCommon({}, { username: "alice", role: "user" });
  await buildNav("rules");

  const nav = byTag(doc.body.children[0], "nav")[0];
  const links = (root) => {
    const acc = [];
    const walk = (n) => n.children.forEach((c) => (c.tag === "a" ? acc.push(c) : walk(c)));
    walk(root);
    return acc;
  };
  assert.ok(!links(nav).some((a) => label(a) === "Пользователи"));
});

test("group header toggles the group and persists the state", async () => {
  const store = {};
  const { buildNav, doc } = await loadCommon(store, { username: "root", role: "admin" });
  await buildNav("topology");

  const nav = byTag(doc.body.children[0], "nav")[0];
  const group = byTag(nav, "div").find((d) => String(d.className).split(" ").includes("nav-group"));
  const header = byTag(group, "button").find((b) => b.classList.contains("nav-group-header"));

  fire(header, "click");
  assert.ok(group.classList.contains("closed"), "group collapses on header click");
  assert.equal(store["firenet-nav-topology"], "closed", "closed state is stored");

  fire(header, "click");
  assert.ok(!group.classList.contains("closed"), "group expands back");
  assert.notEqual(store["firenet-nav-topology"], "closed", "open state is stored");
});

test("group with the active link is expanded regardless of the stored state", async () => {
  const store = { "firenet-nav-firewall": "closed" };
  const { buildNav, doc } = await loadCommon(store, { username: "root", role: "admin" });
  await buildNav("rules");

  const nav = byTag(doc.body.children[0], "nav")[0];
  const groups = byTag(nav, "div").filter((d) => String(d.className).split(" ").includes("nav-group"));
  assert.ok(!groups[1].classList.contains("closed"), "active group is expanded");
  assert.ok(groups[0].classList.contains("closed"), "inactive group stays collapsed");
});

test("toggle collapses the sidebar and persists the state", async () => {
  const store = {};
  const { buildNav, doc } = await loadCommon(store, { username: "root", role: "admin" });
  await buildNav("topology");

  const aside = doc.body.children[0];
  const toggle = byTag(doc.body.children[0], "button").find((b) => b.classList.contains("sidebar-toggle"));

  fire(toggle, "click");
  assert.ok(aside.classList.contains("collapsed"), "sidebar collapses on click");
  assert.equal(store["firenet-sidebar"], "collapsed", "collapsed state is stored");

  fire(toggle, "click");
  assert.ok(!aside.classList.contains("collapsed"), "sidebar expands back");
  assert.notEqual(store["firenet-sidebar"], "collapsed", "expanded state is stored");
});

test("collapsed state is restored on load", async () => {
  const { buildNav, doc } = await loadCommon({ "firenet-sidebar": "collapsed" }, { username: "root", role: "admin" });
  await buildNav("topology");
  assert.ok(doc.body.children[0].classList.contains("collapsed"), "sidebar starts collapsed");
});

test("brand keeps its height when collapsed by swapping the label for a short letter", async () => {
  const { buildNav, doc } = await loadCommon({}, { username: "root", role: "admin" });
  await buildNav("topology");

  const brand = byTag(doc.body.children[0], "strong")[0];
  const full = brand.children.find((s) => s.className === "brand-full");
  const short = brand.children.find((s) => s.className === "brand-short");
  assert.equal(full.textContent, "firenet", "full brand name in expanded state");
  assert.equal(short.textContent, "F", "single letter in collapsed state");
});
})();
