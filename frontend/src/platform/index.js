// Wählt zur Laufzeit, ob Trimly im Browser (Play-Backend über HTTP) oder als
// Tauri-Desktop-App (ffmpeg direkt auf dem Rechner) läuft. Beide Varianten
// bieten dieselbe Schnittstelle:
//
//   kind                         "web" | "desktop"
//   open(source, {onUploadProgress}) → { name, size, src, ref, dispose() }
//   pick()                       Desktop: Dateidialog, Web: null (nutzt <input>)
//   exportVideo(video, job, {onProgress}) → Ergebnis oder null bei Abbruch
//   cancel()                     laufenden Export abbrechen (falls unterstützt)
//   encoderInfo()                → { label, hardware }
//   onDragDrop(handler)          Desktop: Drag & Drop aus dem Finder
//   reveal(path)                 Desktop: Datei im Finder zeigen
//   renderEdit({project, overlays, name, output}, {onProgress})
//                                nur Desktop: Editor-Projekt lokal rendern (Web: POST /render im Editor)

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadPlatform() {
  if (isDesktop) {
    const { createDesktopPlatform } = await import("./desktop");
    return createDesktopPlatform();
  }
  const { createWebPlatform } = await import("./web");
  return createWebPlatform();
}
