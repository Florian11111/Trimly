// Qualität in drei Modi:
//   original – nur schneiden (-c copy), sofort fertig
//   compress – Stufen Small/Medium/High oder eigene Werte
//   size     – Zielgröße in MB; Bitrate und Auflösung ergeben sich aus der Cliplänge
// `height` meint die kürzere Bildseite, damit Hochformat genauso behandelt wird wie Querformat.
// Bitraten in kbit/s.

export const MODES = [
  { id: "original", label: "Original", hint: "Cut only. Instant, same quality." },
  { id: "compress", label: "Compress", hint: "Pick a quality level." },
  { id: "size", label: "Target size", hint: "Trimly fits the clip into a file size." },
];

export const PRESETS = [
  { id: "small", label: "Small", hint: "480p, 30 fps", height: 480, fps: 30, bitrate: 1000 },
  { id: "medium", label: "Medium", hint: "720p, 30 fps", height: 720, fps: 30, bitrate: 2500 },
  { id: "high", label: "High", hint: "1080p, 60 fps", height: 1080, fps: 60, bitrate: 5000 },
  { id: "custom", label: "Custom", hint: "Set it yourself" },
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

/** Zielgrößen zum Antippen, in MB */
export const TARGET_SIZES = [10, 25, 50, 100];

export const DEFAULT_QUALITY = { mode: "compress", presetId: "medium", custom: DEFAULT_CUSTOM, sizeMb: 25 };

/** Ausgabe-Codecs. HEVC und AV1 brauchen für dieselbe Qualität weniger Bitrate. */
export const CODECS = [
  { id: "h264", label: "H.264", hint: "Plays everywhere" },
  { id: "hevc", label: "HEVC", hint: "About 30 % smaller" },
  { id: "av1", label: "AV1", hint: "About 40 % smaller, newer players" },
];
const CODEC_FACTOR = { h264: 1, hevc: 0.7, av1: 0.6 };
const codecFactor = (codec) => CODEC_FACTOR[codec] || 1;

// Muss zu VideoCalculator.AudioBitrateKbps / FFmpegUtils.AudioOnlyBitrateKbps
// im Backend und zu ffmpeg.rs passen
export const AUDIO_KBPS = 128;
export const AUDIO_ONLY_KBPS = 192;

export const OUTPUTS = [
  { id: "both", label: "With sound", hint: "Video with sound" },
  { id: "video", label: "No sound", hint: "Video only, the sound is removed" },
  { id: "audio", label: "Sound only", hint: "Only the sound as MP3" },
];

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === "medium");
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Rechnet eine Stufe in konkrete Zielwerte für das Quellvideo um.
 * Skaliert nie hoch, hält das Seitenverhältnis und liefert gerade Kantenlängen
 * (H.264 braucht sie). HEVC/AV1 bekommen bei festen Stufen weniger Bitrate,
 * eigene Werte bleiben, wie eingegeben.
 */
export function resolveTarget(preset, custom, source, codec = "h264") {
  if (preset.copy) return { copy: true };

  const isCustom = preset.id === "custom";
  const settings = isCustom ? custom : preset;
  const shortSide = Math.min(source.width, source.height);
  const wanted = settings.height > 0 ? Math.min(settings.height, shortSide) : shortSide;
  const scale = shortSide > 0 ? wanted / shortSide : 1;

  const fps = Number(settings.fps) > 0 ? Number(settings.fps) : 30;
  const factor = isCustom ? 1 : codecFactor(codec);
  const wantedKbps = Math.max(100, Math.round((Number(settings.bitrate) || 0) * factor));
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

// Ab welcher Videobitrate (H.264, kbit/s) sich eine Auflösung lohnt
const SIZE_LADDER = [
  [2160, 14000],
  [1440, 8000],
  [1080, 4000],
  [720, 1800],
  [480, 800],
  [360, 0],
];
// Puffer für Container und Schwankungen der Encoder, damit die Datei sicher unter dem Ziel bleibt
const SIZE_MARGIN = 0.94;

/**
 * Zielgröße → Bitrate, Auflösung und Bildrate für einen Clip von `clipSeconds`.
 * `tooSmall`: selbst mit kleinster Qualität passt der Clip nicht hinein.
 */
export function resolveSizeTarget(sizeMb, clipSeconds, source, output = "both", codec = "h264") {
  const audio = output === "video" ? 0 : resolveTarget(PRESETS[0], {}, source).audioBitrate;
  const totalKbps =
    clipSeconds > 0 ? ((Number(sizeMb) || 0) * 1024 * 1024 * 8 * SIZE_MARGIN) / clipSeconds / 1000 : 0;
  const videoKbps = Math.floor(totalKbps - audio);
  const tooSmall = videoKbps < 100;

  // Ist die Videobitrate des Originals unbekannt (Web), schätzt die Gesamtbitrate der Datei die Obergrenze
  const sourceTotalKbps = source.size > 0 && source.duration > 0 ? (source.size * 8) / source.duration / 1000 : 0;
  const sourceKbps = source.videoKbps > 0 ? source.videoKbps : sourceTotalKbps;

  const factor = codecFactor(codec);
  const [height] = SIZE_LADDER.find(([, min]) => videoKbps >= min * factor) || SIZE_LADDER[SIZE_LADDER.length - 1];
  const fps = videoKbps >= (height >= 1080 ? 6000 : 3000) * factor ? 60 : 30;
  // Passt das Original ohnehin hinein, behält es seine Auflösung und wird nicht aufgebläht
  const fitsAsIs = sourceKbps > 0 && videoKbps >= sourceKbps;
  const target = resolveTarget(
    { id: "custom" },
    { height: fitsAsIs ? 0 : height, fps, bitrate: Math.max(100, videoKbps) },
    { ...source, videoKbps: sourceKbps }
  );
  return { ...target, tooSmall };
}

/** Qualität ({mode, presetId, custom, sizeMb}) → Zielwerte für den Export. */
export function resolveQuality(quality, source, clipSeconds, output = "both", codec = "h264") {
  if (quality.mode === "original") return { copy: true };
  if (quality.mode === "size") return resolveSizeTarget(quality.sizeMb, clipSeconds, source, output, codec);
  return resolveTarget(findPreset(quality.presetId), quality.custom, source, codec);
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
