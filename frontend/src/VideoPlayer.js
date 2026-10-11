import React, { useRef, useState, useEffect } from "react";
import "./VideoPlayer.css";
import { PRESETS, RESOLUTION_OPTIONS } from "./presets";

const inputStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  boxSizing: "border-box",
  fontSize: "0.9rem",
};

const labelStyle = { display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "0.9rem" };

export default function VideoPlayer({
  videoURL,
  videoRef,
  currentTime,
  duration,
  startTime,
  endTime,
  volume,
  playerVolume,
  limitSize,
  setLimitSize,
  maxSizeMb,
  setMaxSizeMb,
  finetune,
  setFinetune,
  handleLoadedMetadata,
  handleTimeUpdate,
  setStartTime,
  setEndTime,
  setVolume,
  removeAudio,
  setRemoveAudio,
  setPlayerVolume,
  mode,
  setMode,
  message,
  setMessage,
  handleDownload,
  handlePreview,
  handleReset,
  previewing,
  uploadProgress,
  originalFileSize,
  previewFileSize,
  estimatedSize,
  formatFileSize,
}) {
  const timelineRef = useRef(null);

  const [mute, setMute] = useState(false);

  // Vorschau-Lautstärke ist unabhängig von der Export-Lautstärke
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = mute ? 0 : playerVolume;
    }
  }, [playerVolume, mute, videoRef]);

  const handleVideoClick = () => {
    const video = videoRef.current;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  };

  const timeAtClientX = (clientX) => {
    const rect = timelineRef.current.getBoundingClientRect();
    const percent = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(duration, percent * duration));
  };

  const handleLocalTimelineClick = (e) => {
    const time = timeAtClientX(e.clientX);
    if (e.shiftKey) {
      setStartTime(Math.min(time, endTime));
    } else if (e.altKey) {
      setEndTime(Math.max(time, startTime));
    } else {
      videoRef.current.currentTime = time;
    }
  };

  const handleAudioMultiplier = (val) => {
    const vol = Math.min(2, Math.max(0, val));
    setVolume(vol);
  };

  const handleDrag = (setter) => (e) => {
    e.stopPropagation();
    const move = (moveEvent) => setter(timeAtClientX(moveEvent.clientX));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const formatTime = (timeInSeconds) => {
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const updateFinetune = (key, value) => setFinetune({ ...finetune, [key]: value });

  const currentPreset = PRESETS[mode];
  const isFineTune = mode === "finetune";
  const isOriginal = mode === "original";
  const pct = (t) => (duration > 0 ? (t / duration) * 100 : 0);

  return (
    <div className="p-4 space-y-4">
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={handleReset}
          style={{
            padding: "6px 14px",
            backgroundColor: "#dc2626",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: "600",
            fontSize: "0.85rem",
          }}
        >
          ✕ Neues Video
        </button>
      </div>
      {uploadProgress !== null && (
        <div style={{ marginBottom: "8px" }}>
          <div style={{ fontSize: "0.85rem", color: "#6b7280", marginBottom: "4px" }}>
            Upload: {uploadProgress}%
          </div>
          <div style={{ height: "6px", backgroundColor: "#e5e7eb", borderRadius: "3px", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${uploadProgress}%`,
                backgroundColor: "#2563eb",
                borderRadius: "3px",
                transition: "width 0.2s ease",
              }}
            />
          </div>
        </div>
      )}

      {/* Video + Volume Overlay */}
      <div className="video-wrapper">
        <video
          ref={videoRef}
          src={videoURL}
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onClick={handleVideoClick}
          className="video-player"
          controls={false}
        />
      </div>

      <div
        className="timeline-bar"
        ref={timelineRef}
        onClick={handleLocalTimelineClick}
      >
        <div className="timeline-background" />
        <div
          className="timeline-indicator"
          style={{ left: `${pct(currentTime)}%` }}
        />
        <div
          className="timeline-range"
          style={{
            left: `${pct(startTime)}%`,
            width: `${pct(endTime - startTime)}%`,
          }}
        />
        <div
          className="timeline-handle-start"
          style={{ left: `${pct(startTime)}%` }}
          onMouseDown={handleDrag(setStartTime)}
          onClick={(e) => e.stopPropagation()}
        />
        <div
          className="timeline-handle-end"
          style={{ left: `${pct(endTime)}%` }}
          onMouseDown={handleDrag(setEndTime)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className="timeline-time-display">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Audio: Vorschau betrifft nur den Player, Export nur die Ausgabedatei */}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: "8px 12px", alignItems: "center" }}>
        <strong>Vorschau</strong>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={playerVolume}
          disabled={mute}
          aria-label="Vorschau-Lautstärke"
          onChange={(e) => setPlayerVolume(parseFloat(e.target.value))}
        />
        <span>{Math.round(playerVolume * 100)}%</span>
        <label>
          <input type="checkbox" checked={mute} onChange={() => setMute(!mute)} />
          {" "}stumm
        </label>

        <strong>Export</strong>
        <input
          type="range"
          min="0"
          max="2"
          step="0.1"
          value={volume}
          disabled={removeAudio}
          aria-label="Export-Lautstärke"
          onChange={(e) => handleAudioMultiplier(parseFloat(e.target.value))}
        />
        <span>{volume.toFixed(1)}x</span>
        <label>
          <input type="checkbox" checked={removeAudio} onChange={(e) => setRemoveAudio(e.target.checked)} />
          {" "}ohne Ton
        </label>
      </div>

      {/* Mode Selection Buttons */}
      <div className="flex gap-2" style={{ borderBottom: "1px solid #d1d5db", paddingBottom: "12px" }}>
        {["original", "low", "medium", "high", "finetune"].map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => { setMode(key); setMessage(""); }}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: mode === key ? "#2563eb" : "#e5e7eb",
              color: mode === key ? "white" : "#111827",
              fontWeight: "500",
              cursor: "pointer",
            }}
          >
            {key === "finetune" ? "FINETUNE" : key === "original" ? "ORIGINAL" : PRESETS[key].label}
          </button>
        ))}
      </div>

      {/* Settings Section */}
      {isOriginal ? (
        <div>
          <p style={{ margin: 0, fontWeight: 600, marginBottom: "8px" }}>Nur schneiden</p>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#666" }}>
            Originalqualität, fertig in Sekunden. Der Start springt auf den nächsten Keyframe davor.
          </p>
        </div>
      ) : !isFineTune ? (
        <div>
          <p style={{ margin: 0, fontWeight: 600, marginBottom: "8px" }}>Preset Settings</p>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#666" }}>
            {currentPreset.resolution}, {currentPreset.fps} FPS, {currentPreset.bitrate} kbps
          </p>
        </div>
      ) : (
        <div style={{ maxWidth: "300px", margin: "0 auto" }}>
          <div style={{ marginBottom: "12px" }}>
            <label style={labelStyle}>FPS</label>
            <input
              type="number"
              min="1"
              value={finetune.fps}
              onChange={(e) => updateFinetune("fps", parseInt(e.target.value, 10) || 0)}
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={labelStyle}>Resolution</label>
            <select
              value={finetune.resolution}
              onChange={(e) => updateFinetune("resolution", e.target.value)}
              style={inputStyle}
            >
              {RESOLUTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {finetune.resolution === "custom" && (
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Breite</label>
                <input
                  type="number"
                  min="16"
                  value={finetune.customWidth}
                  onChange={(e) => updateFinetune("customWidth", e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Höhe</label>
                <input
                  type="number"
                  min="16"
                  value={finetune.customHeight}
                  onChange={(e) => updateFinetune("customHeight", e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>
          )}

          <div style={{ marginBottom: "12px" }}>
            <label style={labelStyle}>Bitrate (kbps)</label>
            <input
              type="number"
              min="1"
              value={finetune.bitrate}
              onChange={(e) => updateFinetune("bitrate", parseInt(e.target.value, 10) || 0)}
              style={inputStyle}
            />
          </div>
        </div>
      )}

      {/* Größenlimit (nur beim Neu-Kodieren möglich) */}
      {!isOriginal && <div className="flex items-center space-x-4">
        <input
          type="checkbox"
          checked={limitSize}
          onChange={(e) => setLimitSize(e.target.checked)}
        />
        <label>Max. Dateigröße</label>
        <input
          type="number"
          min="1"
          value={maxSizeMb}
          disabled={!limitSize}
          onChange={(e) => setMaxSizeMb(parseFloat(e.target.value) || 0)}
          style={{ ...inputStyle, width: "90px" }}
        />
        <span>MB</span>
      </div>}

      {originalFileSize && (
        <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "#22c55e" }}>
          Originalgröße: {formatFileSize(originalFileSize)}
        </p>
      )}
      {previewFileSize ? (
        <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "#a78bfa" }}>
          Ausgabegröße: {formatFileSize(previewFileSize)}
        </p>
      ) : estimatedSize ? (
        <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "#a78bfa" }}>
          Ausgabegröße: ≈ {formatFileSize(estimatedSize)} (geschätzt)
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={() => handlePreview()}
          disabled={previewing}
          style={{
            flex: 1,
            padding: "10px 16px",
            backgroundColor: previewing ? "#9ca3af" : "#7c3aed",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: previewing ? "not-allowed" : "pointer",
            fontWeight: "600",
          }}
        >
          {previewing ? "⏳ Preview..." : "Preview"}
        </button>
        <button
          className="download-button"
          type="button"
          onClick={handleDownload}
          disabled={previewing}
          style={{
            flex: 1,
            padding: "10px 16px",
            backgroundColor: previewing ? "#9ca3af" : "#2563eb",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: previewing ? "not-allowed" : "pointer",
            fontWeight: "600",
          }}
        >
          Download
        </button>
      </div>
      {message && <p style={{ color: message.includes("Fehler") ? "red" : "green", marginTop: "10px", fontSize: "0.9rem" }}>{message}</p>}
    </div>
  );
}
