"use strict";

// loginRedirectTarget picks where to send the browser after a successful
// login: the "next" query param if it's a same-origin absolute path,
// otherwise the topology page. Guards against open redirects the same
// way common.js's loginRedirectURL does for the outgoing direction.
function loginRedirectTarget(search) {
  const next = new URLSearchParams(search).get("next");
  const safe = next && next.startsWith("/") && !next.startsWith("//");
  return safe ? next : "/ui/topology";
}

document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.theme =
    localStorage.getItem("firenet-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });

    if (!res.ok) {
      errorEl.textContent = "Неверный логин или пароль";
      errorEl.hidden = false;
      return;
    }
    window.location.href = loginRedirectTarget(window.location.search);
  });
});
