<h1 align="center">Trimly</h1>

<p align="center"><b>Cut it. Shrink it. Send it.</b></p>

<p align="center">
  <a href="https://github.com/Florian11111/Trimly/releases/latest">Download</a> ·
  <a href="#install">Install</a> ·
  <a href="#for-developers">Developers</a>
</p>

![Trimming a clip and watching the file size change with the quality](docs/images/demo.gif)
<sub>Video: [A pond in the middle of a forest](https://www.pexels.com/video/a-pond-in-the-middle-of-a-forest-with-tall-grass-20732245/) on Pexels</sub>

<table>
<tr>
<td width="62%" valign="top">

#### Too big to send?
**Target size** → type 20 MB. Trimly picks bitrate, resolution and frame rate.

#### Too long?
Drag the handles, choose **Original**. No re-encoding, done in a second.

#### Too blurry after compressing?
**Compress** shows the size live while you switch between 480p, 720p and 1080p.

#### Too slow?
Your GPU does the work: NVIDIA, AMD, Intel, Apple or VA-API.

</td>
<td width="38%" valign="top">
<img src="docs/images/target-size.jpg" alt="Target size set to 25 MB, Trimly estimates about 23.5 MB instead of 38.8 MB">
</td>
</tr>
</table>

Also: H.264 / HEVC / AV1 · sound only as MP3 · editor with clips, speed, crop, text and zoom · undo · never makes a file bigger.

## Install

| Windows 10/11 | macOS 11+ (Apple Silicon) | Linux |
|---|---|---|
| `…_x64-setup.exe` | `…_aarch64.dmg` | `.deb` · `.rpm` · `.AppImage` |
| ffmpeg included | `brew install ffmpeg` | ffmpeg from package manager |

Not code-signed yet: Windows → *More info → Run anyway*, macOS → right-click → *Open*.
Right-click any video → *Open with → Trimly*.

**Keys:** <kbd>Space</kbd> play · <kbd>I</kbd>/<kbd>O</kbd> start/end · <kbd>←</kbd>/<kbd>→</kbd> 5 s · <kbd>,</kbd>/<kbd>.</kbd> frame · <kbd>M</kbd> mute · <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> undo

## For developers

<details>
<summary>Web version</summary>

```bash
git clone https://github.com/Florian11111/Trimly.git && cd Trimly
docker compose up --build        # http://localhost:3000
```

Production: `docker-compose.prod.yml` with nginx on port 80. NVIDIA: `-f docker-compose.gpu.yml`.
</details>

<details>
<summary>Build the desktop app</summary>

```bash
cd frontend && npm ci && npm run desktop:build
```

Windows: build ffmpeg first with `frontend/src-tauri/scripts/build-ffmpeg.sh` (MSYS2 UCRT64). macOS: `brew install ffmpeg node rust`. Linux: WebKitGTK and GStreamer dev packages.
</details>

<details>
<summary>Tests and stack</summary>

`npm test` · `cargo test` · `sbt test`
React 19 · Tauri 2 / Rust · Scala / Play · ffmpeg
</details>

[GPL-3.0-or-later](LICENSE) · the Windows build ships ffmpeg with libx264 (GPL)
