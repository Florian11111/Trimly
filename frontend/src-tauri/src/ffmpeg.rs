//! Pure logic around ffmpeg: find the programs, parse ffprobe output,
//! build arguments, read progress. No processes, so everything is testable.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SW_ENCODER: &str = "libx264";
/// Must match AUDIO_KBPS in the frontend and VideoCalculator.AudioBitrateKbps in the backend
const DEFAULT_AUDIO_KBPS: u32 = 128;
/// Like FFmpegUtils.AudioOnlyBitrateKbps in the backend
pub const AUDIO_ONLY_KBPS: u32 = 192;

/// Hardware encoders (H.264) in the order they are tried.
/// Whether one really works is checked with a short test encode (see lib.rs):
/// ffmpeg lists e.g. h264_nvenc even without an NVIDIA card.
pub const HWS: &[&str] = &[
    "h264_videotoolbox", // Apple
    "h264_nvenc",        // NVIDIA
    "h264_qsv",          // Intel Quick Sync
    "h264_amf",          // AMD
    "h264_vaapi",        // Linux: Intel and AMD via VA-API
];

/// Hardware families (suffix of the ffmpeg name) in the order they are tried, like HWS
pub const FAMILIES: &[&str] = &["videotoolbox", "nvenc", "qsv", "amf", "vaapi"];

/// VA-API needs a graphics device; the default is the first card, `TRIMLY_VAAPI_DEVICE` picks another.
pub fn vaapi_device() -> String {
    std::env::var("TRIMLY_VAAPI_DEVICE").unwrap_or_else(|_| "/dev/dri/renderD128".into())
}

fn is_vaapi(encoder: &str) -> bool {
    encoder.ends_with("_vaapi")
}

/// Global options before the inputs (VA-API: open the device)
pub fn hw_init_args(encoder: &str) -> Vec<String> {
    if is_vaapi(encoder) {
        vec!["-vaapi_device".into(), vaapi_device()]
    } else {
        Vec::new()
    }
}

/// Last filter before the encoder: VA-API only encodes frames in GPU memory (NV12)
pub fn final_format_filter(encoder: &str) -> &'static str {
    if is_vaapi(encoder) {
        "format=nv12,hwupload"
    } else {
        "format=yuv420p"
    }
}

/// Output pixel format; with VA-API the upload filter already sets it
pub fn pix_fmt_args(encoder: &str) -> &'static [&'static str] {
    if is_vaapi(encoder) {
        &[]
    } else {
        &["-pix_fmt", "yuv420p"]
    }
}
/// Output codecs; only H.264 is also available in software (libx264)
pub const CODECS: &[&str] = &["h264", "hevc", "av1"];

/// ffmpeg encoder for family + codec, e.g. ("amf", "av1") → "av1_amf". "cpu" only exists for H.264.
pub fn encoder_for(family: &str, codec: &str) -> Option<String> {
    match (family, codec) {
        ("cpu", "h264") => Some(SW_ENCODER.to_string()),
        ("cpu", _) => None,
        // VideoToolbox doesn't encode AV1
        ("videotoolbox", "av1") => None,
        (f, c) if FAMILIES.contains(&f) && CODECS.contains(&c) => Some(format!("{c}_{f}")),
        _ => None,
    }
}

/// Family of an encoder ("h264_amf" → "amf", "libx264" → "cpu")
pub fn family_of(encoder: &str) -> &str {
    encoder.rsplit_once('_').map(|(_, f)| f).filter(|f| FAMILIES.contains(f)).unwrap_or("cpu")
}

/// Picks the encoder from the tested ones (`working`, in try order) by preferred codec and
/// device ("auto", "cpu" or a family). Falls back first to other hardware with this codec,
/// then to H.264; libx264 always works.
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
        // The chosen device can't do the codec: at least H.264 there
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

/// All hardware encoders `ffmpeg -encoders` knows (any codec), in try order.
pub fn listed_hw_encoders_all(encoders_listing: &str) -> Vec<String> {
    let listed: Vec<&str> = encoders_listing.lines().filter_map(|l| l.split_whitespace().nth(1)).collect();
    FAMILIES
        .iter()
        .flat_map(|f| CODECS.iter().filter_map(move |c| encoder_for(f, c)))
        .filter(|e| listed.contains(&e.as_str()))
        .collect()
}

/// Finds a program: first the bundled one next to the Trimly executable
/// (Tauri `externalBin`, see scripts/build-ffmpeg.sh), then in PATH and in the
/// usual install folders. Apps started from the Finder don't inherit the shell's PATH.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let bundled = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
    let mut dirs: Vec<PathBuf> = bundled.into_iter().collect();
    dirs.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
    if cfg!(windows) {
        // winget puts links here; many guides unpack to C:\ffmpeg
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

/// Hardware encoders ffmpeg knows according to `ffmpeg -encoders`, in try order.
pub fn listed_hw_encoders(encoders_listing: &str) -> Vec<&'static str> {
    let listed: Vec<&str> = encoders_listing
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    HWS.iter().copied().filter(|e| listed.contains(e)).collect()
}

