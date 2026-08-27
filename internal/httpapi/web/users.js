"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const table = document.getElementById("users-table");
  const tbody = table.querySelector("tbody");
  const denied = document.getElementById("access-denied");
  const form = document.getElementById("create-user-form");

  async function refresh() {
    const res = await fetch("/api/users");
    if (res.status === 403) {
      denied.hidden = false;
      form.hidden = true;
      return;
    }
    if (res.status === 401) {
      window.location.href = loginRedirectURL(window.location.pathname, window.location.search);
      return;
    }
    const users = await res.json();
    tbody.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = u.username;
      const role = document.createElement("td");
      role.textContent = u.role;
      const actions = document.createElement("td");
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Удалить";
      del.addEventListener("click", async () => {
        const delRes = await fetch("/api/users/" + u.id, { method: "DELETE" });
        if (delRes.ok) refresh();
        else showBanner((await delRes.json()).error || "Не удалось удалить пользователя", "error");
      });
      actions.append(del);
      tr.append(name, role, actions);
      tbody.append(tr);
    });
    table.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
        role: form.role.value,
      }),
    });
    if (!res.ok) {
      showBanner((await res.json()).error || "Не удалось создать пользователя", "error");
      return;
    }
    form.reset();
    refresh();
  });

  refresh();
});
