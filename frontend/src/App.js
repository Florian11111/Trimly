import React, { useState, useRef, useEffect } from "react";
import "./App.css";
import VideoPlayer from "./VideoPlayer";


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

  // --- Funktionsdefinitionen für useEffect müssen vor useEffect stehen ---
  const togglePlayPause = () => {
    const video = videoRef.current;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  };

  const skipTime = React.useCallback((time) => {
    const video = videoRef.current;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + time));
  }, [duration]);

  const changeVolume = React.useCallback((amount) => {
    const newVolume = Math.min(1, Math.max(0, playerVolume + amount));
    setPlayerVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  }, [playerVolume]);

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
  }, [currentTime, volume, changeVolume, skipTime]);

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

      console.log(`test :):`);
      const response = await fetch("http://localhost:9000/upload", {
        method: "POST",
        body: formData,
      });
      console.log(`Response status: ${response.status}`);
      console.log(`Response headers:`, response.headers);
      const result = await response.json();
      
      console.log(`Upload result:`, result);
      if (result.status === "success") {
        // Poll /check/:filename until available
        const filename = result.filename;
        const checkUrl = `http://localhost:9000/check/${encodeURIComponent(filename)}`;
        let available = false;
        let attempts = 0;
        while (!available && attempts < 200) { // max 200s
          console.log(`Checking availability for ${filename}... attempt ${attempts + 1}`);
          const checkResp = await fetch(checkUrl);
          const checkData = await checkResp.json();
          console.log(`Check response:`, checkData);
          if (checkData.exists === true) {
            available = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 1000));
          attempts++;
        }
        if (available) {
          const downloadUrl = `http://localhost:9000/download/${encodeURIComponent(filename)}`;
          const a = document.createElement("a");
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          alert("Download nicht verfügbar. Bitte später erneut versuchen.");
        }
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
            handleUpload={handleUpload}
            uploading={uploading}
          />
        ) : (
          <p>Ziehe eine Videodatei hierher oder klicke, um eine Datei auszuwählen</p>
        )}
      </div>
    </div>
  );
}

export default App;
