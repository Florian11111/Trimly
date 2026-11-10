import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import Timeline from "./components/Timeline";
import Editor from "./editor/Editor";
import { formatBytes, formatTime } from "./lib/format";
import {
  CUSTOM_HEIGHTS,
  DEFAULT_CUSTOM,
  OUTPUTS,
  estimateBytes,
  findPreset,
  presetsFor,
  resolveTarget,
  sourceVideoKbps,
} from "./lib/presets";
import { isDesktop, loadPlatform } from "./platform";
import { API } from "./platform/web";

const FRAME = 1 / 30;
const MIN_CLIP = 0.01; // Sekunden

export default function App() {
  const [platform, setPlatform] = useState(null);
  const [encoder, setEncoder] = useState(null);

  const [video, setVideo] = useState(null); // { name, size, src, ref, dispose }
  const [meta, setMeta] = useState(null); // { duration, width, height }
  const [upload, setUpload] = useState(null); // Web: Upload-Fortschritt 0–100
  const [range, setRange] = useState([0, 0]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [presetId, setPresetId] = useState("medium");
  const [custom, setCustom] = useState(DEFAULT_CUSTOM);
  const [volume, setVolume] = useState(1);
  const [output, setOutput] = useState("both"); // both | video | audio

  const [job, setJob] = useState(null); // { state: running|done|error, progress, result, message }
  const [dragging, setDragging] = useState(false);
  // Editor-Tab (Web: Backend rendert, Desktop: src-tauri/src/edit.rs)
  const [tab, setTab] = useState("trim"); // trim | edit
  const [editorOpened, setEditorOpened] = useState(false);
  const [originalId, setOriginalId] = useState(null);

  const videoRef = useRef(null);
  const inputRef = useRef(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  // ─── Plattform laden ────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    loadPlatform().then((p) => alive && setPlatform(p));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    platform?.encoderInfo?.().then(setEncoder).catch(() => {});
  }, [platform]);

  const log = useCallback((message) => platform?.log?.(message), [platform]);

  // ─── Video öffnen ───────────────────────────────────────────────────────

  // Alles vom vorigen Video verwerfen: Datei, Ausschnitt, Einstellungen, Ergebnis.
  // `next` ersetzt das alte Video im selben Render, damit kein leerer Zwischenstand aufblitzt.
  const resetAll = useCallback((next = null) => {
    setVideo((prev) => {
      if (prev !== next) prev?.dispose?.();
      return next;
    });
    setMeta(null);
    setRange([0, 0]);
    setCurrent(0);
    setPlaying(false);
    setPresetId("medium");
    setCustom(DEFAULT_CUSTOM);
    setVolume(1);
    setOutput("both");
    setJob(null);
    setTab("trim");
    setEditorOpened(false);
    setOriginalId(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const openVideo = useCallback(
    async (source) => {
      if (!platform || !source) return;
      try {
        // Erst öffnen, dann altes Video samt Einstellungen in einem Schritt ersetzen
        const next = await platform.open(source, { onUploadProgress: setUpload });
        log(`geöffnet: ${next.name} ${JSON.stringify(next.ref?.info || {})}`);
        resetAll(next);
      } catch (e) {
        setJob({ state: "error", message: e.message });
      }
    },
    [platform, resetAll, log]
  );

  const chooseFile = async () => {
    if (!platform) return;
    const picked = await platform.pick();
    if (picked) openVideo(picked);
    // null: Web ohne File System Access API → normales Dateifeld; undefined: abgebrochen
    else if (picked === null && platform.kind === "web") inputRef.current?.click();
  };

  // „Anderes Video“: Auswahl öffnen; erst wenn eine Datei gewählt ist, ersetzt sie
  // das alte Video komplett. Abbrechen lässt alles, wie es war.
  const replaceVideo = () => chooseFile();

  // Desktop: Datei aus „Öffnen mit“ oder der Kommandozeile (`Trimly video.mp4`)
  useEffect(() => {
    platform?.initialFile?.().then((path) => path && openVideo(path)).catch(() => {});
    // nur einmal nach dem Laden der Plattform
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // macOS: „Öffnen mit Trimly“, während die App schon läuft
  useEffect(() => {
    if (!platform?.onOpenFile) return undefined;
    let unlisten;
    let alive = true;
    platform.onOpenFile((path) => openVideo(path)).then((fn) => (alive ? (unlisten = fn) : fn()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [platform, openVideo]);

  // Desktop: Drag & Drop aus dem Finder kommt über Tauri, nicht als DOM-Event
  useEffect(() => {
    if (!platform?.onDragDrop) return undefined;
    let unlisten;
    let alive = true;
    platform
      .onDragDrop((type, paths) => {
        if (type === "enter" || type === "over") setDragging(true);
        else if (type === "leave") setDragging(false);
        else if (type === "drop") {
          setDragging(false);
          if (paths[0]) openVideo(paths[0]);
        }
      })
      .then((fn) => (alive ? (unlisten = fn) : fn()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [platform, openVideo]);

  const webDrop = {
    onDragOver: (e) => {
      if (platform?.kind !== "web") return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e) => {
      if (platform?.kind !== "web") return;
      e.preventDefault();
      setDragging(false);
      openVideo(e.dataTransfer.files[0]);
    },
  };

  // ─── Wiedergabe ─────────────────────────────────────────────────────────

  // Abmessungen von ffprobe (Desktop) sind verlässlicher als die des Players,
  // der sie bei manchen Videos erst später oder gar nicht meldet.
  const onLoadedMetadata = () => {
    const v = videoRef.current;
    const info = video?.ref?.info;
    log(`loadedmetadata ${v.videoWidth}x${v.videoHeight} dauer=${v.duration} readyState=${v.readyState}`);
    const duration = info?.duration || v.duration;
    setMeta({
      duration,
      width: info?.width || v.videoWidth,
      height: info?.height || v.videoHeight,
    });
    setRange([0, duration]);
  };

  const onResize = () => {
    const v = videoRef.current;
    log(`resize ${v.videoWidth}x${v.videoHeight}`);
    if (!video?.ref?.info && v.videoWidth > 0) {
      setMeta((m) => (m ? { ...m, width: v.videoWidth, height: v.videoHeight } : m));
    }
  };

  const onVideoError = () => {
    const err = videoRef.current?.error;
    log(`video error code=${err?.code} ${err?.message || ""}`);
    setJob({
      state: "error",
      message: "Die Vorschau kann dieses Video nicht abspielen. Exportieren funktioniert trotzdem.",
    });
  };

  const seek = useCallback((t) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    setCurrent(t);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    const [s, e] = rangeRef.current;
    if (v.currentTime < s || v.currentTime >= e - 0.05) v.currentTime = s;
    v.play().catch(() => {});
  }, []);

  // Flüssiger Abspielkopf; hält am Ende des Ausschnitts an
  useEffect(() => {
    if (!playing) return undefined;
    let raf;
    const tick = () => {
      const v = videoRef.current;
      if (!v) return;
      const [, e] = rangeRef.current;
      if (v.currentTime >= e) {
        v.pause();
        v.currentTime = e;
      }
      setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const setIn = useCallback(() => {
    setRange(([, e]) => [Math.min(videoRef.current?.currentTime ?? 0, e - MIN_CLIP), e]);
  }, []);
  const setOut = useCallback(() => {
    setRange(([s]) => [s, Math.max(videoRef.current?.currentTime ?? 0, s + MIN_CLIP)]);
  }, []);

  useEffect(() => {
    if (!meta || tab !== "trim") return undefined;
    const onKey = (e) => {
      if (e.target.closest?.("input, select, textarea, [role=slider]")) return;
      const v = videoRef.current;
      if (!v) return;
      const step = (s) => seek(Math.min(meta.duration, Math.max(0, v.currentTime + s)));
      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          step(5);
          break;
        case "Comma":
          step(-FRAME);
          break;
        case "Period":
          step(FRAME);
          break;
        case "KeyI":
        case "KeyS":
          setIn();
          break;
        case "KeyO":
        case "KeyE":
          setOut();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [meta, seek, togglePlay, setIn, setOut, tab]);

  // Server-ID des Originals für den Editor (ändert sich bei einem Neu-Upload)
  useEffect(() => {
    let alive = true;
    video?.ref?.uploaded?.then((id) => alive && setOriginalId(id)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [video, upload]);

  const switchTab = (next) => {
    if (next === "edit") {
      videoRef.current?.pause();
      setEditorOpened(true);
    }
    setTab(next);
  };

  // ─── Export ─────────────────────────────────────────────────────────────

  const desktop = platform?.kind === "desktop";
  const presets = presetsFor(desktop);
  const preset = findPreset(presetId);

  const source = useMemo(
    () =>
      meta && video && meta.width > 0 && meta.height > 0
        ? {
            width: meta.width,
            height: meta.height,
            duration: meta.duration,
            size: video.size,
            fps: video.ref?.info?.fps || 0,
            videoKbps: sourceVideoKbps(video.ref?.info, video.size, meta.duration),
            audioKbps: video.ref?.info?.audioKbps || 0,
          }
        : null,
    [meta, video]
  );
  const target = source ? resolveTarget(preset, custom, source) : null;
  const clipLength = Math.max(0, range[1] - range[0]);
  const estimate = source ? estimateBytes(target, clipLength, source, output) : 0;
  const hasAudio = video?.ref?.info ? video.ref.info.hasAudio : true;

  // Lautstärke im Player mithören (Browser kann nicht über 100 % gehen)
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = Math.min(1, volume);
  }, [volume, video]);

  // Geänderte Einstellungen machen ein altes Ergebnis ungültig
  useEffect(() => {
    setJob((j) => (j?.state === "done" ? null : j));
  }, [presetId, custom, volume, range, output]);

  // Video ohne Tonspur: nur Video exportieren
  useEffect(() => {
    if (!hasAudio) setOutput("video");
  }, [hasAudio]);

  const runExport = async () => {
    if (!platform || !video || !target) return;
    setJob({ state: "running", progress: desktop ? 0 : null });
    try {
      const result = await platform.exportVideo(
        video,
        { start: range[0], end: range[1], volume, target, output },
        {
          onProgress: (p) =>
            setJob((j) => (j?.state === "running" ? { ...j, progress: p } : j)),
        }
      );
      setJob(result ? { state: "done", result } : null);
    } catch (e) {
      const message = e.message || String(e);
      setJob(message === "cancelled" ? null : { state: "error", message });
    }
  };

  const cancelExport = () => platform?.cancel?.();

  // ─── Darstellung ────────────────────────────────────────────────────────

  const running = job?.state === "running";
  const uploading = upload !== null && !desktop;

  return (
    <div className={`app ${isDesktop ? "is-desktop" : ""}`} {...webDrop}>
      <div className="backdrop" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <header className="topbar" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          <TrimMark />
          Trimly
        </span>
        {video && (
          <span className="file" data-tauri-drag-region>
            <span className="file-name" title={video.name}>{video.name}</span>
            <span className="file-size">{formatBytes(video.size)}</span>
          </span>
        )}
        {video && platform && (
          <div className="tabs" role="tablist" aria-label="Ansicht">
            {[
              ["trim", "Schneiden"],
              ["edit", "Editor"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`tab ${tab === id ? "is-active" : ""}`}
                onClick={() => switchTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {video && (
          <button className="btn btn-quiet" onClick={replaceVideo} disabled={running}>
            Anderes Video
          </button>
        )}
      </header>

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => openVideo(e.target.files[0])}
        data-testid="file-input"
      />

      {!video ? (
        <main className={`empty ${dragging ? "is-dragging" : ""}`}>
          <div className="empty-inner">
            <TrimMark large />
            <h1>
              Video hierher ziehen
              <span>schneiden, verkleinern, fertig</span>
            </h1>
            <p>Wähle den Teil, den du brauchst. Trimly macht daraus eine kleinere Datei.</p>
            <button className="btn btn-primary" onClick={chooseFile} disabled={!platform}>
              Video auswählen
            </button>
            <p className="empty-formats">MP4, MOV, MKV und WebM</p>
            {job?.state === "error" && <p className="notice notice-error" role="alert">{job.message}</p>}
          </div>
        </main>
      ) : (
        <>
        {/* Schneiden bleibt beim Tabwechsel erhalten (Marker, Einstellungen) */}
        <main
          key={video.src}
          className={`workspace ${dragging ? "is-dragging" : ""}`}
          hidden={tab !== "trim"}
        >
          <section className="stage">
            <div className="screen">
              <video
                ref={videoRef}
                src={video.src}
                onLoadedMetadata={onLoadedMetadata}
                onResize={onResize}
                onLoadedData={() => log(`loadeddata readyState=${videoRef.current?.readyState}`)}
                onError={onVideoError}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => !playing && setCurrent(e.currentTarget.currentTime)}
                onClick={togglePlay}
                playsInline
                preload="auto"
              />
            </div>

            <div className="transport">
              <button
                className="btn btn-icon"
                onClick={togglePlay}
                disabled={!meta}
                aria-label={playing ? "Pause" : "Abspielen"}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="time">
                {formatTime(current)}
                <span className="time-total"> / {formatTime(meta?.duration)}</span>
              </span>
              <span className="marks">
                <button className="mark" onClick={setIn} disabled={!meta} title="Anfang auf Abspielposition (I)">
                  <span className="mark-label">Anfang</span>
                  <span className="time">{formatTime(range[0])}</span>
                </button>
                <button className="mark" onClick={setOut} disabled={!meta} title="Ende auf Abspielposition (O)">
                  <span className="mark-label">Ende</span>
                  <span className="time">{formatTime(range[1])}</span>
                </button>
                <span className="mark mark-static">
                  <span className="mark-label">Länge</span>
                  <span className="time">{formatTime(clipLength)}</span>
                </span>
              </span>
            </div>

            <Timeline
              src={video.src}
              duration={meta?.duration || 0}
              aspect={meta ? meta.width / meta.height : 16 / 9}
              range={range}
              current={current}
              onSeek={seek}
              onRangeChange={setRange}
            />

            <p className="hint">
              Griffe ziehen oder <kbd>I</kbd> und <kbd>O</kbd> drücken, um Anfang und Ende zu setzen.
              <kbd>Leertaste</kbd> spielt den Ausschnitt ab.
            </p>
          </section>

          <aside className="panel" aria-label="Export">
            <fieldset className={`field ${output === "audio" ? "is-inactive" : ""}`} disabled={output === "audio"}>
              <legend>Qualität</legend>
              <div className="choices">
                {presets.map((p) => (
                  <label key={p.id} className={`choice ${presetId === p.id ? "is-active" : ""}`}>
                    <input
                      type="radio"
                      name="preset"
                      value={p.id}
                      checked={presetId === p.id}
                      onChange={() => setPresetId(p.id)}
                      disabled={running}
                    />
                    <span className="choice-label">{p.label}</span>
                    <span className="choice-hint">{p.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {output !== "audio" && presetId === "custom" && (
              <div className="custom">
                <label className="field-inline">
                  <span>Auflösung</span>
                  <select
                    value={custom.height}
                    onChange={(e) => setCustom({ ...custom, height: Number(e.target.value) })}
                  >
                    {CUSTOM_HEIGHTS.map((h) => (
                      <option key={h.value} value={h.value}>{h.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field-inline">
                  <span>Bilder pro Sekunde</span>
                  <input
                    type="number"
                    min="1"
                    max="240"
                    value={custom.fps}
                    onChange={(e) => setCustom({ ...custom, fps: e.target.value })}
                  />
                </label>
                <label className="field-inline">
                  <span>Bitrate in kbit/s</span>
                  <input
                    type="number"
                    min="100"
                    step="100"
                    value={custom.bitrate}
                    onChange={(e) => setCustom({ ...custom, bitrate: e.target.value })}
                  />
                </label>
              </div>
            )}

            <fieldset className="field">
              <legend>Ausgabe</legend>
              <div className="segmented">
                {OUTPUTS.map((o) => (
                  <label
                    key={o.id}
                    className={`segment ${output === o.id ? "is-active" : ""}`}
                    title={o.hint}
                  >
                    <input
                      type="radio"
                      name="output"
                      value={o.id}
                      checked={output === o.id}
                      onChange={() => setOutput(o.id)}
                      disabled={running || (!hasAudio && o.id !== "video")}
                    />
                    <OutputIcon kind={o.id} />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {output === "video" ? (
              <p className="field-note">
                <OutputIcon kind="video" />
                Das Ergebnis hat keinen Ton.
              </p>
            ) : (
              <label className="field">
                <span className="field-row">
                  <span className="legend">Lautstärke</span>
                  <span className="value">{volume === 0 ? "Stumm" : `${Math.round(volume * 100)} %`}</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  disabled={running}
                  aria-label="Lautstärke"
                />
              </label>
            )}

            <div className="summary">
              {output === "audio" && <p className="summary-line">MP3, 192 kbit/s</p>}
              {output !== "audio" && target && !target.copy && (
                <p className="summary-line">
                  {target.width} × {target.height}, {Math.round(target.fps)} fps, {target.bitrate} kbit/s
                </p>
              )}
              {output !== "audio" && target?.capped && (
                <p className="summary-line">Bitrate auf die des Originals begrenzt</p>
              )}
              <p className="summary-size">
                <span>ca. {formatBytes(estimate)}</span>
                {video && <span className="summary-original">statt {formatBytes(video.size)}</span>}
              </p>
            </div>

            {uploading && (
              <Progress value={upload} label={`Wird hochgeladen, ${upload} %`} />
            )}

            {running ? (
              <div className="running">
                <Progress
                  value={job.progress === null ? null : Math.round(job.progress * 100)}
                  label={
                    job.progress === null
                      ? "Wird verarbeitet"
                      : `Wird exportiert, ${Math.round(job.progress * 100)} %`
                  }
                />
                {platform?.cancel && (
                  <button className="btn btn-quiet btn-block" onClick={cancelExport}>
                    Abbrechen
                  </button>
                )}
              </div>
            ) : (
              <button
                className={`btn btn-primary btn-block ${job?.state === "done" ? "is-done" : ""}`}
                onClick={runExport}
                disabled={!meta || clipLength <= 0}
              >
                {desktop ? "Exportieren" : "Exportieren und herunterladen"}
              </button>
            )}

            {job?.state === "done" && (
              <div className="notice notice-done" role="status">
                <p>
                  <strong>{job.result.savedAs}</strong> ist fertig, {formatBytes(job.result.size)}.
                </p>
                {job.result.path && platform?.reveal && (
                  <button className="btn btn-quiet" onClick={() => platform.reveal(job.result.path)}>
                    Im Finder zeigen
                  </button>
                )}
              </div>
            )}
            {job?.state === "error" && (
              <p className="notice notice-error" role="alert">{job.message}</p>
            )}

            {encoder && (
              <p className={`encoder ${encoder.hardware ? "is-hardware" : ""}`}>{encoder.label}</p>
            )}
          </aside>
        </main>
        {editorOpened && (
          <main className="editor-host" hidden={tab !== "edit"}>
            <Editor
              key={video.src}
              api={API}
              platform={platform}
              active={tab === "edit"}
              mainClip={
                meta
                  ? {
                      url: video.src,
                      name: video.name,
                      duration: meta.duration,
                      // Desktop: der Dateipfad ist die „ID“, es wird nichts hochgeladen
                      originalId: desktop ? video.ref.path : originalId,
                    }
                  : null
              }
              ensureMainOriginal={(force) =>
                desktop ? Promise.resolve(video.ref.path) : video.ref.ensureUploaded(force)
              }
              formatFileSize={formatBytes}
            />
          </main>
        )}
        </>
      )}
    </div>
  );
}

function Progress({ value, label }) {
  const indeterminate = value === null || value === undefined;
  return (
    <div className="progress">
      <div
        className={`progress-bar ${indeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : value}
      >
        <span style={indeterminate ? undefined : { width: `${value}%` }} />
      </div>
      <p className="progress-label">{label}</p>
    </div>
  );
}

// Lautsprecher (mit Ton), durchgestrichener Lautsprecher (ohne Ton), Note (nur Ton)
function OutputIcon({ kind }) {
  const speaker = <path d="M3 9.5h3l4-3.5v12l-4-3.5H3z" fill="currentColor" />;
  return (
    <svg className="output-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "both" && (
        <>
          {speaker}
          <path d="M14 9a4 4 0 0 1 0 6M16.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {kind === "video" && (
        <>
          {speaker}
          <path d="M14.5 9.5l5 5M19.5 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {kind === "audio" && (
        <path d="M9 17.5V6l10-2v11.5M9 17.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 17.5zM19 15.5a2.5 2.5 0 1 1-2.5-2.5 2.5 2.5 0 0 1 2.5 2.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function TrimMark({ large }) {
  const size = large ? 56 : 18;
  return (
    <svg className="trim-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3H3v18h4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M17 3h4v18h-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M10 8.5v7l5.5-3.5z" fill="currentColor" />
    </svg>
  );
}

const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
  </svg>
);

const PauseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" fill="currentColor" />
  </svg>
);
