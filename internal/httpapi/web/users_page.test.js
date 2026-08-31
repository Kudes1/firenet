// internal/httpapi/web/users_page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

async function bootPage() {
  const factories = {};
  const calls = [];
  const banners = [];
  const docListeners = {};
  const notify = (event) => {
    if (event.type === "notify") banners.push(event.detail);
  };
  let usersFixture = [
    { id: "u1", username: "admin", role: "admin", activated: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "u2", username: "pending-guy", role: "user", activated: false, createdAt: "2026-01-02T00:00:00Z" },
  ];
  global.document = {
    addEventListener: (t, fn) => (docListeners[t] ||= []).push(fn),
  };
  global.window = { dispatchEvent: notify };
  global.localStorage = { getItem: () => null, setItem() {} };
  global.matchMedia = () => ({ matches: false });
  global.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  global.confirm = () => true;
  Object.defineProperty(global, "navigator", {
    value: { clipboard: { writeText: async (text) => { calls.push({ path: "clipboard.writeText", text }); } } },
    configurable: true,
  });
  global.fetch = async (path_, opts) => {
    calls.push({ path: path_, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    if (path_ === "/api/users" && (!opts || !opts.method)) {
      return { ok: true, status: 200, json: async () => usersFixture };
    }
    if (path_ === "/api/me") {
      return { ok: true, status: 200, json: async () => ({ id: "u1", username: "admin", role: "admin" }) };
    }
    if (path_ === "/api/users" && opts?.method === "POST") {
      const req = JSON.parse(opts.body);
      const created = { id: "u3", username: req.username, role: req.role, activated: false, createdAt: "2026-01-03T00:00:00Z" };
      usersFixture = [...usersFixture, created];
      return { ok: true, status: 201, json: async () => ({ user: created, inviteUrl: "https://firenet.example/invite/tok3" }) };
    }
    if (path_ === "/api/users/u2/invite" && opts?.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ inviteUrl: "https://firenet.example/invite/tok2b" }) };
    }
    if (path_ === "/api/users/u2" && opts?.method === "PATCH") {
      const req = JSON.parse(opts.body);
      const updated = { ...usersFixture.find((u) => u.id === "u2"), role: req.role };
      usersFixture = usersFixture.map((u) => (u.id === "u2" ? updated : u));
      return { ok: true, status: 200, json: async () => updated };
    }
    if (path_ === "/api/users/u2" && opts?.method === "DELETE") {
      usersFixture = usersFixture.filter((u) => u.id !== "u2");
      return { ok: true, status: 204, json: async () => null };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  global.Alpine = { data: (name, factory) => (factories[name] = factory) };
  await import(path.join(__dirname, "users.js") + `?t=${Date.now()}-${Math.random()}`);
  (docListeners["alpine:init"] || []).forEach((fn) => fn());
  const page = factories.usersPage();
  page.$nextTick = (fn) => fn();
  page.$refs = {
    table: null,
    createDialog: { showModal: () => calls.push({ path: "createDialog.showModal" }), close: () => calls.push({ path: "createDialog.close" }) },
    editDialog: { showModal: () => calls.push({ path: "editDialog.showModal" }), close: () => calls.push({ path: "editDialog.close" }) },
    inviteDialog: { showModal: () => calls.push({ path: "inviteDialog.showModal" }), close: () => calls.push({ path: "inviteDialog.close" }) },
  };
  return { page, calls, banners, getFixture: () => usersFixture };
}

async function bootLoadedPage() {
  const ctx = await bootPage();
  await ctx.page.init();
  return ctx;
}

test("init loads users and the current user id", async () => {
  const { page } = await bootLoadedPage();
  assert.equal(page.users.length, 2);
  assert.equal(page.currentUserId, "u1");
  assert.equal(page.loaded, true);
});

test("createHint requires a unique non-empty username", async () => {
  const { page } = await bootLoadedPage();
  page.createDraft = { username: "", role: "user" };
  assert.match(page.createHint, /Укажите логин/);

  page.createDraft = { username: "admin", role: "user" };
  assert.match(page.createHint, /уже используется/);

  page.createDraft = { username: "newperson", role: "user" };
  assert.equal(page.createHint, "");
});

test("submitCreate posts the invite request and opens the invite modal", async () => {
  const { page, calls } = await bootLoadedPage();
  page.createDraft = { username: "newperson", role: "user" };

  await page.submitCreate();

  const post = calls.find((c) => c.path === "/api/users" && c.method === "POST");
  assert.deepEqual(post.body, { username: "newperson", role: "user" });
  assert.equal(page.inviteUrl, "https://firenet.example/invite/tok3");
  assert.equal(page.inviteUsername, "newperson");
  assert.ok(calls.some((c) => c.path === "createDialog.close"));
  assert.ok(calls.some((c) => c.path === "inviteDialog.showModal"));
  assert.equal(page.users.length, 3);
});

test("openInviteFor regenerates a link for a pending user", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.openInviteFor(page.users.find((u) => u.id === "u2"));

  assert.ok(calls.some((c) => c.path === "/api/users/u2/invite" && c.method === "POST"));
  assert.equal(page.inviteUrl, "https://firenet.example/invite/tok2b");
  assert.equal(page.inviteUsername, "pending-guy");
  assert.ok(calls.some((c) => c.path === "inviteDialog.showModal"));
});

test("copyInviteUrl writes the current invite link to the clipboard", async () => {
  const { page, calls } = await bootLoadedPage();
  page.inviteUrl = "https://firenet.example/invite/tokX";

  await page.copyInviteUrl();

  assert.ok(calls.some((c) => c.path === "clipboard.writeText" && c.text === "https://firenet.example/invite/tokX"));
});

test("submitEdit patches the role and updates the local row", async () => {
  const { page, calls } = await bootLoadedPage();
  page.editDraft = { id: "u2", username: "pending-guy", role: "admin" };

  await page.submitEdit();

  const patch = calls.find((c) => c.path === "/api/users/u2" && c.method === "PATCH");
  assert.deepEqual(patch.body, { role: "admin" });
  assert.equal(page.users.find((u) => u.id === "u2").role, "admin");
  assert.ok(calls.some((c) => c.path === "editDialog.close"));
});

test("removeUser deletes after confirmation", async () => {
  const { page, calls } = await bootLoadedPage();

  await page.removeUser(page.users.find((u) => u.id === "u2"));

  assert.ok(calls.some((c) => c.path === "/api/users/u2" && c.method === "DELETE"));
  assert.deepEqual(page.users.map((u) => u.id), ["u1"]);
});

test("filteredUsers matches by username", async () => {
  const { page } = await bootLoadedPage();

  page.filters.username = "pending";
  assert.deepEqual(page.filteredUsers.map((u) => u.id), ["u2"]);

  page.filters.username = "";
  assert.deepEqual(page.filteredUsers.map((u) => u.id), ["u1", "u2"]);
});
