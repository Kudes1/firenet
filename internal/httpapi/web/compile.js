"use strict";

import { Api, showBanner, apiPath } from "./common.js";

// renderDevice builds one device's scripts as text nodes (never innerHTML —
// compiler output is untrusted-ish generated text, not markup) plus a
// download link per script, built from a Blob so no server round-trip is
// needed just to save a file.
function renderDevice(device) {
  const section = document.createElement("section");
  section.className = "compile-device";
  const h2 = document.createElement("h2");
  h2.textContent = device.Name;
  section.append(h2);

  const addScript = (label, filename, content) => {
    const h3 = document.createElement("h3");
    h3.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = content;
    const link = document.createElement("a");
    link.textContent = "Скачать " + filename;
    link.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    link.download = filename;
    section.append(h3, pre, link);
  };
  addScript("ipset", `${device.Name}.ipsets.restore`, device.IPSetsScript);
  addScript("iptables", `${device.Name}.rules.sh`, device.RulesScript);
  return section;
}

async function runCompile() {
  const output = document.getElementById("compile-output");
  try {
    const devices = await Api.post(apiPath("compile"), {});
    output.replaceChildren(...devices.map(renderDevice));
  } catch (err) {
    showBanner(err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("compile-run").addEventListener("click", runCompile);
});
