import React, { useRef, useState, useEffect } from "react";
import "./VideoPlayer.css";

export default function VideoPlayer({ 
  videoURL, 
  videoRef, 
  progressBarRef, 
  currentTime, 
  duration, 
  startTime, 
  endTime, 
  volume, 
  playerVolume, 
  handleTimelineClick, 
  togglePlayPause, 
  handleVolumeChange, 
  handleSoundMultiplierChange, 
  limitSize, 
  setLimitSize, 
  maxSizeMb, 
  setMaxSizeMb, 
  changeResolution, 
  setChangeResolution, 
  resolution, 
  setResolution, 
  resolutionMapping, 
  customWidth, 
  setCustomWidth, 
  customHeight, 
  setCustomHeight, 
  handleLoadedMetadata,
  handleTimeUpdate,
  setStartTime,
  setEndTime,
  setDuration,
  setCurrentTime,
  setVolume,
  setPlayerVolume,
  mode,
  setMode,
  message,
  setMessage,
  handleDownload,
  handlePreview,
  handleReset,
  previewing,
  originalFileSize,
  previewFileSize,
  canDownload,
  formatFileSize,
}) {
  const timelineRef = useRef(null);

  const [mute, setMute] = useState(false);
  const [prevVolume, setPrevVolume] = useState(1);

  const [advancedSettings, setAdvancedSettings] = useState({
    fps: 30,
    resolution: "1280x720",
    bitrate: 1000,
  });

  const resolutionOptions = [
    { label: "480p", value: "854x480" },
    { label: "720p", value: "1280x720" },
    { label: "1080p", value: "1920x1080" },
    { label: "1440p", value: "2560x1440" },
    { label: "2160p (4K)", value: "3840x2160" },
    { label: "Custom", value: "custom" },
  ];

  const presets = {
    low: {
      label: "LOW",
      fps: 24,
      resolution: "854x480",
      bitrate: 600,
    },
    medium: {
      label: "MEDIUM",
      fps: 30,
      resolution: "1280x720",
      bitrate: 1200,
    },
    high: {
      label: "HIGH",
      fps: 60,
      resolution: "1920x1080",
      bitrate: 2500,
    },
  };

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

  const handleLocalTimelineClick = (e) => {
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = clickX / rect.width;
    const time = duration * percent;

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

  const toggleMute = () => {
    if (mute) {
      setMute(false);
      setPlayerVolume(prevVolume);
    } else {
      setMute(true);
      setPrevVolume(playerVolume);
    }
  };

  const handleDrag = (setter) => (e) => {
    const rect = timelineRef.current.getBoundingClientRect();
    const move = (moveEvent) => {
      const x = moveEvent.clientX - rect.left;
      const percent = x / rect.width;
      const time = Math.max(0, Math.min(duration, percent * duration));
      setter(time);
    };
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

  const currentPreset = presets[mode];
  const isFineTune = mode === "finetune";

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

        <div className="volume-overlay">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={playerVolume}
            onChange={(e) => setPlayerVolume(parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div
        className="timeline-bar"
        ref={(el) => {
          progressBarRef.current = el;
          timelineRef.current = el;
        }}
        onClick={handleLocalTimelineClick}
      >
        <div className="timeline-background" />
        <div
          className="timeline-indicator"
          style={{
            left: `${(currentTime / duration) * 100}%`,
          }}
        />
        <div
          className="timeline-range"
          style={{
            left: `${(startTime / duration) * 100}%`,
            width: `${((endTime - startTime) / duration) * 100}%`,
          }}
        />
        <div
          className="timeline-handle-start"
          style={{ left: `${(startTime / duration) * 100}%` }}
          onMouseDown={handleDrag(setStartTime)}
        />
        <div
          className="timeline-handle-end"
          style={{ left: `${(endTime / duration) * 100}%` }}
          onMouseDown={handleDrag(setEndTime)}
        />
      </div>
      <div className="timeline-time-display">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Audio Multiplier */}
      <div className="flex items-center space-x-4">
        <label>Audio Multiplier:</label>
        <input
          type="range"
          min="0"
          max="2"
          step="0.1"
          value={volume}
          onChange={(e) => handleAudioMultiplier(parseFloat(e.target.value))}
        />
        <span>{volume.toFixed(1)}x</span>
        <input type="checkbox" checked={mute} onChange={toggleMute} />
        <label>Mute</label>
      </div>

      {/* Mode Selection Buttons */}
      <div className="flex gap-2" style={{ borderBottom: "1px solid #d1d5db", paddingBottom: "12px" }}>
        {["low", "medium", "high", "finetune"].map((key) => (
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
            {key === "finetune" ? "FINETUNE" : key.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Settings Section */}
      {!isFineTune ? (
        <div className="space-y-3">
          <div>
            <p style={{ margin: 0, fontWeight: 600, marginBottom: "8px" }}>Preset Settings</p>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#666" }}>
              {currentPreset.resolution}, {currentPreset.fps} FPS, {currentPreset.bitrate} kbps
            </p>
            {originalFileSize && (
              <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "#22c55e" }}>
                Originalgröße: {formatFileSize(originalFileSize)}
              </p>
            )}
            {previewFileSize && (
              <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "#a78bfa" }}>
                Ausgabegröße: {formatFileSize(previewFileSize)}
              </p>
            )}
          </div>
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
      ) : (
        <div style={{ maxWidth: "300px", margin: "0 auto" }}>
          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "0.9rem" }}>FPS</label>
            <input
              type="number"
              value={advancedSettings.fps}
              onChange={(e) =>
                setAdvancedSettings({
                  ...advancedSettings,
                  fps: parseInt(e.target.value, 10) || 0,
                })
              }
              style={{
                width: "100%",
                padding: "6px 8px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                boxSizing: "border-box",
                fontSize: "0.9rem",
              }}
            />
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "0.9rem" }}>Resolution</label>
            <select
              value={advancedSettings.resolution}
              onChange={(e) =>
                setAdvancedSettings({
                  ...advancedSettings,
                  resolution: e.target.value,
                })
              }
              style={{
                width: "100%",
                padding: "6px 8px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                boxSizing: "border-box",
                fontSize: "0.9rem",
              }}
            >
              {resolutionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "0.9rem" }}>Bitrate (kbps)</label>
            <input
              type="number"
              value={advancedSettings.bitrate}
              onChange={(e) =>
                setAdvancedSettings({
                  ...advancedSettings,
                  bitrate: parseInt(e.target.value, 10) || 0,
                })
              }
              style={{
                width: "100%",
                padding: "6px 8px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                boxSizing: "border-box",
                fontSize: "0.9rem",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={() => handlePreview()}
              disabled={previewing}
              style={{
                flex: 1,
                padding: "10px 12px",
                backgroundColor: previewing ? "#9ca3af" : "#7c3aed",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: previewing ? "not-allowed" : "pointer",
                fontWeight: "600",
                fontSize: "0.9rem",
              }}
            >
              {previewing ? "⏳ Preview..." : "Preview"}
            </button>
            <button
              className="download-button"
              type="button"
              onClick={handleDownload}
              disabled={!canDownload}
              style={{
                flex: 1,
                padding: "10px 12px",
                backgroundColor: !canDownload ? "#9ca3af" : "#2563eb",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: !canDownload ? "not-allowed" : "pointer",
                fontWeight: "600",
                fontSize: "0.9rem",
              }}
            >
              Download
            </button>
          </div>
          {message && <p style={{ color: message.includes("Fehler") ? "red" : "green", marginTop: "10px", fontSize: "0.9rem" }}>{message}</p>}
        </div>
      )}
    </div>
  );
}

