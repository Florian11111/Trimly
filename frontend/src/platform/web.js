import { fileStem } from "../lib/format";

// Leer (Prod) → relative URLs über nginx; nicht gesetzt (Dev) → lokales Backend.
export const API =
  process.env.REACT_APP_API_URL !== undefined
    ? process.env.REACT_APP_API_URL
    : "http://localhost:9000";

const POLL_MS = 1000;
const POLL_LIMIT = 600; // 10 Minuten, wie der Server-Timeout

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        reject(new Error("Der Server hat nicht wie erwartet geantwortet."));
        return;
      }
      if (result.status === "success") resolve(result.originalId);
      else reject(new Error(`Hochladen fehlgeschlagen: ${result.message}`));
    };
    xhr.onerror = () => {
      onUploadProgress?.(null);
      reject(new Error("Der Server ist nicht erreichbar. Läuft das Backend auf Port 9000?"));
    };
    xhr.open("POST", `${API}/store`);
    xhr.send(form);
  });
}

async function triggerDownload(url, filename) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Das Ergebnis konnte nicht geladen werden.");
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
  return blob.size;
}

export function createWebPlatform() {
  return {
    kind: "web",

    async pick() {
      return null;
    },

    open(file, { onUploadProgress } = {}) {
      if (!file || !file.type.startsWith("video/")) {
        throw new Error("Diese Datei ist kein Video. Wähle eine MP4-, MOV- oder WebM-Datei.");
      }
      const src = URL.createObjectURL(file);
      onUploadProgress?.(0);
      const uploaded = uploadOriginal(file, onUploadProgress);
      uploaded.catch(() => {}); // Fehler zeigt erst der Export, nicht als unhandled rejection
      return {
        name: file.name,
        size: file.size,
        src,
        ref: { uploaded },
        dispose: () => URL.revokeObjectURL(src),
      };
    },

    async exportVideo(video, job, { onProgress } = {}) {
      const { start, end, volume, target } = job;
      if (target.copy) throw new Error("„Nur schneiden“ gibt es nur in der Desktop-App.");

      onProgress?.(null);
      const originalId = await video.ref.uploaded;

      const form = new FormData();
      form.append("originalId", originalId);
      form.append("startTime", Math.floor(start * 1000));
      form.append("endTime", Math.floor(end * 1000));
      form.append("volume", volume);
      form.append("framerate", target.fps);
      form.append("bitrate", target.bitrate);
      form.append("resolution", `${target.width}x${target.height}`);

      const res = await fetch(`${API}/process`, { method: "POST", body: form });
      const data = await res.json();
      if (data.status !== "success") throw new Error(data.message || "Verarbeitung abgelehnt.");

      const filename = data.filename;
      for (let i = 0; i < POLL_LIMIT; i++) {
        await sleep(POLL_MS);
        let state;
        try {
          state = await (await fetch(`${API}/check/${encodeURIComponent(filename)}`)).json();
        } catch {
          continue; // kurzer Netzwerkfehler: weiter versuchen
        }
        if (state.failed) throw new Error(state.message || "ffmpeg ist fehlgeschlagen.");
        if (state.exists && state.size) {
          const savedAs = `${fileStem(video.name)}_trim.mp4`;
          const size = await triggerDownload(
            `${API}/download/${encodeURIComponent(filename)}`,
            savedAs
          );
          return { size, savedAs };
        }
      }
      throw new Error("Die Verarbeitung hat zu lange gedauert. Versuche einen kürzeren Ausschnitt.");
    },

    async encoderInfo() {
      return { label: "Verarbeitung auf dem Server", hardware: false };
    },
  };
}
