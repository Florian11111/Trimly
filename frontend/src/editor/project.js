// Projektmodell des Editors (reine Funktionen, ohne React).
//
// project = {
//   clips:     { [clipId]: { url, name, duration } },   // Server-IDs separat (nicht im Undo-Verlauf)
//   videoSegs: [{ id, clipId, srcStart, srcEnd, volume }]          // laufen nacheinander
//   audioSegs: null | [{ id, clipId, srcStart, srcEnd, tlStart, volume }]  // null = mit Video verbunden
//   overlays:  [{ id, type: "arrow"|"text"|"image", start, end, ... }]
//   zooms:     [{ id, start, end, x, y, w }]
// }

// Kürzester Abschnitt in Sekunden (Backend erlaubt ab 0.005)
export const MIN_LEN = 0.01;

let nextId = 1;
export const newId = (prefix) => `${prefix}${Date.now().toString(36)}_${nextId++}`;

export const emptyProject = () => ({ clips: {}, videoSegs: [], audioSegs: null, overlays: [], zooms: [] });

// Videoabschnitte mit Position auf der Timeline
export function layoutVideo(videoSegs) {
  let t = 0;
  return videoSegs.map(s => {
    const len = s.srcEnd - s.srcStart;
    const item = { ...s, tlStart: t, len };
    t += len;
    return item;
  });
}

export const totalDuration = (project) =>
  project.videoSegs.reduce((sum, s) => sum + (s.srcEnd - s.srcStart), 0);

// Tonspur, wie sie abgespielt/exportiert wird: verbunden = folgt der Videospur
export function effectiveAudio(project) {
  if (project.audioSegs) return project.audioSegs;
  return layoutVideo(project.videoSegs).map(s => ({
    id: s.id, clipId: s.clipId, srcStart: s.srcStart, srcEnd: s.srcEnd, tlStart: s.tlStart, volume: s.volume,
  }));
}

export function addClip(project, clipId, clip) {
  const total = totalDuration(project);
  const seg = { id: newId("v"), clipId, srcStart: 0, srcEnd: clip.duration, volume: 1 };
  return {
    ...project,
    clips: { ...project.clips, [clipId]: clip },
    videoSegs: [...project.videoSegs, seg],
    // getrennte Tonspur: Ton des neuen Clips ans Ende legen
    audioSegs: project.audioSegs && [
      ...project.audioSegs,
      { id: newId("a"), clipId, srcStart: 0, srcEnd: clip.duration, tlStart: total, volume: 1 },
    ],
  };
}

// Videoabschnitt am Timeline-Zeitpunkt t teilen
export function splitVideoAt(project, t) {
  const layout = layoutVideo(project.videoSegs);
  const i = layout.findIndex(s => t > s.tlStart + MIN_LEN && t < s.tlStart + s.len - MIN_LEN);
  if (i < 0) return project;
  const s = project.videoSegs[i];
  const cut = s.srcStart + (t - layout[i].tlStart);
  const a = { ...s, srcEnd: cut };
  const b = { ...s, id: newId("v"), srcStart: cut };
  const videoSegs = [...project.videoSegs];
  videoSegs.splice(i, 1, a, b);
  return { ...project, videoSegs };
}

// Abschnitt der getrennten Tonspur am Timeline-Zeitpunkt t teilen
export function splitAudioAt(project, segId, t) {
  if (!project.audioSegs) return project;
  const i = project.audioSegs.findIndex(s => s.id === segId);
  if (i < 0) return project;
  const s = project.audioSegs[i];
  const len = s.srcEnd - s.srcStart;
  if (t <= s.tlStart + MIN_LEN || t >= s.tlStart + len - MIN_LEN) return project;
  const cut = s.srcStart + (t - s.tlStart);
  const audioSegs = [...project.audioSegs];
  audioSegs.splice(i, 1, { ...s, srcEnd: cut }, { ...s, id: newId("a"), srcStart: cut, tlStart: t });
  return { ...project, audioSegs };
}

export function detachAudio(project) {
  if (project.audioSegs) return project;
  return { ...project, audioSegs: effectiveAudio(project).map(s => ({ ...s, id: newId("a") })) };
}

export const linkAudio = (project) => ({ ...project, audioSegs: null });

export function moveVideoSeg(project, segId, dir) {
  const i = project.videoSegs.findIndex(s => s.id === segId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= project.videoSegs.length) return project;
  const videoSegs = [...project.videoSegs];
  [videoSegs[i], videoSegs[j]] = [videoSegs[j], videoSegs[i]];
  return { ...project, videoSegs };
}

