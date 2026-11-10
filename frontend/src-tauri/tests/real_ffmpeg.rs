//! Ruft das echte ffmpeg mit dem Testvideo aus dem Backend auf.
//! Wird übersprungen, wenn ffmpeg oder das Video fehlen.

use std::path::PathBuf;
use std::process::Command;
use trimly_lib::ffmpeg::{self, ExportRequest, VideoInfo};

fn test_video() -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/test/resources/testVideo.mp4");
    p.is_file().then_some(p)
}

fn setup() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let (Some(ff), Some(probe), Some(video)) =
        (ffmpeg::find_tool("ffmpeg"), ffmpeg::find_tool("ffprobe"), test_video())
    else {
        eprintln!("übersprungen: ffmpeg, ffprobe oder Testvideo fehlt");
        return None;
    };
    Some((ff, probe, video))
}

fn probe(ffprobe: &PathBuf, path: &PathBuf) -> VideoInfo {
    let out = Command::new(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .unwrap();
    ffmpeg::parse_probe(&String::from_utf8_lossy(&out.stdout)).unwrap()
}

/// Erster Hardware-Encoder, der auf diesem Rechner wirklich läuft, sonst libx264
fn encoder(ff: &PathBuf) -> &'static str {
    let out = Command::new(ff).args(["-hide_banner", "-encoders"]).output().unwrap();
    ffmpeg::listed_hw_encoders(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .find(|e| Command::new(ff).args(ffmpeg::encoder_test_args(e)).status().is_ok_and(|s| s.success()))
        .unwrap_or(ffmpeg::SW_ENCODER)
}

fn run(ff: &PathBuf, req: &ExportRequest, enc: &str) {
    let args = ffmpeg::build_args(req, enc).unwrap();
    let out = Command::new(ff).args(&args).output().unwrap();
    assert!(out.status.success(), "ffmpeg fehlgeschlagen: {}", String::from_utf8_lossy(&out.stderr));
}

fn out_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("trimly_test_{}_{name}", std::process::id()))
}

#[test]
fn probes_the_test_video() {
    let Some((_, ffprobe, video)) = setup() else { return };
    let info = probe(&ffprobe, &video);
    assert_eq!((info.width, info.height), (2560, 1440));
    assert!((info.fps - 60.0).abs() < 0.01);
    assert!((info.duration - 19.05).abs() < 0.1);
    assert!(info.has_audio);
}

#[test]
fn encodes_scaled_trimmed_clip() {
    let Some((ff, ffprobe, video)) = setup() else { return };
    let output = out_path("encoded.mp4");
    let req = ExportRequest {
        input: video.display().to_string(),
        output: output.display().to_string(),
        start: 2.0,
        end: 4.0,
        volume: 1.5,
        copy: false,
        width: Some(640),
        height: Some(360),
        fps: Some(30.0),
        bitrate: Some(1000),
        audio_bitrate: None,
        streams: "both".into(),
    };
    run(&ff, &req, encoder(&ff));

    let info = probe(&ffprobe, &output);
    assert_eq!((info.width, info.height), (640, 360));
    assert!((info.fps - 30.0).abs() < 0.5, "fps {}", info.fps);
    assert!((info.duration - 2.0).abs() < 0.3, "Länge {}", info.duration);
    assert!(info.has_audio);
    let _ = std::fs::remove_file(output);
}

#[test]
fn software_encoder_works_too() {
    let Some((ff, ffprobe, video)) = setup() else { return };
    let output = out_path("x264.mp4");
    let req = ExportRequest {
        input: video.display().to_string(),
        output: output.display().to_string(),
        start: 0.0,
        end: 1.0,
        volume: 1.0,
        copy: false,
        width: Some(320),
        height: Some(180),
        fps: Some(24.0),
        bitrate: Some(500),
        audio_bitrate: Some(64),
        streams: "both".into(),
    };
    run(&ff, &req, ffmpeg::SW_ENCODER);
    assert_eq!(probe(&ffprobe, &output).width, 320);
    let _ = std::fs::remove_file(output);
}

#[test]
fn copy_mode_keeps_resolution_and_cuts_length() {
    let Some((ff, ffprobe, video)) = setup() else { return };
    let output = out_path("copy.mp4");
    let req = ExportRequest {
        input: video.display().to_string(),
        output: output.display().to_string(),
        start: 5.0,
        end: 13.0,
        volume: 0.5,
        copy: true,
        width: None,
        height: None,
        fps: None,
        bitrate: None,
        audio_bitrate: None,
        streams: "both".into(),
    };
    run(&ff, &req, ffmpeg::SW_ENCODER);

    let info = probe(&ffprobe, &output);
    assert_eq!((info.width, info.height), (2560, 1440));
    // Schnitt ohne Neukodierung landet auf Keyframes, daher großzügige Toleranz
    assert!(info.duration > 7.0 && info.duration < 10.5, "Länge {}", info.duration);
    let _ = std::fs::remove_file(output);
}

#[test]
fn exports_audio_only_as_mp3_and_video_without_audio() {
    let Some((ff, ffprobe, video)) = setup() else { return };
    let mp3 = out_path("audio.mp3");
    let req = ExportRequest {
        input: video.display().to_string(),
        output: mp3.display().to_string(),
        start: 1.0,
        end: 3.0,
        volume: 1.0,
        copy: false,
        width: None,
        height: None,
        fps: None,
        bitrate: None,
        audio_bitrate: None,
        streams: "audio".into(),
    };
    run(&ff, &req, ffmpeg::SW_ENCODER);
    let out = Command::new(&ffprobe)
        .args(["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0"])
        .arg(&mp3)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "mp3");
    let _ = std::fs::remove_file(mp3);

    let silent = out_path("silent.mp4");
    let req = ExportRequest {
        output: silent.display().to_string(),
        streams: "video".into(),
        width: Some(320),
        height: Some(180),
        fps: Some(30.0),
        bitrate: Some(500),
        ..req
    };
    run(&ff, &req, encoder(&ff));
    assert!(!probe(&ffprobe, &silent).has_audio);
    let _ = std::fs::remove_file(silent);
}
