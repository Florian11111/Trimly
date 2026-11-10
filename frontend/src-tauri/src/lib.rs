pub mod edit;
pub mod ffmpeg;
mod media_server;

use ffmpeg::{ExportRequest, VideoInfo};
use media_server::MediaServer;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{Manager, State};

#[cfg(target_os = "macos")]
const MISSING_FFMPEG: &str =
    "ffmpeg wurde nicht gefunden. Installiere es im Terminal mit: brew install ffmpeg";
#[cfg(windows)]
const MISSING_FFMPEG: &str =
    "ffmpeg wurde nicht gefunden. Installiere es in der Eingabeaufforderung mit: winget install ffmpeg";
#[cfg(not(any(target_os = "macos", windows)))]
const MISSING_FFMPEG: &str = "ffmpeg wurde nicht gefunden. Installiere es über die Paketverwaltung.";

pub const CANCELLED: &str = "cancelled";

struct Tools {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    encoder: &'static str,
}

/// ffmpeg/ffprobe starten, ohne dass unter Windows jedes Mal ein Konsolenfenster aufblitzt.
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

/// Läuft ein kurzer Test-Encode mit diesem Encoder durch?
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
        // TRIMLY_ENCODER=cpu erzwingt Software-Kodierung (wie im Backend)
        let forced_cpu = std::env::var("TRIMLY_ENCODER").is_ok_and(|v| v.eq_ignore_ascii_case("cpu"));
        let encoder = match (&ffmpeg, forced_cpu) {
            (Some(path), false) => tool_command(path)
                .args(["-hide_banner", "-encoders"])
                .output()
                .ok()
                .map(|o| ffmpeg::listed_hw_encoders(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or_default()
                .into_iter()
                .find(|e| encoder_works(path, e))
                .unwrap_or(ffmpeg::SW_ENCODER),
            _ => ffmpeg::SW_ENCODER,
        };
        eprintln!("[ffmpeg] {:?}, Encoder: {encoder}", ffmpeg);
        Tools { ffmpeg, ffprobe: ffmpeg::find_tool("ffprobe"), encoder }
    })
}

/// Der gerade laufende ffmpeg-Prozess, damit „Abbrechen“ ihn beenden kann.
#[derive(Default)]
struct Running {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<Mutex<bool>>,
}

/// Datei, die per „Öffnen mit“ kam und noch nicht von der Oberfläche abgeholt wurde.
#[derive(Default)]
struct PendingFile {
    path: Mutex<Option<String>>,
    argv_used: Mutex<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderInfo {
    label: String,
    hardware: bool,
    ffmpeg: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    size: u64,
    seconds: f64,
    encoder: String,
}

/// Async, damit das Warten auf den Encoder-Test nicht den Haupt-Thread (und damit das Fenster) blockiert.
#[tauri::command]
async fn encoder_info() -> Result<EncoderInfo, String> {
    tauri::async_runtime::spawn_blocking(encoder_info_blocking).await.map_err(|e| e.to_string())
}

fn encoder_info_blocking() -> EncoderInfo {
    let t = tools();
    let hardware = t.ffmpeg.is_some() && ffmpeg::is_hardware(t.encoder);
    let label = match &t.ffmpeg {
        None => MISSING_FFMPEG.to_string(),
        Some(_) if hardware => format!("Kodierung mit {} (Hardware)", ffmpeg::encoder_label(t.encoder)),
        Some(_) => "Kodierung mit libx264 (Software)".to_string(),
    };
    EncoderInfo { label, hardware, ffmpeg: t.ffmpeg.as_ref().map(|p| p.display().to_string()) }
}

/// Datei, mit der Trimly geöffnet wurde: „Öffnen mit“ auf macOS (Ereignis) oder
/// Startargument (Windows-Dateizuordnung, `Trimly video.mp4`). Liefert sie nur einmal.
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
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

/// Meldungen der Oberfläche im Terminal ausgeben (Fehlersuche).
#[tauri::command]
fn frontend_log(message: String) {
    eprintln!("[ui] {message}");
}

/// Gibt eine Datei für die Vorschau frei und liefert ihre lokale URL.
#[tauri::command]
fn media_url(path: String, server: State<'_, MediaServer>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("Die Datei gibt es nicht mehr.".into());
    }
    Ok(server.register(&p))
}

fn probe_file(path: &str) -> Result<VideoInfo, String> {
    let ffprobe = tools().ffprobe.clone().ok_or(MISSING_FFMPEG)?;
    let out = tool_command(&ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe konnte nicht gestartet werden: {e}"))?;
    if !out.status.success() {
        return Err("Diese Datei kann nicht gelesen werden. Ist es ein Video?".to_string());
    }
    ffmpeg::parse_probe(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command]
async fn probe(path: String) -> Result<VideoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || probe_file(&path)).await.map_err(|e| e.to_string())?
}

