import React, { useState, useRef, useEffect } from "react";
import "./App.css";
import VideoPlayer from "./VideoPlayer";

const API = process.env.REACT_APP_API_URL !== undefined
  ? process.env.REACT_APP_API_URL   // Prod: "" → relativ, nginx proxied
  : "http://localhost:9000";         // Dev: kein Build, kein Env gesetzt

function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoURL, setVideoURL] = useState(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [playerVolume, setPlayerVolume] = useState(1.0);
  const [limitSize, setLimitSize] = useState(false);
  const [maxSizeMb, setMaxSizeMb] = useState(100);
  const [changeResolution, setChangeResolution] = useState(false);
  const [resolution, setResolution] = useState("720p");
  const [customWidth, setCustomWidth] = useState("");
  const [customHeight, setCustomHeight] = useState("");
  const [mode, setMode] = useState("medium");
  const [message, setMessage] = useState("");
  const [originalFileName, setOriginalFileName] = useState("");
  const [originalFileSize, setOriginalFileSize] = useState(null);
  const [previewFileSize, setPreviewFileSize] = useState(null);
  const [currentUploadFilename, setCurrentUploadFilename] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewedSettings, setPreviewedSettings] = useState(null);
  const videoRef = useRef(null);
  const progressBarRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoFileRef = useRef(null);

  const formatFileSize = (bytes) => {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const resolutionMapping = {
    "720p": { width: 1280, height: 720 },
    "1080p": { width: 1920, height: 1080 },
    "480p": { width: 854, height: 480 },
  };

  const openFileDialog = () => {
    if (!videoURL) fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith("video/")) {
      videoFileRef.current = file;
      setVideoFile(file);
      setOriginalFileName(file.name);
      setVideoURL(URL.createObjectURL(file));
      setOriginalFileSize(file.size);
      setPreviewFileSize(null);
      setCurrentUploadFilename(null);
      setMessage("");
    }
  };

  // Baut FormData mit allen aktuellen Settings
  const buildFormData = () => {
    const presets = {
      low:      { fps: 24, resolution: "854x480",   bitrate: 1000 },
      medium:   { fps: 30, resolution: "1280x720",  bitrate: 2500 },
      high:     { fps: 60, resolution: "1920x1080", bitrate: 5000 },
      finetune: { fps: 30, resolution: "1280x720",  bitrate: 2500 },
    };
    const preset = presets[mode];

    const formData = new FormData();
    formData.append("video", videoFileRef.current);
    formData.append("startTime", Math.floor(startTime * 1000));
    formData.append("endTime", Math.floor(endTime * 1000));
    formData.append("volume", volume);
    formData.append("framerate", preset.fps);
    formData.append("bitrate", preset.bitrate);

    if (limitSize) formData.append("maxSizeMb", maxSizeMb);

    let resolutionWidth, resolutionHeight;
    if (mode !== "finetune") {
      [resolutionWidth, resolutionHeight] = preset.resolution.split("x");
    } else if (changeResolution) {
      if (resolution === "custom") {
        resolutionWidth = customWidth;
        resolutionHeight = customHeight;
      } else {
        resolutionWidth = resolutionMapping[resolution].width;
        resolutionHeight = resolutionMapping[resolution].height;
      }
    }
    if (resolutionWidth && resolutionHeight) {
      formData.append("resolution", `${resolutionWidth}x${resolutionHeight}`);
    }

    return formData;
  };

  const doDownload = async (filename) => {
    const downloadUrl = `${API}/download/${encodeURIComponent(filename)}`;
    const response = await fetch(downloadUrl);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const nameParts = originalFileName.split(".");
    const ext = nameParts.pop();
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `${nameParts.join(".")}_trim.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
    setMessage("Download gestartet!");
  };

  // Verarbeitet Video mit aktuellen Settings, speichert temporär
  const handlePreview = async (autoDownload = false) => {
    if (!videoFileRef.current) return;
    setPreviewing(true);
    setPreviewFileSize(null);
    setCurrentUploadFilename(null);
    setMessage(autoDownload ? "Verarbeitung läuft, Download startet danach..." : "Verarbeitung läuft...");

    try {
      const formData = buildFormData();
      const res = await fetch(`${API}/upload`, { method: "POST", body: formData });
      const result = await res.json();

      if (result.status !== "success") {
        setMessage("Fehler: " + result.message);
        setPreviewing(false);
        return;
      }

      const filename = result.filename;
      const checkUrl = `${API}/check/${encodeURIComponent(filename)}`;

      for (let i = 0; i < 300; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const r2 = await fetch(checkUrl);
          const d = await r2.json();
          if (d.exists === true && d.size) {
            setCurrentUploadFilename(filename);
            setPreviewFileSize(d.size);
            setPreviewedSettings({ mode, startTime, endTime, volume });
            setPreviewing(false);
            if (autoDownload) {
              await doDownload(filename);
            } else {
              setMessage("Preview bereit.");
            }
            return;
          }
        } catch (e) {}
      }
    } catch (err) {
      setMessage("Fehler: " + err.message);
    }
    setPreviewing(false);
  };

  // Settings haben sich seit letztem Preview geändert?
  const canDownload = !!(
    currentUploadFilename &&
    previewedSettings &&
    previewedSettings.mode === mode &&
    Math.abs(previewedSettings.startTime - startTime) < 0.05 &&
    Math.abs(previewedSettings.endTime - endTime) < 0.05 &&
    previewedSettings.volume === volume
  );

  // Download: direkt wenn Preview gültig, sonst Preview → Download
  const handleDownload = async () => {
    if (canDownload) {
      try {
        setMessage("Download wird vorbereitet...");
        await doDownload(currentUploadFilename);
      } catch (err) {
        setMessage("Fehler beim Download: " + err.message);
      }
    } else {
      await handlePreview(true);
    }
  };

  // Preview invalidieren wenn sich Settings ändern
  useEffect(() => {
    setPreviewFileSize(null);
    setCurrentUploadFilename(null);
  }, [mode]);

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (video.paused) video.play();
    else video.pause();
  };

  const skipTime = React.useCallback((time) => {
    const video = videoRef.current;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + time));
  }, [duration]);

  const changeVolume = React.useCallback((amount) => {
    const newVolume = Math.min(1, Math.max(0, playerVolume + amount));
    setPlayerVolume(newVolume);
    if (videoRef.current) videoRef.current.volume = newVolume;
  }, [playerVolume]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === "Space") { e.preventDefault(); togglePlayPause(); }
      if (e.code === "Period") { e.preventDefault(); skipTime(1 / 30); }
      else if (e.code === "Comma") { e.preventDefault(); skipTime(-1 / 30); }
      if (e.code === "ArrowRight") { e.preventDefault(); skipTime(5); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); skipTime(-5); }
      if (e.code === "KeyS") setStartTime(currentTime);
      else if (e.code === "KeyE") setEndTime(currentTime);
      if (e.code === "ArrowUp") { e.preventDefault(); changeVolume(0.05); }
      else if (e.code === "ArrowDown") { e.preventDefault(); changeVolume(-0.05); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentTime, volume, changeVolume, skipTime]);

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      videoFileRef.current = file;
      setVideoFile(file);
      setOriginalFileName(file.name);
      setVideoURL(URL.createObjectURL(file));
      setOriginalFileSize(file.size);
      setPreviewFileSize(null);
      setCurrentUploadFilename(null);
      setMessage("");
    }
  };

  const handleDragOver = (e) => e.preventDefault();

  const handleLoadedMetadata = () => {
    const vid = videoRef.current;
    setDuration(vid.duration);
    setEndTime(vid.duration);
  };

  const handleTimeUpdate = () => {
    setCurrentTime(videoRef.current.currentTime);
  };

  const handleTimelineClick = (e) => {
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = duration * percent;
    if (e.shiftKey) setStartTime(Math.min(newTime, endTime));
    else if (e.altKey) setEndTime(Math.max(newTime, startTime));
    else videoRef.current.currentTime = newTime;
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setPlayerVolume(newVolume);
    if (videoRef.current) videoRef.current.volume = newVolume;
  };

  const handleSoundMultiplierChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) videoRef.current.volume = playerVolume * newVolume;
  };

  useEffect(() => {
    if (endTime <= startTime) setEndTime(startTime + 1);
  }, [startTime, endTime]);

  return (
    <div className="App">
      <h1>🎬 Video Upload & Trim</h1>

      <input
        type="file"
        accept="video/*"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <div className="dropzone-wrapper">
        {message && (
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
              progressBarRef={progressBarRef}
              currentTime={currentTime}
              duration={duration}
              startTime={startTime}
              endTime={endTime}
              volume={volume}
              playerVolume={playerVolume}
              handleTimelineClick={handleTimelineClick}
              togglePlayPause={togglePlayPause}
              handleVolumeChange={handleVolumeChange}
              handleSoundMultiplierChange={handleSoundMultiplierChange}
              limitSize={limitSize}
              setLimitSize={setLimitSize}
              maxSizeMb={maxSizeMb}
              setMaxSizeMb={setMaxSizeMb}
              changeResolution={changeResolution}
              setChangeResolution={setChangeResolution}
              resolution={resolution}
              setResolution={setResolution}
              resolutionMapping={resolutionMapping}
              customWidth={customWidth}
              setCustomWidth={setCustomWidth}
              customHeight={customHeight}
              setCustomHeight={setCustomHeight}
              handlePreview={handlePreview}
              handleDownload={handleDownload}
              previewing={previewing}
              handleLoadedMetadata={handleLoadedMetadata}
              handleTimeUpdate={handleTimeUpdate}
              setStartTime={setStartTime}
              setEndTime={setEndTime}
              setDuration={setDuration}
              setCurrentTime={setCurrentTime}
              setVolume={setVolume}
              setPlayerVolume={setPlayerVolume}
              mode={mode}
              setMode={setMode}
              message={message}
              setMessage={setMessage}
              originalFileSize={originalFileSize}
              previewFileSize={previewFileSize}
              canDownload={canDownload}
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
    </div>
  );
}

export default App;
