//! Reine Logik rund um ffmpeg: Programme finden, ffprobe auswerten,
//! Argumente bauen, Fortschritt lesen. Ohne Prozesse, damit alles testbar ist.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const HW_ENCODER: &str = "h264_videotoolbox";
pub const SW_ENCODER: &str = "libx264";
const DEFAULT_AUDIO_KBPS: u32 = 160;

/// Sucht ein Programm im PATH und in den üblichen Homebrew-Ordnern.
/// Aus dem Finder gestartete Apps erben den PATH der Shell nicht.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// Wählt VideoToolbox, wenn ffmpeg es kennt, sonst libx264.
pub fn pick_encoder(encoders_listing: &str) -> &'static str {
    let has_hw = encoders_listing
        .lines()
        .any(|line| line.split_whitespace().nth(1) == Some(HW_ENCODER));
    if has_hw {
        HW_ENCODER
    } else {
        SW_ENCODER
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
        serde_json::from_str(json).map_err(|_| "ffprobe hat keine lesbare Antwort geliefert.".to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        .ok_or_else(|| "Die Datei enthält keine Videospur.".to_string())?;

    let duration: f64 = str_num(v["format"].get("duration")).unwrap_or(0.0);
    if duration <= 0.0 {
        return Err("Die Datei hat keine Länge. Ist es wirklich ein Video?".into());
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
    /// kbit/s für AAC, Standard 160
    #[serde(default)]
    pub audio_bitrate: Option<u32>,
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
        return Err("Der Anfang darf nicht negativ sein.".into());
    }
    if req.end <= req.start {
        return Err("Das Ende muss hinter dem Anfang liegen.".into());
    }
    if req.volume < 0.0 {
        return Err("Die Lautstärke darf nicht negativ sein.".into());
    }
    if req.input == req.output {
        return Err("Die Ausgabe darf das Original nicht überschreiben.".into());
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

    if req.copy {
        push(&["-map", "0:v:0", "-map", "0:a?", "-c", "copy"]);
        if volume_changed {
            push(&["-af", &volume_filter, "-c:a", "aac", "-b:a", &audio_bitrate]);
        }
        push(&["-avoid_negative_ts", "make_zero"]);
    } else {
        let bitrate = req.bitrate.ok_or("Für die Kodierung fehlt die Bitrate.")?;
        if let (Some(w), Some(h)) = (req.width, req.height) {
            push(&["-vf", &format!("scale={w}:{h}")]);
        }
        if let Some(fps) = req.fps.filter(|f| *f > 0.0) {
            push(&["-fpsmax", &num(fps)]);
        }
        push(&["-c:v", encoder, "-b:v", &format!("{bitrate}k")]);
        if encoder == SW_ENCODER {
            push(&["-preset", "veryfast"]);
        }
        push(&["-pix_fmt", "yuv420p"]);
        if volume_changed {
            push(&["-af", &volume_filter]);
        }
        push(&["-c:a", "aac", "-b:a", &audio_bitrate]);
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
        }
    }

    fn joined(args: &[String]) -> String {
        args.join(" ")
    }

    #[test]
    fn picks_videotoolbox_when_listed() {
        let listing = " V....D libx264              libx264 H.264\n V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n";
        assert_eq!(pick_encoder(listing), HW_ENCODER);
    }

    #[test]
    fn falls_back_to_libx264() {
        let listing = " V....D libx264              libx264 H.264\n V....D hevc_videotoolbox    VideoToolbox H.265\n";
        assert_eq!(pick_encoder(listing), SW_ENCODER);
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
        assert!(parse_probe(audio_only).unwrap_err().contains("keine Videospur"));
        let still = r#"{"streams":[{"codec_type":"video","width":10,"height":10}],"format":{}}"#;
        assert!(parse_probe(still).unwrap_err().contains("keine Länge"));
        assert!(parse_probe("kaputt").is_err());
    }

    #[test]
    fn encode_args_use_encoder_scale_fps_and_bitrate() {
        let args = build_args(&request(), HW_ENCODER).unwrap();
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
        assert!(joined(&build_args(&request(), HW_ENCODER).unwrap()).contains("-c:a aac -b:a 160k"));
        let low = ExportRequest { audio_bitrate: Some(64), ..request() };
        assert!(joined(&build_args(&low, HW_ENCODER).unwrap()).contains("-c:a aac -b:a 64k"));
    }

    #[test]
    fn volume_adds_audio_filter() {
        let req = ExportRequest { volume: 1.5, ..request() };
        assert!(joined(&build_args(&req, HW_ENCODER).unwrap()).contains("-af volume=1.5"));
    }

    #[test]
    fn copy_mode_keeps_streams() {
        let req = ExportRequest { copy: true, bitrate: None, width: None, height: None, fps: None, ..request() };
        let s = joined(&build_args(&req, HW_ENCODER).unwrap());
        assert!(s.contains("-map 0:v:0 -map 0:a? -c copy"));
        assert!(s.contains("-avoid_negative_ts make_zero"));
        assert!(!s.contains("-c:v h264_videotoolbox"));
        assert!(!s.contains("-vf"));
    }

    #[test]
    fn copy_mode_reencodes_only_audio_when_volume_changes() {
        let req = ExportRequest { copy: true, volume: 0.5, ..request() };
        let s = joined(&build_args(&req, HW_ENCODER).unwrap());
        assert!(s.contains("-c copy -af volume=0.5 -c:a aac"));
    }

    #[test]
    fn rejects_invalid_requests() {
        assert!(build_args(&ExportRequest { start: -1.0, ..request() }, HW_ENCODER).is_err());
        assert!(build_args(&ExportRequest { end: 1.5, ..request() }, HW_ENCODER).is_err());
        assert!(build_args(&ExportRequest { volume: -0.1, ..request() }, HW_ENCODER).is_err());
        assert!(build_args(&ExportRequest { output: "/v/in.mp4".into(), ..request() }, HW_ENCODER).is_err());
        assert!(build_args(&ExportRequest { bitrate: None, ..request() }, HW_ENCODER).is_err());
    }

    #[test]
    fn faststart_only_for_mp4_and_mov() {
        let mkv = ExportRequest { copy: true, output: "/v/out.mkv".into(), ..request() };
        assert!(!joined(&build_args(&mkv, HW_ENCODER).unwrap()).contains("faststart"));
        assert!(joined(&build_args(&request(), HW_ENCODER).unwrap()).contains("-movflags +faststart"));
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
