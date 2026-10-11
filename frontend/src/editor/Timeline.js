import React, { useRef } from "react";

const EDGE = 7; // px am Rand eines Abschnitts zum Kürzen/Verlängern
const LABEL_W = 80;

const formatTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

function tickStep(pxPerSec) {
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => s * pxPerSec >= 60) || 600;
}

// Überlappende Einträge auf mehrere Zeilen verteilen
function packLanes(items) {
  const lanes = [];
  const result = {};
  [...items].sort((a, b) => a.start - b.start).forEach(item => {
    let lane = lanes.findIndex(end => end <= item.start + 1e-6);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = item.end;
    result[item.id] = lane;
  });
  return { laneOf: result, count: Math.max(1, lanes.length) };
}

export const overlayLabel = (o) =>
  o.type === "arrow" ? "➜ Pfeil" : o.type === "text" ? `T ${o.text.split("\n")[0] || "Text"}` : "🖼 Bild";

export default function Timeline({
  total, time, pxPerSec, clips, videoLayout, audio, linked, overlays, zooms,
  selected, onSeek, onSelect, onDrag,
}) {
  const scrollRef = useRef(null);
  const width = Math.max(total * pxPerSec, 200);

  const timeFromClientX = (clientX) => {
    const rect = scrollRef.current.getBoundingClientRect();
    const x = clientX - rect.left + scrollRef.current.scrollLeft - LABEL_W;
    return Math.max(0, Math.min(total, x / pxPerSec));
  };

  // Klick/Ziehen auf freie Fläche oder Lineal: Abspielposition setzen
  const startScrub = (e) => {
    if (e.button !== 0) return;
    onSeek(timeFromClientX(e.clientX));
    const move = (ev) => onSeek(timeFromClientX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startItemDrag = (e, kind, id, canMove, canResize) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientX - rect.left;
    let mode = "move";
    if (canResize && offset < EDGE) mode = "start";
    else if (canResize && offset > rect.width - EDGE) mode = "end";
    onSelect(kind, id);
    if (mode === "move" && !canMove) {
      onSeek(timeFromClientX(e.clientX));
      return;
    }
    const startX = e.clientX;
    onDrag(kind, id, mode, 0, "start");
    const move = (ev) => onDrag(kind, id, mode, (ev.clientX - startX) / pxPerSec, "move");
    const up = (ev) => {
      onDrag(kind, id, mode, (ev.clientX - startX) / pxPerSec, "end");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const isSelected = (kind, id) => selected && selected.kind === kind && selected.id === id;

  const item = ({ kind, id, start, len, label, className, canMove, canResize, lane = 0, title }) => (
    <div
      key={`${kind}-${id}`}
      className={`tl-item ${className} ${isSelected(kind, id) ? "selected" : ""}`}
      style={{ left: start * pxPerSec, width: Math.max(4, len * pxPerSec), top: 4 + lane * 26 }}
      title={title || label}
      onPointerDown={(e) => startItemDrag(e, kind, id, canMove, canResize)}
    >
      {canResize && <span className="tl-edge left" />}
      <span className="tl-label">{label}</span>
      {canResize && <span className="tl-edge right" />}
    </div>
  );

  const step = tickStep(pxPerSec);
  const ticks = [];
  for (let t = 0; t <= total + 1e-6; t += step) ticks.push(t);

  const overlayLanes = packLanes(overlays);
  const zoomLanes = packLanes(zooms);
  const rowHeight = (lanes) => 8 + lanes * 26;

  return (
    <div className="ed-timeline" ref={scrollRef}>
      <div className="tl-inner" style={{ width: width + LABEL_W }}>
        <div className="tl-row tl-ruler" onPointerDown={startScrub}>
          <div className="tl-row-label">{formatTime(time)}</div>
          <div className="tl-track">
            {ticks.map(t => (
              <span key={t} className="tl-tick" style={{ left: t * pxPerSec }}>{formatTime(t).replace(/\.0$/, "")}</span>
            ))}
          </div>
        </div>

        <div className="tl-row" style={{ height: rowHeight(1) }} onPointerDown={startScrub}>
          <div className="tl-row-label">Video</div>
          <div className="tl-track">
            {videoLayout.map(s => item({
              kind: "video", id: s.id, start: s.tlStart, len: s.len, className: "video",
              label: clips[s.clipId]?.name || "Clip", canMove: false, canResize: true,
            }))}
          </div>
        </div>

        <div className="tl-row" style={{ height: rowHeight(1) }} onPointerDown={startScrub}>
          <div className="tl-row-label">Ton{linked ? " 🔗" : ""}</div>
          <div className="tl-track">
            {audio.map(s => item({
              kind: linked ? "video" : "audio", id: s.id, start: s.tlStart, len: s.srcEnd - s.srcStart,
              className: `audio ${linked ? "linked" : ""}`,
              label: `${clips[s.clipId]?.name || "Ton"}${s.volume !== 1 ? ` (${Math.round(s.volume * 100)}%)` : ""}`,
              canMove: !linked, canResize: !linked,
              title: linked ? "Mit Video verbunden – „Tonspur trennen“ zum separaten Bearbeiten" : undefined,
            }))}
          </div>
        </div>

        <div className="tl-row" style={{ height: rowHeight(overlayLanes.count) }} onPointerDown={startScrub}>
          <div className="tl-row-label">Overlays</div>
          <div className="tl-track">
            {overlays.map(o => item({
              kind: "overlay", id: o.id, start: o.start, len: o.end - o.start, className: `overlay ${o.type}`,
              label: overlayLabel(o), canMove: true, canResize: true, lane: overlayLanes.laneOf[o.id],
            }))}
          </div>
        </div>

        <div className="tl-row" style={{ height: rowHeight(zoomLanes.count) }} onPointerDown={startScrub}>
          <div className="tl-row-label">Zoom</div>
          <div className="tl-track">
            {zooms.map(z => item({
              kind: "zoom", id: z.id, start: z.start, len: z.end - z.start, className: "zoom",
              label: `🔍 ${(1 / z.w).toFixed(1)}x`, canMove: true, canResize: true, lane: zoomLanes.laneOf[z.id],
            }))}
          </div>
        </div>

        <div className="tl-playhead" style={{ left: LABEL_W + time * pxPerSec }} />
      </div>
    </div>
  );
}
