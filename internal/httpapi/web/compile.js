"use strict";

// Compile calls the same internal/app.Compile the CLI's `firenet compile`
// uses, and renders the per-device scripts for review/download.
(() => {
  function downloadLink(filename, content) {
    const a = document.createElement("a");
    a.textContent = "Скачать " + filename;
    a.href = "#";
    a.onclick = (e) => {
      e.preventDefault();
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const tmp = document.createElement("a");
      tmp.href = url;
      tmp.download = filename;
      tmp.click();
      URL.revokeObjectURL(url);
    };
    return a;
  }

  function renderDevice(d) {
    const box = document.createElement("div");
    box.className = "compile-device";
    const h = document.createElement("h3");
    h.textContent = d.Name;
    box.append(h);

    box.append(downloadLink(d.Name + ".ipsets.restore", d.IPSetsScript));
    const ipsetsPre = document.createElement("pre");
    ipsetsPre.textContent = d.IPSetsScript;
    box.append(ipsetsPre);

    box.append(downloadLink(d.Name + ".rules.sh", d.RulesScript));
    const rulesPre = document.createElement("pre");
    rulesPre.textContent = d.RulesScript;
    box.append(rulesPre);

    return box;
  }

  document.getElementById("compile-run").addEventListener("click", async () => {
    const out = document.getElementById("compile-output");
    out.textContent = "Компиляция…";
    try {
      const devices = await Api.post("/api/compile");
      out.innerHTML = "";
      devices.forEach((d) => out.append(renderDevice(d)));
    } catch (e) {
      out.textContent = "";
      showBanner("Ошибка компиляции: " + e.message);
    }
  });
})();
