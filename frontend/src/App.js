import React, { useState, useRef, useEffect } from "react";
import "./App.css";

function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoURL, setVideoURL] = useState(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [uploading, setUploading] = useState(false);
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
  const videoRef = useRef(null);
  const progressBarRef = useRef(null);

  const resolutionMapping = {
    "720p": { width: 1280, height: 720 },
    "1080p": { width: 1920, height: 1080 },
    "480p": { width: 854, height: 480 },
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
      }

      if (e.code === "Period") {
        e.preventDefault();
        skipTime(1 / 30);
      } else if (e.code === "Comma") {
        e.preventDefault();
        skipTime(-1 / 30);
      }

      if (e.code === "ArrowRight") {
        e.preventDefault();
        skipTime(5);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        skipTime(-5);
      }

      if (e.code === "KeyS") {
        setStartTime(currentTime);
      } else if (e.code === "KeyE") {
        setEndTime(currentTime);
      }

      if (e.code === "ArrowUp") {
        e.preventDefault();
        changeVolume(0.05);
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        changeVolume(-0.05);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentTime, volume]);

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  };

  const skipTime = (time) => {
    const video = videoRef.current;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + time));
  };

  const changeVolume = (amount) => {
    const newVolume = Math.min(1, Math.max(0, playerVolume + amount));
    setPlayerVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoURL(url);
    }
  };

  const handleDragOver = (e) => e.preventDefault();

  const handleLoadedMetadata = () => {
    const vid = videoRef.current;
    setDuration(vid.duration);
    setEndTime(vid.duration);
  };

  const handleTimeUpdate = () => {
    const vid = videoRef.current;
    setCurrentTime(vid.currentTime);
  };

  const handleTimelineClick = (e) => {
    const rect = progressBarRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = clickX / rect.width;
    const newTime = duration * percent;

    if (e.shiftKey) {
      setStartTime(Math.min(newTime, endTime));
    } else if (e.altKey) {
      setEndTime(Math.max(newTime, startTime));
    } else {
      videoRef.current.currentTime = newTime;
    }
  };

  const handleUpload = async () => {
    if (!videoFile) return;
    setUploading(true);

    const formData = new FormData();
    formData.append("video", videoFile);
    formData.append("startTime", Math.floor(startTime * 1000));
    formData.append("endTime", Math.floor(endTime * 1000));
    formData.append("volume", volume);
    if (limitSize) {
      formData.append("maxSizeMb", maxSizeMb);
    }

    if (changeResolution) {
      let resolutionWidth = customWidth;
      let resolutionHeight = customHeight;

      if (resolution !== "custom") {
        resolutionWidth = resolutionMapping[resolution].width;
        resolutionHeight = resolutionMapping[resolution].height;
      }

      formData.append("resolution", `${resolutionWidth}x${resolutionHeight}`);
    }

    try {
      const response = await fetch("http://localhost:9000/upload", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();
      if (result.status === "success") {
        const downloadUrl = "http://localhost:9000" + result.processedVideo;
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        alert(result.message);
      }
    } catch (error) {
      console.error("Fehler beim Hochladen:", error);
    }

    setUploading(false);
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setPlayerVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  };

  const handleSoundMultiplierChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = playerVolume * newVolume;
    }
  };

  useEffect(() => {
    if (endTime <= startTime) {
      setEndTime(startTime + 1);
    }
  }, [startTime, endTime]);

  return (
    <div className="App">
      <h1>🎬 Video Upload & Trim</h1>

      <div
        className="dropzone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {videoURL ? (
          <div className="player">
            <video
              ref={videoRef}
              src={videoURL}
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onClick={togglePlayPause}
              style={{ width: "100%", maxHeight: "360px", cursor: "pointer" }}
              volume={playerVolume}
            />
            <div
              className="timeline"
              ref={progressBarRef}
              onClick={handleTimelineClick}
            >
              <div
                className="progress"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
              <div
                className="range start"
                style={{ left: `${(startTime / duration) * 100}%` }}
              />
              <div
                className="range end"
                style={{ left: `${(endTime / duration) * 100}%` }}
              />
            </div>

            <div className="time-info">
              <span>Start: {startTime.toFixed(1)}s</span>
              <span>Ende: {endTime.toFixed(1)}s</span>
              <span>Aktuell: {currentTime.toFixed(1)}s</span>
            </div>

            <div className="player-controls">
              <div className="sound-multiplier">
                <label>Sound Multiplier:</label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={volume}
                  onChange={handleSoundMultiplierChange}
                />
                <span>{volume.toFixed(1)}x</span>
              </div>

              <div className="player-volume">
                <label>Volume:</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={playerVolume}
                  onChange={handleVolumeChange}
                />
                <span>{(playerVolume * 100).toFixed(0)}%</span>
              </div>
            </div>

            <div className="limit-size-option" style={{ marginTop: "1rem" }}>
              <label>
                <input
                  type="checkbox"
                  checked={limitSize}
                  onChange={(e) => setLimitSize(e.target.checked)}
                />
                Max. Dateigröße (MB)
              </label>
              {limitSize && (
                <input
                  type="number"
                  min="1"
                  value={maxSizeMb}
                  onChange={(e) => setMaxSizeMb(e.target.value)}
                />
              )}
            </div>

            <div className="resolution-option" style={{ marginTop: "1rem" }}>
              <label>
                <input
                  type="checkbox"
                  checked={changeResolution}
                  onChange={(e) => setChangeResolution(e.target.checked)}
                />
                Auflösung ändern
              </label>

              {changeResolution && (
                <div className="resolution-dropdown">
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                    <option value="480p">480p</option>
                    <option value="custom">Benutzerdefiniert</option>
                  </select>

                  {resolution === "custom" && (
                    <div>
                      <label>Breite:</label>
                      <input
                        type="number"
                        value={customWidth}
                        onChange={(e) => setCustomWidth(e.target.value)}
                      />
                      <label>Höhe:</label>
                      <input
                        type="number"
                        value={customHeight}
                        onChange={(e) => setCustomHeight(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              className="upload-button"
              onClick={handleUpload}
              disabled={uploading}
            >
              {uploading ? "Hochladen..." : "Hochladen"}
            </button>
          </div>
        ) : (
          <p>Ziehe eine Videodatei hierher oder klicke, um eine Datei auszuwählen</p>
        )}
      </div>
    </div>
  );
}

export default App;
