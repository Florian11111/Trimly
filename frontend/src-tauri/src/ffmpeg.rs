//! Reine Logik rund um ffmpeg: Programme finden, ffprobe auswerten,
//! Argumente bauen, Fortschritt lesen. Ohne Prozesse, damit alles testbar ist.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SW_ENCODER: &str = "libx264";
/// Muss zu AUDIO_KBPS im Frontend und VideoCalculator.AudioBitrateKbps im Backend passen
const DEFAULT_AUDIO_KBPS: u32 = 128;
/// Wie FFmpegUtils.AudioOnlyBitrateKbps im Backend
pub const AUDIO_ONLY_KBPS: u32 = 192;

/// Hardware-Encoder (H.264) in der Reihenfolge, in der sie probiert werden.
/// Ob einer wirklich funktioniert, prüft ein kurzer Test-Encode (siehe lib.rs):
/// ffmpeg listet z. B. h264_nvenc auch ohne NVIDIA-Karte.
pub const HWS: &[&str] = &[
    "h264_videotoolbox", // Apple
    "h264_nvenc",        // NVIDIA
    "h264_qsv",          // Intel Quick Sync
    "h264_amf",          // AMD
];

/// Hardware-Familien (Suffix im ffmpeg-Namen) in Probier-Reihenfolge, wie HWS
pub const FAMILIES: &[&str] = &["videotoolbox", "nvenc", "qsv", "amf"];
/// Ausgabe-Codecs; nur H.264 gibt es auch in Software (libx264)
pub const CODECS: &[&str] = &["h264", "hevc", "av1"];

/// ffmpeg-Encoder für Familie + Codec, z. B. ("amf", "av1") → "av1_amf". "cpu" gibt es nur für H.264.
pub fn encoder_for(family: &str, codec: &str) -> Option<String> {
    match (family, codec) {
        ("cpu", "h264") => Some(SW_ENCODER.to_string()),
        ("cpu", _) => None,
        // VideoToolbox kodiert kein AV1
        ("videotoolbox", "av1") => None,
        (f, c) if FAMILIES.contains(&f) && CODECS.contains(&c) => Some(format!("{c}_{f}")),
        _ => None,
    }
}

/// Familie eines Encoders ("h264_amf" → "amf", "libx264" → "cpu")
pub fn family_of(encoder: &str) -> &str {
    encoder.rsplit_once('_').map(|(_, f)| f).filter(|f| FAMILIES.contains(f)).unwrap_or("cpu")
}

/// Wählt den Encoder aus den getesteten (`working`, Probier-Reihenfolge) nach Wunsch-Codec und
/// -Gerät ("auto", "cpu" oder eine Familie). Fällt erst auf eine andere Hardware mit diesem Codec,
/// dann auf H.264 zurück; libx264 geht immer.
pub fn pick_encoder(working: &[String], codec: &str, preference: &str) -> String {
    let has = |e: &str| working.iter().any(|w| w == e);
    let wanted_family = |f: &str| encoder_for(f, codec).filter(|e| has(e));
    if preference == "cpu" {
        return SW_ENCODER.to_string();
    }
    if preference != "auto" {
        if let Some(e) = wanted_family(preference) {
            return e;
        }
        // Gewähltes Gerät kann den Codec nicht: dort wenigstens H.264
        if codec != "h264" {
            if let Some(e) = encoder_for(preference, "h264").filter(|e| has(e)) {
                return e;
            }
        }
    }
    FAMILIES
        .iter()
        .find_map(|f| wanted_family(f))
        .or_else(|| FAMILIES.iter().find_map(|f| encoder_for(f, "h264").filter(|e| has(e))))
        .unwrap_or_else(|| SW_ENCODER.to_string())
}

