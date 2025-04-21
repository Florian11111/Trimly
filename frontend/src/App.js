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
  const [volume, setVolume] = useState(1.0); // Sound multiplier state
  const [playerVolume, setPlayerVolume] = useState(1.0); // Volume for the video player
  const videoRef = useRef(null);
  const progressBarRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
      }

      // Skip 1 frame or 5 seconds
      if (e.code === "Period") { // .
        e.preventDefault();
        skipTime(1 / 30); // Skip 1 frame (assuming 30fps)
      } else if (e.code === "Comma") { // ,
        e.preventDefault();
        skipTime(-1 / 30); // Skip 1 frame backward
      }

      // Skip 5 seconds forward or backward
      if (e.code === "ArrowRight") {
        e.preventDefault();
        skipTime(5); // Skip 5 seconds forward
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        skipTime(-5); // Skip 5 seconds backward
      }

      // Set start and end time to current video time
      if (e.code === "KeyS") { // S for start
        setStartTime(currentTime);
      } else if (e.code === "KeyE") { // E for end
        setEndTime(currentTime);
      }

      // Adjust volume with ArrowUp/ArrowDown
      if (e.code === "ArrowUp") {
        e.preventDefault();
        changeVolume(0.05); // Increase volume
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        changeVolume(-0.05); // Decrease volume
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
    formData.append("startTime", Math.floor(startTime * 1000)); // in ms
    formData.append("endTime", Math.floor(endTime * 1000));     // in ms
    formData.append("volume", volume); // Send volume multiplier to backend

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
    setPlayerVolume(newVolume); // Setzt den Player-Volume-Wert
    if (videoRef.current) {
      videoRef.current.volume = newVolume; // Setzt die Lautstärke direkt im Video-Tag
    }
  };

  const handleSoundMultiplierChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume); // Setzt den Volume-Wert
    if (videoRef.current) {
      videoRef.current.volume = playerVolume * newVolume; // Setzt die Lautstärke basierend auf dem Player-Volume und dem Sound-Multiplier
    }
  };

  // Ensure that endTime is always greater than startTime
  useEffect(() => {
    if (endTime <= startTime) {
      setEndTime(startTime + 1); // Set endTime to be just slightly greater than startTime
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
              volume={playerVolume} // Apply the player volume
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
            <p style={{ fontSize: "0.9rem", color: "#888" }}>
              Klick auf Timeline = springen <br />
              ⇧ Shift+Klick = Start setzen, ⎇ Alt+Klick = Ende setzen
            </p>

            {/* Sound Multiplier and Volume Control inside the Player */}
            <div className="player-controls">
              {/* Sound Multiplier */}
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

              {/* Video Player Volume Control */}
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
          </div>
        ) : (
          <p>Zieh ein Video hierher oder klick zum Auswählen.</p>
        )}
      </div>

      {videoFile && (
        <button onClick={handleUpload} disabled={uploading}>
          {uploading ? "Hochladen..." : "Hochladen & Zuschneiden"}
        </button>
      )}

      {/* Hotkeys Legend */}
      <div className="hotkeys-legend">
        <h3>Hotkeys:</h3>
        <ul>
          <li>Space: Play/Pause</li>
          <li>., ArrowRight: Skip 1 frame</li>
          <li>,, ArrowLeft: Skip 5 seconds</li>
          <li>Shift + Click: Set Start time</li>
          <li>Alt + Click: Set End time</li>
          <li>S: Set Start time to current video time</li>
          <li>E: Set End time to current video time</li>
          <li>ArrowUp: Increase Volume</li>
          <li>ArrowDown: Decrease Volume</li>
        </ul>
      </div>
    </div>
  );
}

export default App;
