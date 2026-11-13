pub mod edit;
pub mod ffmpeg;
mod media_server;

use ffmpeg::{ExportRequest, VideoInfo};
use media_server::MediaServer;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

#[cfg(target_os = "macos")]
const MISSING_FFMPEG: &str =
    "ffmpeg wasn't found. Reinstall Trimly or install ffmpeg in Terminal with: brew install ffmpeg";
#[cfg(windows)]
const MISSING_FFMPEG: &str =
    "ffmpeg wasn't found. Reinstall Trimly or install ffmpeg in a command prompt with: winget install ffmpeg";
#[cfg(not(any(target_os = "macos", windows)))]
const MISSING_FFMPEG: &str = "ffmpeg wasn't found. Install it with your package manager.";

pub const CANCELLED: &str = "cancelled";

struct Tools {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    /// Encoders whose test encode succeeded, in try order (without libx264, which always works)
    working: Vec<String>,
}

/// Starts ffmpeg/ffprobe without a console window flashing up on Windows every time.
fn tool_command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Does a short test encode with this encoder succeed?
fn encoder_works(ffmpeg: &Path, encoder: &str) -> bool {
    tool_command(ffmpeg)
        .args(ffmpeg::encoder_test_args(encoder))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn tools() -> &'static Tools {
    static TOOLS: OnceLock<Tools> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let ffmpeg = ffmpeg::find_tool("ffmpeg");
        // TRIMLY_ENCODER=cpu forces software encoding (as in the backend)
        let forced_cpu = std::env::var("TRIMLY_ENCODER").is_ok_and(|v| v.eq_ignore_ascii_case("cpu"));
        let working = match (&ffmpeg, forced_cpu) {
            (Some(path), false) => tool_command(path)
                .args(["-hide_banner", "-encoders"])
                .output()
                .ok()
                .map(|o| ffmpeg::listed_hw_encoders_all(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or_default()
                .into_iter()
                .filter(|e| encoder_works(path, e))
                .collect(),
            _ => Vec::new(),
        };
        eprintln!("[ffmpeg] {:?}, Hardware: {working:?}", ffmpeg);
        Tools { ffmpeg, ffprobe: ffmpeg::find_tool("ffprobe"), working }
    })
}

/// The ffmpeg process currently running, so "Cancel" can stop it.
#[derive(Default)]
struct Running {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<Mutex<bool>>,
}

/// File that came via "Open with" and hasn't been picked up by the UI yet.
#[derive(Default)]
struct PendingFile {
    path: Mutex<Option<String>>,
    argv_used: Mutex<bool>,
}

/// A device to choose in the settings and the codecs it supports.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderOption {
    id: String,
    label: String,
    codecs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderInfo {
    label: String,
    hardware: bool,
    ffmpeg: Option<String>,
    /// Hardware devices with their codecs; libx264 (H.264 only) is always available in addition
    options: Vec<EncoderOption>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    size: u64,
    seconds: f64,
    encoder: String,
}

/// Async, so waiting for the encoder test doesn't block the main thread (and with it the window).
#[tauri::command]
async fn encoder_info(codec: Option<String>, encoder: Option<String>) -> Result<EncoderInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        encoder_info_blocking(&codec.unwrap_or_else(ffmpeg::default_codec), &encoder.unwrap_or_else(ffmpeg::default_auto))
    })
    .await
    .map_err(|e| e.to_string())
}