export function removeItem(project, kind, id) {
  if (kind === "video") {
    if (project.videoSegs.length <= 1) return project; // mindestens ein Abschnitt bleibt
    return { ...project, videoSegs: project.videoSegs.filter(s => s.id !== id) };
  }
  if (kind === "audio") return { ...project, audioSegs: (project.audioSegs || []).filter(s => s.id !== id) };
  if (kind === "overlay") return { ...project, overlays: project.overlays.filter(o => o.id !== id) };
  if (kind === "zoom") return { ...project, zooms: project.zooms.filter(z => z.id !== id) };
  return project;
}

export function updateItem(project, kind, id, patch) {
  const apply = (list) => list.map(x => (x.id === id ? { ...x, ...patch } : x));
  if (kind === "video") return { ...project, videoSegs: apply(project.videoSegs) };
  if (kind === "audio") return { ...project, audioSegs: apply(project.audioSegs || []) };
  if (kind === "overlay") return { ...project, overlays: apply(project.overlays) };
  if (kind === "zoom") return { ...project, zooms: apply(project.zooms) };
  return project;
}

// Ziehen auf der Timeline: neue Werte aus dem Zustand bei Drag-Beginn (orig) + Verschiebung dt
export function dragPatch(kind, mode, orig, dt, ctx) {
  const clampv = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (kind === "video") {
    const dur = ctx.clipDuration;
    if (mode === "start") return { srcStart: clampv(orig.srcStart + dt, 0, orig.srcEnd - MIN_LEN) };
    if (mode === "end") return { srcEnd: clampv(orig.srcEnd + dt, orig.srcStart + MIN_LEN, dur) };
    return null;
  }
  if (kind === "audio") {
    const dur = ctx.clipDuration;
    if (mode === "move") return { tlStart: Math.max(0, orig.tlStart + dt) };
    if (mode === "start") {
      const d = clampv(dt, Math.max(-orig.srcStart, -orig.tlStart), orig.srcEnd - orig.srcStart - MIN_LEN);
      return { srcStart: orig.srcStart + d, tlStart: orig.tlStart + d };
    }
    if (mode === "end") return { srcEnd: clampv(orig.srcEnd + dt, orig.srcStart + MIN_LEN, dur) };
    return null;
  }
  // Overlay / Zoom: Zeitbereich innerhalb des Projekts
  const total = ctx.total;
  const len = orig.end - orig.start;
  if (mode === "move") {
    const start = clampv(orig.start + dt, 0, Math.max(0, total - len));
    return { start, end: start + len };
  }
  if (mode === "start") return { start: clampv(orig.start + dt, 0, orig.end - MIN_LEN) };
  if (mode === "end") return { end: clampv(orig.end + dt, orig.start + MIN_LEN, total) };
  return null;
}

// Projekt für POST /render. Liefert auch die Overlays, die als overlay_<i>.png mitgeschickt werden müssen
// (Einträge hinter dem Videoende fallen weg, beim reinen Ton-Export bleibt die ganze Tonspur).
export function buildRenderProject(project, preset, originalIds, output = "both") {
  const total = totalDuration(project);
  const originalId = (clipId) => originalIds[clipId];
  const inRange = (x) => x.start < total - MIN_LEN;
  const overlays = project.overlays.filter(inRange);
  const body = {
    preset: { width: preset.width, height: preset.height, fps: preset.fps, bitrate: preset.bitrate },
    video: project.videoSegs.map(s => ({ originalId: originalId(s.clipId), start: s.srcStart, end: s.srcEnd })),
    audio: effectiveAudio(project)
      .filter(s => output === "audio" || s.tlStart < total)
      .map(s => ({ originalId: originalId(s.clipId), start: s.srcStart, end: s.srcEnd, at: s.tlStart, volume: s.volume })),
    zooms: project.zooms.filter(inRange).map(({ start, end, x, y, w }) => ({ start, end: Math.min(end, total), x, y, w })),
    overlays: overlays.map((o, i) => ({ file: `overlay_${i}`, start: o.start, end: Math.min(o.end, total) })),
    output,
  };
  return { body, overlays };
}

// Länge der Tonspur (Ende des letzten Ton-Abschnitts)
export function audioDuration(project) {
  return Math.max(0, ...effectiveAudio(project).map(s => s.tlStart + s.srcEnd - s.srcStart));
}
