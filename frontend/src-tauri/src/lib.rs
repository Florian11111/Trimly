pub mod ffmpeg;
mod media_server;

use ffmpeg::{ExportRequest, VideoInfo};
use media_server::MediaServer;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{Manager, State};

const MISSING_FFMPEG: &str =
    "ffmpeg wurde nicht gefunden. Installiere es im Terminal mit: brew install ffmpeg";
pub const CANCELLED: &str = "cancelled";

struct Tools {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    encoder: &'static str,
}

fn tools() -> &'static Tools {
    static TOOLS: OnceLock<Tools> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let ffmpeg = ffmpeg::find_tool("ffmpeg");
        let encoder = ffmpeg
            .as_ref()
            .and_then(|p| Command::new(p).args(["-hide_banner", "-encoders"]).output().ok())
            .map(|o| ffmpeg::pick_encoder(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(ffmpeg::SW_ENCODER);
        Tools { ffmpeg, ffprobe: ffmpeg::find_tool("ffprobe"), encoder }
    })
}

/// Der gerade laufende ffmpeg-Prozess, damit „Abbrechen“ ihn beenden kann.
#[derive(Default)]
struct Running {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<Mutex<bool>>,
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

#[tauri::command]
fn encoder_info() -> EncoderInfo {
    let t = tools();
    let label = match (&t.ffmpeg, t.encoder) {
        (None, _) => MISSING_FFMPEG.to_string(),
        (Some(_), ffmpeg::HW_ENCODER) => "Kodierung mit Apple VideoToolbox (Hardware)".to_string(),
        (Some(_), _) => "Kodierung mit libx264 (Software)".to_string(),
    };
    EncoderInfo {
        label,
        hardware: t.ffmpeg.is_some() && t.encoder == ffmpeg::HW_ENCODER,
        ffmpeg: t.ffmpeg.as_ref().map(|p| p.display().to_string()),
    }
}

/// Datei aus der Kommandozeile (`Trimly video.mp4`), falls angegeben.
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
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

#[tauri::command]
async fn probe(path: String) -> Result<VideoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffprobe = tools().ffprobe.clone().ok_or(MISSING_FFMPEG)?;
        let out = Command::new(ffprobe)
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(&path)
            .output()
            .map_err(|e| format!("ffprobe konnte nicht gestartet werden: {e}"))?;
        if !out.status.success() {
            return Err("Diese Datei kann nicht gelesen werden. Ist es ein Video?".to_string());
        }
        ffmpeg::parse_probe(&String::from_utf8_lossy(&out.stdout))
    })
    .await
    .map_err(|e| e.to_string())?
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
        let args = ffmpeg::build_args(&request, t.encoder)?;
        let clip = request.clip_seconds();
        let started = Instant::now();

        {
            let slot = child_slot.lock().unwrap();
            if slot.is_some() {
                return Err("Es läuft bereits ein Export.".to_string());
            }
        }
        *cancelled.lock().unwrap() = false;

        let mut child = Command::new(ffmpeg_path)
            .args(&args)
            .stdin(Stdio::null())
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
            let _ = std::fs::remove_file(&request.output);
            return Err(CANCELLED.to_string());
        }
        match status {
            Some(Ok(s)) if s.success() => {}
            _ => {
                let _ = std::fs::remove_file(&request.output);
                return Err(format!("ffmpeg ist fehlgeschlagen:\n{stderr_tail}"));
            }
        }

        let size = std::fs::metadata(&request.output).map(|m| m.len()).unwrap_or(0);
        Ok(ExportResult {
            size,
            seconds: started.elapsed().as_secs_f64(),
            encoder: if request.copy { "copy".into() } else { t.encoder.to_string() },
        })
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Running::default())
        .setup(|app| {
            let server = MediaServer::start().map_err(|e| format!("Vorschau-Server: {e}"))?;
            app.manage(server);
            // ffmpeg-Suche und Encoder-Erkennung im Hintergrund vorwärmen
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
            cancel_export
        ])
        .run(tauri::generate_context!())
        .expect("Trimly konnte nicht gestartet werden");
}