/// Ein ffmpeg-Lauf mit Fortschritt. Err(CANCELLED) bei Abbruch, sonst Err mit den letzten stderr-Zeilen.
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
        .map_err(|e| format!("ffmpeg konnte nicht gestartet werden: {e}"))?;

    let stdout = child.stdout.take().expect("stdout ist gepiped");
    let mut stderr = child.stderr.take().expect("stderr ist gepiped");
    *child_slot.lock().unwrap() = Some(child);

    // stderr nebenher leeren (sonst kann ffmpeg blockieren), letzte Zeilen behalten
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
        _ => Err(format!("ffmpeg ist fehlgeschlagen:\n{stderr_tail}")),
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
            return Err("Es läuft bereits ein Export.".to_string());
        }
        *cancelled.lock().unwrap() = false;

        let encodes_video = !request.copy && request.streams != "audio";
        let mut encoder = t.encoder;
        let mut result = run_ffmpeg(
            &ffmpeg_path,
            &ffmpeg::build_args(&request, encoder)?,
            clip,
            &on_progress,
            &child_slot,
            &cancelled,
        );

        // Hardware kann an einzelnen Videos scheitern (10 bit, exotische Auflösung):
        // dann mit libx264 neu versuchen, wie das Backend
        if let Err(e) = &result {
            if e != CANCELLED && encodes_video && ffmpeg::is_hardware(encoder) {
                eprintln!("[ffmpeg] {encoder} fehlgeschlagen, nutze libx264: {e}");
                encoder = ffmpeg::SW_ENCODER;
                let _ = on_progress.send(0.0);
                result = run_ffmpeg(
                    &ffmpeg_path,
                    &ffmpeg::build_args(&request, encoder)?,
                    clip,
                    &on_progress,
                    &child_slot,
                    &cancelled,
                );
            }
        }

        if let Err(e) = result {
            let _ = std::fs::remove_file(&request.output);
            return Err(e);
        }

        let size = std::fs::metadata(&request.output).map(|m| m.len()).unwrap_or(0);
        Ok(ExportResult {
            size,
            seconds: started.elapsed().as_secs_f64(),
            encoder: if encodes_video { encoder.to_string() } else { "copy".into() },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Editor-Export (Gegenstück zu POST /render im Backend). `overlays` sind PNGs als Base64,
/// in derselben Reihenfolge wie `overlay_0`, `overlay_1`, … im Projekt.
#[tauri::command]
async fn render_edit(
    project: edit::EditProject,
    overlays: Vec<String>,
    output: String,
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
            return Err("Es läuft bereits ein Export.".to_string());
        }
        *cancelled.lock().unwrap() = false;

        // Overlays als Dateien ablegen; der Ordner wird am Ende wieder gelöscht
        let dir = std::env::temp_dir().join(format!("trimly-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Temporärer Ordner: {e}"))?;
        let mut overlay_files = std::collections::HashMap::new();
        for (i, data) in overlays.iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "Ein Overlay ist beschädigt.".to_string())?;
            let file = dir.join(format!("overlay_{i}.png"));
            std::fs::write(&file, bytes).map_err(|e| format!("Overlay speichern: {e}"))?;
            overlay_files.insert(format!("overlay_{i}"), file.display().to_string());
        }

        let result = (|| {
            edit::validate(&project, &overlay_files)?;
            // Jede Quelle einmal prüfen: gibt es sie noch, hat sie Ton, welche Bildrate?
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
                    .ok_or("Das Projekt hat keinen Ton.")?;
                run_ffmpeg(&ffmpeg_path, &args, project.audio_total(), &on_progress, &child_slot, &cancelled)?;
                return Ok("copy".to_string());
            }

            let total = project.total();
            let run = |encoder: &str| {
                let args = edit::build_video_args(&project, &overlay_files, source_fps, &has_audio, encoder, &output);
                run_ffmpeg(&ffmpeg_path, &args, total, &on_progress, &child_slot, &cancelled)
            };
            // Filter laufen auf der CPU, kodiert wird mit Hardware, falls vorhanden
            match run(t.encoder) {
                Err(e) if e != CANCELLED && ffmpeg::is_hardware(t.encoder) => {
                    eprintln!("[edit] {} fehlgeschlagen, nutze libx264: {e}", t.encoder);
                    let _ = on_progress.send(0.0);
                    run(ffmpeg::SW_ENCODER).map(|_| ffmpeg::SW_ENCODER.to_string())
                }
                other => other.map(|_| t.encoder.to_string()),
            }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Running::default())
        .manage(PendingFile::default())
        .setup(|app| {
            let server = MediaServer::start().map_err(|e| format!("Vorschau-Server: {e}"))?;
            app.manage(server);
            // ffmpeg-Suche und Encoder-Test im Hintergrund vorwärmen
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
            cancel_export
        ])
        .build(tauri::generate_context!())
        .expect("Trimly konnte nicht gestartet werden");

    app.run(|_app, _event| {
        // macOS liefert „Öffnen mit“ als Ereignis, nicht als Startargument. Die Datei wird
        // gemerkt (falls die Oberfläche noch lädt) und die Oberfläche benachrichtigt.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            use tauri::Emitter;
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                *_app.state::<PendingFile>().path.lock().unwrap() = Some(path.display().to_string());
                let _ = _app.emit("open-file", ());
            }
        }
    });
}