/// Alle Hardware-Encoder, die `ffmpeg -encoders` kennt (jeder Codec), in Probier-Reihenfolge.
pub fn listed_hw_encoders_all(encoders_listing: &str) -> Vec<String> {
    let listed: Vec<&str> = encoders_listing.lines().filter_map(|l| l.split_whitespace().nth(1)).collect();
    FAMILIES
        .iter()
        .flat_map(|f| CODECS.iter().filter_map(move |c| encoder_for(f, c)))
        .filter(|e| listed.contains(&e.as_str()))
        .collect()
}

/// Sucht ein Programm: zuerst das mitgelieferte neben der Trimly-Programmdatei
/// (Tauri `externalBin`, siehe scripts/build-ffmpeg.sh), dann im PATH und in den
/// üblichen Installationsordnern. Aus dem Finder gestartete Apps erben den PATH der Shell nicht.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let bundled = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
    let mut dirs: Vec<PathBuf> = bundled.into_iter().collect();
    dirs.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
    if cfg!(windows) {
        // winget legt Verknüpfungen hier ab; viele Anleitungen entpacken nach C:\ffmpeg
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
        }
        dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
        dirs.push(PathBuf::from(r"C:\Program Files\ffmpeg\bin"));
    } else {
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            dirs.push(PathBuf::from(extra));
        }
    }
    dirs.into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

/// Hardware-Encoder, die ffmpeg laut `ffmpeg -encoders` kennt, in Probier-Reihenfolge.
pub fn listed_hw_encoders(encoders_listing: &str) -> Vec<&'static str> {
    let listed: Vec<&str> = encoders_listing
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    HWS.iter().copied().filter(|e| listed.contains(e)).collect()
}

/// Encoder-spezifische Einstellungen.
pub fn encoder_args(encoder: &str) -> &'static [&'static str] {
    match encoder {
        "libx264" => &["-preset", "veryfast"],
        // hvc1: Apple-Player (QuickTime, iOS) spielen HEVC in MP4 nur mit diesem Tag
        "hevc_nvenc" => &["-preset", "p4", "-bf", "0", "-tag:v", "hvc1"],
        "hevc_qsv" => &["-preset", "veryfast", "-tag:v", "hvc1"],
        "hevc_amf" => &["-quality", "speed", "-tag:v", "hvc1"],
        "hevc_videotoolbox" => &["-tag:v", "hvc1"],
        // -bf 0: NVENC mit B-Frames verschiebt bei 29,97-fps-Quellen die Zeitstempel,
        // viele Player zeigen dann nur ein graues Bild (siehe Backend FFmpegUtils)
        e if e.ends_with("_nvenc") => &["-preset", "p4", "-bf", "0"],
        e if e.ends_with("_qsv") => &["-preset", "veryfast"],
        e if e.ends_with("_amf") => &["-quality", "speed"],
        _ => &[],
    }
}

/// Argumente für einen winzigen Test-Encode, der zeigt, ob ein Encoder auf diesem Rechner läuft.
pub fn encoder_test_args(encoder: &str) -> Vec<String> {
    // 640×480: hevc_amf lehnt kleinere Bilder ab (320×240 scheitert auf einer RX 9070 XT)
    let mut a: Vec<String> = ["-v", "error", "-f", "lavfi", "-i", "color=size=640x480:duration=0.2", "-c:v", encoder]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.extend(encoder_args(encoder).iter().map(|s| s.to_string()));
    a.extend(["-f", "null", "-"].iter().map(|s| s.to_string()));
    a
}

pub fn is_hardware(encoder: &str) -> bool {
    family_of(encoder) != "cpu"
}

/// Lesbarer Name des Geräts für die Oberfläche.
pub fn family_label(family: &str) -> &'static str {
    match family {
        "videotoolbox" => "Apple VideoToolbox",
        "nvenc" => "NVIDIA NVENC",
        "qsv" => "Intel Quick Sync",
        "amf" => "AMD AMF",
        _ => "CPU (libx264)",
    }
}

