"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// common.js's auto-init (DOMContentLoaded, at the bottom of the file) calls
// renderDraftBanner() on EVERY page unless <body data-no-draft-banner> opts
// out — the same switch templated pages set via pageData.NoDraftBanner.
// Templated pages (internal/httpapi/templates/*.html) always carry
// data-nav, set by layout.html, so they're structurally covered.
//
// Standalone pages living directly in web/ (login.html, invite.html, and
// any future one) sit outside that templating system: nothing sets either
// attribute for them automatically. A standalone page whose script imports
// common.js — directly or transitively — but forgets data-no-draft-banner
// gets renderDraftBanner() firing pre-auth, where no session can exist: it
// 401s, the 401 handler redirects back to the very page that just ran, and
// the reload re-fires the same import chain — a tight reload loop, as fast
// as the network allows (this is exactly what shipped with login.html and
// invite.html; see git history around 2026-09-01 for the incident).
//
// This test scans every standalone HTML page and, for each one that (a)
// has no data-nav (so it's not part of the templated app shell) and (b)
// pulls in common.js through its script's import graph, asserts
// data-no-draft-banner is set. It's graph-based rather than a hardcoded
// filename list so a *new* standalone page trips it automatically instead
// of relying on someone remembering this incident.

const WEB_DIR = __dirname;

function findModuleScriptSrc(html) {
  const m = /<script[^>]*type="module"[^>]*\ssrc="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

function importsFrom(jsSource) {
  const specifiers = [];
  const re = /import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(jsSource))) specifiers.push(m[1]);
  return specifiers;
}

// Depth-first search over the ES module import graph, starting at
// entryFile (a path relative to WEB_DIR), looking for "common.js".
function reachesCommonJS(entryFile, seen = new Set()) {
  if (entryFile === "common.js") return true;
  if (seen.has(entryFile)) return false;
  seen.add(entryFile);
  const abs = path.join(WEB_DIR, entryFile);
  if (!fs.existsSync(abs)) return false;
  const src = fs.readFileSync(abs, "utf8");
  for (const spec of importsFrom(src)) {
    if (!spec.startsWith(".")) continue; // ignore bare/external specifiers
    const resolved = path.normalize(path.join(path.dirname(entryFile), spec));
    if (reachesCommonJS(resolved, seen)) return true;
  }
  return false;
}

const htmlFiles = fs.readdirSync(WEB_DIR).filter((f) => f.endsWith(".html"));
assert.ok(htmlFiles.length > 0, "sanity: expected to find standalone html pages in web/");

for (const file of htmlFiles) {
  test(`${file}: opts out of the auto-init draft banner if it has no nav shell but imports common.js`, () => {
    const html = fs.readFileSync(path.join(WEB_DIR, file), "utf8");
    const bodyMatch = /<body\b([^>]*)>/.exec(html);
    assert.ok(bodyMatch, `${file} must have a <body> tag`);
    const bodyAttrs = bodyMatch[1];

    if (/\bdata-nav=/.test(bodyAttrs)) return; // part of the templated app shell — covered by layout.html

    const scriptSrc = findModuleScriptSrc(html);
    if (!scriptSrc) return; // no module script — nothing can import common.js

    const scriptFile = scriptSrc.replace(/^\//, "");
    if (!reachesCommonJS(scriptFile)) return; // doesn't touch common.js — no auto-init to opt out of

    assert.match(
      bodyAttrs,
      /\bdata-no-draft-banner="true"/,
      `${file}'s script (${scriptSrc}) imports common.js but <body> lacks data-no-draft-banner — ` +
        "common.js's DOMContentLoaded auto-init will call renderDraftBanner() pre-auth, 401, and " +
        "redirect back into a reload loop (see login.html/invite.html)",
    );
  });
}
