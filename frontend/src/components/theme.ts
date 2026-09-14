// Тема: сохранённый выбор, иначе светлая.
import { storageKeys } from "../lib/storage";

export function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem(storageKeys.theme);
  if (saved === "light" || saved === "dark") return saved;
  return "light";
}

export function initializeTheme(): void {
  document.documentElement.dataset.theme = initialTheme();
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(storageKeys.theme, theme);
}
