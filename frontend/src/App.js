import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import Settings from "./components/Settings";
import Timeline from "./components/Timeline";
import { formatBytes, formatTime } from "./lib/format";
import {
  CODECS,
  CUSTOM_HEIGHTS,
  DEFAULT_QUALITY,
  MODES,
  OUTPUTS,
  PRESETS,
  TARGET_SIZES,
  estimateBytes,
  resolveQuality,
  sourceVideoKbps,
} from "./lib/presets";
import { useSettings } from "./lib/settings";
import { useUndo } from "./lib/useUndo";
import { isDesktop, loadPlatform } from "./platform";
import { API } from "./platform/web";

// Editor als eigenes Bundle: wird erst geladen, wenn man in die Nähe des Tabs kommt,
// damit der Start (Trim-Ansicht) schlank bleibt
const loadEditor = () => import("./editor/Editor");
const Editor = lazy(loadEditor);

const FRAME = 1 / 30;
const MIN_CLIP = 0.01; // Sekunden
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

export default function App() {
  const [platform, setPlatform] = useState(null);
  const [encoder, setEncoder] = useState(null);
  const [settings, updateSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [video, setVideo] = useState(null); // { name, size, src, ref, dispose }
  const [meta, setMeta] = useState(null); // { duration, width, height }
  const [upload, setUpload] = useState(null); // Web: Upload-Fortschritt 0–100
  const [range, setRange] = useState([0, 0]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [quality, setQuality] = useState(DEFAULT_QUALITY); // { mode, presetId, custom, sizeMb }
  const [volume, setVolume] = useState(1);
  const [output, setOutput] = useState("both"); // both | video | audio

  // Lautstärke nur fürs Abspielen (ändert den Export nicht), über Neustarts gemerkt
  const [playerVolume, setPlayerVolume] = useState(loadPlayerVolume);
  const [playerMuted, setPlayerMuted] = useState(false);

  // { state: running|computed|done|error, progress, computeOnly, result, message }
  // computed: „Nur berechnen“ ist fertig, Export legt das Ergebnis ohne neues Kodieren ab
  const [job, setJob] = useState(null);
  const jobRef = useRef(job);
  jobRef.current = job;
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const platformRef = useRef(null);
  platformRef.current = platform;
  const [dragging, setDragging] = useState(false);
  // Datei aus „Öffnen mit“, während schon ein Video offen ist: erst nachfragen
  const [pendingOpen, setPendingOpen] = useState(null);
  // Editor-Tab (Web: Backend rendert, Desktop: src-tauri/src/edit.rs)
  const [tab, setTab] = useState("trim"); // trim | edit
  const [editorOpened, setEditorOpened] = useState(false);
  const [originalId, setOriginalId] = useState(null);

  const videoRef = useRef(null);
  const inputRef = useRef(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const videoOpenRef = useRef(false);
  videoOpenRef.current = !!video;

  // Rückgängig / Wiederholen für Ausschnitt und Export-Einstellungen
  const applySnapshot = useCallback((s) => {
    setRange(s.range);
    setQuality(s.quality);
    setVolume(s.volume);
    setOutput(s.output);
  }, []);
  const history = useUndo({ range, quality, volume, output }, applySnapshot);
  const { rebase } = history;

  // ─── Plattform laden ────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    loadPlatform().then((p) => alive && setPlatform(p));
    return () => {
      alive = false;
    };
  }, []);

  // Encoder-Anzeige folgt Format und Gerät aus den Einstellungen
  useEffect(() => {
    platform
      ?.encoderInfo?.({ codec: settings.codec, encoder: settings.encoder })
      .then(setEncoder)
      .catch(() => {});
  }, [platform, settings.codec, settings.encoder]);

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
    setQuality(DEFAULT_QUALITY);
    setVolume(1);
    setOutput("both");
    if (jobRef.current?.state === "computed") platformRef.current?.discardComputed?.(jobRef.current.result);
    setJob(null);
    setTab("trim");
    setEditorOpened(false);
    setOriginalId(null);
    rebase({ range: [0, 0], quality: DEFAULT_QUALITY, volume: 1, output: "both" });
    if (inputRef.current) inputRef.current.value = "";
  }, [rebase]);

  const openVideo = useCallback(
    async (source) => {
      if (!platform || !source) return;
      try {
        // Erst öffnen, dann altes Video samt Einstellungen in einem Schritt ersetzen
        const next = await platform.open(source, { onUploadProgress: setUpload });
        log(`opened: ${next.name} ${JSON.stringify(next.ref?.info || {})}`);
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

  // ⌘O / Strg+O und das macOS-Menü: Auswahl öffnen; erst wenn eine Datei gewählt ist, ersetzt
  // sie das alte Video komplett. Abbrechen lässt alles, wie es war.
  const chooseFileRef = useRef(chooseFile);
  chooseFileRef.current = chooseFile;
  const runningRef = useRef(false);

  useEffect(() => {
    if (!platform?.onMenuOpen) return undefined;
    let unlisten;
    let alive = true;
    platform
      .onMenuOpen(() => !runningRef.current && chooseFileRef.current())
      .then((fn) => (alive ? (unlisten = fn) : fn()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [platform]);

  useEffect(() => {
    const onKey = (e) => {
      // Auf dem Mac-Desktop fängt das Menü ⌘O ab
      if (platform?.onMenuOpen && IS_MAC) return;
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyO" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!runningRef.current) chooseFileRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [platform]);

  // Home: zurück zum Startbildschirm, das aktuelle Video wird verworfen
  const goHome = () => resetAll(null);

  // Desktop: Datei aus „Öffnen mit“ oder der Kommandozeile (`Trimly video.mp4`)
  useEffect(() => {
    platform?.initialFile?.().then((path) => path && openVideo(path)).catch(() => {});
    // nur einmal nach dem Laden der Plattform
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // „Öffnen mit Trimly“, während die App schon läuft: bei offenem Video erst nachfragen
  useEffect(() => {
    if (!platform?.onOpenFile) return undefined;
    let unlisten;
    let alive = true;
    platform
      .onOpenFile((path) => (videoOpenRef.current ? setPendingOpen(path) : openVideo(path)))
      .then((fn) => (alive ? (unlisten = fn) : fn()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [platform, openVideo]);

  // Desktop: Drag & Drop aus dem Explorer/Finder kommt über Tauri, nicht als DOM-Event
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
    log(`loadedmetadata ${v.videoWidth}x${v.videoHeight} duration=${v.duration} readyState=${v.readyState}`);
    const duration = info?.duration || v.duration;
    setMeta({
      duration,
      width: info?.width || v.videoWidth,
      height: info?.height || v.videoHeight,
    });
    setRange([0, duration]);
    // Der volle Ausschnitt ist der Ausgangspunkt, nicht ein Schritt zum Rückgängigmachen
    rebase((s) => ({ ...s, range: [0, duration] }));
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
      message: "The preview can't play this video. Exporting still works.",
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

  // Strg+Z / Strg+Y / Strg+Umschalt+Z (Cmd auf dem Mac). In Textfeldern bleibt das eigene Rückgängig.
  const { undo, redo } = history;
  useEffect(() => {
    if (!video || tab !== "trim") return undefined;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target;
      if (t.closest?.("textarea, select, .modal") || (t.tagName === "INPUT" && !["range", "radio", "checkbox"].includes(t.type))) return;
      if (e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [video, tab, undo, redo]);

  useEffect(() => {
    if (!meta || tab !== "trim") return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey) return; // Kürzel wie Strg+Z gehören dem Verlauf
      if (e.target.closest?.("input, select, textarea, [role=slider], .settings, .modal")) return;
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
        case "KeyM":
          setPlayerMuted((m) => !m);
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
  // Die Web-Version kodiert auf dem Server immer H.264
  const codec = desktop ? settings.codec : "h264";
  const setQ = (patch) => setQuality((q) => ({ ...q, ...patch }));

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
  const clipLength = Math.max(0, range[1] - range[0]);
  const target = source ? resolveQuality(quality, source, clipLength, output, codec) : null;
  const estimate = source ? estimateBytes(target, clipLength, source, output) : 0;
  const hasAudio = video?.ref?.info ? video.ref.info.hasAudio : true;

  // Player-Regler × Export-Lautstärke mithören (Browser kann nicht über 100 % gehen)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.min(1, playerVolume * Math.min(1, volume));
    v.muted = playerMuted || playerVolume === 0;
  }, [volume, video, playerVolume, playerMuted]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PLAYER_VOLUME_KEY, String(playerVolume));
    } catch {
      // ohne Speicher eben nicht gemerkt
    }
  }, [playerVolume]);

  // Alles, wovon ein Ergebnis abhängt. Ändert sich etwas, ist ein altes Ergebnis ungültig.
  const paramsKey = JSON.stringify([
    video?.src,
    range,
    quality,
    volume,
    output,
    settings.codec,
    settings.encoder,
  ]);
  const paramsKeyRef = useRef(paramsKey);
  paramsKeyRef.current = paramsKey;

  useEffect(() => {
    const j = jobRef.current;
    if (j?.state === "computed") platformRef.current?.discardComputed?.(j.result);
    if (j?.state === "done" || j?.state === "computed") setJob(null);
  }, [paramsKey]);


  // Video ohne Tonspur: nur Video exportieren
  useEffect(() => {
    if (!hasAudio) {
      setOutput("video");
      rebase((s) => ({ ...s, output: "video" }));
    }
  }, [hasAudio, rebase]);

  // computeOnly: kodieren, aber nicht speichern („Nur berechnen“, zeigt die genaue Größe).
  // Liegt so ein Ergebnis vor und hat sich nichts geändert, speichert Export es sofort.
  const runExport = async ({ askLocation = false, computeOnly = false } = {}) => {
    if (!platform || !video || !target) return;
    setExportMenuOpen(false);

    const ready = jobRef.current;
    if (!computeOnly && ready?.state === "computed") {
      try {
        const result = await platform.saveComputed(ready.result, { settings, askLocation });
        if (result) setJob({ state: "done", result });
        return;
      } catch (e) {
        // Web: Server hat das Ergebnis schon gelöscht → normal neu exportieren
        if (e.message !== "expired") {
          setJob({ state: "error", message: e.message || String(e) });
          return;
        }
      }
    }

    const key = paramsKeyRef.current;
    setJob({ state: "running", computeOnly, progress: desktop ? 0 : null });
    try {
      const exportJob = {
        start: range[0],
        end: range[1],
        volume,
        target,
        output,
        // Zielgröße hart einhalten (Desktop kodiert nach, wenn der Encoder darüber liegt)
        maxBytes:
          quality.mode === "size" && output !== "audio" && Number(quality.sizeMb) > 0
            ? Math.floor(Number(quality.sizeMb) * 1024 * 1024)
            : null,
      };
      const opts = {
        settings,
        askLocation,
        onProgress: (p) => setJob((j) => (j?.state === "running" ? { ...j, progress: p } : j)),
      };
      if (computeOnly) {
        const result = await platform.computeVideo(video, exportJob, opts);
        // Während des Rechnens etwas geändert (oder anderes Video): Ergebnis passt nicht mehr
        if (paramsKeyRef.current !== key) {
          platform.discardComputed?.(result);
          setJob((j) => (j?.state === "running" ? null : j));
          return;
        }
        setJob({ state: "computed", result });
      } else {
        const result = await platform.exportVideo(video, exportJob, opts);
        setJob(result ? { state: "done", result } : null);
      }
    } catch (e) {
      const message = e.message || String(e);
      setJob(message === "cancelled" ? null : { state: "error", message });
    }
  };

  // Export-Menü schließt bei Klick daneben und mit Escape
  useEffect(() => {
    if (!exportMenuOpen) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.(".export-menu")) setExportMenuOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setExportMenuOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportMenuOpen]);

  const cancelExport = () => platform?.cancel?.();

  const pickOutputFolder = async () => {
    const folder = await platform?.pickFolder?.();
    if (folder) updateSettings({ outputDir: folder });
  };

  // ─── Darstellung ────────────────────────────────────────────────────────

  const running = job?.state === "running";
  runningRef.current = running;
  const uploading = upload !== null && !desktop;
  const quietInputs = running || output === "audio";
  const codecLabel = CODECS.find((c) => c.id === codec)?.label;

  return (
    <div
      className={`app ${isDesktop ? "is-desktop" : ""} ${IS_MAC ? "is-mac" : ""} ${
        video && tab === "edit" ? "is-editing" : ""
      }`}
      {...webDrop}
    >
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
          </span>
        )}
        {video && platform && (
          <div className="tabs" role="tablist" aria-label="View">
            {[
              ["trim", "Trim"],
              ["edit", "Editor"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`tab ${tab === id ? "is-active" : ""}`}
                onClick={() => switchTab(id)}
                // vorab laden, damit der Wechsel ohne Wartezeit klappt
                onPointerEnter={id === "edit" ? loadEditor : undefined}
                onFocus={id === "edit" ? loadEditor : undefined}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {video && (
          <button
            type="button"
            className="btn btn-icon btn-quiet home-button"
            onClick={goHome}
            disabled={running}
            aria-label="Start screen"
            title={`Start screen – open another video (${IS_MAC ? "⌘" : "Ctrl+"}O)`}
          >
            <HomeIcon />
          </button>
        )}
        <button
          type="button"
          className={`btn btn-icon btn-quiet settings-toggle ${settingsOpen ? "is-active" : ""}`}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}
        >
          <GearIcon />
        </button>
        {settingsOpen && (
          <Settings
            settings={settings}
            update={updateSettings}
            desktop={desktop}
            encoders={encoder?.options || []}
            onPickFolder={pickOutputFolder}
            onClose={() => setSettingsOpen(false)}
          />
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
              Drop a video here
              <span>trim, shrink, done</span>
            </h1>
            <p>Pick the part you need. Trimly turns it into a smaller file.</p>
            <button className="btn btn-primary" onClick={chooseFile} disabled={!platform}>
              Choose video
            </button>
            <p className="empty-formats">MP4, MOV, MKV and WebM</p>
            {job?.state === "error" && <p className="notice notice-error" role="alert">{job.message}</p>}
          </div>
        </main>
      ) : (
        <>
        {/* Trim bleibt beim Tabwechsel erhalten (Marker, Einstellungen) */}
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
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="time">
                {formatTime(current)}
                <span className="time-total"> / {formatTime(meta?.duration)}</span>
              </span>
              <span className="player-volume" title="Player volume. Doesn't change the export. (M)">
                <button
                  className="btn btn-icon btn-quiet"
                  onClick={() => {
                    if (playerVolume === 0) {
                      setPlayerVolume(0.5);
                      setPlayerMuted(false);
                    } else setPlayerMuted((m) => !m);
                  }}
                  aria-label={playerMuted || playerVolume === 0 ? "Unmute player" : "Mute player"}
                >
                  <OutputIcon kind={playerMuted || playerVolume === 0 ? "video" : "both"} />
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={playerMuted ? 0 : playerVolume}
                  onChange={(e) => {
                    setPlayerVolume(Number(e.target.value));
                    setPlayerMuted(false);
                  }}
                  aria-label="Player volume"
                />
              </span>
              {/* Rückgängig/Wiederholen hier nur per Tastatur, Knöpfe gibt es im Editor */}
              <span className="marks">
                <button className="mark" onClick={setIn} disabled={!meta} title="Set start to playhead (I)">
                  <span className="mark-label">Start</span>
                  <span className="time">{formatTime(range[0])}</span>
                </button>
                <button className="mark" onClick={setOut} disabled={!meta} title="Set end to playhead (O)">
                  <span className="mark-label">End</span>
                  <span className="time">{formatTime(range[1])}</span>
                </button>
                <span className="mark mark-static">
                  <span className="mark-label">Length</span>
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
              Drag the handles or press <kbd>I</kbd> and <kbd>O</kbd> to set start and end.
              <kbd>Space</kbd> plays the selection.
            </p>
          </section>

          <aside className="panel" aria-label="Export">
            <fieldset className={`field ${output === "audio" ? "is-inactive" : ""}`} disabled={quietInputs}>
              <legend>Quality</legend>
              <div className="segmented" role="radiogroup" aria-label="Quality mode">
                {MODES.map((m) => (
                  <label
                    key={m.id}
                    className={`segment ${quality.mode === m.id ? "is-active" : ""}`}
                    title={m.hint}
                  >
                    <input
                      type="radio"
                      name="mode"
                      value={m.id}
                      checked={quality.mode === m.id}
                      onChange={() => setQ({ mode: m.id })}
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>

              <div className="mode-panel">
                {quality.mode === "original" && (
                  <p className="mode-note">Cuts without re-encoding. Instant, same quality as the original.</p>
                )}

                {quality.mode === "compress" && (
                  <>
                    <div className="chips" role="radiogroup" aria-label="Compression level">
                      {PRESETS.map((p) => (
                        <label key={p.id} className={`chip ${quality.presetId === p.id ? "is-active" : ""}`}>
                          <input
                            type="radio"
                            name="preset"
                            value={p.id}
                            checked={quality.presetId === p.id}
                            onChange={() => setQ({ presetId: p.id })}
                          />
                          <span className="chip-label">{p.label}</span>
                          <span className="chip-hint">{p.id === "custom" ? "Manual" : `${p.height}p`}</span>
                        </label>
                      ))}
                    </div>
                    {quality.presetId === "custom" && (
                      <div className="custom">
                        <label className="field-inline">
                          <span>Resolution</span>
                          <select
                            value={quality.custom.height}
                            onChange={(e) => setQ({ custom: { ...quality.custom, height: Number(e.target.value) } })}
                          >
                            {CUSTOM_HEIGHTS.map((h) => (
                              <option key={h.value} value={h.value}>{h.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="field-inline">
                          <span>Frames per second</span>
                          <input
                            type="number"
                            min="1"
                            max="240"
                            value={quality.custom.fps}
                            onChange={(e) => setQ({ custom: { ...quality.custom, fps: e.target.value } })}
                          />
                        </label>
                        <label className="field-inline">
                          <span>Bitrate in kbit/s</span>
                          <input
                            type="number"
                            min="100"
                            step="100"
                            value={quality.custom.bitrate}
                            onChange={(e) => setQ({ custom: { ...quality.custom, bitrate: e.target.value } })}
                          />
                        </label>
                      </div>
                    )}
                  </>
                )}

                {quality.mode === "size" && (
                  <>
                    <div className="chips" role="radiogroup" aria-label="Target size">
                      {TARGET_SIZES.map((mb) => (
                        <label key={mb} className={`chip ${Number(quality.sizeMb) === mb ? "is-active" : ""}`}>
                          <input
                            type="radio"
                            name="size"
                            value={mb}
                            checked={Number(quality.sizeMb) === mb}
                            onChange={() => setQ({ sizeMb: mb })}
                          />
                          <span className="chip-label">{mb} MB</span>
                        </label>
                      ))}
                    </div>
                    <label className="field-inline">
                      <span>Size in MB</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={quality.sizeMb}
                        onChange={(e) => setQ({ sizeMb: e.target.value })}
                      />
                    </label>
                    {target?.tooSmall && output !== "audio" && (
                      <p className="mode-note mode-warning">
                        This clip doesn't fit into {quality.sizeMb} MB, even at the lowest quality. Choose a
                        bigger size or a shorter clip.
                      </p>
                    )}
                  </>
                )}
              </div>
            </fieldset>

            <fieldset className="field">
              <legend>Output</legend>
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
                The result has no sound.
              </p>
            ) : (
              <label className="field">
                <span className="field-row">
                  <span className="legend">Volume</span>
                  <span className="value">{volume === 0 ? "Muted" : `${Math.round(volume * 100)} %`}</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  disabled={running}
                  aria-label="Volume"
                />
              </label>
            )}

            <div className="summary">
              {output === "audio" && <p className="summary-line">MP3, 192 kbit/s</p>}
              {output !== "audio" && target && !target.copy && (
                <p className="summary-line">
                  {target.width} × {target.height}, {Math.round(target.fps)} fps, {target.bitrate} kbit/s
                  {desktop && `, ${codecLabel}`}
                </p>
              )}
              {output !== "audio" && target?.capped && (
                <p className="summary-line">Bitrate limited to the original's</p>
              )}
              <p className="summary-size">
                {job?.state === "computed" ? (
                  <span className="is-exact">exactly {formatBytes(job.result.size, { exact: true })}</span>
                ) : (
                  <span>about {formatBytes(estimate)}</span>
                )}
                {video && <span className="summary-original">Original: {formatBytes(video.size)}</span>}
              </p>
            </div>

            {uploading && <Progress value={upload} label={`Uploading, ${upload} %`} />}

            {running ? (
              <div className="running">
                <Progress
                  value={job.progress === null ? null : Math.round(job.progress * 100)}
                  label={
                    job.progress === null
                      ? job.computeOnly
                        ? "Calculating"
                        : "Processing"
                      : `${job.computeOnly ? "Calculating" : "Exporting"}, ${Math.round(job.progress * 100)} %`
                  }
                />
                {platform?.cancel && (
                  <button className="btn btn-quiet btn-block" onClick={cancelExport}>
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <div className="export-row">
                {platform?.computeVideo && (
                  <div className="export-menu">
                    <button
                      className="btn btn-icon btn-quiet export-more"
                      onClick={() => setExportMenuOpen((o) => !o)}
                      disabled={!meta || clipLength <= 0}
                      aria-haspopup="menu"
                      aria-expanded={exportMenuOpen}
                      aria-label="More export options"
                      title="More export options"
                    >
                      <ChevronIcon />
                    </button>
                    {exportMenuOpen && (
                      <div className="menu" role="menu">
                        <button
                          role="menuitem"
                          className="menu-item"
                          onClick={() => runExport({ computeOnly: true })}
                          disabled={job?.state === "computed"}
                        >
                          <span className="menu-label">Calculate exact size</span>
                          <span className="menu-hint">
                            Encodes without saving. Keep the settings and Export is instant.
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <button
                  className={`btn btn-primary btn-block ${job?.state === "done" ? "is-done" : ""}`}
                  onClick={() => runExport()}
                  disabled={!meta || clipLength <= 0}
                  title={desktop && settings.outputDir ? `Saves to ${settings.outputDir}` : undefined}
                >
                  {desktop ? "Export" : "Export and download"}
                </button>
                {desktop && settings.outputDir && (
                  <button
                    className="btn btn-icon btn-quiet export-where"
                    onClick={() => runExport({ askLocation: true })}
                    disabled={!meta || clipLength <= 0}
                    aria-label="Export to another folder"
                    title="Export to another folder"
                  >
                    <FolderIcon />
                  </button>
                )}
              </div>
            )}

            {job?.state === "done" && (
              <div className="notice notice-done" role="status">
                <p>
                  <strong>{job.result.savedAs}</strong> is ready, {formatBytes(job.result.size, { exact: true })}.
                </p>
                {job.result.path && platform?.reveal && (
                  <button className="btn btn-quiet" onClick={() => platform.reveal(job.result.path)}>
                    {IS_MAC ? "Show in Finder" : "Show in folder"}
                  </button>
                )}
              </div>
            )}
            {job?.state === "error" && (
              <p className="notice notice-error" role="alert">{job.message}</p>
            )}

            {encoder && (
              <p className={`encoder ${encoder.hardware ? "is-hardware" : ""}`} title={encoder.label}>
                {encoder.label}
              </p>
            )}
          </aside>
        </main>
        {editorOpened && (
          <main className="editor-host" hidden={tab !== "edit"}>
            <Suspense fallback={null}>
            <Editor
              key={video.src}
              api={API}
              platform={platform}
              settings={settings}
              active={tab === "edit"}
              mainClip={
                meta
                  ? {
                      url: video.src,
                      name: video.name,
                      duration: meta.duration,
                      path: desktop ? video.ref.path : null,
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
            </Suspense>
          </main>
        )}
        </>
      )}

      {pendingOpen && (
        <div className="modal-backdrop">
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="replace-title">
            <h2 id="replace-title">Open {baseName(pendingOpen)}?</h2>
            <p>This replaces the current video. Your trim, settings and editor changes for it will be lost.</p>
            <div className="modal-actions">
              <button className="btn btn-quiet" onClick={() => setPendingOpen(null)} autoFocus>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const path = pendingOpen;
                  setPendingOpen(null);
                  openVideo(path);
                }}
              >
                Open video
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const baseName = (path) => String(path).slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

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

const GearIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

// Kleiner Pfeil nach oben: das Export-Menü öffnet sich über dem Knopf
const ChevronIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PLAYER_VOLUME_KEY = "trimly.playerVolume";

function loadPlayerVolume() {
  try {
    const v = Number(window.localStorage.getItem(PLAYER_VOLUME_KEY));
    return window.localStorage.getItem(PLAYER_VOLUME_KEY) !== null && v >= 0 && v <= 1 ? v : 1;
  } catch {
    return 1;
  }
}

const HomeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);

const FolderIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);
