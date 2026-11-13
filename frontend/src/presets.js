// Single source of the editor presets: shown in the UI AND sent to the backend
export const PRESETS = {
  low:    { label: "Small",  fps: 24, resolution: "854x480",   bitrate: 1000 },
  medium: { label: "Medium", fps: 30, resolution: "1280x720",  bitrate: 2500 },
  high:   { label: "High",   fps: 60, resolution: "1920x1080", bitrate: 5000 },
};

export const RESOLUTION_OPTIONS = [
  { label: "480p", value: "854x480" },
  { label: "720p", value: "1280x720" },
  { label: "1080p", value: "1920x1080" },
  { label: "1440p", value: "2560x1440" },
  { label: "2160p (4K)", value: "3840x2160" },
  { label: "Custom", value: "custom" },
];

export const DEFAULT_FINETUNE = {
  fps: 30,
  resolution: "1280x720",
  customWidth: "",
  customHeight: "",
  bitrate: 2500,
};