/// Lesbarer Name eines Encoders, z. B. "AMD AMF" (H.264 bleibt ohne Zusatz) oder "AMD AMF, AV1".
pub fn encoder_label(encoder: &str) -> String {
    let family = family_label(family_of(encoder));
    match encoder.split('_').next() {
        Some("hevc") => format!("{family}, HEVC"),
        Some("av1") => format!("{family}, AV1"),
        _ => family.to_string(),
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub duration: f64,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    /// Bitrate der Videospur in kbit/s, 0 wenn unbekannt
    pub video_kbps: u32,
    /// Bitrate der Tonspuren in kbit/s, 0 wenn unbekannt
    pub audio_kbps: u32,
}

fn parse_rate(rate: &str) -> f64 {
    match rate.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().unwrap_or(0.0), d.parse::<f64>().unwrap_or(0.0));
            if d > 0.0 {
                n / d
            } else {
                0.0
            }
        }
        None => rate.parse().unwrap_or(0.0),
    }
}

fn str_num<T: std::str::FromStr>(v: Option<&serde_json::Value>) -> Option<T> {
    v.and_then(|v| v.as_str()).and_then(|s| s.parse().ok())
}

/// Wertet `ffprobe -print_format json -show_format -show_streams` aus.
pub fn parse_probe(json: &str) -> Result<VideoInfo, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "ffprobe returned an unreadable answer.".to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        .ok_or_else(|| "This file has no video track.".to_string())?;

    let duration: f64 = str_num(v["format"].get("duration")).unwrap_or(0.0);
    if duration <= 0.0 {
        return Err("This file has no duration. Is it really a video?".into());
    }

    let fps = video["avg_frame_rate"]
        .as_str()
        .map(parse_rate)
        .filter(|f| *f > 0.0)
        .or_else(|| video["r_frame_rate"].as_str().map(parse_rate))
        .unwrap_or(0.0);

    // Videobitrate: aus der Spur, sonst Gesamtbitrate minus Ton
    let audio_bps: f64 = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .filter_map(|s| str_num::<f64>(s.get("bit_rate")))
        .sum();
    let video_bps = str_num::<f64>(video.get("bit_rate")).or_else(|| {
        str_num::<f64>(v["format"].get("bit_rate")).map(|total| (total - audio_bps).max(0.0))
    });

    Ok(VideoInfo {
        duration,
        size: str_num(v["format"].get("size")).unwrap_or(0),
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        fps,
        has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
        video_kbps: video_bps.map(|b| (b / 1000.0).round() as u32).unwrap_or(0),
        audio_kbps: (audio_bps / 1000.0).round() as u32,
    })
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub input: String,
    pub output: String,
    /// Sekunden
    pub start: f64,
    /// Sekunden
    pub end: f64,
    pub volume: f64,
    /// Nur schneiden, Videospur nicht neu kodieren
    pub copy: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    /// kbit/s
    pub bitrate: Option<u32>,
    /// kbit/s für AAC, Standard 128
    #[serde(default)]
    pub audio_bitrate: Option<u32>,
    /// "both" (Standard), "video" (ohne Ton) oder "audio" (nur Ton als MP3)
    #[serde(default = "default_streams")]
    pub streams: String,
    /// "h264" (Standard), "hevc" oder "av1"
    #[serde(default = "default_codec")]
    pub codec: String,
    /// Wunsch-Gerät: "auto" (Standard), "cpu" oder eine Familie wie "amf"
    #[serde(default = "default_auto")]
    pub encoder: String,
    /// Zielgröße in Bytes (Modus „Target size“): größere Ergebnisse werden mit weniger Bitrate neu kodiert
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

/// Neue Videobitrate, wenn eine Datei `actual` Bytes statt höchstens `max` hat. Hardware-Encoder wie AMF
/// überschreiten die Bitrate um 10–20 %, darum skaliert Trimly mit 3 % Puffer nach.
pub fn shrink_bitrate(bitrate: u32, actual: u64, max: u64) -> u32 {
    if actual == 0 || actual <= max {
        return bitrate;
    }
    let factor = max as f64 / actual as f64 * 0.97;
    ((bitrate as f64 * factor).floor() as u32).max(50)
}

