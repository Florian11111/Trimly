import { useEffect, useRef, useState } from "react";
import { formatTime } from "../lib/format";

const STRIP_HEIGHT = 64;
const MIN_LENGTH = 0.01; // Sekunden
const HOLD_MS = 200; // so lange gedrückt halten, bis ein Griff verschiebbar wird

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Filmstreifen mit Vorschaubildern, gelber Schnittklammer und Abspielkopf.
 * Ziehen an den Griffen setzt Anfang/Ende, Klicken oder Ziehen auf dem Streifen
 * springt. Shift+Klick setzt den Anfang, Alt+Klick das Ende.
 */
export default function Timeline({ src, duration, aspect, range, current, onSeek, onRangeChange }) {
  const trackRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const holdRef = useRef(null); // { mode, time, timer } solange ein Griff gedrückt, aber noch nicht gegriffen ist
  const [grabbing, setGrabbing] = useState(null);
  const [width, setWidth] = useState(0);
  const [start, end] = range;

  // Breite beobachten, damit die Vorschaubilder den Streifen genau füllen
  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Vorschaubilder direkt in den Canvas zeichnen. Kein Auslesen nötig, daher
  // funktioniert das auch mit Videos aus dem Tauri-Asset-Protokoll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src || !duration || !width) return undefined;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return undefined;

    let cancelled = false;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(STRIP_HEIGHT * dpr);
    const thumbWidth = STRIP_HEIGHT * (aspect || 16 / 9);
    const count = Math.max(1, Math.ceil(width / thumbWidth));

    const probe = document.createElement("video");
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = "auto";
    probe.src = src;

    const once = (event) =>
      new Promise((resolve, reject) => {
        probe.addEventListener(event, resolve, { once: true });
        probe.addEventListener("error", reject, { once: true });
      });

    (async () => {
      // Erst zeichnen, wenn ein Bild dekodiert ist; sonst bleibt das erste leer (WebKit)
      if (probe.readyState < 2) await once("loadeddata");
      for (let i = 0; i < count && !cancelled; i++) {
        const seeked = once("seeked");
        probe.currentTime = Math.min(duration - 0.05, ((i + 0.5) * duration) / count);
        await seeked;
        if (cancelled) return;
        ctx.drawImage(probe, i * thumbWidth * dpr, 0, thumbWidth * dpr, STRIP_HEIGHT * dpr);
      }
    })().catch(() => {});

    return () => {
      cancelled = true;
      probe.removeAttribute("src");
      probe.load();
    };
  }, [src, duration, width, aspect]);

  const timeAt = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
  };

  const apply = (mode, t) => {
    if (mode === "start") onRangeChange([clamp(t, 0, end - MIN_LENGTH), end]);
    else if (mode === "end") onRangeChange([start, clamp(t, start + MIN_LENGTH, duration)]);
    else onSeek(t);
  };

  // Streifen: Klicken oder Ziehen springt; Shift/Alt setzt Anfang/Ende
  const pressTrack = (e) => {
    if (!duration || e.button !== 0) return;
    e.preventDefault();
    let m = "seek";
    if (e.shiftKey) m = "start";
    else if (e.altKey) m = "end";
    dragRef.current = m;
    trackRef.current.setPointerCapture?.(e.pointerId);
    apply(m, timeAt(e.clientX));
  };

  // Griff: kurzer Klick springt an die Stelle, erst Gedrückthalten macht ihn verschiebbar
  const pressHandle = (mode) => (e) => {
    if (!duration || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    trackRef.current.setPointerCapture?.(e.pointerId);
    const time = timeAt(e.clientX);
    const timer = setTimeout(() => {
      holdRef.current = null;
      dragRef.current = mode;
      setGrabbing(mode);
    }, HOLD_MS);
    holdRef.current = { time, timer };
  };

  const onPointerMove = (e) => {
    if (dragRef.current) apply(dragRef.current, timeAt(e.clientX));
  };

  const endDrag = (e) => {
    const hold = holdRef.current;
    if (hold) {
      // losgelassen, bevor der Griff gegriffen war: wie ein Klick → springen
      clearTimeout(hold.timer);
      holdRef.current = null;
      onSeek(hold.time);
    }
    dragRef.current = null;
    setGrabbing(null);
    trackRef.current?.releasePointerCapture?.(e.pointerId);
  };

  useEffect(() => () => clearTimeout(holdRef.current?.timer), []);

  const handleKeys = (which) => (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const delta = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    apply(which, (which === "start" ? start : end) + delta);
  };

  const pct = (t) => (duration ? `${(t / duration) * 100}%` : "0%");

  return (
    <div className="timeline">
      <div
        ref={trackRef}
        className={`timeline-track ${grabbing ? `is-grabbing-${grabbing}` : ""}`}
        style={{ height: STRIP_HEIGHT }}
        onPointerDown={pressTrack}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="timeline"
      >
        <canvas ref={canvasRef} className="timeline-strip" aria-hidden="true" />
        <div className="timeline-shade" style={{ left: 0, width: pct(start) }} />
        <div className="timeline-shade" style={{ left: pct(end), right: 0 }} />
        <div className="timeline-selection" style={{ left: pct(start), width: pct(end - start) }}>
          <div
            className="timeline-handle timeline-handle-start"
            role="slider"
            tabIndex={0}
            aria-label="Anfang"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={start}
            aria-valuetext={formatTime(start)}
            onPointerDown={pressHandle("start")}
            onKeyDown={handleKeys("start")}
          />
          <div
            className="timeline-handle timeline-handle-end"
            role="slider"
            tabIndex={0}
            aria-label="Ende"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={end}
            aria-valuetext={formatTime(end)}
            onPointerDown={pressHandle("end")}
            onKeyDown={handleKeys("end")}
          />
        </div>
        <div className="timeline-playhead" style={{ left: pct(current) }} />
      </div>
    </div>
  );
}