/// Encoder-specific settings.
pub fn encoder_args(encoder: &str) -> &'static [&'static str] {
    match encoder {
        "libx264" => &["-preset", "veryfast"],
        // hvc1: Apple players (QuickTime, iOS) only play HEVC in MP4 with this tag
        "hevc_nvenc" => &["-preset", "p4", "-bf", "0", "-tag:v", "hvc1"],
        "hevc_qsv" => &["-preset", "veryfast", "-tag:v", "hvc1"],
        "hevc_amf" => &["-quality", "speed", "-tag:v", "hvc1"],
        "hevc_videotoolbox" | "hevc_vaapi" => &["-tag:v", "hvc1"],
        // -bf 0: with B-frames NVENC shifts the timestamps of 29.97 fps sources,
        // and many players then show only a grey picture (see FFmpegUtils in the backend)
        e if e.ends_with("_nvenc") => &["-preset", "p4", "-bf", "0"],
        e if e.ends_with("_qsv") => &["-preset", "veryfast"],
        e if e.ends_with("_amf") => &["-quality", "speed"],
        _ => &[],
    }
}

/// Arguments for a tiny test encode that shows whether an encoder works on this machine.
pub fn encoder_test_args(encoder: &str) -> Vec<String> {
    // 640×480: hevc_amf rejects smaller frames (320×240 fails on an RX 9070 XT)
    let mut a: Vec<String> = vec!["-v".into(), "error".into()];
    a.extend(hw_init_args(encoder));
    a.extend(["-f", "lavfi", "-i", "color=size=640x480:duration=0.2"].iter().map(|s| s.to_string()));
    if is_vaapi(encoder) {
        a.extend(["-vf".to_string(), final_format_filter(encoder).to_string()]);
    }
    a.extend(["-c:v".to_string(), encoder.to_string()]);
    a.extend(encoder_args(encoder).iter().map(|s| s.to_string()));
    a.extend(["-f", "null", "-"].iter().map(|s| s.to_string()));
    a
}

pub fn is_hardware(encoder: &str) -> bool {
    family_of(encoder) != "cpu"
}

/// Readable device name for the UI.
pub fn family_label(family: &str) -> &'static str {
    match family {
        "videotoolbox" => "Apple VideoToolbox",
        "nvenc" => "NVIDIA NVENC",
        "qsv" => "Intel Quick Sync",
        "amf" => "AMD AMF",
        "vaapi" => "VA-API",
        _ => "CPU (libx264)",
    }
}

/// Readable encoder name, e.g. "AMD AMF" (H.264 has no suffix) or "AMD AMF, AV1".
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
    /// Bitrate of the video track in kbit/s, 0 if unknown
    pub video_kbps: u32,
    /// Bitrate of the audio tracks in kbit/s, 0 if unknown
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

/// Extensions Trimly is meant to open (like `fileAssociations` in tauri.conf.json)
const KNOWN_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "avi"];

/// Message when ffprobe can't read the file at all.
pub fn unreadable_file_message(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext.is_empty() || KNOWN_EXTENSIONS.contains(&ext.as_str()) {
        "Trimly can't read this file. It may be damaged or not a video.".into()
    } else {
        format!("Trimly can't open .{ext} files. Use MP4, MOV, MKV, WebM or AVI.")
    }
}

/// Codec names with decoding support from `ffmpeg -codecs`.
/// Lines like ` DEV.LS h264   H.264 / AVC …`; the first character is 'D' if ffmpeg can decode it.
pub fn parse_decodable_codecs(listing: &str) -> std::collections::HashSet<String> {
    listing
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("---"))
        .skip(1)
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let flags = parts.next()?;
            let name = parts.next()?;
            (flags.len() == 6 && flags.starts_with('D')).then(|| name.to_string())
        })
        .collect()
}

/// Name for the error message: ffprobe long name with short name, e.g. "Windows Media Video 9 (wmv3)"
fn codec_label(stream: &serde_json::Value) -> String {
    let name = stream["codec_name"].as_str().unwrap_or("unknown");
    match stream["codec_long_name"].as_str() {
        Some(long) if !long.is_empty() => format!("{long} ({name})"),
        _ => name.to_string(),
    }
}