fn default_streams() -> String {
    "both".into()
}

pub fn default_codec() -> String {
    "h264".into()
}

pub fn default_auto() -> String {
    "auto".into()
}

impl ExportRequest {
    pub fn clip_seconds(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

fn num(v: f64) -> String {
    // ffmpeg mag keine Exponentialschreibweise; 3 Nachkommastellen reichen für ms
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Baut die ffmpeg-Argumente (ohne den Programmnamen).
pub fn build_args(req: &ExportRequest, encoder: &str) -> Result<Vec<String>, String> {
    if req.start < 0.0 {
        return Err("The start can't be negative.".into());
    }
    if req.end <= req.start {
        return Err("The end has to come after the start.".into());
    }
    if req.volume < 0.0 {
        return Err("The volume can't be negative.".into());
    }
    if req.input == req.output {
        return Err("The export can't overwrite the original. Choose another file name.".into());
    }

    let mut a: Vec<String> = ["-hide_banner", "-nostats", "-y", "-progress", "pipe:1"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut push = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));

    push(&["-ss", &num(req.start), "-to", &num(req.end), "-i", &req.input]);

    let volume_changed = (req.volume - 1.0).abs() > 1e-3;
    let audio_bitrate = format!("{}k", req.audio_bitrate.unwrap_or(DEFAULT_AUDIO_KBPS).clamp(32, 320));
    let volume_filter = format!("volume={}", num(req.volume));
    let with_audio = req.streams != "video";

    if req.streams == "audio" {
        // Nur die Tonspur des Ausschnitts als MP3
        push(&["-map", "0:a:0", "-vn", "-af", &volume_filter, "-c:a", "libmp3lame"]);
        push(&["-b:a", &format!("{AUDIO_ONLY_KBPS}k"), "-f", "mp3", &req.output]);
        return Ok(a);
    }

    if req.copy {
        push(&["-map", "0:v:0"]);
        if with_audio {
            push(&["-map", "0:a?"]);
        }
        push(&["-c", "copy"]);
        if !with_audio {
            push(&["-an"]);
        } else if volume_changed {
            push(&["-af", &volume_filter, "-c:a", "aac", "-b:a", &audio_bitrate]);
        }
        push(&["-avoid_negative_ts", "make_zero"]);
    } else {
        let bitrate = req.bitrate.ok_or("The bitrate for encoding is missing.")?;
        if let (Some(w), Some(h)) = (req.width, req.height) {
            push(&["-vf", &format!("scale={w}:{h}")]);
        }
        if let Some(fps) = req.fps.filter(|f| *f > 0.0) {
            push(&["-fpsmax", &num(fps)]);
        }
        push(&["-c:v", encoder, "-b:v", &format!("{bitrate}k")]);
        push(encoder_args(encoder));
        push(&["-pix_fmt", "yuv420p"]);
        if !with_audio {
            push(&["-an"]);
        } else {
            if volume_changed {
                push(&["-af", &volume_filter]);
            }
            push(&["-c:a", "aac", "-b:a", &audio_bitrate]);
        }
    }

    if req.output.to_lowercase().ends_with(".mp4") || req.output.to_lowercase().ends_with(".mov") {
        push(&["-movflags", "+faststart"]);
    }
    push(&[&req.output]);
    Ok(a)
}

/// Liest eine Zeile von `-progress pipe:1` und liefert den Anteil 0–1.
pub fn progress_from_line(line: &str, clip_seconds: f64) -> Option<f64> {
    let (key, value) = line.trim().split_once('=')?;
    match key {
        "out_time_us" | "out_time_ms" => {
            // out_time_ms ist trotz Namen ebenfalls in Mikrosekunden
            let us: f64 = value.parse().ok()?;
            if clip_seconds <= 0.0 || us < 0.0 {
                return None;
            }
            Some((us / 1_000_000.0 / clip_seconds).clamp(0.0, 1.0))
        }
        "progress" if value == "end" => Some(1.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ExportRequest {
        ExportRequest {
            input: "/v/in.mp4".into(),
            output: "/v/out.mp4".into(),
            start: 1.5,
            end: 4.0,
            volume: 1.0,
            copy: false,
            width: Some(1280),
            height: Some(720),
            fps: Some(30.0),
            bitrate: Some(2500),
            audio_bitrate: None,
            streams: "both".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            max_bytes: None,
        }
    }

    #[test]
    fn shrinks_bitrate_only_when_the_file_is_too_big() {
        assert_eq!(shrink_bitrate(15000, 9_000_000, 10_000_000), 15000);
        // 17 % zu groß → knapp 17 % weniger, mit Puffer
        let b = shrink_bitrate(15000, 11_700_000, 10_000_000);
        assert!((12000..=12500).contains(&b), "{b}");
        assert_eq!(shrink_bitrate(100, 100_000_000, 1), 50);
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn builds_encoder_names_per_family_and_codec() {
        assert_eq!(encoder_for("amf", "av1").as_deref(), Some("av1_amf"));
        assert_eq!(encoder_for("nvenc", "hevc").as_deref(), Some("hevc_nvenc"));
        assert_eq!(encoder_for("cpu", "h264").as_deref(), Some("libx264"));
        assert_eq!(encoder_for("cpu", "av1"), None);
        assert_eq!(encoder_for("videotoolbox", "av1"), None);
        assert_eq!(family_of("hevc_amf"), "amf");
        assert_eq!(family_of("libx264"), "cpu");
        assert_eq!(encoder_label("av1_amf"), "AMD AMF, AV1");
        assert_eq!(encoder_label("h264_nvenc"), "NVIDIA NVENC");
    }

    #[test]
    fn picks_wanted_codec_then_falls_back() {
        let amd = strings(&["h264_amf", "hevc_amf", "av1_amf"]);
        assert_eq!(pick_encoder(&amd, "av1", "auto"), "av1_amf");
        assert_eq!(pick_encoder(&amd, "av1", "cpu"), "libx264");
        // Gewähltes Gerät fehlt: automatisch
        assert_eq!(pick_encoder(&amd, "hevc", "nvenc"), "hevc_amf");
        // Gerät kann kein AV1: dort H.264
        let nv = strings(&["h264_nvenc", "hevc_nvenc"]);
        assert_eq!(pick_encoder(&nv, "av1", "nvenc"), "h264_nvenc");
        assert_eq!(pick_encoder(&nv, "av1", "auto"), "h264_nvenc");
        // Gar keine Hardware
        assert_eq!(pick_encoder(&[], "av1", "auto"), "libx264");
    }

    #[test]
    fn lists_all_hardware_codecs() {
        let listing = " V....D av1_amf  AMD\n V....D h264_amf AMD\n V....D libx264 x\n V....D hevc_nvenc NV\n";
        assert_eq!(listed_hw_encoders_all(listing), strings(&["hevc_nvenc", "h264_amf", "av1_amf"]));
    }

    #[test]
    fn hevc_gets_the_apple_tag() {
        let s = joined(&build_args(&request(), "hevc_amf").unwrap());
        assert!(s.contains("-c:v hevc_amf -b:v 2500k -quality speed -tag:v hvc1"), "{s}");
    }

    fn joined(args: &[String]) -> String {
        args.join(" ")
    }

    const HW: &str = "h264_videotoolbox";

    #[test]
    fn lists_hardware_encoders_in_priority_order() {
        let listing = " V....D libx264              libx264 H.264\n V....D h264_nvenc           NVIDIA NVENC\n V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n";
        assert_eq!(listed_hw_encoders(listing), vec!["h264_videotoolbox", "h264_nvenc"]);
    }

    #[test]
    fn ignores_hevc_and_unknown_encoders() {
        let listing = " V....D libx264              libx264 H.264\n V....D hevc_videotoolbox    VideoToolbox H.265\n";
        assert!(listed_hw_encoders(listing).is_empty());
    }

    #[test]
    fn nvenc_gets_no_b_frames() {
        let s = joined(&build_args(&request(), "h264_nvenc").unwrap());
        assert!(s.contains("-c:v h264_nvenc -b:v 2500k -preset p4 -bf 0"), "{s}");
    }

    #[test]
    fn test_encode_uses_encoder_specific_args() {
        let s = encoder_test_args("h264_nvenc").join(" ");
        assert!(s.contains("-c:v h264_nvenc -preset p4 -bf 0 -f null -"));
    }

    #[test]
    fn video_only_drops_audio() {
        let req = ExportRequest { streams: "video".into(), volume: 1.5, ..request() };
        let s = joined(&build_args(&req, HW).unwrap());
        assert!(s.contains(" -an "));
        assert!(!s.contains("-c:a"));
        let copy = ExportRequest { streams: "video".into(), copy: true, ..request() };
        let s = joined(&build_args(&copy, HW).unwrap());
        assert!(s.contains("-map 0:v:0 -c copy -an"), "{s}");
    }

    #[test]
    fn audio_only_writes_mp3() {
        let req = ExportRequest { streams: "audio".into(), output: "/v/out.mp3".into(), ..request() };
        let s = joined(&build_args(&req, HW).unwrap());
        assert!(s.contains("-map 0:a:0 -vn -af volume=1 -c:a libmp3lame -b:a 192k -f mp3 /v/out.mp3"), "{s}");
        assert!(!s.contains("-c:v"));
    }

    #[test]
    fn parses_ffprobe_output() {
        let json = r#"{
          "streams": [
            {"codec_type": "video", "width": 2560, "height": 1440, "avg_frame_rate": "60/1", "r_frame_rate": "60/1", "bit_rate": "26360421", "disposition": {"attached_pic": 0}},
            {"codec_type": "audio", "bit_rate": "129697"}
          ],
          "format": {"duration": "19.050000", "size": "63115631", "bit_rate": "26505000"}
        }"#;
        let info = parse_probe(json).unwrap();
        assert_eq!(
            info,
            VideoInfo {
                duration: 19.05,
                size: 63_115_631,
                width: 2560,
                height: 1440,
                fps: 60.0,
                has_audio: true,
                video_kbps: 26_360,
                audio_kbps: 130,
            }
        );
    }

    #[test]
    fn handles_ntsc_framerates_and_missing_audio() {
        let json = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30000/1001"}],
                       "format":{"duration":"2.0","size":"10"}}"#;
        let info = parse_probe(json).unwrap();
        assert!((info.fps - 29.97).abs() < 0.01);
        assert!(!info.has_audio);
        assert_eq!(info.video_kbps, 0);
    }

    #[test]
    fn derives_video_bitrate_from_total_when_stream_has_none() {
        let json = r#"{"streams":[{"codec_type":"video","width":1280,"height":720,"avg_frame_rate":"25/1"},
                                  {"codec_type":"audio","bit_rate":"64000"}],
                       "format":{"duration":"10.0","size":"10","bit_rate":"164000"}}"#;
        assert_eq!(parse_probe(json).unwrap().video_kbps, 100);
    }

    #[test]
    fn rejects_files_without_video_or_duration() {
        let audio_only = r#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"3.0"}}"#;
        assert!(parse_probe(audio_only).unwrap_err().contains("no video track"));
        let still = r#"{"streams":[{"codec_type":"video","width":10,"height":10}],"format":{}}"#;
        assert!(parse_probe(still).unwrap_err().contains("no duration"));
        assert!(parse_probe("kaputt").is_err());
    }

    #[test]
    fn encode_args_use_encoder_scale_fps_and_bitrate() {
        let args = build_args(&request(), HW).unwrap();
        let s = joined(&args);
        assert!(s.contains("-ss 1.5 -to 4 -i /v/in.mp4"), "{s}");
        assert!(s.contains("-vf scale=1280:720"));
        assert!(s.contains("-fpsmax 30"));
        assert!(s.contains("-c:v h264_videotoolbox -b:v 2500k"));
        assert!(!s.contains("-preset"), "VideoToolbox kennt kein -preset");
        assert!(!s.contains("volume="), "Lautstärke 1 braucht keinen Filter");
        assert!(s.contains("-progress pipe:1"));
        assert_eq!(args.last().unwrap(), "/v/out.mp4");
    }

    #[test]
    fn software_encoder_gets_a_fast_preset() {
        let s = joined(&build_args(&request(), SW_ENCODER).unwrap());
        assert!(s.contains("-c:v libx264 -b:v 2500k -preset veryfast"));
    }

    #[test]
    fn audio_bitrate_defaults_to_160_and_can_be_lowered() {
        assert!(joined(&build_args(&request(), HW).unwrap()).contains("-c:a aac -b:a 128k"));
        let low = ExportRequest { audio_bitrate: Some(64), ..request() };
        assert!(joined(&build_args(&low, HW).unwrap()).contains("-c:a aac -b:a 64k"));
    }

    #[test]
    fn volume_adds_audio_filter() {
        let req = ExportRequest { volume: 1.5, ..request() };
        assert!(joined(&build_args(&req, HW).unwrap()).contains("-af volume=1.5"));
    }

    #[test]
    fn copy_mode_keeps_streams() {
        let req = ExportRequest { copy: true, bitrate: None, width: None, height: None, fps: None, ..request() };
        let s = joined(&build_args(&req, HW).unwrap());
        assert!(s.contains("-map 0:v:0 -map 0:a? -c copy"));
        assert!(s.contains("-avoid_negative_ts make_zero"));
        assert!(!s.contains("-c:v h264_videotoolbox"));
        assert!(!s.contains("-vf"));
    }

    #[test]
    fn copy_mode_reencodes_only_audio_when_volume_changes() {
        let req = ExportRequest { copy: true, volume: 0.5, ..request() };
        let s = joined(&build_args(&req, HW).unwrap());
        assert!(s.contains("-c copy -af volume=0.5 -c:a aac"));
    }

    #[test]
    fn rejects_invalid_requests() {
        assert!(build_args(&ExportRequest { start: -1.0, ..request() }, HW).is_err());
        assert!(build_args(&ExportRequest { end: 1.5, ..request() }, HW).is_err());
        assert!(build_args(&ExportRequest { volume: -0.1, ..request() }, HW).is_err());
        assert!(build_args(&ExportRequest { output: "/v/in.mp4".into(), ..request() }, HW).is_err());
        assert!(build_args(&ExportRequest { bitrate: None, ..request() }, HW).is_err());
    }

    #[test]
    fn faststart_only_for_mp4_and_mov() {
        let mkv = ExportRequest { copy: true, output: "/v/out.mkv".into(), ..request() };
        assert!(!joined(&build_args(&mkv, HW).unwrap()).contains("faststart"));
        assert!(joined(&build_args(&request(), HW).unwrap()).contains("-movflags +faststart"));
    }

    #[test]
    fn reads_progress_lines() {
        assert_eq!(progress_from_line("out_time_us=1250000", 2.5), Some(0.5));
        assert_eq!(progress_from_line("out_time_ms=5000000", 2.5), Some(1.0));
        assert_eq!(progress_from_line("progress=end", 2.5), Some(1.0));
        assert_eq!(progress_from_line("progress=continue", 2.5), None);
        assert_eq!(progress_from_line("out_time_us=N/A", 2.5), None);
        assert_eq!(progress_from_line("frame=10", 2.5), None);
    }
}
