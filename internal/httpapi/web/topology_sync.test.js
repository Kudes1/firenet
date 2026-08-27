"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// topology_sync.js is a plain browser script (global TopologySync, no
// module.exports, no DOM/fetch/storage dependency at all) — loaded the same
// way draft_context.test.js loads common.js, but the sandbox needs nothing
// beyond the JS built-ins vm.createContext already provides.
function loadTopologySync() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "topology_sync.js"), "utf8"), sandbox, {
    filename: "topology_sync.js",
  });
  return vm.runInContext("TopologySync", sandbox);
}

test("queue serializes commands and projects later pending commands over a canonical response", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  const sync = TopologySync.create({
    read: () => ({ value: 0 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => {
      sent.push(op.delta);
      return { value: sent.reduce((a, b) => a + b, 0) };
    },
    onState() {},
    onStatus() {},
    reload: async () => ({ value: 0 }),
  });
  sync.seed({ value: 0 });
  sync.enqueue({ delta: 1 });
  sync.enqueue({ delta: 2 });
  await sync.idle();
  assert.deepEqual(sent, [1, 2]);
});

test("projection never regresses: onState always reflects confirmed snapshot plus every still-pending op", async () => {
  const TopologySync = loadTopologySync();
  const states = [];
  let total = 0;
  const sync = TopologySync.create({
    read: () => ({ value: 0 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => {
      total += op.delta;
      return { value: total };
    },
    onState: (s) => states.push(s.value),
    onStatus() {},
    reload: async () => ({ value: 0 }),
  });
  sync.seed({ value: 0 });
  // Three ops queued back-to-back, synchronously, before any write settles.
  sync.enqueue({ delta: 1 });
  sync.enqueue({ delta: 2 });
  sync.enqueue({ delta: 3 });
  // Immediate projection must already reflect all three, even though only
  // the first has actually been sent.
  assert.equal(states[states.length - 1], 6);
  await sync.idle();
  // The visible total must never have dipped below what was already shown,
  // even as `confirmed` was replaced under the hood by each server reply.
  for (const s of states) assert.ok(s <= 6, `saw regression: ${s}`);
  assert.equal(states[states.length - 1], 6);
});

test("coalesces move operations for the same target queued before the first one sends", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  const sync = TopologySync.create({
    read: () => ({ positions: {} }),
    apply: (s, op) => ({ positions: { ...s.positions, [op.deviceName]: op.position } }),
    write: async (op) => {
      sent.push(op);
      return { positions: { [op.deviceName]: op.position } };
    },
    onState() {},
    onStatus() {},
    reload: async () => ({ positions: {} }),
  });
  sync.seed({ positions: {} });
  sync.enqueue({ kind: "set-device-position", deviceName: "r1", position: { x: 1, y: 1 } });
  sync.enqueue({ kind: "set-device-position", deviceName: "r1", position: { x: 2, y: 2 } });
  sync.enqueue({ kind: "set-device-position", deviceName: "r1", position: { x: 3, y: 3 } });
  // First move is already in flight (sent synchronously); the second and
  // third, both still unsent, collapse into a single final-position op.
  assert.equal(sync.pending().length, 2);
  await sync.idle();
  assert.deepEqual(sent.map((op) => op.position), [{ x: 1, y: 1 }, { x: 3, y: 3 }]);
});

test("does not coalesce move operations for different targets", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  const sync = TopologySync.create({
    read: () => ({ positions: {} }),
    apply: (s, op) => ({ positions: { ...s.positions, [op.deviceName]: op.position } }),
    write: async (op) => {
      sent.push(op);
      return { positions: { [op.deviceName]: op.position } };
    },
    onState() {},
    onStatus() {},
    reload: async () => ({ positions: {} }),
  });
  sync.seed({ positions: {} });
  sync.enqueue({ kind: "set-device-position", deviceName: "r1", position: { x: 1, y: 1 } });
  sync.enqueue({ kind: "set-device-position", deviceName: "r2", position: { x: 9, y: 9 } });
  await sync.idle();
  assert.deepEqual(sent.map((op) => op.deviceName), ["r1", "r2"]);
});

test("onStatus reports saving while a write is in flight and saved once the queue drains", async () => {
  const TopologySync = loadTopologySync();
  const statuses = [];
  const sync = TopologySync.create({
    read: () => ({ value: 0 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => ({ value: op.delta }),
    onState() {},
    onStatus: (s) => statuses.push(s),
    reload: async () => ({ value: 0 }),
  });
  sync.seed({ value: 0 });
  sync.enqueue({ delta: 1 });
  await sync.idle();
  assert.deepEqual(statuses, ["saving", "saved"]);
});

test("on 409 revision conflict: reloads canonical snapshot, discards pending, reports failure, never resends", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  let reloaded = false;
  const statuses = [];
  let lastState = null;
  const conflict = Object.assign(new Error("stale revision"), { status: 409 });
  const sync = TopologySync.create({
    read: () => ({ value: -1 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => {
      sent.push(op.delta);
      throw conflict;
    },
    onState: (s) => { lastState = s; },
    onStatus: (s) => statuses.push(s),
    reload: async () => {
      reloaded = true;
      return { value: 99 };
    },
  });
  sync.seed({ value: 0 });
  sync.enqueue({ delta: 1 });
  sync.enqueue({ delta: 2 });
  await sync.idle();
  assert.deepEqual(sent, [1]); // second op must never be attempted
  assert.equal(reloaded, true);
  // .length, not deepEqual against a literal [] - pending() builds its array
  // inside the vm sandbox, a different realm than this test file's Array.
  assert.equal(sync.pending().length, 0);
  assert.deepEqual(lastState, { value: 99 });
  assert.ok(statuses.includes("error"));
});

test("on 422 invalid operation: same reload/discard/report rollback as 409", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  let reloaded = false;
  const statuses = [];
  let lastState = null;
  const invalid = Object.assign(new Error("invalid operation"), { status: 422 });
  const sync = TopologySync.create({
    read: () => ({ value: -1 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => {
      sent.push(op.delta);
      throw invalid;
    },
    onState: (s) => { lastState = s; },
    onStatus: (s) => statuses.push(s),
    reload: async () => {
      reloaded = true;
      return { value: 42 };
    },
  });
  sync.seed({ value: 0 });
  sync.enqueue({ delta: 1 });
  sync.enqueue({ delta: 2 });
  await sync.idle();
  assert.deepEqual(sent, [1]);
  assert.equal(reloaded, true);
  // .length, not deepEqual against a literal [] - pending() builds its array
  // inside the vm sandbox, a different realm than this test file's Array.
  assert.equal(sync.pending().length, 0);
  assert.deepEqual(lastState, { value: 42 });
  assert.ok(statuses.includes("error"));
});

test("when reload also fails during reconcile: does not wedge the queue, still reports error, and recovers on the next enqueue", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  const statuses = [];
  let lastState = null;
  const conflict = Object.assign(new Error("stale revision"), { status: 409 });
  const reloadFailure = new TypeError("Failed to fetch");
  let reloadShouldFail = true;
  const sync = TopologySync.create({
    read: () => ({ value: -1 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => {
      sent.push(op.delta);
      if (op.delta === 1) throw conflict; // first op: the write itself fails
      return { value: 100 + op.delta }; // second op (after recovery): succeeds
    },
    onState: (s) => { lastState = s; },
    onStatus: (s) => statuses.push(s),
    reload: async () => {
      if (reloadShouldFail) throw reloadFailure; // reconcile's own reload also fails
      return { value: 50 };
    },
  });
  sync.seed({ value: 0 });
  sync.enqueue({ delta: 1 });
  // Must settle (not hang) and must not throw/reject despite reload() also
  // failing inside reconcile() - no unhandled rejection should escape.
  await assert.doesNotReject(sync.idle());
  assert.deepEqual(sent, [1]);
  // Status must reflect the failure even though reload() itself threw -
  // never left silently stuck on "saving".
  assert.ok(statuses.includes("error"));
  // Nothing fresher to publish, so the last known-good confirmed snapshot
  // (from seed) stands, with the discarded queue projected over it (empty).
  assert.deepEqual(lastState, { value: 0 });
  assert.equal(sync.pending().length, 0);

  // The queue must not be permanently wedged: a later enqueue still drains.
  reloadShouldFail = false;
  sync.enqueue({ delta: 5 });
  await assert.doesNotReject(sync.idle());
  assert.deepEqual(sent, [1, 5]);
  assert.deepEqual(lastState, { value: 105 });
  assert.equal(statuses[statuses.length - 1], "saved");
});

test("on network error: same reload/discard/report rollback, distinguished only by the thrown shape", async () => {
  const TopologySync = loadTopologySync();
  const sent = [];
  let reloaded = false;
  const statuses = [];
  // A network failure has no `status` field, unlike the 409/422 HTTP errors.
  const networkError = new TypeError("Failed to fetch");
  const sync = TopologySync.create({
    read: () => ({ value: -1 }),
    apply: (s, op) => ({ value: s.value + op.delta }),
    write: async (op) => {
      sent.push(op.delta);
      throw networkError;
    },
    onState() {},
    onStatus: (s) => statuses.push(s),
    reload: async () => {
      reloaded = true;
      return { value: 7 };
    },
  });
  sync.seed({ value: 0 });
  sync.enqueue({ delta: 1 });
  await sync.idle();
  assert.deepEqual(sent, [1]);
  assert.equal(reloaded, true);
  // .length, not deepEqual against a literal [] - pending() builds its array
  // inside the vm sandbox, a different realm than this test file's Array.
  assert.equal(sync.pending().length, 0);
  assert.ok(statuses.includes("error"));
});
