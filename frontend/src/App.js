import React, { useState, useRef, useEffect } from "react";
import "./App.css";
import VideoPlayer from "./VideoPlayer";
import Editor from "./editor/Editor";
import { PRESETS, DEFAULT_FINETUNE } from "./presets";

const API = process.env.REACT_APP_API_URL !== undefined
  ? process.env.REACT_APP_API_URL   // Prod: "" → relativ, nginx proxied
  : "http://localhost:9000";         // Dev: kein Build, kein Env gesetzt

// Mindestlänge des Ausschnitts in Sekunden
const MIN_CLIP = 0.1;

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".mov", ".webm", ".avi"];

// Muss zu VideoCalculator.AudioBitrateKbps im Backend passen
const AUDIO_KBPS = 128;

function App() {
  const [videoURL, setVideoURL] = useState(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [removeAudio, setRemoveAudio] = useState(false);
  const [playerVolume, setPlayerVolume] = useState(1.0);
  const [limitSize, setLimitSize] = useState(false);
  const [maxSizeMb, setMaxSizeMb] = useState(100);
  const [finetune, setFinetune] = useState(DEFAULT_FINETUNE);
  const [mode, setMode] = useState("medium");
  const [message, setMessage] = useState("");
  const [originalFileName, setOriginalFileName] = useState("");
  const [originalFileSize, setOriginalFileSize] = useState(null);
  const [previewFileSize, setPreviewFileSize] = useState(null);
  const [currentUploadFilename, setCurrentUploadFilename] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [previewedSettings, setPreviewedSettings] = useState(null);
  const [storedOriginalId, setStoredOriginalId] = useState(null);
  const [tab, setTab] = useState("trim"); // "trim" | "edit"
  const [editorOpened, setEditorOpened] = useState(false);
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const uploadXhrRef = useRef(null);

  const formatFileSize = (bytes) => {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const openFileDialog = async () => {
    if (videoURL) return;
    // Chrome/Edge: Dialog im Videos-Ordner starten (dort speichern NVIDIA App und AMD ReLive),
    // danach merkt sich der Browser über die id den zuletzt benutzten Unterordner
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          id: "trimly-videos",
          startIn: "videos",
          types: [{ description: "Videos", accept: { "video/*": VIDEO_EXTENSIONS } }],
        });
        loadFile(await handle.getFile());
      } catch (err) {
        if (err.name !== "AbortError") fileInputRef.current?.click();
      }
      return;
    }
    fileInputRef.current?.click();
  };

  // Gemeinsam für Dateiauswahl und Drag & Drop: Datei anzeigen und im Hintergrund hochladen
  const loadFile = (file) => {
    const isVideo = file && (file.type.startsWith("video/") ||
      VIDEO_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext)));
    if (!isVideo) {
      setMessage("Fehler: Bitte eine Videodatei auswählen.");
      return;
    }
    uploadXhrRef.current?.abort();
    if (videoURL) URL.revokeObjectURL(videoURL);

    setOriginalFileName(file.name);
    setVideoURL(URL.createObjectURL(file));
    setOriginalFileSize(file.size);
    setStartTime(0);
    setEndTime(0);
    setDuration(0);
    setPreviewFileSize(null);
    setCurrentUploadFilename(null);
    setPreviewedSettings(null);
    setStoredOriginalId(null);
    setMessage("Video wird hochgeladen...");
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("video", file);
    const xhr = new XMLHttpRequest();
    uploadXhrRef.current = xhr;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      uploadXhrRef.current = null;
      setUploadProgress(null);
      if (xhr.status === 413) {
        setMessage("Fehler beim Hochladen: Datei ist zu groß für den Server.");
        return;
      }
      try {
        const result = JSON.parse(xhr.responseText);
        if (result.status === "success") {
          setStoredOriginalId(result.originalId);
          setMessage("");
        } else {
          setMessage("Fehler beim Hochladen: " + result.message);
        }
      } catch {
        setMessage(`Fehler beim Hochladen (HTTP ${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      uploadXhrRef.current = null;
      setUploadProgress(null);
      setMessage("Fehler beim Hochladen: Server nicht erreichbar.");
    };
    xhr.open("POST", `${API}/store`);
    xhr.send(formData);
  };

  const handleFileChange = (e) => loadFile(e.target.files[0]);

  const handleReset = () => {
    uploadXhrRef.current?.abort();
    uploadXhrRef.current = null;
    if (videoURL) URL.revokeObjectURL(videoURL);
    setVideoURL(null);
    setTab("trim");
    setEditorOpened(false);
    setStartTime(0);
    setEndTime(0);
    setDuration(0);
    setCurrentTime(0);
    setVolume(1.0);
    setRemoveAudio(false);
    setPlayerVolume(1.0);
    setMode("medium");
    setMessage("");
    setOriginalFileSize(null);
    setPreviewFileSize(null);
    setCurrentUploadFilename(null);
    setPreviewedSettings(null);
    setStoredOriginalId(null);
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Alle Einstellungen, die das Ergebnis beeinflussen
  const getSettings = () => {
    if (mode === "original") {
      return {
        mode,
        startMs: Math.floor(startTime * 1000),
        endMs: Math.floor(endTime * 1000),
        volume,
        removeAudio,
      };
    }
    let fps, resolution, bitrate;
    if (mode === "finetune") {
      fps = finetune.fps;
      bitrate = finetune.bitrate;
      resolution = finetune.resolution === "custom"
        ? `${finetune.customWidth}x${finetune.customHeight}`
        : finetune.resolution;
    } else {
      ({ fps, resolution, bitrate } = PRESETS[mode]);
    }
    return {
      mode,
      startMs: Math.floor(startTime * 1000),
      endMs: Math.floor(endTime * 1000),
      volume,
      removeAudio,
      fps,
      resolution,
      bitrate,
      maxSizeMb: limitSize ? maxSizeMb : null,
    };
  };

  const validateSettings = (s) => {
    if (s.mode === "original") return null;
    const [w, h] = s.resolution.split("x").map(Number);
    if (!(w >= 16 && h >= 16)) return "Bitte gültige Breite und Höhe angeben.";
    if (!(s.fps > 0)) return "Bitte gültige FPS angeben.";
    if (!(s.bitrate > 0)) return "Bitte gültige Bitrate angeben.";
    if (s.maxSizeMb !== null && !(s.maxSizeMb > 0)) return "Bitte gültige Maximalgröße angeben.";
    return null;
  };

  const buildFormData = (s) => {
    const formData = new FormData();
    formData.append("originalId", storedOriginalId);
    formData.append("mode", s.mode);
    formData.append("startTime", s.startMs);
    formData.append("endTime", s.endMs);
    formData.append("volume", s.volume);
    formData.append("removeAudio", s.removeAudio);
    if (s.mode === "original") return formData;
    formData.append("framerate", s.fps);
    formData.append("bitrate", s.bitrate);
    formData.append("resolution", s.resolution);
    if (s.maxSizeMb !== null) formData.append("maxSizeMb", s.maxSizeMb);
    return formData;
  };

  // Direkter Download-Link: der Browser streamt die Datei auf die Platte statt sie im RAM zu halten
  const doDownload = (filename) => {
    const nameParts = originalFileName.split(".");
    const ext = nameParts.length > 1 ? nameParts.pop() : "mp4";
    const downloadName = `${nameParts.join(".")}_trim.${ext}`;
    const a = document.createElement("a");
    a.href = `${API}/download/${encodeURIComponent(filename)}?name=${encodeURIComponent(downloadName)}`;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setMessage("Download gestartet!");
  };

  // Verarbeitet Video mit aktuellen Settings, speichert temporär
  const handlePreview = async (autoDownload = false) => {
    if (!storedOriginalId) {
      setMessage(uploadProgress !== null
        ? "Video wird noch hochgeladen, bitte kurz warten..."
        : "Fehler: Video ist nicht auf dem Server. Bitte erneut auswählen.");
      return;
    }
    const settings = getSettings();
    const invalid = validateSettings(settings);
    if (invalid) {
      setMessage("Fehler: " + invalid);
      return;
    }

    setPreviewing(true);
    setPreviewFileSize(null);
    setCurrentUploadFilename(null);
    setMessage(autoDownload ? "Verarbeitung läuft, Download startet danach..." : "Verarbeitung läuft...");

    try {
      const res = await fetch(`${API}/process`, { method: "POST", body: buildFormData(settings) });
      const result = await res.json();

      if (result.status !== "success") {
        setMessage("Fehler: " + result.message);
        return;
      }

      const filename = result.filename;
      const checkUrl = `${API}/check/${encodeURIComponent(filename)}`;

      // Pollen bis fertig oder fehlgeschlagen (kein festes Zeitlimit, große Videos dauern)
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        let d;
        try {
          d = await (await fetch(checkUrl)).json();
        } catch {
          continue; // kurzzeitiger Netzwerkfehler
        }
        if (d.status === "ready") {
          setCurrentUploadFilename(filename);
          setPreviewFileSize(d.size);
          setPreviewedSettings(JSON.stringify(settings));
          if (autoDownload) doDownload(filename);
          else setMessage("Preview bereit.");
          return;
        }
        if (d.status === "error") {
          setMessage("Fehler bei der Verarbeitung: " + d.message);
          return;
        }
        if (d.status === "unknown") {
          setMessage("Fehler: Verarbeitungsauftrag unbekannt (Server neu gestartet?). Bitte Video erneut auswählen.");
          return;
        }
      }
    } catch (err) {
      setMessage("Fehler: " + err.message);
    } finally {
      setPreviewing(false);
    }
  };

  // Download nur ohne erneute Verarbeitung, wenn sich seit der Preview nichts geändert hat
  const canDownload = !!(
    currentUploadFilename &&
    previewedSettings === JSON.stringify(getSettings())
  );

  // Sofortige Schätzung ohne Verarbeitung: Original = anteilige Dateigröße, sonst Bitrate × Länge
  const estimateSize = () => {
    const seconds = Math.max(0, endTime - startTime);
    if (!duration || !originalFileSize || !seconds) return null;
    if (mode === "original") return originalFileSize * (seconds / duration);
    const s = getSettings();
    let bytes = (s.bitrate + (removeAudio ? 0 : AUDIO_KBPS)) * 1000 / 8 * seconds;
    if (s.maxSizeMb) bytes = Math.min(bytes, s.maxSizeMb * 1024 * 1024);
    return bytes;
  };

  // Download: direkt wenn Preview gültig, sonst Preview → Download
  const handleDownload = async () => {
    if (canDownload) doDownload(currentUploadFilename);
    else await handlePreview(true);
  };

  const updateStartTime = (t) => setStartTime(Math.max(0, Math.min(t, duration - MIN_CLIP)));
  const updateEndTime = (t) => setEndTime(Math.max(MIN_CLIP, Math.min(t, duration)));

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  };

  const skipTime = React.useCallback((time) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + time));
  }, [duration]);

  const changeVolume = React.useCallback((amount) => {
    setPlayerVolume(v => Math.min(1, Math.max(0, v + amount)));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!videoURL || tab !== "trim") return;
      // Tastenkürzel nicht auslösen, während in Eingabefeldern getippt wird
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) && e.target.type !== "range" && e.target.type !== "checkbox") return;
      if (e.code === "Space") { e.preventDefault(); togglePlayPause(); }
      if (e.code === "Period") { e.preventDefault(); skipTime(1 / 30); }
      else if (e.code === "Comma") { e.preventDefault(); skipTime(-1 / 30); }
      if (e.code === "ArrowRight") { e.preventDefault(); skipTime(5); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); skipTime(-5); }
      if (e.code === "KeyS") updateStartTime(currentTime);
      else if (e.code === "KeyE") updateEndTime(currentTime);
      if (e.code === "ArrowUp") { e.preventDefault(); changeVolume(0.05); }
      else if (e.code === "ArrowDown") { e.preventDefault(); changeVolume(-0.05); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const handleDrop = (e) => {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  };

  const handleDragOver = (e) => e.preventDefault();

  const handleLoadedMetadata = () => {
    const vid = videoRef.current;
    setDuration(vid.duration);
    setStartTime(0);
    setEndTime(vid.duration);
  };

  const handleTimeUpdate = () => {
    setCurrentTime(videoRef.current.currentTime);
  };

  // Ende immer hinter dem Start halten
  useEffect(() => {
    if (duration > 0 && endTime <= startTime) setEndTime(Math.min(duration, startTime + 1));
  }, [startTime, endTime, duration]);

  const switchTab = (next) => {
    if (next === "edit") {
      videoRef.current?.pause();
      setEditorOpened(true);
    }
    setTab(next);
  };

  return (
    <div className={`App ${tab === "edit" ? "wide" : ""}`}>
      <h1>🎬 Video Upload & Trim</h1>

      {videoURL && (
        <div className="tabs">
          <button type="button" className={tab === "trim" ? "active" : ""} onClick={() => switchTab("trim")}>
            ✂ Schneiden
          </button>
          <button type="button" className={tab === "edit" ? "active" : ""} onClick={() => switchTab("edit")}>
            🎞 Editor
          </button>
        </div>
      )}

      <input
        type="file"
        accept="video/*"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      {/* Schneiden-Tab bleibt beim Tabwechsel erhalten (Marker, Player-Zustand) */}
      <div className="dropzone-wrapper" style={{ display: tab === "trim" ? undefined : "none" }}>
        {message && !videoURL && (
          <p style={{ color: message.includes("Fehler") ? "red" : "green", marginBottom: "10px" }}>
            {message}
          </p>
        )}
        <div
          className={`dropzone ${videoURL ? "loaded" : ""}`}
          onClick={!videoURL ? openFileDialog : undefined}
          onDrop={!videoURL ? handleDrop : undefined}
          onDragOver={!videoURL ? handleDragOver : undefined}
        >
          {!videoURL ? (
            <p>Ziehe eine Videodatei hierher oder klicke, um eine Datei auszuwählen</p>
          ) : (
            <VideoPlayer
              videoURL={videoURL}
              videoRef={videoRef}
              currentTime={currentTime}
              duration={duration}
              startTime={startTime}
              endTime={endTime}
              volume={volume}
              playerVolume={playerVolume}
              limitSize={limitSize}
              setLimitSize={setLimitSize}
              maxSizeMb={maxSizeMb}
              setMaxSizeMb={setMaxSizeMb}
              finetune={finetune}
              setFinetune={setFinetune}
              handlePreview={handlePreview}
              handleDownload={handleDownload}
              handleReset={handleReset}
              previewing={previewing}
              uploadProgress={uploadProgress}
              handleLoadedMetadata={handleLoadedMetadata}
              handleTimeUpdate={handleTimeUpdate}
              setStartTime={updateStartTime}
              setEndTime={updateEndTime}
              setVolume={setVolume}
              removeAudio={removeAudio}
              setRemoveAudio={setRemoveAudio}
              setPlayerVolume={setPlayerVolume}
              mode={mode}
              setMode={setMode}
              message={message}
              setMessage={setMessage}
              originalFileSize={originalFileSize}
              previewFileSize={canDownload ? previewFileSize : null}
              estimatedSize={estimateSize()}
              formatFileSize={formatFileSize}
            />
          )}
        </div>

        <div className="info-panel-side">
          <div style={{ fontWeight: 700, marginBottom: "10px" }}>Timeline Controls</div>
          <div style={{ marginBottom: "10px" }}>
            <div style={{ marginBottom: "6px" }}><strong>Click</strong> → Preview jump</div>
            <div style={{ marginBottom: "6px" }}><strong>Shift + Click</strong> → Set start</div>
            <div><strong>Alt + Click</strong> → Set end</div>
          </div>
        </div>
      </div>

      {videoURL && editorOpened && (
        <div style={{ display: tab === "edit" ? undefined : "none" }}>
          <Editor
            key={videoURL}
            api={API}
            active={tab === "edit"}
            mainClip={duration > 0
              ? { url: videoURL, name: originalFileName, duration, originalId: storedOriginalId }
              : null}
            formatFileSize={formatFileSize}
          />
        </div>
      )}
    </div>
  );
}

export default App;
