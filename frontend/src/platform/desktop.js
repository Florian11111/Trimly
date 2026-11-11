import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { videoDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fileExtension, fileStem } from "../lib/format";

const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi"];

// Windows-Pfade nutzen „\\“, macOS „/“
const lastSep = (path) => Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
const baseName = (path) => path.slice(lastSep(path) + 1);
const dirName = (path) => path.slice(0, lastSep(path) + 1);
const joinPath = (dir, name) => (/[\\/]$/.test(dir) ? dir + name : `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`);

const asError = (e) => (e instanceof Error ? e : new Error(String(e)));

// PNG-Blob → Base64 ohne „data:“-Präfix (Rust dekodiert es in render_edit)
const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Speichert ein Export-Ergebnis:
 * - Standard-Ordner gesetzt (und nicht `askLocation`): direkt dorthin, freier Dateiname.
 * - Sonst startet der Export sofort in eine Temp-Datei, während der Speichern-Dialog offen ist,
 *   und wird danach verschoben. Abbrechen im Dialog bricht auch den Export ab.
 * `start(outputPath)` startet den Rust-Befehl und liefert dessen Promise.
 */
async function saveExport({ name, ext, kind, sourceDir, settings, askLocation }, start) {
  const fileName = `${name}.${ext}`;
  const folder = settings?.outputDir;

  if (folder && !askLocation && (await invoke("path_exists", { path: folder }))) {
    const output = await invoke("unique_path", { path: joinPath(folder, fileName) });
    const result = await start(output);
    return { ...result, path: output, savedAs: baseName(output) };
  }

  const temp = await invoke("temp_output", { ext });
  const running = start(temp);
  // Fehler erst nach dem Dialog melden, aber nicht als „unhandled“ verlieren
  running.catch(() => {});

  const dest = await save({
    defaultPath: joinPath(folder || sourceDir, fileName),
    filters: [{ name: kind, extensions: [ext] }],
  });
  if (!dest) {
    await invoke("cancel_export").catch(() => {});
    await running.catch(() => {});
    await invoke("discard_temp", { path: temp }).catch(() => {});
    return null;
  }
  const result = await running;
  await invoke("finalize_export", { from: temp, to: dest });
  return { ...result, path: dest, savedAs: baseName(dest) };
}

const progressChannel = (onProgress) => {
  const channel = new Channel();
  channel.onmessage = (p) => onProgress?.(p);
  onProgress?.(0);
  return channel;
};

export function createDesktopPlatform() {
  return {
    kind: "desktop",

    async pick() {
      // Erster Dialog startet im Videos-Ordner, danach merkt sich das System den letzten
      const defaultPath = await videoDir().catch(() => undefined);
      const path = await open({
        multiple: false,
        directory: false,
        defaultPath,
        filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
      });
      return typeof path === "string" ? path : null;
    },

    async pickFolder() {
      const defaultPath = await videoDir().catch(() => undefined);
      const path = await open({ directory: true, multiple: false, defaultPath });
      return typeof path === "string" ? path : null;
    },

    async open(path) {
      let info;
      let src;
      try {
        info = await invoke("probe", { path });
        // Eigener lokaler Server statt Asset-Protokoll, siehe media_server.rs
        src = await invoke("media_url", { path });
      } catch (e) {
        throw asError(e);
      }
      return {
        name: baseName(path),
        size: info.size,
        src,
        ref: { path, info },
        dispose: () => {},
      };
    },

    async exportVideo(video, job, { onProgress, settings, askLocation } = {}) {
      const { start, end, volume, target, output: outputMode } = job;
      const ext =
        outputMode === "audio" ? "mp3" : target.copy ? fileExtension(video.name) || "mp4" : "mp4";
      try {
        return await saveExport(
          {
            name: `${fileStem(video.name)}_trim`,
            ext,
            kind: outputMode === "audio" ? "Audio" : "Video",
            sourceDir: dirName(video.ref.path),
            settings,
            askLocation,
          },
          (output) =>
            invoke("export_video", {
              request: {
                input: video.ref.path,
                output,
                start,
                end,
                volume,
                copy: !!target.copy,
                width: target.width ?? null,
                height: target.height ?? null,
                fps: target.fps ?? null,
                bitrate: target.bitrate ?? null,
                audioBitrate: target.audioBitrate ?? null,
                streams: outputMode,
                codec: settings?.codec || "h264",
                encoder: settings?.encoder || "auto",
                maxBytes: job.maxBytes ?? null,
              },
              onProgress: progressChannel(onProgress),
            })
        );
      } catch (e) {
        throw asError(e);
      }
    },

    // Editor-Export: Projekt aus buildRenderProject, Overlays als PNG-Blobs (overlay_0, overlay_1, …)
    async renderEdit({ project, overlays, name, output: outputMode, sourcePath, settings }, { onProgress } = {}) {
      try {
        const encoded = await Promise.all(overlays.map(blobToBase64));
        return await saveExport(
          {
            name: `${fileStem(name)}_edit`,
            ext: outputMode === "audio" ? "mp3" : "mp4",
            kind: outputMode === "audio" ? "Audio" : "Video",
            sourceDir: sourcePath ? dirName(sourcePath) : "",
            settings,
          },
          (output) =>
            invoke("render_edit", {
              project,
              overlays: encoded,
              output,
              codec: settings?.codec || "h264",
              encoder: settings?.encoder || "auto",
              onProgress: progressChannel(onProgress),
            })
        );
      } catch (e) {
        throw asError(e);
      }
    },

    // Datei, mit der die App gestartet wurde („Öffnen mit“, Doppelklick, Startargument)
    async initialFile() {
      return invoke("initial_file");
    },

    // „Öffnen mit Trimly“, während die App schon läuft (macOS-Ereignis, Windows: zweiter Start)
    async onOpenFile(handler) {
      return listen("open-file", () => {
        invoke("initial_file").then((path) => path && handler(path));
      });
    },

    log(message) {
      invoke("frontend_log", { message }).catch(() => {});
    },

    async cancel() {
      await invoke("cancel_export");
    },

    async encoderInfo(settings) {
      return invoke("encoder_info", { codec: settings?.codec, encoder: settings?.encoder });
    },

    async onDragDrop(handler) {
      return getCurrentWebview().onDragDropEvent((event) => {
        const { type, paths } = event.payload;
        handler(type, paths || []);
      });
    },

    async reveal(path) {
      await revealItemInDir(path);
    },
  };
}