fn encoder_info_blocking(codec: &str, preference: &str) -> EncoderInfo {
    let t = tools();
    let chosen = ffmpeg::pick_encoder(&t.working, codec, preference);
    let hardware = t.ffmpeg.is_some() && ffmpeg::is_hardware(&chosen);
    let label = match &t.ffmpeg {
        None => MISSING_FFMPEG.to_string(),
        // short, so it fits in one line under the export button
        Some(_) if hardware => format!("Hardware: {}", ffmpeg::encoder_label(&chosen)),
        Some(_) => "Software: libx264".to_string(),
    };
    let options = ffmpeg::FAMILIES
        .iter()
        .filter_map(|f| {
            let codecs: Vec<String> = ffmpeg::CODECS
                .iter()
                .filter(|c| ffmpeg::encoder_for(f, c).is_some_and(|e| t.working.contains(&e)))
                .map(|c| c.to_string())
                .collect();
            (!codecs.is_empty()).then(|| EncoderOption {
                id: f.to_string(),
                label: ffmpeg::family_label(f).to_string(),
                codecs,
            })
        })
        .collect();
    EncoderInfo { label, hardware, ffmpeg: t.ffmpeg.as_ref().map(|p| p.display().to_string()), options }
}

/// File Trimly was opened with: "Open with" on macOS (event), a second launch
/// on Windows (single instance) or a start argument. Returns it only once.
#[tauri::command]
fn initial_file(pending: State<'_, PendingFile>) -> Option<String> {
    if let Some(path) = pending.path.lock().unwrap().take() {
        return Some(path);
    }
    let mut used = pending.argv_used.lock().unwrap();
    if *used {
        return None;
    }
    *used = true;
    file_arg(std::env::args().skip(1))
}

fn file_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter().find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

/// Prints UI messages in the terminal (debugging).
#[tauri::command]
fn frontend_log(message: String) {
    eprintln!("[ui] {message}");
}

/// Allows a file for the preview and returns its local URL.
#[tauri::command]
fn media_url(path: String, server: State<'_, MediaServer>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("This file doesn't exist anymore.".into());
    }
    Ok(server.register(&p))
}

fn probe_file(path: &str) -> Result<VideoInfo, String> {
    let ffprobe = tools().ffprobe.clone().ok_or(MISSING_FFMPEG)?;
    let out = tool_command(&ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe couldn't start: {e}"))?;
    if !out.status.success() {
        return Err(ffmpeg::unreadable_file_message(path));
    }
    let json = String::from_utf8_lossy(&out.stdout);
    let info = ffmpeg::parse_probe(&json)?;
    // Say so right when opening if the (slim, bundled) ffmpeg can't handle the codec,
    // instead of failing only at export with an ffmpeg error
    if let Some(codecs) = decodable_codecs() {
        ffmpeg::check_decodable(&json, codecs)?;
    }
    Ok(info)
}

/// Codecs the ffmpeg found can decode. None: list not readable, then nothing is checked.
fn decodable_codecs() -> Option<&'static HashSet<String>> {
    static CODECS: OnceLock<Option<HashSet<String>>> = OnceLock::new();
    CODECS
        .get_or_init(|| {
            let ffmpeg = tools().ffmpeg.as_ref()?;
            let out = tool_command(ffmpeg).args(["-hide_banner", "-codecs"]).output().ok()?;
            out.status
                .success()
                .then(|| ffmpeg::parse_decodable_codecs(&String::from_utf8_lossy(&out.stdout)))
        })
        .as_ref()
}

#[tauri::command]
async fn probe(path: String) -> Result<VideoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || probe_file(&path)).await.map_err(|e| e.to_string())?
}

/// One ffmpeg run with progress. Err(CANCELLED) when cancelled, otherwise Err with the last stderr lines.
fn run_ffmpeg(
    ffmpeg_path: &Path,
    args: &[String],
    clip: f64,
    on_progress: &Channel<f64>,
    child_slot: &Mutex<Option<Child>>,
    cancelled: &Mutex<bool>,
) -> Result<(), String> {
    let mut child = tool_command(ffmpeg_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg couldn't start: {e}"))?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    *child_slot.lock().unwrap() = Some(child);

    // drain stderr alongside (otherwise ffmpeg can block), keep the last lines
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        let tail: VecDeque<&str> = buf.lines().rev().take(6).collect();
        tail.into_iter().rev().collect::<Vec<_>>().join("\n")
    });

    let mut last_sent = -1.0;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(p) = ffmpeg::progress_from_line(&line, clip) {
            if p - last_sent >= 0.005 || p >= 1.0 {
                last_sent = p;
                let _ = on_progress.send(p);
            }
        }
    }

    let status = {
        let mut slot = child_slot.lock().unwrap();
        let status = slot.as_mut().map(|c| c.wait());
        *slot = None;
        status
    };
    let stderr_tail = stderr_reader.join().unwrap_or_default();

    if *cancelled.lock().unwrap() {
        return Err(CANCELLED.to_string());
    }
    match status {
        Some(Ok(s)) if s.success() => Ok(()),
        _ => Err(format!("ffmpeg failed:\n{stderr_tail}")),
    }
}