/// Checks whether ffmpeg can decode the picture and sound of this file. Err with a message for the UI.
pub fn check_decodable(json: &str, decodable: &std::collections::HashSet<String>) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "ffprobe returned an unreadable answer.".to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let supported = |s: &serde_json::Value| s["codec_name"].as_str().is_some_and(|c| decodable.contains(c));

    if let Some(video) = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
    {
        if !supported(video) {
            return Err(format!(
                "Trimly can't decode this video's format: {}. Convert it to MP4 (H.264) first, e.g. with HandBrake.",
                codec_label(video)
            ));
        }
    }
    // Audio: build_args keeps all audio tracks (-map 0:a?), so check all of them
    if let Some(audio) = streams.iter().find(|s| s["codec_type"] == "audio" && !supported(s)) {
        if !supported(audio) {
            return Err(format!(
                "Trimly can't decode this video's sound format: {}. Convert it to MP4 (AAC) first, e.g. with HandBrake.",
                codec_label(audio)
            ));
        }
    }
    Ok(())
}

/// Parses `ffprobe -print_format json -show_format -show_streams`.
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

    // Video bitrate: from the track, otherwise the total bitrate minus audio
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
    /// seconds
    pub start: f64,
    /// seconds
    pub end: f64,
    pub volume: f64,
    /// Trim only, don't re-encode the video track
    pub copy: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    /// kbit/s
    pub bitrate: Option<u32>,
    /// kbit/s for AAC, default 128
    #[serde(default)]
    pub audio_bitrate: Option<u32>,
    /// "both" (default), "video" (no audio) or "audio" (audio only, as MP3)
    #[serde(default = "default_streams")]
    pub streams: String,
    /// "h264" (default), "hevc" or "av1"
    #[serde(default = "default_codec")]
    pub codec: String,
    /// Preferred device: "auto" (default), "cpu" or a family like "amf"
    #[serde(default = "default_auto")]
    pub encoder: String,
    /// Target size in bytes ("Target size" mode): larger results are re-encoded with less bitrate
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

/// Free crop relative to the frame (0..1), used by the editor (edit.rs)
#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Crop {
    /// ffmpeg filter with even edges, independent of the source resolution
    pub fn filter(&self) -> String {
        format!(
            "crop=trunc(iw*{w}/2)*2:trunc(ih*{h}/2)*2:trunc(iw*{x}):trunc(ih*{y})",
            w = num(self.w),
            h = num(self.h),
            x = num(self.x),
            y = num(self.y)
        )
    }

    pub fn valid(&self) -> bool {
        let ok = |v: f64| (0.0..=1.0).contains(&v);
        ok(self.x) && ok(self.y) && self.w > 0.01 && self.h > 0.01 && self.x + self.w <= 1.001 && self.y + self.h <= 1.001
    }
}

