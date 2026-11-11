<!--
  ENTWURF für die neue README (Layout, Texte grob). Bilder in eckigen Klammern sind Platzhalter:
  [BILD: …] beschreibt, was dort hin soll. Erst ersetzen, dann nach /README.md verschieben.
-->

<p align="center">
  <img src="docs/images/logo.png" alt="" width="72">
</p>

<h1 align="center">Trimly</h1>

<p align="center">
  Lightweight and fast tool to easily cut and compress videos.
</p>

<p align="center">
  <a href="https://github.com/Florian11111/Trimly/releases/latest">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#self-hosting-the-web-version">Web version</a> ·
  <a href="#building-from-source">Build from source</a>
</p>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.jpg">
  <img src="docs/images/hero-dark.jpg" alt="Trimly with a 6.5 s clip selected and a 10 MB target size">
</picture>
<sub>Video: [A pond in the middle of a forest](https://www.pexels.com/video/a-pond-in-the-middle-of-a-forest-with-tall-grass-20732245/) on Pexels</sub>

**Open video → choose the interesting part → select quality → export.**
No account, no subscription, no upload. Just speed.

- **Target size** for upload limits (10, 25, 100 MB …)
- **Original**: cut without re-encoding, done in a second
- **Compress**: Small, Medium, High or custom
- **Hardware encoding**: NVIDIA, AMD, Intel, Apple · H.264, HEVC, AV1
- **Right-click → Open with → Trimly**

## Download

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `Trimly_x.y.z_x64-setup.exe` | ffmpeg is included |
| macOS 11+ (Apple Silicon) | `Trimly_x.y.z_aarch64.dmg` | needs ffmpeg: `brew install ffmpeg` |

All files are on the [releases page](https://github.com/Florian11111/Trimly/releases).
The builds aren't code-signed yet. Windows shows a SmartScreen warning (*More info → Run anyway*),
on macOS right-click the app and choose *Open* the first time.

## Features

<!-- [GIF: 20–30 s Demo, ohne Ton, ~960 px, 12 fps:
     Explorer Rechtsklick → Open with → Trimly (Zoom) · Griff ziehen (Zoom auf Timeline) ·
     Original → Compress → Target size 25 MB, Schätzung springt mit (Zoom aufs Panel) ·
     Export → "is ready" → Show in folder] -->
![Opening a clip, trimming it and exporting it at 25 MB](docs/images/demo.gif)

### Trimming

Click anywhere on the film strip to jump there. Hold a handle to drag it, or press <kbd>I</kbd> and
<kbd>O</kbd> to set start and end at the playhead. <kbd>Space</kbd> plays only the selection.

### Quality

| Mode | What it does | Good for |
|---|---|---|
| **Original** | Cuts without re-encoding. Same quality, done in a second. Cuts land on keyframes. | Long recordings, quick trims |
| **Compress** | Small (480p), Medium (720p), High (1080p) or custom values | Sharing, archiving |
| **Target size** | Picks bitrate, resolution and frame rate so the file stays under the size you set | Discord, email, forums, chat apps |

Trimly never scales up and never uses more bitrate than the original, so a file can't get bigger by
compressing it. The size estimate in the sidebar updates as you change things.

#### Good for file transfers with a limit, e.g. Discord

![A 479 MB game recording cut to 40 s and fitted into 20 MB](docs/images/game.jpg)

### Output

Video with sound, video without sound, or only the sound as MP3. Volume from 0 to 200 %.

### Formats and encoders

H.264 plays everywhere. HEVC and AV1 give the same quality at roughly 30 to 40 % less size, but need
a newer player. Choose the format and the encoder (automatic, a specific GPU, or CPU) in the
settings. On startup Trimly runs a short test encode on every hardware encoder and only offers the
ones that work on your machine.

<!-- Messwerte: aktuell nur Mac. Windows-Zeile (RX 9070 XT, AMF) ergänzen. -->
| 19 s clip, 1440p60 | → 720p30 | → 1440p60 |
|---|---|---|
| MacBook (M5), VideoToolbox | 1.8 s | 7.5 s |
| Windows, AMD AMF | … | … |
| Web version in Docker, libx264 | 5.0 s | 19.8 s |
| *Original* (cut only) | instant | instant |

### Editor

The *Editor* tab combines several clips, lets you detach and move the audio, and adds arrows, text,
images and zooms.

<img src="docs/images/editor.jpg" alt="The editor with a text overlay and a zoom" width="80%">

### Settings

Dark, light or system theme, four accent colors, video format, encoder and a default export folder.
With a default folder, *Export* saves there right away; the folder button next to it still asks.

### Keyboard

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play / pause the selection |
| <kbd>←</kbd> / <kbd>→</kbd> | 5 s back / forward |
| <kbd>,</kbd> / <kbd>.</kbd> | One frame back / forward |
| <kbd>I</kbd> / <kbd>O</kbd> | Set start / end |
| <kbd>←</kbd> / <kbd>→</kbd> on a handle | Move it 0.1 s, with <kbd>Shift</kbd> 1 s |

## Self-hosting the web version

The same interface also runs in the browser, with a server doing the encoding. Useful on a home
server or for people who can't install apps.

You need [Docker](https://docs.docker.com/get-docker/) with Compose.

```bash
git clone https://github.com/Florian11111/Trimly.git
cd Trimly
docker compose up --build
```

Open <http://localhost:3000>. The backend runs on port 9000.

**Production**, with nginx on port 80 in front of both:

```bash
APPLICATION_SECRET=$(openssl rand -base64 32) \
  docker compose -f docker-compose.prod.yml up --build -d
```

| Setting | Where | Default |
|---|---|---|
| Upload limit | `nginx.conf`, `backend/conf/application.conf` | 20 GB |
| NVIDIA GPU encoding | add `-f docker-compose.gpu.yml` | off |
| Windows one-click start | `start-trimly.bat` | |

<!-- Hinweis prüfen, sobald das Backend umgezogen ist: Web-Version kann aktuell nur H.264,
     keine Zielgröße, kein HEVC/AV1. -->
The web version currently encodes H.264 only. Uploaded files are temporary: the server deletes them
after a while and forgets them when it restarts.

## Building from source

<details>
<summary><b>Windows</b></summary>

```bash
winget install OpenJS.NodeJS.LTS Rustlang.Rustup MSYS2.MSYS2
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Build the bundled ffmpeg once, in the *MSYS2 UCRT64* shell:

```bash
cd frontend/src-tauri && bash scripts/build-ffmpeg.sh
```

Then:

```bash
cd frontend && npm ci && npm run desktop:build
```

The installer is in `frontend/src-tauri/target/release/bundle/nsis/`.
</details>

<details>
<summary><b>macOS</b></summary>

```bash
brew install ffmpeg node rust
cd frontend && npm ci && npm run desktop:build
```

The `.app` and `.dmg` are in `frontend/src-tauri/target/release/bundle/`.
</details>

`npm run desktop` starts the app with hot reload.

### Tests

```bash
cd frontend && CI=true npm test -- --watchAll=false
cd frontend/src-tauri && cargo test
docker compose run --rm backend sbt -batch test
```

Tests that need ffmpeg and the sample video are skipped when either is missing.

## How it works

| Part | Tech | Folder |
|---|---|---|
| Interface | React 19 | `frontend/src/` |
| Desktop app | Tauri 2, Rust | `frontend/src-tauri/` |
| Web backend | Scala, Play Framework | `backend/` |
| Video | ffmpeg / ffprobe | |

The interface talks to Rust in the desktop app and to the backend over HTTP in the browser, through
the small layer in `frontend/src/platform/`.

## License

<!-- LICENSE-Datei fehlt noch. Mit mitgeliefertem libx264-ffmpeg ist GPL-3.0 die einfachste Wahl. -->
[GPL-3.0](LICENSE). The Windows build ships ffmpeg compiled with libx264 (GPL); its source is at
[ffmpeg.org](https://ffmpeg.org/releases/), the build script is in
`frontend/src-tauri/scripts/build-ffmpeg.sh`.
