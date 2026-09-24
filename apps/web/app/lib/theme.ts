// Sealine Web theme (WEB 2.1 Phase 5): light / dark / system, persisted.
// localStorage is fine here (sessionStorage is not). Applied via body[data-theme].

export type ThemeMode = "light" | "dark" | "system";

export const THEME_KEY = "wpt_web_theme_v1";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(mode: ThemeMode, root: HTMLElement = document.body): void {
  const resolved = mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
  root.setAttribute("data-theme", resolved);
}

export function readThemeMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    return "system";
  }
  return "system";
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // storage unavailable (privacy mode) — theme still applies for this paint
  }
}