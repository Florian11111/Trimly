import { useCallback, useEffect, useState } from "react";

// App settings, stored in the window's localStorage (Tauri keeps it permanently).
// encoder/codec/outputDir only apply in the desktop app, theme/accent everywhere.

export const THEMES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

// Colour for actions, the trim bracket and the background lights (see index.css)
export const ACCENTS = [
  { id: "violet", label: "Violet", color: "#8a5cff" },
  { id: "blue", label: "Blue", color: "#3f8cff" },
  { id: "pink", label: "Pink", color: "#e2559f" },
  { id: "green", label: "Green", color: "#1fb98a" },
];

export const DEFAULT_SETTINGS = {
  theme: "dark",
  accent: "violet",
  codec: "h264", // h264 | hevc | av1
  encoder: "auto", // auto | cpu | amf | nvenc | qsv | videotoolbox | vaapi
  outputDir: null, // null: ask every time
};

const KEY = "trimly.settings";

export function loadSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // private window or similar: settings then only last until it is closed
  }
}

/** Theme and accent as data attributes on <html>, so index.css can switch. */
export function applyAppearance({ theme, accent }) {
  const root = document.documentElement;
  const dark =
    theme === "dark" ||
    (theme === "system" && !(window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false));
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.accent = ACCENTS.some((a) => a.id === accent) ? accent : "violet";
}

export function useSettings() {
  const [settings, setSettings] = useState(loadSettings);

  const update = useCallback((patch) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  useEffect(() => {
    applyAppearance(settings);
    if (settings.theme !== "system" || !window.matchMedia) return undefined;
    // "System" follows switches between light and dark live
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyAppearance(settings);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, [settings]);

  return [settings, update];
}
