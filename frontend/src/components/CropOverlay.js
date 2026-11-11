import { useEffect, useRef, useState } from "react";

// Freier Zuschnitt über dem Vorschau-Video. `crop` ist relativ zum Bild: {x, y, w, h} in 0..1.
// Außerhalb des Rahmens wird abgedunkelt; im Bearbeiten-Modus lässt er sich verschieben und an
// Ecken und Kanten in jedes Format ziehen.
const MIN = 0.05;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Neue Box nach Ziehen um dx/dy (relativ) mit Griff `mode` ("move" oder Himmelsrichtung). */
export function dragCrop(start, mode, dx, dy) {
  if (mode === "move") {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  }
  let { x, y, w, h } = start;
  if (mode.includes("w")) {
    const nx = clamp(x + dx, 0, x + w - MIN);
    w += x - nx;
    x = nx;
  }
  if (mode.includes("e")) w = clamp(w + dx, MIN, 1 - x);
  if (mode.includes("n")) {
    const ny = clamp(y + dy, 0, y + h - MIN);
    h += y - ny;
    y = ny;
  }
  if (mode.includes("s")) h = clamp(h + dy, MIN, 1 - y);
  return { x, y, w, h };
}

/**
 * Liegt als Kind im Bildrahmen (`frameRef`, position: relative) und füllt ihn ganz aus.
 * `sourceSize` = Ausgabegröße des ganzen Bildes, für die Pixelangabe im Rahmen.
 */
export default function CropOverlay({ crop, editing, sourceSize, frameRef, onChange, onDragStart }) {
  const [rect, setRect] = useState(null);
  const drag = useRef(null);

  // Größe des Bildrahmens verfolgen (Fenstergröße)
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const update = () => setRect({ left: 0, top: 0, width: frame.clientWidth, height: frame.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [frameRef]);

  if (!crop || !rect) return null;

  const start = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, crop };
    onDragStart?.();
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    onChange(dragCrop(d.crop, d.mode, (e.clientX - d.x) / rect.width, (e.clientY - d.y) / rect.height));
  };
  const end = () => {
    drag.current = null;
  };

  const pct = (v) => `${v * 100}%`;
  const pixels = sourceSize
    ? `${Math.round((sourceSize.width * crop.w) / 2) * 2} × ${Math.round((sourceSize.height * crop.h) / 2) * 2}`
    : null;

  return (
    <div
      className={`crop-layer ${editing ? "is-editing" : ""}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className="crop-box"
        style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}
        onPointerDown={editing ? start("move") : undefined}
        aria-label="Crop area"
      >
        {editing && (
          <>
            <span className="crop-grid" aria-hidden="true" />
            {pixels && <span className="crop-size">{pixels}</span>}
            {HANDLES.map((h) => (
              <span key={h} className={`crop-handle crop-${h}`} onPointerDown={start(h)} aria-hidden="true" />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
