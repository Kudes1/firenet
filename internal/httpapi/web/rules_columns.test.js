"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseColumnWidths,
  resetPair,
  resizePair,
  toPercentages,
  formatChainPosition,
  formatChainName,
  formatEndpointSummary,
  rulesPanel,
} = require("./rules.js");

test("resizePair changes only the selected pair", () => {
  const widths = [46, 130, 170];
  const result = resizePair(widths, 1, 30, [40, 80, 100]);

  assert.deepEqual(result, [46, 160, 140]);
  assert.equal(result[1] + result[2], widths[1] + widths[2]);
});

test("resizePair respects both minimum widths", () => {
  assert.deepEqual(resizePair([130, 100], 0, 60, [80, 80]), [150, 80]);
  assert.deepEqual(resizePair([130, 100], 0, -60, [80, 80]), [80, 150]);
});

test("resetPair restores the default proportion without changing pair width", () => {
  const result = resetPair([200, 100], 0, [130, 170], [80, 100]);

  assert.deepEqual(result, [130, 170]);
  assert.equal(result[0] + result[1], 300);
});

test("stored widths require the current format and a complete 100-percent layout", () => {
  assert.deepEqual(parseColumnWidths('{"version":2,"widths":[40,60]}', 2), [40, 60]);
  assert.equal(parseColumnWidths('{"version":1,"widths":[40,60]}', 2), null);
  assert.equal(parseColumnWidths('{"version":2,"widths":[40,50]}', 2), null);
  assert.deepEqual(toPercentages([40, 60]), [40, 60]);
});

test("formatChainPosition and formatChainName return formatted labels", () => {
  assert.equal(formatChainPosition("top"), "в начало FORWARD");
  assert.equal(formatChainPosition("bottom"), "в конец FORWARD");
  assert.equal(formatChainName("CUSTOM-CHAIN"), "CUSTOM-CHAIN");
  assert.equal(formatChainName(""), "FIRENET-FWD");
  assert.equal(formatChainName("   "), "FIRENET-FWD");
});

test("formatEndpointSummary formats selected endpoints correctly", () => {
  assert.equal(formatEndpointSummary(["lan1"]), "lan1");
  assert.equal(formatEndpointSummary(["lan1", "dmz"]), "lan1, dmz");
  assert.equal(formatEndpointSummary([]), "— выбрать —");
  assert.equal(formatEndpointSummary(null), "— выбрать —");
});

test("rulesPanel initializes and manages draft and edit state", () => {
  const panel = rulesPanel({
    defaultAction: "deny",
    chainName: "CUSTOM",
    chainPosition: "bottom",
  });

  assert.equal(panel.editing, false);
  assert.equal(panel.defaultAction, "deny");
  assert.equal(panel.chainName, "CUSTOM");
  assert.equal(panel.chainPosition, "bottom");

  panel.startEdit();
  assert.equal(panel.editing, true);
  assert.equal(panel.draftDefaultAction, "deny");

  panel.draftDefaultAction = "allow";
  panel.draftChainName = "NEW-NAME";
  panel.cancelEdit();
  assert.equal(panel.editing, false);
  assert.equal(panel.defaultAction, "deny"); // not changed

  // Mock confirm for applyEdit
  global.confirm = () => true;
  panel.startEdit();
  panel.draftDefaultAction = "allow";
  panel.draftChainName = "NEW-NAME";
  panel.draftChainPosition = "top";
  panel.applyEdit();

  assert.equal(panel.editing, false);
  assert.equal(panel.defaultAction, "allow");
  assert.equal(panel.chainName, "NEW-NAME");
  assert.equal(panel.chainPosition, "top");
});
