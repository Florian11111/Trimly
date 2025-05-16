import subprocess
import json
import os

def get_video_info(filepath):
    # ffprobe Befehl, der JSON-Infos liefert
    cmd = [
        "ffprobe",
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filepath
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    info = json.loads(result.stdout)

    # Format-Info (enthält duration, bit_rate, size)
    format_info = info.get("format", {})
    duration = float(format_info.get("duration", 0))
    bit_rate = int(format_info.get("bit_rate", 0)) if format_info.get("bit_rate") else None
    file_size = int(format_info.get("size", 0))  # in bytes

    # Streams durchsuchen, Video-Stream finden
    video_stream = None
    for stream in info.get("streams", []):
        print(stream)
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    if not video_stream:
        raise ValueError("Keine Videospur gefunden")

    # FPS berechnen (frame rate) – oft als String "30000/1001"
    r_frame_rate = video_stream.get("r_frame_rate", "0/1")
    num, den = r_frame_rate.split("/")
    fps = float(num) / float(den) if float(den) != 0 else 0

    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))

    return {
        "duration_sec": duration,
        "bitrate_bps": bit_rate,
        "fps": fps,
        "width": width,
        "height": height,
        "file_size_bytes": file_size,
    }


def main():
    video_path = "C:\\Users\\flori\\Videos\\Radeon ReLive\\Apex Legends\\test2.mp4"

    info = get_video_info(video_path)

    print(f"Dauer: {info['duration_sec']:.2f} s")
    print(f"Bitrate: {info['bitrate_bps']} bps")
    print(f"FPS: {info['fps']:.2f}")
    print(f"Auflösung: {info['width']}x{info['height']}")
    print(f"Dateigröße: {info['file_size_bytes'] / (1024*1024):.2f} MB")

if __name__ == "__main__":
    main()
