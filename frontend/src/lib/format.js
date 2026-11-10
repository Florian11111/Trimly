export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const digits = i === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", ",")} ${units[i]}`;
}

/** 83.25 → "1:23,2" */
export function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  const whole = Math.floor(rest);
  const tenth = Math.floor((rest - whole) * 10);
  return `${minutes}:${String(whole).padStart(2, "0")},${tenth}`;
}

export function fileStem(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
