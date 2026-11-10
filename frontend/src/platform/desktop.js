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

const asError = (e) => (e instanceof Error ? e : new Error(String(e)));

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

    async exportVideo(video, job, { onProgress } = {}) {
      const { start, end, volume, target, output: outputMode } = job;
      const ext =
        outputMode === "audio" ? "mp3" : target.copy ? fileExtension(video.name) || "mp4" : "mp4";
      const output = await save({
        defaultPath: `${dirName(video.ref.path)}${fileStem(video.name)}_trim.${ext}`,
        filters: [{ name: outputMode === "audio" ? "Audio" : "Video", extensions: [ext] }],
      });
      if (!output) return null;

      const channel = new Channel();
      channel.onmessage = (p) => onProgress?.(p);
      onProgress?.(0);

      try {
        const result = await invoke("export_video", {
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
          },
          onProgress: channel,
        });
        return { size: result.size, path: output, savedAs: baseName(output), seconds: result.seconds };
      } catch (e) {
        throw asError(e);
      }
    },

    // Datei, mit der die App gestartet wurde („Öffnen mit“, Doppelklick, Startargument)
    async initialFile() {
      return invoke("initial_file");
    },

    // macOS: „Öffnen mit Trimly“, während die App schon läuft
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

    async encoderInfo() {
      return invoke("encoder_info");
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
