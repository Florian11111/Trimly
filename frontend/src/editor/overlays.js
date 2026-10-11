// Gemeinsame Geometrie für Vorschau und Export.
// Alle Positionen sind relativ zum Ausgabebild (0..1), Größen relativ zur Bildhöhe.

export const ZOOM_RAMP = 0.3; // muss zu EditRenderer.ZoomRamp im Backend passen

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Zoomzustand zum Zeitpunkt t: Faktor und sichtbarer Bereich (oben links, relativ)
// Gleiche Formel wie der zoompan-Ausdruck im Backend.
export function zoomAt(zooms, t) {
  let z = 1;
  let cx = 0.5;
  let cy = 0.5;
  for (const zm of zooms) {
    const r = Math.min(ZOOM_RAMP, (zm.end - zm.start) / 2);
    const ramp = clamp((t - zm.start) / r, 0, 1) * clamp((zm.end - t) / r, 0, 1);
    z += (1 / zm.w - 1) * ramp;
    cx += (zm.x + zm.w / 2 - 0.5) * ramp;
    cy += (zm.y + zm.w / 2 - 0.5) * ramp;
  }
  const visible = 1 / z;
  return {
    z,
    x: clamp(cx - visible / 2, 0, 1 - visible),
    y: clamp(cy - visible / 2, 0, 1 - visible),
  };
}

export const isVisible = (o, t) => t >= o.start && t < o.end;

function textLines(o) {
  return (o.text || "").split("\n");
}

function drawArrow(ctx, o, W, H) {
  const x1 = o.x1 * W, y1 = o.y1 * H, x2 = o.x2 * W, y2 = o.y2 * H;
  const lw = Math.max(2, o.thickness * H);
  const head = lw * 3.5;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const bx = x2 - Math.cos(angle) * head * 0.9;
  const by = y2 - Math.sin(angle) * head * 0.9;

  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(angle - 0.45) * head, y2 - Math.sin(angle - 0.45) * head);
    ctx.lineTo(x2 - Math.cos(angle + 0.45) * head, y2 - Math.sin(angle + 0.45) * head);
    ctx.closePath();
  };

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // dunkle Kontur, damit der Pfeil auf jedem Hintergrund sichtbar ist
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = lw + Math.max(2, lw * 0.5);
  path();
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  path();
  ctx.fill();
}

function drawText(ctx, o, W, H) {
  const size = o.size * H;
  ctx.font = `bold ${size}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const lines = textLines(o);
  lines.forEach((line, i) => {
    const y = o.y * H + (i - (lines.length - 1) / 2) * size * 1.15;
    ctx.lineWidth = size * 0.18;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(line, o.x * W, y);
    ctx.fillStyle = o.color;
    ctx.fillText(line, o.x * W, y);
  });
}

function imageRect(o, W, H, images) {
  const img = images[o.imageKey];
  const w = o.w * W;
  const h = img && img.naturalWidth ? (w * img.naturalHeight) / img.naturalWidth : w;
  return { x: o.x * W, y: o.y * H, w, h };
}

export function drawOverlay(ctx, o, W, H, images) {
  ctx.save();
  if (o.type === "arrow") drawArrow(ctx, o, W, H);
  else if (o.type === "text") drawText(ctx, o, W, H);
  else if (o.type === "image") {
    const img = images[o.imageKey];
    if (img && img.complete) {
      const r = imageRect(o, W, H, images);
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
    }
  }
  ctx.restore();
}

// Bounding-Box in Pixeln (für Auswahl-Rahmen und Treffer-Erkennung)
export function overlayBox(ctx, o, W, H, images) {
  if (o.type === "arrow") {
    return {
      x: Math.min(o.x1, o.x2) * W, y: Math.min(o.y1, o.y2) * H,
      w: Math.abs(o.x2 - o.x1) * W, h: Math.abs(o.y2 - o.y1) * H,
    };
  }
  if (o.type === "text") {
    const size = o.size * H;
    ctx.save();
    ctx.font = `bold ${size}px Arial, sans-serif`;
    const lines = textLines(o);
    const w = Math.max(...lines.map(l => ctx.measureText(l).width), size);
    ctx.restore();
    const h = lines.length * size * 1.15;
    return { x: o.x * W - w / 2, y: o.y * H - h / 2, w, h };
  }
  return imageRect(o, W, H, images);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Was liegt unter dem Punkt? Liefert {mode} oder null.
// mode: "move" | "p1" | "p2" (Pfeilenden) | "resize" (Bild unten rechts)
export function hitOverlay(ctx, o, px, py, W, H, images) {
  const grab = 12;
  if (o.type === "arrow") {
    if (Math.hypot(px - o.x1 * W, py - o.y1 * H) < grab) return { mode: "p1" };
    if (Math.hypot(px - o.x2 * W, py - o.y2 * H) < grab) return { mode: "p2" };
    const d = distToSegment(px, py, o.x1 * W, o.y1 * H, o.x2 * W, o.y2 * H);
    return d < Math.max(grab, o.thickness * H * 2) ? { mode: "move" } : null;
  }
  const b = overlayBox(ctx, o, W, H, images);
  if (o.type === "image" && Math.hypot(px - (b.x + b.w), py - (b.y + b.h)) < grab) return { mode: "resize" };
  if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return { mode: "move" };
  return null;
}

// Zoom-Rechteck: Höhe = Breite (relativ), da gleiches Seitenverhältnis wie das Bild
export function hitZoom(zm, px, py, W, H) {
  const x = zm.x * W, y = zm.y * H, w = zm.w * W, h = zm.w * H;
  if (Math.hypot(px - (x + w), py - (y + h)) < 14) return { mode: "resize" };
  if (px >= x && px <= x + w && py >= y && py <= y + h) return { mode: "move" };
  return null;
}

// Ein Overlay als PNG in Ausgabegröße rendern (für den Export)
export function renderOverlayPng(o, W, H, images) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  drawOverlay(canvas.getContext("2d"), o, W, H, images);
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}
