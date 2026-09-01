"use strict";

import { initialTheme } from "./common.js";

export function tokenFromPath(pathname) {
  const m = pathname.match(/^\/invite\/([^/]+)$/);
  return m ? m[1] : "";
}

export function validatePasswords(password, confirmPassword) {
  if (password.length < 8) return "Пароль должен содержать не менее 8 символов";
  if (password !== confirmPassword) return "Пароли не совпадают";
  return "";
}

document.addEventListener("DOMContentLoaded", async () => {
  document.documentElement.dataset.theme = initialTheme();

  const token = tokenFromPath(window.location.pathname);
  const loadingEl = document.getElementById("invite-loading");
  const invalidEl = document.getElementById("invite-invalid");
  const form = document.getElementById("invite-form");
  const greetingEl = document.getElementById("invite-greeting");
  const errorEl = document.getElementById("invite-error");

  const res = await fetch(`/api/invites/${token}`);
  loadingEl.hidden = true;
  if (!res.ok) {
    invalidEl.hidden = false;
    return;
  }
  const { username } = await res.json();
  greetingEl.textContent = `Здравствуйте, ${username}! Задайте пароль для входа.`;
  form.hidden = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;
    const validationError = validatePasswords(password, confirmPassword);
    if (validationError) {
      errorEl.textContent = validationError;
      errorEl.hidden = false;
      return;
    }

    const submitRes = await fetch(`/api/invites/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, confirmPassword }),
    });
    if (!submitRes.ok) {
      errorEl.textContent = "Не удалось установить пароль. Попробуйте ещё раз или обратитесь к администратору.";
      errorEl.hidden = false;
      return;
    }
    window.location.href = "/login?activated=1";
  });
});
