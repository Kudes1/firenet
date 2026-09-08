// Тема: сохранённый выбор, иначе системная. initialTheme ничего не пишет,
// чтобы невыбранная тема продолжала следовать за системой.
// matchMedia — нативный window-API (в браузерах с 2015), но jsdom его не
// реализует, поэтому защищаемся проверкой typeof — без неё Sidebar упал бы
// в тестах при useState(initialTheme).
import { storageKeys } from "../lib/storage";

export function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem(storageKeys.theme);
  if (saved === "light" || saved === "dark") return saved;
  const mql = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
  return mql?.matches ? "dark" : "light";
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(storageKeys.theme, theme);
}
