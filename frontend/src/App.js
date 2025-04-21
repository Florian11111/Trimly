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
  const videoRef = useRef(null);
  const progressBarRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
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
    </div>
  );
}

export default App;
