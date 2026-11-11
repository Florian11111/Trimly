import { fileExtension, fileStem } from "../lib/format";

// Leer (Prod) → relative URLs über nginx; nicht gesetzt (Dev) → lokales Backend.
export const API =
  process.env.REACT_APP_API_URL !== undefined
    ? process.env.REACT_APP_API_URL
    : "http://localhost:9000";

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"];

const POLL_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isVideoFile(file) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function uploadOriginal(file, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("video", file);
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      onUploadProgress?.(null);
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("The server sent an unexpected answer."));
        return;
      }
      if (result.status === "success") resolve(result.originalId);
      else reject(new Error(`Upload failed: ${result.message}`));
    };
    xhr.onerror = () => {
      onUploadProgress?.(null);
      reject(new Error("Can't reach the server. Is the backend running on port 9000?"));
    };
    xhr.open("POST", `${API}/store`);
    xhr.send(form);
  });
}

// Direkter Link: der Browser streamt die Datei auf die Platte, statt sie im RAM zu puffern
function triggerDownload(filename, downloadName) {
  const a = document.createElement("a");
  a.href = `${API}/download/${encodeURIComponent(filename)}?name=${encodeURIComponent(downloadName)}`;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function processForm(originalId, job) {
  const { start, end, volume, target, output } = job;
  const form = new FormData();
  form.append("originalId", originalId);
  form.append("mode", target.copy ? "original" : "custom");
  form.append("startTime", Math.floor(start * 1000));
  form.append("endTime", Math.floor(end * 1000));
  form.append("volume", volume);
  form.append("output", output);
  if (!target.copy) {
    form.append("framerate", target.fps);
    form.append("bitrate", target.bitrate);
    form.append("resolution", `${target.width}x${target.height}`);
  }
  return form;
}

export function createWebPlatform() {
  return {
    kind: "web",

    // Chrome/Edge: Dialog im Videos-Ordner starten (dort speichern NVIDIA App und AMD ReLive).
    // Ohne File System Access API: null → die App nutzt das normale <input type=file>.
    async pick() {
      if (!window.showOpenFilePicker) return null;
      try {
        const [handle] = await window.showOpenFilePicker({
          id: "trimly-videos",
          startIn: "videos",
          types: [{ description: "Videos", accept: { "video/*": VIDEO_EXTENSIONS } }],
        });
        return await handle.getFile();
      } catch (e) {
        if (e.name === "AbortError") return undefined; // abgebrochen: nichts tun
        return null;
      }
    },

    open(file, { onUploadProgress } = {}) {
      if (!isVideoFile(file)) {
        throw new Error("This file isn't a video. Choose an MP4, MOV or WebM file.");
      }
      const src = URL.createObjectURL(file);
      const ref = { file, uploaded: null };
      // Original hochladen; schlägt es fehl oder ist es auf dem Server abgelaufen,
      // lädt der Export es automatisch neu hoch
      ref.ensureUploaded = (force = false) => {
        if (force || !ref.uploaded) {
          onUploadProgress?.(0);
          ref.uploaded = uploadOriginal(file, onUploadProgress);
          ref.uploaded.catch(() => {
            ref.uploaded = null;
          });
        }
        return ref.uploaded;
      };
      ref.ensureUploaded().catch(() => {});
      return {
        name: file.name,
        size: file.size,
        src,
        ref,
        dispose: () => URL.revokeObjectURL(src),
      };
    },

    async exportVideo(video, job, { onProgress } = {}) {
      onProgress?.(null);
      const ref = video.ref;

      let originalId = await ref.ensureUploaded();
      const send = (id) => fetch(`${API}/process`, { method: "POST", body: processForm(id, job) });
      let data = await (await send(originalId)).json();
      if (data.status === "missing") {
        // Server kennt das Original nicht mehr (abgelaufen oder neu gestartet)
        originalId = await ref.ensureUploaded(true);
        data = await (await send(originalId)).json();
      }
      if (data.status !== "success") throw new Error(data.message || "The server refused the export.");

      const filename = data.filename;
      // Kein festes Zeitlimit: lange Videos dauern
      for (;;) {
        await sleep(POLL_MS);
        let state;
        try {
          state = await (await fetch(`${API}/check/${encodeURIComponent(filename)}`)).json();
        } catch {
          continue; // kurzer Netzwerkfehler: weiter versuchen
        }
        if (state.status === "ready") {
          const ext = job.output === "audio" ? "mp3" : fileExtension(video.name) || "mp4";
          const savedAs = `${fileStem(video.name)}_trim.${ext}`;
          triggerDownload(filename, savedAs);
          return { size: state.size, savedAs };
        }
        if (state.status === "error") throw new Error(`Export failed: ${state.message}`);
        if (state.status === "unknown") {
          throw new Error("The server lost this export (was it restarted?). Export again.");
        }
      }
    },

    async encoderInfo() {
      return { label: "Encoding on the server", hardware: false };
    },
  };
}