/// First with the chosen encoder; on errors (hardware acting up with 10 bit, unusual resolutions …)
/// once more with libx264. Returns the encoder that succeeded.
fn encode_with_fallback(
    encoder: &str,
    on_progress: &Channel<f64>,
    run: &dyn Fn(&str) -> Result<(), String>,
) -> Result<String, String> {
    match run(encoder) {
        Ok(()) => Ok(encoder.to_string()),
        Err(e) if e != CANCELLED && ffmpeg::is_hardware(encoder) => {
            eprintln!("[ffmpeg] {encoder} fehlgeschlagen, nutze libx264: {e}");
            let _ = on_progress.send(0.0);
            run(ffmpeg::SW_ENCODER).map(|_| ffmpeg::SW_ENCODER.to_string())
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn export_video(
    request: ExportRequest,
    on_progress: Channel<f64>,
    running: State<'_, Running>,
) -> Result<ExportResult, String> {
    let child_slot = running.child.clone();
    let cancelled = running.cancelled.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let t = tools();
        let ffmpeg_path = t.ffmpeg.clone().ok_or(MISSING_FFMPEG)?;
        let clip = request.clip_seconds();
        let started = Instant::now();

        if child_slot.lock().unwrap().is_some() {
            return Err("An export is already running.".to_string());
        }
        *cancelled.lock().unwrap() = false;

        let encodes_video = !request.copy && request.streams != "audio";
        let encoder = ffmpeg::pick_encoder(&t.working, &request.codec, &request.encoder);
        let run = |enc: &str| {
            run_ffmpeg(&ffmpeg_path, &ffmpeg::build_args(&request, enc)?, clip, &on_progress, &child_slot, &cancelled)
        };
        let mut result = if encodes_video {
            encode_with_fallback(&encoder, &on_progress, &run)
        } else {
            run(&encoder).map(|_| "copy".to_string())
        };

        // Target size: hardware encoders like to overshoot the bitrate. Then re-encode up to twice
        // with a suitably lower bitrate until the file is below the limit.
        if let (Ok(used), Some(max), Some(mut bitrate)) = (&result, request.max_bytes, request.bitrate) {
            let used = used.clone();
            for _ in 0..2 {
                let actual = std::fs::metadata(&request.output).map(|m| m.len()).unwrap_or(0);
                if !encodes_video || actual <= max {
                    break;
                }
                bitrate = ffmpeg::shrink_bitrate(bitrate, actual, max);
                eprintln!("[ffmpeg] {actual} > {max} bytes, retrying with {bitrate} kbit/s");
                let _ = on_progress.send(0.0);
                let smaller = ExportRequest { bitrate: Some(bitrate), ..request.clone() };
                result = ffmpeg::build_args(&smaller, &used)
                    .and_then(|args| run_ffmpeg(&ffmpeg_path, &args, clip, &on_progress, &child_slot, &cancelled))
                    .map(|_| used.clone());
                if result.is_err() {
                    break;
                }
            }
        }

        match result {
            Ok(used) => Ok(ExportResult {
                size: std::fs::metadata(&request.output).map(|m| m.len()).unwrap_or(0),
                seconds: started.elapsed().as_secs_f64(),
                encoder: used,
            }),
            Err(e) => {
                let _ = std::fs::remove_file(&request.output);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Editor export (counterpart of POST /render in the backend). `overlays` are PNGs as Base64,
/// in the same order as `overlay_0`, `overlay_1`, … in the project.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn render_edit(
    project: edit::EditProject,
    overlays: Vec<String>,
    output: String,
    codec: Option<String>,
    encoder: Option<String>,
    on_progress: Channel<f64>,
    running: State<'_, Running>,
) -> Result<ExportResult, String> {
    use base64::Engine;
    let child_slot = running.child.clone();
    let cancelled = running.cancelled.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let t = tools();
        let ffmpeg_path = t.ffmpeg.clone().ok_or(MISSING_FFMPEG)?;
        let started = Instant::now();
        if child_slot.lock().unwrap().is_some() {
            return Err("An export is already running.".to_string());
        }
        *cancelled.lock().unwrap() = false;

        // Write the overlays as files; the folder is deleted again at the end
        let dir = std::env::temp_dir().join(format!("trimly-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Temporary folder: {e}"))?;
        let mut overlay_files = std::collections::HashMap::new();
        for (i, data) in overlays.iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "An overlay is damaged.".to_string())?;
            let file = dir.join(format!("overlay_{i}.png"));
            std::fs::write(&file, bytes).map_err(|e| format!("Saving an overlay failed: {e}"))?;
            overlay_files.insert(format!("overlay_{i}"), file.display().to_string());
        }

        let result = (|| {
            edit::validate(&project, &overlay_files)?;
            // Check each source once: does it still exist, does it have audio, which frame rate?
            let mut infos = std::collections::HashMap::new();
            for path in project.video.iter().map(|s| &s.original_id).chain(project.audio.iter().map(|s| &s.original_id)) {
                if !infos.contains_key(path) {
                    let info = probe_file(path).map_err(|e| format!("{path}: {e}"))?;
                    infos.insert(path.clone(), info);
                }
            }
            let has_audio = |p: &str| infos.get(p).is_some_and(|i| i.has_audio);
            let source_fps = infos.values().map(|i| i.fps).fold(0.0, f64::max);

            if project.output == "audio" {
                let args = edit::build_audio_args(&project, &has_audio, &output)
                    .ok_or("This project has no audio.")?;
                run_ffmpeg(&ffmpeg_path, &args, project.audio_total(), &on_progress, &child_slot, &cancelled)?;
                return Ok("copy".to_string());
            }

            let total = project.total();
            let encoder = ffmpeg::pick_encoder(
                &t.working,
                codec.as_deref().unwrap_or("h264"),
                encoder.as_deref().unwrap_or("auto"),
            );
            // Filters run on the CPU, encoding uses hardware if available
            encode_with_fallback(&encoder, &on_progress, &|enc: &str| {
                let args = edit::build_video_args(&project, &overlay_files, source_fps, &has_audio, enc, &output);
                run_ffmpeg(&ffmpeg_path, &args, total, &on_progress, &child_slot, &cancelled)
            })
        })();
        let _ = std::fs::remove_dir_all(&dir);

        match result {
            Ok(encoder) => Ok(ExportResult {
                size: std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0),
                seconds: started.elapsed().as_secs_f64(),
                encoder,
            }),
            Err(e) => {
                let _ = std::fs::remove_file(&output);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_export(running: State<'_, Running>) {
    *running.cancelled.lock().unwrap() = true;
    if let Some(child) = running.child.lock().unwrap().as_mut() {
        let _ = child.kill();
    }
}

// ─── Saving in the background ────────────────────────────────────────────
// The export starts right away into a temporary file while the save dialog is open.
// Afterwards it is moved to the chosen place (or discarded if cancelled).

const TEMP_PREFIX: &str = "trimly-export-";

/// New, not yet existing path in the temp folder, e.g. …/trimly-export-1234-3.mp4
#[tauri::command]
fn temp_output(ext: String) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join(format!("{TEMP_PREFIX}{}-{n}.{ext}", std::process::id()))
        .display()
        .to_string()
}

/// Only our own temp files may be moved or deleted.
fn is_own_temp(path: &Path) -> bool {
    path.parent() == Some(std::env::temp_dir().as_path())
        && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(TEMP_PREFIX))
}

/// Moves the finished temp file to its destination (copying across drives).
#[tauri::command]
fn finalize_export(from: String, to: String) -> Result<(), String> {
    let from = PathBuf::from(from);
    if !is_own_temp(&from) {
        return Err("Trimly only moves its own temporary exports.".into());
    }
    let _ = std::fs::remove_file(&to);
    if std::fs::rename(&from, &to).is_err() {
        std::fs::copy(&from, &to).map_err(|e| format!("Saving to {to} failed: {e}"))?;
        let _ = std::fs::remove_file(&from);
    }
    Ok(())
}

#[tauri::command]
fn discard_temp(path: String) {
    let p = PathBuf::from(path);
    if is_own_temp(&p) {
        let _ = std::fs::remove_file(p);
    }
}

/// Free file name in the default folder: "clip_trim.mp4", otherwise "clip_trim (2).mp4" …
#[tauri::command]
fn unique_path(path: String) -> String {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return path;
    }
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("export").to_string();
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..10_000)
        .map(|i| p.with_file_name(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap_or_else(|| p.clone())
        .display()
        .to_string()
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[cfg(target_os = "macos")]
const OPEN_MENU_ID: &str = "open-new-file";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Must be the first plugin: a second launch (e.g. "Open with" on Windows) passes
        // its file to the running window instead of opening a second one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = file_arg(argv.into_iter().skip(1)) {
                *app.state::<PendingFile>().path.lock().unwrap() = Some(path);
                let _ = app.emit("open-file", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Running::default())
        .manage(PendingFile::default());

    // macOS: standard menu bar plus "Open New File…" (⌘O) under "File". Windows keeps
    // its windows without a menu bar; there the home icon or Ctrl+O opens files.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            let menu = Menu::default(app)?;
            for item in menu.items()? {
                if let Some(sub) = item.as_submenu() {
                    if sub.text()? == "File" {
                        let open = MenuItem::with_id(app, OPEN_MENU_ID, "Open New File…", true, Some("CmdOrCtrl+O"))?;
                        sub.prepend_items(&[&open, &PredefinedMenuItem::separator(app)?])?;
                    }
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == OPEN_MENU_ID {
                let _ = app.emit("menu-open", ());
            }
        });

    let app = builder
        .setup(|app| {
            let server = MediaServer::start().map_err(|e| format!("Preview server: {e}"))?;
            app.manage(server);
            // Warm up the ffmpeg search and encoder test in the background
            std::thread::spawn(|| {
                tools();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            encoder_info,
            initial_file,
            frontend_log,
            probe,
            media_url,
            export_video,
            render_edit,
            cancel_export,
            temp_output,
            finalize_export,
            discard_temp,
            unique_path,
            path_exists
        ])
        .build(tauri::generate_context!())
        .expect("Trimly couldn't start");

    app.run(|_app, _event| {
        // macOS delivers "Open with" as an event, not as a start argument. The file is
        // remembered (in case the UI is still loading) and the UI is notified.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                *_app.state::<PendingFile>().path.lock().unwrap() = Some(path.display().to_string());
                let _ = _app.emit("open-file", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_outputs_are_unique_and_recognised() {
        let a = temp_output("mp4".into());
        let b = temp_output("mp4".into());
        assert_ne!(a, b);
        assert!(is_own_temp(Path::new(&a)));
        assert!(!is_own_temp(Path::new("/home/x/video.mp4")));
        // only harmless extensions
        assert!(temp_output("../../x".into()).ends_with(".x"));
    }

    #[test]
    fn unique_path_counts_up() {
        let dir = std::env::temp_dir().join(format!("trimly-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("clip_trim.mp4");
        assert_eq!(unique_path(p.display().to_string()), p.display().to_string());
        std::fs::write(&p, b"x").unwrap();
        assert!(unique_path(p.display().to_string()).ends_with("clip_trim (2).mp4"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
