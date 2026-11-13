import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { videoDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fileExtension, fileStem } from "../lib/format";

const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi"];

// Windows paths use "\\", macOS "/"
const lastSep = (path) => Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
const baseName = (path) => path.slice(lastSep(path) + 1);
const dirName = (path) => path.slice(0, lastSep(path) + 1);
const joinPath = (dir, name) => (/[\\/]$/.test(dir) ? dir + name : `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`);

const asError = (e) => (e instanceof Error ? e : new Error(String(e)));

// PNG blob → Base64 without the "data:" prefix (Rust decodes it in render_edit)
const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Saves an export result:
 * - Default folder set (and not `askLocation`): straight there, with a free file name.
 * - Otherwise the export starts right away into a temp file while the save dialog is open,
 *   and is moved afterwards. Cancelling the dialog also cancels the export.
 * `start(outputPath)` starts the Rust command and returns its promise.
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
  // Report errors only after the dialog, but don't lose them as "unhandled"
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

// File name, extension and start folder of a trim export
function trimTarget(video, { target, output }) {
  return {
    name: `${fileStem(video.name)}_trim`,
    ext: output === "audio" ? "mp3" : target.copy ? fileExtension(video.name) || "mp4" : "mp4",
    kind: output === "audio" ? "Audio" : "Video",
    sourceDir: dirName(video.ref.path),
  };
}

function runTrim(video, job, settings, output, onProgress) {
  const { start, end, volume, target, output: outputMode } = job;
  return invoke("export_video", {
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
  });
}

export function createDesktopPlatform() {
  return {
    kind: "desktop",

    async pick() {
      // The first dialog starts in the Videos folder, after that the system remembers the last one
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
        // Own local server instead of the asset protocol, see media_server.rs
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
      try {
        return await saveExport({ ...trimTarget(video, job), settings, askLocation }, (output) =>
          runTrim(video, job, settings, output, onProgress)
        );
      } catch (e) {
        throw asError(e);
      }
    },

    // "Compute only": encode into a temp file to know the exact size.
    // saveComputed then saves it without encoding again, discardComputed deletes it.
    async computeVideo(video, job, { onProgress, settings } = {}) {
      const info = trimTarget(video, job);
      const temp = await invoke("temp_output", { ext: info.ext });
      try {
        const result = await runTrim(video, job, settings, temp, onProgress);
        return { ...result, ...info, temp };
      } catch (e) {
        await invoke("discard_temp", { path: temp }).catch(() => {});
        throw asError(e);
      }
    },

    async saveComputed(computed, { settings, askLocation } = {}) {
      const { name, ext, kind, sourceDir, temp, size } = computed;
      const fileName = `${name}.${ext}`;
      const folder = settings?.outputDir;
      let dest;
      try {
        if (folder && !askLocation && (await invoke("path_exists", { path: folder }))) {
          dest = await invoke("unique_path", { path: joinPath(folder, fileName) });
        } else {
          dest = await save({
            defaultPath: joinPath(folder || sourceDir, fileName),
            filters: [{ name: kind, extensions: [ext] }],
          });
          // Dialog cancelled: the result is kept
          if (!dest) return null;
        }
        await invoke("finalize_export", { from: temp, to: dest });
      } catch (e) {
        throw asError(e);
      }
      return { size, path: dest, savedAs: baseName(dest) };
    },

    async discardComputed(computed) {
      if (computed?.temp) await invoke("discard_temp", { path: computed.temp }).catch(() => {});
    },

    // Editor export: project from buildRenderProject, overlays as PNG blobs (overlay_0, overlay_1, …)
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

    // File the app was started with ("Open with", double-click, start argument)
    async initialFile() {
      return invoke("initial_file");
    },

    // "Open with Trimly" while the app is already running (macOS event, Windows: second launch)
    async onOpenFile(handler) {
      return listen("open-file", () => {
        invoke("initial_file").then((path) => path && handler(path));
      });
    },

    // macOS menu "File › Open New File…" (⌘O), see lib.rs
    async onMenuOpen(handler) {
      return listen("menu-open", () => handler());
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
