import React, { useRef, useState, useEffect } from "react";
import "./VideoPlayer.css";

export default function VideoPlayer({ videoURL, videoRef, progressBarRef }) {
  const timelineRef = useRef(null);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);

  const [volume, setVolume] = useState(1);       // Export volume multiplier
  const [uiVolume, setUiVolume] = useState(1);   // Actual UI volume
  const [mute, setMute] = useState(false);
  const [prevVolume, setPrevVolume] = useState(1);

  const [activeTab, setActiveTab] = useState("compromise");

  const [compressionSettings, setCompressionSettings] = useState({
    maxSizeMb: 100,
  });

  const [advancedSettings, setAdvancedSettings] = useState({
    fps: 30,
    resolution: "720p",
    bitrate: 1000,
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateTime = () => setCurrentTime(video.currentTime);
    video.addEventListener("timeupdate", updateTime);
    return () => video.removeEventListener("timeupdate", updateTime);
  }, [videoRef]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = mute ? 0 : uiVolume;
    }
  }, [uiVolume, mute, videoRef]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    setEndTime(video.duration);
  };

  const handleTimelineClick = (e) => {
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
      setUiVolume(prevVolume);
    } else {
      setMute(true);
      setPrevVolume(uiVolume);
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


  return (
    <div className="p-4 space-y-4">
      {/* Video + Volume Overlay */}
      <div className="video-wrapper">
        <video
          ref={videoRef}
          src={videoURL}
          onLoadedMetadata={handleLoadedMetadata}
          className="video-player"
          controls={false}
        />

        <div className="volume-overlay">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={uiVolume}
            onChange={(e) => setUiVolume(parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div
        className="timeline-bar"
        ref={(el) => {
          progressBarRef.current = el;
          timelineRef.current = el;
        }}
        onClick={handleTimelineClick}
      >
        {/* Hintergrund für Klick & Zeitindikator */}
        <div className="timeline-background" />

        {/* Weißer Strich als Zeitindikator */}
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

      {/* Tabs */}
      <div className="flex space-x-4 border-b">
        <button
          className={`py-2 px-4 ${
            activeTab === "compromise" ? "border-b-2 border-blue-600" : ""
          }`}
          onClick={() => setActiveTab("compromise")}
        >
          Compromise
        </button>
        <button
          className={`py-2 px-4 ${
            activeTab === "advanced" ? "border-b-2 border-blue-600" : ""
          }`}
          onClick={() => setActiveTab("advanced")}
        >
          FineTune
        </button>
      </div>

      {/* Compromise Tab */}
      {activeTab === "compromise" && (
        <div className="space-y-2">
          <label>Max. File Size (MB)</label>
          <input
            type="number"
            value={compressionSettings.maxSizeMb}
            onChange={(e) =>
              setCompressionSettings({
                ...compressionSettings,
                maxSizeMb: parseFloat(e.target.value),
              })
            }
            className="border p-1 rounded"
          />

          <button className="bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded">
            Upload (Compromise)
          </button>
        </div>
      )}

      {/* FineTune Tab */}
      {activeTab === "advanced" && (
        <div className="space-y-2">
          <label>FPS</label>
          <input
            type="number"
            value={advancedSettings.fps}
            onChange={(e) =>
              setAdvancedSettings({
                ...advancedSettings,
                fps: parseInt(e.target.value),
              })
            }
            className="border p-1 rounded"
          />

          <label>Resolution</label>
          <input
            type="text"
            value={advancedSettings.resolution}
            onChange={(e) =>
              setAdvancedSettings({
                ...advancedSettings,
                resolution: e.target.value,
              })
            }
            className="border p-1 rounded"
          />

          <label>Bitrate (kbps)</label>
          <input
            type="number"
            value={advancedSettings.bitrate}
            onChange={(e) =>
              setAdvancedSettings({
                ...advancedSettings,
                bitrate: parseInt(e.target.value),
              })
            }
            className="border p-1 rounded"
          />

          <button className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded">
            Upload (FineTune)
          </button>
        </div>
      )}
    </div>
  );
}
