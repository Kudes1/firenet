// internal/httpapi/web/invite_page.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

(async () => {
  global.document = { addEventListener() {} };
  const { tokenFromPath, validatePasswords } = await import(path.join(__dirname, "invite.js"));

  test("tokenFromPath extracts the token from /invite/{token}", () => {
    assert.equal(tokenFromPath("/invite/abc123"), "abc123");
  });

  test("tokenFromPath returns empty string for an unrelated path", () => {
    assert.equal(tokenFromPath("/login"), "");
  });

  test("validatePasswords rejects a too-short password", () => {
    assert.match(validatePasswords("short", "short"), /не менее 8/);
  });

  test("validatePasswords rejects a mismatch", () => {
    assert.match(validatePasswords("longenough1", "different1"), /не совпадают/);
  });

  test("validatePasswords accepts a matching, long-enough pair", () => {
    assert.equal(validatePasswords("longenough1", "longenough1"), "");
  });
})();
