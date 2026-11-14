// Theme preference: follow the system (light → Fresh, dark → Sunset) or pin
// one. Stored in a cookie like text size and language. The palettes
// themselves live in app/globals.css; a pin is just <html data-theme>.

export type ThemePref = "system" | "light" | "dark";

/** Browser-chrome color per theme (Android status bar, PWA title bar). */
export const THEME_COLORS = { light: "#f6f7f4", dark: "#17120f" } as const;

export function readThemeCookie(): ThemePref {
  if (typeof document === "undefined") return "system";
  const m = document.cookie.match(/(?:^|;\s*)theme=([^;]+)/);
  const v = m?.[1];
  return v === "light" || v === "dark" ? v : "system";
}

export function setThemeCookie(pref: ThemePref): void {
  document.cookie = `theme=${pref}; path=/; max-age=31536000; SameSite=Lax`;
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  // layout.tsx emits one theme-color meta per color scheme; a pin overrides
  // both, "system" restores what each was rendered with.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.dataset.orig ??= m.content;
    m.content = pref === "system" ? m.dataset.orig : THEME_COLORS[pref];
  });
}

/** Inlined in <head> so a pinned theme is set before first paint (no flash
 *  of the other palette). Keep in sync with readThemeCookie. */
export const THEME_INIT_SCRIPT = `try{var m=document.cookie.match(/(?:^|;\\s*)theme=(light|dark)/);if(m)document.documentElement.dataset.theme=m[1];}catch(e){}`;
