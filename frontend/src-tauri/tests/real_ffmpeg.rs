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
        codec: "h264".into(),
        encoder: "auto".into(),
        max_bytes: None,
        crop: None,
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
        codec: "h264".into(),
        encoder: "auto".into(),
        max_bytes: None,
        crop: None,
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
        codec: "h264".into(),
        encoder: "auto".into(),
        max_bytes: None,
        crop: None,
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
        codec: "h264".into(),
        encoder: "auto".into(),
        max_bytes: None,
        crop: None,
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

/// Editor-Export wie render_edit: zwei Abschnitte, Zoom, PNG-Overlay, zwei Tonspuren gemischt
#[test]
fn renders_editor_project_with_zoom_overlay_and_audio_mix() {
    use base64::Engine;
    use std::collections::HashMap;
    use trimly_lib::edit;
    let Some((ff, ffprobe, video)) = setup() else { return };
    let v = video.display().to_string().replace('\\', "\\\\");

    // 1×1 transparentes PNG, ffmpeg skaliert es auf Ausgabegröße
    let png = out_path("overlay.png");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
        .unwrap();
    std::fs::write(&png, bytes).unwrap();
    let files = HashMap::from([("overlay_0".to_string(), png.display().to_string())]);

    let project: edit::EditProject = serde_json::from_str(&format!(
        r#"{{"preset": {{"width": 640, "height": 360, "fps": 30, "bitrate": 800}},
            "video": [{{"originalId": "{v}", "start": 1, "end": 2.5}}, {{"originalId": "{v}", "start": 10, "end": 11}}],
            "audio": [{{"originalId": "{v}", "start": 1, "end": 3.5, "at": 0, "volume": 1}},
                      {{"originalId": "{v}", "start": 5, "end": 6, "at": 1, "volume": 0.5}}],
            "zooms": [{{"start": 0.2, "end": 1.2, "x": 0.25, "y": 0.25, "w": 0.5}}],
            "overlays": [{{"file": "overlay_0", "start": 0.5, "end": 2}}]}}"#
    ))
    .unwrap();
    edit::validate(&project, &files).unwrap();

    let out = out_path("edit.mp4");
    let args = edit::build_video_args(&project, &files, 60.0, &|_| true, encoder(&ff), &out.display().to_string());
    let res = Command::new(&ff).args(&args).output().unwrap();
    assert!(res.status.success(), "ffmpeg fehlgeschlagen: {}", String::from_utf8_lossy(&res.stderr));

    let info = probe(&ffprobe, &out);
    assert_eq!((info.width, info.height), (640, 360));
    assert!((info.duration - 2.5).abs() < 0.15, "Dauer {}", info.duration);
    assert!(info.has_audio);
    let _ = std::fs::remove_file(&out);
    let _ = std::fs::remove_file(&png);
}

/// HEVC und AV1 mit jeder Hardware, die es auf diesem Rechner kann (sonst nichts zu prüfen)
#[test]
fn encodes_hevc_and_av1_with_available_hardware() {
    let Some((ff, ffprobe, video)) = setup() else { return };
    let out = Command::new(&ff).args(["-hide_banner", "-encoders"]).output().unwrap();
    let working: Vec<String> = ffmpeg::listed_hw_encoders_all(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .filter(|e| !e.starts_with("h264"))
        .filter(|e| Command::new(&ff).args(ffmpeg::encoder_test_args(e)).status().is_ok_and(|s| s.success()))
        .collect();
    if working.is_empty() {
        eprintln!("übersprungen: keine HEVC/AV1-Hardware");
        return;
    }
    for enc in working {
        let output = out_path(&format!("{enc}.mp4"));
        let req = ExportRequest {
            input: video.display().to_string(),
            output: output.display().to_string(),
            start: 2.0,
            end: 4.0,
            volume: 1.0,
            copy: false,
            width: Some(640),
            height: Some(360),
            fps: Some(30.0),
            bitrate: Some(800),
            audio_bitrate: None,
            streams: "both".into(),
            codec: "av1".into(),
            encoder: "auto".into(),
            max_bytes: None,
            crop: None,
        };
        run(&ff, &req, &enc);
        let info = probe(&ffprobe, &output);
        assert_eq!((info.width, info.height), (640, 360), "{enc}");
        assert!((info.duration - 2.0).abs() < 0.15, "{enc}: Dauer {}", info.duration);
        let _ = std::fs::remove_file(output);
    }
}

/// Editor mit Tempo: 2 s Quelle in 2× (1 s) + 1 s in 0,5× (2 s) = 3 s, Ton läuft mit
#[test]
fn renders_editor_speed_changes() {
    use std::collections::HashMap;
    use trimly_lib::edit;
    let Some((ff, ffprobe, video)) = setup() else { return };
    let v = video.display().to_string().replace('\\', "\\\\");
    let project: edit::EditProject = serde_json::from_str(&format!(
        r#"{{"preset": {{"width": 640, "height": 360, "fps": 30, "bitrate": 800}},
            "video": [{{"originalId": "{v}", "start": 1, "end": 3, "speed": 2}}, {{"originalId": "{v}", "start": 10, "end": 11, "speed": 0.5}}],
            "audio": [{{"originalId": "{v}", "start": 1, "end": 3, "at": 0, "volume": 1, "speed": 2}},
                      {{"originalId": "{v}", "start": 10, "end": 11, "at": 1, "volume": 1, "speed": 0.5}}],
            "zooms": [], "overlays": []}}"#
    ))
    .unwrap();
    let files = HashMap::new();
    edit::validate(&project, &files).unwrap();
    let out = out_path("speed.mp4");
    let args = edit::build_video_args(&project, &files, 60.0, &|_| true, encoder(&ff), &out.display().to_string());
    let res = Command::new(&ff).args(&args).output().unwrap();
    assert!(res.status.success(), "ffmpeg fehlgeschlagen: {}", String::from_utf8_lossy(&res.stderr));
    let info = probe(&ffprobe, &out);
    assert!((info.duration - 3.0).abs() < 0.15, "Dauer {}", info.duration);
    assert!(info.has_audio);
    let _ = std::fs::remove_file(&out);
}

/// Freier Zuschnitt: linke Hälfte, Hochformat-Ausschnitt aus 2560×1440 → 640×720 (auf 720 skaliert)
#[test]
fn crops_any_area_before_scaling() {
    let Some((ff, ffprobe, video)) = setup() else { return };
    let output = out_path("crop.mp4");
    let req = ExportRequest {
        input: video.display().to_string(),
        output: output.display().to_string(),
        start: 1.0,
        end: 2.0,
        volume: 1.0,
        copy: false,
        width: Some(640),
        height: Some(720),
        fps: Some(30.0),
        bitrate: Some(800),
        audio_bitrate: None,
        streams: "both".into(),
        codec: "h264".into(),
        encoder: "auto".into(),
        max_bytes: None,
        crop: Some(ffmpeg::Crop { x: 0.0, y: 0.0, w: 0.5, h: 1.0 }),
    };
    run(&ff, &req, ffmpeg::SW_ENCODER);
    let info = probe(&ffprobe, &output);
    assert_eq!((info.width, info.height), (640, 720));
    let _ = std::fs::remove_file(output);
}