/// New video bitrate when a file has `actual` bytes instead of at most `max`. Hardware encoders like AMF
/// overshoot the bitrate by 10–20 %, so Trimly scales down with a 3 % buffer.
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
    // ffmpeg doesn't like exponent notation; 3 decimals are enough for ms
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Builds the ffmpeg arguments (without the program name).
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
    if !req.copy && req.streams != "audio" {
        a.extend(hw_init_args(encoder));
    }
    let mut push = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));

    push(&["-ss", &num(req.start), "-to", &num(req.end), "-i", &req.input]);

    let volume_changed = (req.volume - 1.0).abs() > 1e-3;
    let audio_bitrate = format!("{}k", req.audio_bitrate.unwrap_or(DEFAULT_AUDIO_KBPS).clamp(32, 320));
    let volume_filter = format!("volume={}", num(req.volume));
    let with_audio = req.streams != "video";

    if req.streams == "audio" {
        // Only the audio of the selection as MP3
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
        let mut filters: Vec<String> = Vec::new();
        if let (Some(w), Some(h)) = (req.width, req.height) {
            filters.push(format!("scale={w}:{h}"));
        }
        if is_vaapi(encoder) {
            filters.push(final_format_filter(encoder).into());
        }
        if !filters.is_empty() {
            push(&["-vf", &filters.join(",")]);
        }
        if let Some(fps) = req.fps.filter(|f| *f > 0.0) {
            push(&["-fpsmax", &num(fps)]);
        }
        push(&["-c:v", encoder, "-b:v", &format!("{bitrate}k")]);
        push(encoder_args(encoder));
        push(pix_fmt_args(encoder));
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

/// Reads a line of `-progress pipe:1` and returns the fraction 0–1.
pub fn progress_from_line(line: &str, clip_seconds: f64) -> Option<f64> {
    let (key, value) = line.trim().split_once('=')?;
    match key {
        "out_time_us" | "out_time_ms" => {
            // despite its name, out_time_ms is also in microseconds
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
    fn crop_filter_has_even_edges_and_checks_bounds() {
        let c = Crop { x: 0.25, y: 0.0, w: 0.5, h: 1.0 };
        assert_eq!(c.filter(), "crop=trunc(iw*0.5/2)*2:trunc(ih*1/2)*2:trunc(iw*0.25):trunc(ih*0)");
        assert!(c.valid());
        assert!(!Crop { x: 0.8, y: 0.0, w: 0.5, h: 1.0 }.valid());
    }

    #[test]
    fn shrinks_bitrate_only_when_the_file_is_too_big() {
        assert_eq!(shrink_bitrate(15000, 9_000_000, 10_000_000), 15000);
        // 17 % too big → a bit under 17 % less, with buffer
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
        // Chosen device missing: automatic
        assert_eq!(pick_encoder(&amd, "hevc", "nvenc"), "hevc_amf");
        // Device can't do AV1: H.264 there
        let nv = strings(&["h264_nvenc", "hevc_nvenc"]);
        assert_eq!(pick_encoder(&nv, "av1", "nvenc"), "h264_nvenc");
        assert_eq!(pick_encoder(&nv, "av1", "auto"), "h264_nvenc");
        // No hardware at all
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
    fn vaapi_opens_the_device_and_uploads_frames() {
        assert_eq!(encoder_for("vaapi", "hevc").as_deref(), Some("hevc_vaapi"));
        assert_eq!(encoder_label("h264_vaapi"), "VA-API");
        let s = joined(&build_args(&request(), "h264_vaapi").unwrap());
        assert!(s.starts_with("-hide_banner -nostats -y -progress pipe:1 -vaapi_device /dev/dri/renderD128 -ss"), "{s}");
        assert!(s.contains("-vf scale=1280:720,format=nv12,hwupload"), "{s}");
        assert!(!s.contains("-pix_fmt"), "{s}");
        // Trimming only needs no device
        let copy = ExportRequest { copy: true, ..request() };
        assert!(!joined(&build_args(&copy, "h264_vaapi").unwrap()).contains("vaapi_device"));
        let t = encoder_test_args("h264_vaapi").join(" ");
        assert!(t.contains("-vaapi_device /dev/dri/renderD128 -f lavfi"), "{t}");
        assert!(t.contains("-vf format=nv12,hwupload -c:v h264_vaapi"), "{t}");
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
        assert!(!s.contains("-preset"), "VideoToolbox has no -preset");
        assert!(!s.contains("volume="), "volume 1 needs no filter");
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

    const CODECS_LISTING: &str = "Codecs:
 D..... = Decoding supported
 .E.... = Encoding supported
 -------
 DEV.LS h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (decoders: h264 h264_videotoolbox)
 .EV.L. ffv1                 FFmpeg video codec #1
 DEAIL. aac                  AAC (Advanced Audio Coding)
 ..A.L. dts                  placeholder
";

    #[test]
    fn decodable_codecs_come_from_the_d_flag() {
        let set = parse_decodable_codecs(CODECS_LISTING);
        assert!(set.contains("h264") && set.contains("aac"));
        assert!(!set.contains("ffv1") && !set.contains("dts"));
        // The legend before "-------" doesn't count
        assert!(!set.contains("="));
    }

    fn probe_json(video: &str, audio: &str) -> String {
        format!(
            r#"{{"streams":[
                {{"codec_type":"video","codec_name":"{video}","codec_long_name":"Long {video}","disposition":{{"attached_pic":0}}}},
                {{"codec_type":"audio","codec_name":"aac"}},
                {{"codec_type":"audio","codec_name":"{audio}","codec_long_name":"Long {audio}"}}
            ],"format":{{"duration":"1"}}}}"#
        )
    }

    #[test]
    fn unsupported_codecs_are_named_in_the_error() {
        let set = parse_decodable_codecs(CODECS_LISTING);
        assert_eq!(check_decodable(&probe_json("h264", "aac"), &set), Ok(()));

        let err = check_decodable(&probe_json("ffv1", "aac"), &set).unwrap_err();
        assert!(err.contains("video's format: Long ffv1 (ffv1)"), "{err}");

        // a second audio track is checked too (the export keeps all of them)
        let err = check_decodable(&probe_json("h264", "dts"), &set).unwrap_err();
        assert!(err.contains("sound format: Long dts (dts)"), "{err}");
    }

    #[test]
    fn unreadable_files_get_a_hint_about_the_extension() {
        assert!(unreadable_file_message("/a/clip.mp4").contains("damaged"));
        assert!(unreadable_file_message("/a/clip.MOV").contains("damaged"));
        assert_eq!(
            unreadable_file_message("/a/clip.wmv"),
            "Trimly can't open .wmv files. Use MP4, MOV, MKV, WebM or AVI."
        );
    }
}
