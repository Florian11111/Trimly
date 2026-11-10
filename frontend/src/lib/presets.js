// Qualitätsstufen. `height` meint die kürzere Bildseite, damit Hochformat-Videos
// genauso behandelt werden wie Querformat. Bitraten in kbit/s.
export const PRESETS = [
  {
    id: "copy",
    label: "Original",
    hint: "Nur schneiden, sofort fertig",
    copy: true,
  },
  { id: "small", label: "Klein", hint: "480p, 30 fps", height: 480, fps: 30, bitrate: 1000 },
  { id: "medium", label: "Mittel", hint: "720p, 30 fps", height: 720, fps: 30, bitrate: 2500 },
  { id: "high", label: "Hoch", hint: "1080p, 60 fps", height: 1080, fps: 60, bitrate: 5000 },
  { id: "custom", label: "Eigene", hint: "Selbst einstellen" },
];

export const CUSTOM_HEIGHTS = [
  { value: 0, label: "Original" },
  { value: 2160, label: "2160p (4K)" },
  { value: 1440, label: "1440p" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
  { value: 360, label: "360p" },
];

export const DEFAULT_CUSTOM = { height: 0, fps: 30, bitrate: 4000 };

// Muss zu VideoCalculator.AudioBitrateKbps / FFmpegUtils.AudioOnlyBitrateKbps
// im Backend und zu ffmpeg.rs passen
export const AUDIO_KBPS = 128;
export const AUDIO_ONLY_KBPS = 192;

export const OUTPUTS = [
  { id: "both", label: "Mit Ton", hint: "Video mit Ton" },
  { id: "video", label: "Ohne Ton", hint: "Nur das Video, Ton wird entfernt" },
  { id: "audio", label: "Nur Ton", hint: "Nur der Ton als MP3" },
];

export function presetsFor() {
  return PRESETS;
}

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === "medium");
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Rechnet ein Preset in konkrete Zielwerte für das Quellvideo um.
 * Skaliert nie hoch, hält das Seitenverhältnis und liefert gerade Kantenlängen
 * (H.264 braucht sie).
 */
export function resolveTarget(preset, custom, source) {
  if (preset.copy) return { copy: true };

  const settings = preset.id === "custom" ? custom : preset;
  const shortSide = Math.min(source.width, source.height);
  const wanted = settings.height > 0 ? Math.min(settings.height, shortSide) : shortSide;
  const scale = shortSide > 0 ? wanted / shortSide : 1;

  const fps = Number(settings.fps) > 0 ? Number(settings.fps) : 30;
  const wantedKbps = Math.max(100, Math.round(Number(settings.bitrate) || 0));
  // Nie mehr Bitrate als das Original: das macht die Datei nur größer, nicht besser
  const capped = source.videoKbps > 0 && wantedKbps > source.videoKbps;
  return {
    copy: false,
    width: even(source.width * scale),
    height: even(source.height * scale),
    fps: source.fps > 0 ? Math.min(fps, source.fps) : fps,
    bitrate: capped ? Math.max(50, Math.round(source.videoKbps)) : wantedKbps,
    audioBitrate: source.audioKbps > 0 ? Math.max(32, Math.min(AUDIO_KBPS, source.audioKbps)) : AUDIO_KBPS,
    capped,
  };
}

/**
 * Bitrate der Videospur in kbit/s. Desktop kennt sie von ffprobe, im Browser
 * wird sie aus Dateigröße und Länge geschätzt (abzüglich typischer Tonspur).
 */
export function sourceVideoKbps(info, size, duration) {
  if (info?.videoKbps > 0) return info.videoKbps;
  if (!size || !duration) return 0;
  return Math.max(0, Math.round((size * 8) / duration / 1000 - 128));
}

/** Geschätzte Dateigröße in Bytes für einen Ausschnitt von `clipSeconds`. */
export function estimateBytes(target, clipSeconds, source, output = "both") {
  if (!target || clipSeconds <= 0) return 0;
  const kbpsToBytes = (kbps) => (kbps * 1000 * clipSeconds) / 8;
  if (output === "audio") return kbpsToBytes(AUDIO_ONLY_KBPS);
  if (target.copy) {
    const share = source.duration > 0 ? (source.size * clipSeconds) / source.duration : 0;
    // ohne Ton fällt dessen Anteil weg
    return output === "video" ? Math.max(0, share - kbpsToBytes(source.audioKbps || 0)) : share;
  }
  const audio = output === "video" ? 0 : target.audioBitrate || AUDIO_KBPS;
  return kbpsToBytes(target.bitrate + audio);
}
