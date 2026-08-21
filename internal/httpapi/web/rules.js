"use strict";

// Rules is a plain table editor (not graphical, per this iteration's scope)
// for the priority-ordered rule list. Row order is load-bearing — first
// match wins, like iptables — so rows support native HTML5 drag reorder.
const Rules = (() => {
  let dragFrom = null;

  function selectFromNames(selected, onChange) {
    const sel = document.createElement("select");
    sel.multiple = true;
    sel.size = 3;
    Topology.endpointNames().forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      opt.selected = selected.includes(name);
      sel.append(opt);
    });
    sel.onchange = () => onChange(Array.from(sel.selectedOptions).map((o) => o.value));
    return sel;
  }

  function textInput(value, onChange) {
    const input = document.createElement("input");
    input.value = value || "";
    input.onchange = () => onChange(input.value);
    return input;
  }

  function selectInput(value, options, onChange) {
    const sel = document.createElement("select");
    options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      o.selected = opt === value;
      sel.append(o);
    });
    sel.onchange = () => onChange(sel.value);
    return sel;
  }

  function rowFor(rule, index) {
    const tr = document.createElement("tr");
    tr.draggable = true;
    tr.ondragstart = () => {
      dragFrom = index;
    };
    tr.ondragover = (e) => {
      e.preventDefault();
      tr.classList.add("drag-over");
    };
    tr.ondragleave = () => tr.classList.remove("drag-over");
    tr.ondrop = (e) => {
      e.preventDefault();
      tr.classList.remove("drag-over");
      if (dragFrom === null || dragFrom === index) return;
      const [moved] = State.rules.rules.splice(dragFrom, 1);
      State.rules.rules.splice(index, 0, moved);
      dragFrom = null;
      render();
    };

    const handleTd = document.createElement("td");
    handleTd.className = "drag-handle";
    handleTd.textContent = "⠿";
    tr.append(handleTd);

    const nameTd = document.createElement("td");
    nameTd.append(textInput(rule.name, (v) => (rule.name = v)));
    tr.append(nameTd);

    const srcTd = document.createElement("td");
    srcTd.append(selectFromNames(rule.src || [], (v) => (rule.src = v)));
    tr.append(srcTd);

    const dstTd = document.createElement("td");
    dstTd.append(selectFromNames(rule.dst || [], (v) => (rule.dst = v)));
    tr.append(dstTd);

    const protoTd = document.createElement("td");
    protoTd.append(selectInput(rule.proto || "any", ["any", "tcp", "udp", "icmp"], (v) => (rule.proto = v)));
    tr.append(protoTd);

    const srcPortsTd = document.createElement("td");
    srcPortsTd.append(
      textInput((rule.srcPorts || []).join(","), (v) => {
        rule.srcPorts = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      })
    );
    tr.append(srcPortsTd);

    const dstPortsTd = document.createElement("td");
    dstPortsTd.append(
      textInput((rule.dstPorts || []).join(","), (v) => {
        rule.dstPorts = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      })
    );
    tr.append(dstPortsTd);

    const actionTd = document.createElement("td");
    actionTd.append(selectInput(rule.action || "allow", ["allow", "deny"], (v) => (rule.action = v)));
    tr.append(actionTd);

    const mirrorTd = document.createElement("td");
    const mirrorCb = document.createElement("input");
    mirrorCb.type = "checkbox";
    mirrorCb.title = "При компиляции также разрешить трафик в обратном направлении (dst → src)";
    mirrorCb.checked = !!rule.mirror;
    mirrorCb.onchange = () => {
      rule.mirror = mirrorCb.checked;
    };
    mirrorTd.append(mirrorCb);
    tr.append(mirrorTd);

    const delTd = document.createElement("td");
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.textContent = "×";
    del.onclick = () => {
      State.rules.rules.splice(index, 1);
      render();
    };
    delTd.append(del);
    tr.append(delTd);

    return tr;
  }

  function render() {
    const tbody = document.getElementById("rules-tbody");
    tbody.innerHTML = "";
    State.rules.rules.forEach((rule, i) => tbody.append(rowFor(rule, i)));
    document.getElementById("default-action").value = State.rules.defaultAction || "deny";
  }

  function setup() {
    document.getElementById("default-action").addEventListener("change", (e) => {
      State.rules.defaultAction = e.target.value;
    });
    document.getElementById("add-rule").addEventListener("click", () => {
      State.rules.rules.push({ name: "", src: [], dst: [], proto: "any", srcPorts: [], dstPorts: [], action: "allow" });
      render();
    });
    document.getElementById("rules-save").addEventListener("click", async () => {
      try {
        State.rules = await Api.put("/api/rules", State.rules);
        showBanner("Правила сохранены", "ok");
        render();
      } catch (e) {
        showBanner("Ошибка сохранения правил: " + e.message);
      }
    });
  }
  setup();

  return { render };
})();
