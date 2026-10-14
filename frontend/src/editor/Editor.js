import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import "./Editor.css";
import Timeline, { overlayLabel } from "./Timeline";
import { PRESETS } from "../presets";
import * as P from "./project";
import { drawOverlay, overlayBox, hitOverlay, hitZoom, zoomAt, isVisible, renderOverlayPng } from "./overlays";

// Muss zu VideoCalculator.AudioBitrateKbps bzw. FFmpegUtils.AudioOnlyBitrateKbps im Backend passen
const AUDIO_KBPS = 128;
const AUDIO_ONLY_KBPS = 192;
const EXPORT_PRESETS = ["low", "medium", "high"];
const FRAME_ASPECT = 16 / 9;
const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".mov", ".webm", ".avi"];

const presetDims = (key) => {
  const p = PRESETS[key];
  const [width, height] = p.resolution.split("x").map(Number);
  return { width, height, fps: p.fps, bitrate: p.bitrate };
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isTyping = (e) =>
  ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) && !["range", "checkbox"].includes(e.target.type);

export default function Editor({ api, mainClip, ensureMainOriginal, active, formatFileSize }) {
  const [project, setProject] = useState(P.emptyProject);
  const [originalIds, setOriginalIds] = useState({}); // clipId -> Server-ID (nicht im Undo-Verlauf)
  const [uploads, setUploads] = useState({});          // clipId -> Upload-Fortschritt in %
  const [selected, setSelected] = useState(null);      // { kind, id }
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewVolume, setPreviewVolume] = useState(1);
  const [exportPreset, setExportPreset] = useState("medium");
  const [exportOutput, setExportOutput] = useState("both"); // "both" | "video" | "audio"
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [rootWidth, setRootWidth] = useState(800);
  const [imagesVersion, setImagesVersion] = useState(0);

  const projectRef = useRef(project);
  const historyRef = useRef([]);
  const timeRef = useRef(0);
  const clockRef = useRef({ start: 0, t0: 0 });
  const videoRef = useRef(null);
  const loadedUrlRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const audioElsRef = useRef({});
  const previewVolumeRef = useRef(1);
  const imagesRef = useRef({});
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const rootRef = useRef(null);
  const dragOrigRef = useRef(null);
  const videoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const clipUploadsRef = useRef({}); // clipId -> { file, promise } für erneutes Hochladen

  previewVolumeRef.current = previewVolume;

  // ─── Projektänderungen + Rückgängig ──────────────────────────────────────

  const setProjectNow = useCallback((next) => {
    projectRef.current = next;
    setProject(next);
  }, []);
  const snapshot = useCallback(() => {
    historyRef.current.push(projectRef.current);
    if (historyRef.current.length > 100) historyRef.current.shift();
  }, []);
  // Änderung mit Eintrag im Verlauf
  const commit = useCallback((fn) => {
    snapshot();
    setProjectNow(fn(projectRef.current));
  }, [snapshot, setProjectNow]);
  // Änderung während des Ziehens (Verlaufseintrag wurde bei Drag-Beginn gemacht)
  const live = useCallback((fn) => setProjectNow(fn(projectRef.current)), [setProjectNow]);
  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (prev) {
      setProjectNow(prev);
      setSelected(null);
    }
  }, [setProjectNow]);

  // Hauptvideo aus dem Schneiden-Tab übernehmen
  useEffect(() => {
    if (!mainClip || !mainClip.duration || Object.keys(projectRef.current.clips).length) return;
    setProjectNow(P.addClip(P.emptyProject(), "main", { url: mainClip.url, name: mainClip.name, duration: mainClip.duration }));
  }, [mainClip, setProjectNow]);
  // Server-ID des Hauptvideos kann sich ändern, wenn der Schneiden-Tab es neu hochlädt
  const mainOriginalId = mainClip?.originalId;
  useEffect(() => {
    if (mainOriginalId) setOriginalIds(ids => (ids.main === mainOriginalId ? ids : { ...ids, main: mainOriginalId }));
  }, [mainOriginalId]);

  const total = P.totalDuration(project);
  const videoLayout = useMemo(() => P.layoutVideo(project.videoSegs), [project.videoSegs]);
  const audio = useMemo(() => P.effectiveAudio(project), [project]);
  const linked = !project.audioSegs;
  const exportDims = presetDims(exportPreset);

  // ─── Wiedergabe: Uhr läuft unabhängig, Video und Ton werden nachgeführt ──

  const syncMedia = useCallback((t, isPlaying) => {
    const p = projectRef.current;
    const layout = P.layoutVideo(p.videoSegs);
    const seg = layout.find(s => t >= s.tlStart && t < s.tlStart + s.len) || layout[layout.length - 1];
    const v = videoRef.current;
    if (v && seg) {
      const clip = p.clips[seg.clipId];
      const srcT = Math.min(seg.srcEnd - 0.01, seg.srcStart + Math.max(0, t - seg.tlStart));
      if (loadedUrlRef.current !== clip.url) {
        loadedUrlRef.current = clip.url;
        pendingSeekRef.current = srcT;
        v.src = clip.url;
      } else if (v.readyState >= 1) {
        if (isPlaying) {
          if (Math.abs(v.currentTime - srcT) > 0.25) v.currentTime = srcT;
          if (v.paused) v.play().catch(() => {});
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - srcT) > 0.02) v.currentTime = srcT;
        }
      } else {
        pendingSeekRef.current = srcT;
      }
      if (!isPlaying && !v.paused) v.pause();
    }

    // Ton: ein Audio-Element pro Abschnitt der (ggf. getrennten) Tonspur
    const els = audioElsRef.current;
    const alive = new Set();
    for (const s of P.effectiveAudio(p)) {
      alive.add(s.id);
      const clip = p.clips[s.clipId];
      let entry = els[s.id];
      if (!entry || entry.url !== clip.url) {
        if (entry) entry.el.pause();
        const el = new Audio(clip.url);
        el.preload = "auto";
        entry = els[s.id] = { el, url: clip.url };
      }
      const el = entry.el;
      const on = isPlaying && t >= s.tlStart && t < s.tlStart + (s.srcEnd - s.srcStart);
      el.volume = clamp(s.volume * previewVolumeRef.current, 0, 1);
      if (on) {
        const target = s.srcStart + (t - s.tlStart);
        if (el.paused) {
          el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > 0.3) {
          el.currentTime = target;
        }
      } else if (!el.paused) {
        el.pause();
      }
    }
    for (const id of Object.keys(els)) {
      if (!alive.has(id)) {
        els[id].el.pause();
        delete els[id];
      }
    }
  }, []);

  // Timeline-Zeit des gerade angezeigten Videobilds, falls das Video im Abschnitt zur Zeit t läuft
  const videoTimelineTime = (t) => {
    const v = videoRef.current;
    if (!v || v.paused || v.seeking || v.readyState < 2) return null;
    const p = projectRef.current;
    const seg = P.layoutVideo(p.videoSegs).find(s => t >= s.tlStart && t < s.tlStart + s.len);
    if (!seg || p.clips[seg.clipId]?.url !== loadedUrlRef.current) return null;
    const vt = seg.tlStart + (v.currentTime - seg.srcStart);
    // Video steht noch am Ende des vorigen Abschnitts o.ä. -> Uhr behalten, syncMedia korrigiert
    if (vt < seg.tlStart || vt >= seg.tlStart + seg.len || Math.abs(vt - t) > 0.25) return null;
    return vt;
  };

  const onVideoLoaded = () => {
    const v = videoRef.current;
    if (pendingSeekRef.current !== null) {
      v.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
    syncMedia(timeRef.current, playing);
  };

  const seek = useCallback((t) => {
    const tt = clamp(t, 0, P.totalDuration(projectRef.current));
    timeRef.current = tt;
    clockRef.current = { start: performance.now(), t0: tt };
    setTime(tt);
  }, []);

  useEffect(() => {
    if (!playing) {
      syncMedia(timeRef.current, false);
      return;
    }
    if (timeRef.current >= P.totalDuration(projectRef.current) - 0.05) seek(0);
    clockRef.current = { start: performance.now(), t0: timeRef.current };
    let raf;
    const tick = () => {
      const tot = P.totalDuration(projectRef.current);
      let t = clockRef.current.t0 + (performance.now() - clockRef.current.start) / 1000;
      // Läuft das Video im aktuellen Abschnitt, gibt es den Takt vor: Playhead (und damit „S“) = sichtbares Bild
      const vt = videoTimelineTime(t);
      if (vt !== null) {
        t = vt;
        clockRef.current = { start: performance.now(), t0: vt };
      }
      const done = t >= tot;
      if (done) t = tot;
      timeRef.current = t;
      setTime(t);
      syncMedia(t, !done);
      if (done) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, syncMedia, seek]);

  // Pausiert: Vorschau nach Sprüngen und Projektänderungen aktualisieren
  useEffect(() => {
    if (!playing) syncMedia(time, false);
  }, [time, project, playing, syncMedia]);

  // Projekt kürzer geworden (z.B. Clip gelöscht): Playhead ans Ende setzen
  useEffect(() => {
    if (time > total) seek(total);
  }, [time, total, seek]);

  // Tab verlassen: anhalten
  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  useEffect(() => () => {
    Object.values(audioElsRef.current).forEach(({ el }) => el.pause());
  }, []);

  // Originale auf dem Server aktiv halten, solange der Editor offen ist
  useEffect(() => {
    const ids = Object.values(originalIds);
    if (!ids.length) return;
    const ping = () => fetch(`${api}/keepalive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
    const timer = setInterval(ping, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [api, originalIds]);

  // ─── Größen messen ───────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (frameRef.current) setFrameSize({ w: frameRef.current.clientWidth, h: frameRef.current.clientHeight });
      if (rootRef.current) setRootWidth(rootRef.current.clientWidth);
    });
    if (frameRef.current) ro.observe(frameRef.current);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  const pxPerSec = total > 0 ? ((rootWidth - 100) / total) * timelineZoom : 50;

  // ─── Vorschau: Overlays + Auswahl zeichnen ───────────────────────────────

  const selectedZoom = selected?.kind === "zoom" ? project.zooms.find(z => z.id === selected.id) : null;
  const selectedOverlay = selected?.kind === "overlay" ? project.overlays.find(o => o.id === selected.id) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frameSize.w) return;
    const dpr = window.devicePixelRatio || 1;
    const W = frameSize.w, H = frameSize.h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    project.overlays.filter(o => isVisible(o, time) || o.id === selectedOverlay?.id)
      .forEach(o => {
        ctx.globalAlpha = isVisible(o, time) ? 1 : 0.35; // ausgewählt, aber gerade nicht sichtbar
        drawOverlay(ctx, o, W, H, imagesRef.current);
      });
    ctx.globalAlpha = 1;

    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    if (selectedOverlay) {
      const b = overlayBox(ctx, selectedOverlay, W, H, imagesRef.current);
      ctx.strokeStyle = "#60a5fa";
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      ctx.setLineDash([]);
      ctx.fillStyle = "#60a5fa";
      const handles = selectedOverlay.type === "arrow"
        ? [[selectedOverlay.x1 * W, selectedOverlay.y1 * H], [selectedOverlay.x2 * W, selectedOverlay.y2 * H]]
        : selectedOverlay.type === "image" ? [[b.x + b.w, b.y + b.h]] : [];
      handles.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); });
    }
    if (selectedZoom) {
      const x = selectedZoom.x * W, y = selectedZoom.y * H, w = selectedZoom.w * W, h = selectedZoom.w * H;
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, W, y);
      ctx.fillRect(0, y + h, W, H - y - h);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, W - x - w, h);
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.arc(x + w, y + h, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [project.overlays, time, frameSize, selectedOverlay, selectedZoom, imagesVersion]);

  // Zoom in der Vorschau per CSS (gleiche Formel wie beim Export); beim Bearbeiten eines Zooms aus
  const zoomState = selectedZoom ? { z: 1, x: 0, y: 0 } : zoomAt(project.zooms, time);
  const zoomTransform = `translate(${-zoomState.x * zoomState.z * 100}%, ${-zoomState.y * zoomState.z * 100}%) scale(${zoomState.z})`;

  // ─── Overlays/Zoom im Vorschaubild verschieben ───────────────────────────

  const onFramePointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const ctx = canvasRef.current.getContext("2d");
    const p = projectRef.current;

    let target = null;
    if (selectedZoom) {
      const hit = hitZoom(selectedZoom, px, py, W, H);
      if (hit) target = { kind: "zoom", item: selectedZoom, mode: hit.mode };
    }
    if (!target) {
      // ausgewähltes Overlay zuerst prüfen, damit verdeckte Griffe erreichbar bleiben
      const candidates = p.overlays
        .filter(o => isVisible(o, timeRef.current) || o.id === selectedOverlay?.id)
        .sort((a, b) => (a.id === selectedOverlay?.id) - (b.id === selectedOverlay?.id));
      for (let i = candidates.length - 1; i >= 0 && !target; i--) {
        const hit = hitOverlay(ctx, candidates[i], px, py, W, H, imagesRef.current);
        if (hit) target = { kind: "overlay", item: candidates[i], mode: hit.mode };
      }
    }
    if (!target) {
      if (selected && (selected.kind === "overlay" || selected.kind === "zoom")) setSelected(null);
      else setPlaying(pl => !pl);
      return;
    }
    e.preventDefault();
    setSelected({ kind: target.kind, id: target.item.id });
    snapshot();
    const o = target.item;
    let moved = false;

    const move = (ev) => {
      moved = true;
      const dx = (ev.clientX - e.clientX) / W;
      const dy = (ev.clientY - e.clientY) / H;
      let patch;
      if (target.kind === "zoom") {
        patch = target.mode === "resize"
          ? { w: clamp(o.w + Math.max(dx, dy), 0.1, Math.min(1 - o.x, 1 - o.y)) }
          : { x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.w) };
      } else if (target.mode === "p1") patch = { x1: clamp(o.x1 + dx, 0, 1), y1: clamp(o.y1 + dy, 0, 1) };
      else if (target.mode === "p2") patch = { x2: clamp(o.x2 + dx, 0, 1), y2: clamp(o.y2 + dy, 0, 1) };
      else if (target.mode === "resize") patch = { w: clamp(o.w + dx, 0.03, 1) };
      else if (o.type === "arrow") patch = { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
      else patch = { x: o.x + dx, y: o.y + dy };
      live(q => P.updateItem(q, target.kind, o.id, patch));
    };
    const up = () => {
      if (!moved) historyRef.current.pop(); // nur ausgewählt, nichts geändert
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ─── Timeline-Ziehen ─────────────────────────────────────────────────────

  const onTimelineDrag = (kind, id, mode, dt, phase) => {
    const p = projectRef.current;
    if (phase === "start") {
      const list = { video: p.videoSegs, audio: p.audioSegs || [], overlay: p.overlays, zoom: p.zooms }[kind];
      dragOrigRef.current = list.find(x => x.id === id);
      snapshot();
      return;
    }
    const orig = dragOrigRef.current;
    if (!orig) return;
    const patch = P.dragPatch(kind, mode, orig, dt, {
      clipDuration: p.clips[orig.clipId]?.duration, total: P.totalDuration(p),
    });
    if (patch) live(q => P.updateItem(q, kind, id, patch));
    if (phase === "end") {
      if (Math.abs(dt) < 1e-6) historyRef.current.pop();
      dragOrigRef.current = null;
    }
  };

  const onTimelineSelect = (kind, id) => setSelected({ kind, id });

  // ─── Werkzeuge ───────────────────────────────────────────────────────────

  // Lädt einen Clip hoch; Promise liefert die Server-ID
  const uploadClip = (file, clipId) => {
    setUploads(u => ({ ...u, [clipId]: 0 }));
    const done = () => setUploads(u => { const { [clipId]: _, ...rest } = u; return rest; });
    const promise = new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append("video", file);
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploads(u => ({ ...u, [clipId]: Math.round((e.loaded / e.total) * 100) }));
      };
      xhr.onload = () => {
        done();
        let result;
        try {
          result = JSON.parse(xhr.responseText);
        } catch {
          return reject(new Error(`HTTP ${xhr.status}`));
        }
        if (result.status !== "success") return reject(new Error(result.message));
        setOriginalIds(ids => ({ ...ids, [clipId]: result.originalId }));
        resolve(result.originalId);
      };
      xhr.onerror = () => {
        done();
        reject(new Error("Server nicht erreichbar."));
      };
      xhr.open("POST", `${api}/store`);
      xhr.send(formData);
    });
    clipUploadsRef.current[clipId] = { file, promise };
    return promise;
  };

  // Server-ID eines Clips; wartet auf laufenden Upload oder lädt (erneut) hoch
  const ensureClipOriginal = async (clipId, forceNew = false) => {
    if (clipId === "main") return ensureMainOriginal(forceNew);
    const entry = clipUploadsRef.current[clipId];
    if (!entry) throw new Error("Clip ist nicht auf dem Server. Bitte erneut hinzufügen.");
    if (!forceNew) {
      try {
        return await entry.promise;
      } catch {
        // fehlgeschlagen -> neu hochladen
      }
    }
    return uploadClip(entry.file, clipId);
  };

  const addClipFile = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      const clipId = P.newId("c");
      commit(p => P.addClip(p, clipId, { url, name: file.name, duration: probe.duration }));
      uploadClip(file, clipId).catch(err => setMessage("Fehler beim Hochladen: " + err.message + " Wird beim Export erneut versucht."));
      setMessage(`Clip „${file.name}“ hinzugefügt.`);
    };
    probe.onerror = () => setMessage("Fehler: Video konnte nicht gelesen werden.");
    probe.src = url;
  };

  const pickClip = async () => {
    // wie im Schneiden-Tab: Dialog im Videos-Ordner starten
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          id: "trimly-videos",
          startIn: "videos",
          types: [{ description: "Videos", accept: { "video/*": VIDEO_EXTENSIONS } }],
        });
        addClipFile(await handle.getFile());
      } catch (err) {
        if (err.name !== "AbortError") videoInputRef.current?.click();
      }
      return;
    }
    videoInputRef.current?.click();
  };

  const newItemRange = (len) => {
    const start = clamp(time, 0, Math.max(0, total - P.MIN_LEN));
    return { start, end: Math.min(total, start + len) };
  };

  const addOverlay = (props) => {
    if (total < 0.2) return;
    const item = { id: P.newId("o"), ...newItemRange(3), ...props };
    commit(p => ({ ...p, overlays: [...p.overlays, item] }));
    setSelected({ kind: "overlay", id: item.id });
  };

  const addArrow = () => addOverlay({ type: "arrow", x1: 0.3, y1: 0.3, x2: 0.45, y2: 0.45, color: "#ff3b30", thickness: 0.012 });
  const addText = () => addOverlay({ type: "text", x: 0.5, y: 0.15, text: "Text", color: "#ffffff", size: 0.08 });
  const addImageFile = (file) => {
    if (!file) return;
    const img = new Image();
    const key = P.newId("img");
    img.onload = () => {
      imagesRef.current[key] = img;
      setImagesVersion(v => v + 1);
      addOverlay({ type: "image", imageKey: key, x: 0.35, y: 0.3, w: 0.3 });
    };
    img.onerror = () => setMessage("Fehler: Bild konnte nicht geladen werden.");
    img.src = URL.createObjectURL(file);
  };
  const addZoom = () => {
    if (total < 0.2) return;
    const item = { id: P.newId("z"), ...newItemRange(2), x: 0.25, y: 0.25, w: 0.5 };
    commit(p => ({ ...p, zooms: [...p.zooms, item] }));
    setSelected({ kind: "zoom", id: item.id });
  };

  // Teilt den ausgewählten Ton-Abschnitt, sonst die Videospur am Playhead
  const split = () => {
    const p = projectRef.current;
    const t = timeRef.current;
    const next = selected?.kind === "audio" ? P.splitAudioAt(p, selected.id, t) : P.splitVideoAt(p, t);
    if (next === p) {
      setMessage(selected?.kind === "audio"
        ? "Der ausgewählte Ton-Abschnitt liegt nicht unter dem Playhead."
        : "Am Playhead gibt es nichts zu teilen (zu nah an einem Schnitt?).");
      return;
    }
    commit(() => next);
  };

  const removeSelected = () => {
    if (!selected) return;
    if (selected.kind === "video" && project.videoSegs.length <= 1) {
      setMessage("Der letzte Video-Abschnitt kann nicht gelöscht werden.");
      return;
    }
    commit(p => P.removeItem(p, selected.kind, selected.id));
    setSelected(null);
  };

  const toggleAudioLink = () => {
    if (linked) {
      commit(P.detachAudio);
      setMessage("Tonspur getrennt: Ton-Abschnitte lassen sich jetzt unabhängig schneiden und verschieben.");
    } else {
      if (!window.confirm("Tonspur wieder mit dem Video verbinden? Änderungen an der Tonspur gehen verloren.")) return;
      commit(P.linkAudio);
      if (selected?.kind === "audio") setSelected(null);
    }
  };

  const updateSelected = (patch) => commit(p => P.updateItem(p, selected.kind, selected.id, patch));

  // ─── Tastatur ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (isTyping(e)) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying(p => !p); }
      else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); undo(); }
      else if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); removeSelected(); }
      else if (e.code === "KeyS") { e.preventDefault(); split(); }
      else if (e.code === "ArrowRight") { e.preventDefault(); seek(timeRef.current + (e.shiftKey ? 1 / 30 : 1)); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); seek(timeRef.current - (e.shiftKey ? 1 / 30 : 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ─── Export ──────────────────────────────────────────────────────────────

  // Ton, der erst hinter dem Videoende beginnt, landet nicht im Video
  const audioInVideo = audio.some(s => s.tlStart < total);
  const estimatedBytes = exportOutput === "audio"
    ? AUDIO_ONLY_KBPS * 1000 / 8 * P.audioDuration(project)
    : (exportDims.bitrate + (audioInVideo && exportOutput === "both" ? AUDIO_KBPS : 0)) * 1000 / 8 * total;

  const handleExport = async () => {
    if (exportOutput === "audio" && !audio.length) {
      setMessage("Fehler: Das Projekt hat keinen Ton.");
      return;
    }
    setPlaying(false);
    setExporting(true);
    try {
      // Alle Clips müssen auf dem Server sein (wartet auf laufende Uploads, wiederholt fehlgeschlagene)
      const clipIds = Object.keys(project.clips);
      const ensureAll = async (forceIds = []) => {
        if (clipIds.some(id => forceIds.includes(id) || !originalIds[id])) setMessage("Clips werden hochgeladen...");
        const ids = {};
        for (const id of clipIds) ids[id] = await ensureClipOriginal(id, forceIds.includes(id));
        return ids;
      };
      let ids;
      try {
        ids = await ensureAll();
      } catch (err) {
        setMessage("Fehler beim Hochladen: " + err.message);
        return;
      }

      setMessage("Overlays werden vorbereitet...");
      const { body, overlays } = P.buildRenderProject(project, exportDims, ids, exportOutput);
      const overlayBlobs = [];
      for (let i = 0; i < overlays.length; i++) {
        overlayBlobs.push(await renderOverlayPng(overlays[i], exportDims.width, exportDims.height, imagesRef.current));
      }
      const render = async (renderBody) => {
        const formData = new FormData();
        formData.append("project", JSON.stringify(renderBody));
        overlayBlobs.forEach((blob, i) => formData.append(`overlay_${i}`, blob, `overlay_${i}.png`));
        return (await fetch(`${api}/render`, { method: "POST", body: formData })).json();
      };

      setMessage(exportOutput === "audio" ? "Ton wird exportiert..." : "Video wird gerendert...");
      let result = await render(body);
      // Server kennt Clips nicht mehr (abgelaufen / neu gestartet): neu hochladen, nochmal versuchen
      if (result.status !== "success" && result.missing?.length) {
        const forceIds = clipIds.filter(id => result.missing.includes(ids[id]));
        try {
          ids = await ensureAll(forceIds);
        } catch (err) {
          setMessage("Fehler beim Hochladen: " + err.message);
          return;
        }
        setMessage(exportOutput === "audio" ? "Ton wird exportiert..." : "Video wird gerendert...");
        result = await render(P.buildRenderProject(project, exportDims, ids, exportOutput).body);
      }
      if (result.status !== "success") {
        setMessage("Fehler: " + result.message);
        return;
      }
      const filename = result.filename;
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        let d;
        try {
          d = await (await fetch(`${api}/check/${encodeURIComponent(filename)}`)).json();
        } catch {
          continue;
        }
        if (d.status === "ready") {
          const base = (mainClip?.name || "video").replace(/\.[^.]+$/, "");
          const a = document.createElement("a");
          const ext = filename.endsWith(".mp3") ? "mp3" : "mp4";
          a.href = `${api}/download/${encodeURIComponent(filename)}?name=${encodeURIComponent(`${base}_edit.${ext}`)}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setMessage(`Export fertig (${formatFileSize(d.size)}), Download gestartet!`);
          return;
        }
        if (d.status === "error") { setMessage("Fehler beim Rendern: " + d.message); return; }
        if (d.status === "unknown") { setMessage("Fehler: Auftrag unbekannt (Server neu gestartet?)."); return; }
      }
    } catch (err) {
      setMessage("Fehler: " + err.message);
    } finally {
      setExporting(false);
    }
  };

  // ─── Eigenschaften des ausgewählten Elements ─────────────────────────────

  const renderProperties = () => {
    if (!selected) return <p className="ed-hint">Element in der Timeline oder im Bild anklicken, um es zu bearbeiten.</p>;
    if (selected.kind === "video") {
      const s = project.videoSegs.find(x => x.id === selected.id);
      if (!s) return null;
      const i = project.videoSegs.indexOf(s);
      return (
        <>
          <div className="ed-prop-title">🎬 {project.clips[s.clipId]?.name}</div>
          <div className="ed-prop">Länge: {(s.srcEnd - s.srcStart).toFixed(1)} s</div>
          {linked && (
            <label className="ed-prop">Lautstärke
              <input type="range" min="0" max="2" step="0.05" value={s.volume}
                onChange={(e) => updateSelected({ volume: parseFloat(e.target.value) })} />
              <span>{Math.round(s.volume * 100)}%</span>
            </label>
          )}
          <div className="ed-prop">
            <button type="button" className="ed-btn" disabled={i === 0} onClick={() => commit(p => P.moveVideoSeg(p, s.id, -1))}>◀ nach vorne</button>
            <button type="button" className="ed-btn" disabled={i === project.videoSegs.length - 1} onClick={() => commit(p => P.moveVideoSeg(p, s.id, 1))}>nach hinten ▶</button>
          </div>
        </>
      );
    }
    if (selected.kind === "audio") {
      const s = (project.audioSegs || []).find(x => x.id === selected.id);
      if (!s) return null;
      return (
        <>
          <div className="ed-prop-title">🔊 Ton: {project.clips[s.clipId]?.name}</div>
          <div className="ed-prop">Start: {s.tlStart.toFixed(1)} s · Länge: {(s.srcEnd - s.srcStart).toFixed(1)} s</div>
          <label className="ed-prop">Lautstärke
            <input type="range" min="0" max="2" step="0.05" value={s.volume}
              onChange={(e) => updateSelected({ volume: parseFloat(e.target.value) })} />
            <span>{Math.round(s.volume * 100)}%</span>
          </label>
        </>
      );
    }
    if (selected.kind === "zoom") {
      const z = project.zooms.find(x => x.id === selected.id);
      if (!z) return null;
      return (
        <>
          <div className="ed-prop-title">🔍 Zoom</div>
          <div className="ed-prop">{z.start.toFixed(1)} s – {z.end.toFixed(1)} s</div>
          <label className="ed-prop">Stärke
            <input type="range" min="1.1" max="5" step="0.1" value={1 / z.w}
              onChange={(e) => {
                const w = 1 / parseFloat(e.target.value);
                updateSelected({ w, x: clamp(z.x, 0, 1 - w), y: clamp(z.y, 0, 1 - w) });
              }} />
            <span>{(1 / z.w).toFixed(1)}x</span>
          </label>
          <p className="ed-hint">Gelben Rahmen im Bild verschieben bzw. am Punkt unten rechts größer/kleiner ziehen.</p>
        </>
      );
    }
    const o = project.overlays.find(x => x.id === selected.id);
    if (!o) return null;
    return (
      <>
        <div className="ed-prop-title">{overlayLabel(o)}</div>
        <div className="ed-prop">{o.start.toFixed(1)} s – {o.end.toFixed(1)} s</div>
        {o.type === "text" && (
          <label className="ed-prop">Text
            <textarea rows={2} value={o.text} onChange={(e) => updateSelected({ text: e.target.value })} />
          </label>
        )}
        {o.type !== "image" && (
          <label className="ed-prop">Farbe
            <input type="color" value={o.color} onChange={(e) => updateSelected({ color: e.target.value })} />
          </label>
        )}
        {o.type === "text" && (
          <label className="ed-prop">Größe
            <input type="range" min="0.03" max="0.25" step="0.005" value={o.size}
              onChange={(e) => updateSelected({ size: parseFloat(e.target.value) })} />
          </label>
        )}
        {o.type === "arrow" && (
          <label className="ed-prop">Dicke
            <input type="range" min="0.004" max="0.04" step="0.001" value={o.thickness}
              onChange={(e) => updateSelected({ thickness: parseFloat(e.target.value) })} />
          </label>
        )}
        {o.type === "image" && (
          <label className="ed-prop">Größe
            <input type="range" min="0.05" max="1" step="0.01" value={o.w}
              onChange={(e) => updateSelected({ w: parseFloat(e.target.value) })} />
          </label>
        )}
        <p className="ed-hint">Im Bild verschieben{o.type === "arrow" ? ", Enden an den Punkten ziehen" : ""}.</p>
      </>
    );
  };

  if (!mainClip) {
    return <div className="ed-empty">Lade zuerst ein Video im Tab „Schneiden“.</div>;
  }

  return (
    <div className="editor" ref={rootRef}>
      <div className="ed-top">
        <div className="ed-frame" ref={frameRef} style={{ aspectRatio: `${FRAME_ASPECT}` }}>
          <div className="ed-zoom" style={{ transform: zoomTransform }}>
            <video ref={videoRef} muted playsInline onLoadedMetadata={onVideoLoaded} />
          </div>
          <canvas ref={canvasRef} className="ed-canvas" onPointerDown={onFramePointerDown} />
        </div>

        <div className="ed-side">
          <div className="ed-panel">{renderProperties()}</div>
          {(selected && (selected.kind !== "video" || project.videoSegs.length > 1)) && (
            <button type="button" className="ed-btn danger" onClick={removeSelected}>🗑 Löschen</button>
          )}
        </div>
      </div>

      <div className="ed-transport">
        <button type="button" className="ed-btn primary" onClick={() => setPlaying(p => !p)}>
          {playing ? "⏸ Pause" : "▶ Abspielen"}
        </button>
        <span className="ed-time">{time.toFixed(1)} / {total.toFixed(1)} s</span>
        <label className="ed-inline">🔈
          <input type="range" min="0" max="1" step="0.01" value={previewVolume}
            aria-label="Vorschau-Lautstärke" onChange={(e) => setPreviewVolume(parseFloat(e.target.value))} />
        </label>
        <label className="ed-inline">Timeline
          <input type="range" min="1" max="20" step="0.5" value={timelineZoom}
            aria-label="Timeline-Zoom" onChange={(e) => setTimelineZoom(parseFloat(e.target.value))} />
        </label>
        <button type="button" className="ed-btn" onClick={undo} disabled={!historyRef.current.length} title="Strg+Z">↶ Rückgängig</button>
      </div>

      <div className="ed-toolbar">
        <button type="button" className="ed-btn" onClick={split} title="Taste S">✂ Teilen</button>
        <button type="button" className="ed-btn" onClick={toggleAudioLink}>
          {linked ? "🔊 Tonspur trennen" : "🔗 Tonspur verbinden"}
        </button>
        <button type="button" className="ed-btn" onClick={pickClip}>＋ Clip</button>
        <button type="button" className="ed-btn" onClick={addArrow}>➜ Pfeil</button>
        <button type="button" className="ed-btn" onClick={addText}>T Text</button>
        <button type="button" className="ed-btn" onClick={() => imageInputRef.current?.click()}>🖼 Bild</button>
        <button type="button" className="ed-btn" onClick={addZoom}>🔍 Zoom</button>
        <input ref={videoInputRef} type="file" accept="video/*" style={{ display: "none" }}
          onChange={(e) => { addClipFile(e.target.files[0]); e.target.value = ""; }} />
        <input ref={imageInputRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => { addImageFile(e.target.files[0]); e.target.value = ""; }} />
      </div>

      {Object.entries(uploads).map(([id, pct]) => (
        <div key={id} className="ed-upload">Upload {project.clips[id]?.name}: {pct}%</div>
      ))}

      <Timeline
        total={total}
        time={time}
        pxPerSec={pxPerSec}
        clips={project.clips}
        videoLayout={videoLayout}
        audio={audio}
        linked={linked}
        overlays={project.overlays}
        zooms={project.zooms}
        selected={selected}
        onSeek={seek}
        onSelect={onTimelineSelect}
        onDrag={onTimelineDrag}
      />

      <div className="ed-export">
        <strong>Export</strong>
        <select className="ed-select" value={exportOutput} aria-label="Ausgabe"
          onChange={(e) => setExportOutput(e.target.value)}>
          <option value="both">Video + Audio</option>
          <option value="video">Nur Video</option>
          <option value="audio">Nur Audio (MP3)</option>
        </select>
        {exportOutput !== "audio" && EXPORT_PRESETS.map(key => (
          <button key={key} type="button" className={`ed-btn ${exportPreset === key ? "primary" : ""}`}
            onClick={() => setExportPreset(key)}>
            {PRESETS[key].label}
          </button>
        ))}
        <span className="ed-hint">
          {exportOutput === "audio"
            ? "MP3, 192 kbps"
            : `${PRESETS[exportPreset].resolution}, ${PRESETS[exportPreset].fps} FPS`} · ≈ {formatFileSize(estimatedBytes)}
        </span>
        <button type="button" className="ed-btn export" onClick={handleExport} disabled={exporting || total < 0.1}>
          {exporting ? "⏳ Exportiere..." : "⬇ Exportieren"}
        </button>
      </div>
      {exportOutput === "both" && audio.length > 0 && !audioInVideo && (
        <p className="ed-message error">⚠ Der Ton liegt komplett hinter dem Videoende – das Video wäre stumm. Ton auf der Timeline nach vorne ziehen oder „Nur Audio“ wählen.</p>
      )}
      {message && <p className={`ed-message ${message.includes("Fehler") ? "error" : ""}`}>{message}</p>}
    </div>
  );
}
