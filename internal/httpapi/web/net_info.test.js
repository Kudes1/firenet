"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Minimal DOM stub sufficient to drive net_info.js outside a browser.
function makeEl(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...cs) { this.children.push(...cs); },
    remove() {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) {
      const list = this.listeners[t];
      if (list) this.listeners[t] = list.filter((f) => f !== fn);
    },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text || ""; },
  };
}

(async () => {
  const { NetInfo } = await import(path.join(__dirname, "net_info.js"));

  function boot() {
    const canvas = makeEl("svg");
    const box = makeEl("div");
    box.hidden = true;
    const doc = {
      readyState: "complete",
      listeners: {},
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => (id === "net-info" ? box : null),
      addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
    };
    global.document = doc;
    return { canvas, doc, box, NetInfo };
  }

  function fire(target, type, ev) {
    ev.type = type;
    if (!ev.target) ev.target = target;
    (target.listeners[type] || []).forEach((fn) => fn(ev));
  }

  function texts(node) {
    const out = [];
    (function walk(n) {
      if (n._text) out.push(String(n._text));
      (n.children || []).forEach(walk);
    })(node);
    return out;
  }

  const subnets = [
    { name: "office", cidr: "10.0.0.0/24" },
    { name: "guests", cidr: "10.0.1.0/24" },
  ];

  test("show lists member names with their CIDRs and opens the window", () => {
    const { box } = boot();
    NetInfo.show({ name: "net1", subnets: ["office", "guests"] }, subnets, { x: 200, y: 300 }, { w: 1200, h: 800 });
    assert.ok(!box.hidden, "window opened");
    assert.equal(texts(box)[0], "net1", "title is the network name");
    assert.ok(texts(box).includes("office") && texts(box).includes("10.0.0.0/24"), "member row rendered");
    assert.ok(texts(box).includes("guests") && texts(box).includes("10.0.1.0/24"), "second member row rendered");
  });

  test("show skips unknown subnet names and reports an empty network", () => {
    const { box } = boot();
    NetInfo.show({ name: "empty", subnets: [] }, subnets, { x: 0, y: 0 }, { w: 1200, h: 800 });
    assert.match(texts(box).join("|"), /\(нет подсетей\)/);
    NetInfo.show({ name: "net2", subnets: ["ghost"] }, subnets, { x: 0, y: 0 }, { w: 1200, h: 800 });
    assert.doesNotMatch(texts(box).join("|"), /ghost/, "unknown subnet dropped");
  });

  test("show clamps the window inside the canvas bounds", () => {
    const { box } = boot();
    NetInfo.show({ name: "net1", subnets: ["office"] }, subnets, { x: 5000, y: -50 }, { w: 1200, h: 800 });
    assert.equal(box.style.left, "920px");
    assert.equal(box.style.top, "8px");
  });

  test("hide closes the window; Escape hides it too", () => {
    const { canvas, box, doc } = boot();
    NetInfo.attach(canvas);
    const open = () => NetInfo.show({ name: "net1", subnets: ["office"] }, subnets, { x: 0, y: 0 }, { w: 1200, h: 800 });
    open();
    NetInfo.hide();
    assert.ok(box.hidden, "hidden after hide()");
    open();
    fire(doc, "keydown", { key: "Escape" });
    assert.ok(box.hidden, "Escape hides the open window");
  });

  test("attach hides on wheel and background mousedown but not on node mousedown", () => {
    const { canvas, box } = boot();
    NetInfo.attach(canvas);
    const open = () => NetInfo.show({ name: "net1", subnets: ["office"] }, subnets, { x: 0, y: 0 }, { w: 1200, h: 800 });
    open();
    fire(canvas, "wheel", { deltaY: -120 });
    assert.ok(box.hidden, "wheel zoom hides the window");
    const node = makeEl("path");
    open();
    fire(canvas, "mousedown", { button: 0, target: node });
    assert.ok(!box.hidden, "node mousedown keeps the window");
    fire(canvas, "mousedown", { button: 0, target: canvas });
    assert.ok(box.hidden, "background mousedown hides the window");
    open();
    fire(canvas, "mousedown", { button: 1, target: canvas });
    assert.ok(box.hidden, "middle-button pan hides the window");
  });
})();
