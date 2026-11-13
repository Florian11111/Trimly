import { fileExtension, fileStem } from "../lib/format";

// Empty (production) → relative URLs through nginx; not set (dev) → local backend.
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

// Direct link: the browser streams the file to disk instead of buffering it in RAM
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

    // Chrome/Edge: open the dialog in the Videos folder (where the NVIDIA app and AMD ReLive save).
    // Without the File System Access API: null → the app uses the normal <input type=file>.
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
        if (e.name === "AbortError") return undefined; // cancelled: do nothing
        return null;
      }
    },

    open(file, { onUploadProgress } = {}) {
      if (!isVideoFile(file)) {
        throw new Error("This file isn't a video. Choose an MP4, MOV or WebM file.");
      }
      const src = URL.createObjectURL(file);
      const ref = { file, uploaded: null };
      // Upload the original; if that fails or it expired on the server,
      // the export uploads it again automatically
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

    async exportVideo(video, job, opts = {}) {
      return this.saveComputed(await this.computeVideo(video, job, opts));
    },

    // Download the finished result. The server deletes it 30 min after it is done;
    // if it is gone, this throws and the app encodes again.
    async saveComputed({ filename, savedAs, size }) {
      const state = await (await fetch(`${API}/check/${encodeURIComponent(filename)}`)).json();
      if (state.status !== "ready") throw new Error("expired");
      triggerDownload(filename, savedAs);
      return { size, savedAs };
    },

    // Nothing to do: the server cleans up by itself
    async discardComputed() {},

    // Encode on the server, but don't download yet
    async computeVideo(video, job, { onProgress } = {}) {
      onProgress?.(null);
      const ref = video.ref;

      let originalId = await ref.ensureUploaded();
      const send = (id) => fetch(`${API}/process`, { method: "POST", body: processForm(id, job) });
      let data = await (await send(originalId)).json();
      if (data.status === "missing") {
        // The server no longer knows the original (expired or restarted)
        originalId = await ref.ensureUploaded(true);
        data = await (await send(originalId)).json();
      }
      if (data.status !== "success") throw new Error(data.message || "The server refused the export.");

      const filename = data.filename;
      // No fixed time limit: long videos take time
      for (;;) {
        await sleep(POLL_MS);
        let state;
        try {
          state = await (await fetch(`${API}/check/${encodeURIComponent(filename)}`)).json();
        } catch {
          continue; // brief network error: keep trying
        }
        if (state.status === "ready") {
          const ext = job.output === "audio" ? "mp3" : fileExtension(video.name) || "mp4";
          const savedAs = `${fileStem(video.name)}_trim.${ext}`;
          return { filename, size: state.size, savedAs };
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
