// Picks at runtime whether Trimly runs in the browser (Play backend over HTTP) or as
// a Tauri desktop app (ffmpeg directly on the machine). Both variants
// offer the same interface:
//
//   kind                         "web" | "desktop"
//   open(source, {onUploadProgress}) → { name, size, src, ref, dispose() }
//   pick()                       Desktop: file dialog, web: null (uses <input>)
//   exportVideo(video, job, {onProgress}) → result, or null if cancelled
//   cancel()                     cancel the running export (if supported)
//   encoderInfo()                → { label, hardware }
//   onDragDrop(handler)          Desktop: drag & drop from the Finder
//   reveal(path)                 Desktop: show the file in the Finder
//   renderEdit({project, overlays, name, output}, {onProgress})
//                                desktop only: render an editor project locally (web: POST /render in the editor)

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
