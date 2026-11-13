# Trimly

Cut and compress videos. One React UI, two modes of operation:

- **Desktop (Tauri 2, macOS + Windows + Linux):** Rust runs ffmpeg directly on the local file, with hardware encoding (VideoToolbox, NVENC, Quick Sync, AMF, VA-API on Linux).
- **Web:** upload to a Scala/Play backend that runs ffmpeg in a Docker container (optionally NVENC via `docker-compose.gpu.yml`, Windows start via `start-trimly.bat`).

Florian uses both: a Mac (M5) and a Windows PC with an AMD Radeon RX 9070 XT (AMF, no NVENC).

## Structure

| Part | Tech | Location |
|---|---|---|
| UI | React 19, Create React App (`react-scripts` 5), plain JS | `frontend/src/` |
| Desktop | Tauri 2, Rust, plugins `dialog` and `opener` | `frontend/src-tauri/` |
| Backend | Scala 2.13, Play Framework 3.0.7 (Pekko), sbt 1.10 | `backend/` |
| Video | `ffmpeg` / `ffprobe` as external processes | |
| Prod (web) | nginx in front of the frontend (static) and backend | `nginx.conf`, `docker-compose.prod.yml` |

### Frontend (`frontend/src/`)

- `App.js`: all state. Opening a video, playback (rAF playhead, stops at the end of the selection), keyboard shortcuts, export. Quality as `quality = {mode, presetId, custom, sizeMb}` with three side-by-side modes **Original / Compress / Target size**, each opening its own small panel below (Compress: Small/Medium/High/Custom, Target size: 10/25/50/100 MB + custom number). Deliberately no more than three main options (Florian's wish: keep it simple; several clips per video belong in the editor, not here). If a file arrives via "Open with" while a video is open, an "Open …?" dialog asks first.
- `lib/settings.js` + `components/Settings.js`: gear menu in the header, stored in `localStorage` (`trimly.settings`). Everywhere: theme (Dark/Light/System) and accent colour (violet/blue/pink/green) as `data-theme`/`data-accent` on `<html>`; `public/index.html` sets both before the first paint. Desktop only: format (H.264/HEVC/AV1), encoder (Automatic / detected GPUs / CPU) and default output folder. With a folder set, exports go straight there (free name via `unique_path`); the folder button next to "Export" still asks for a location.
- Everything is in **English**: UI texts, error messages (Rust and Scala), comments, numbers with a dot.
- `components/Timeline.js`: film strip. Thumbnails are drawn straight into a canvas from a hidden `<video>` by seeking (no pixel readback). **A short click on a handle only seeks there; it becomes draggable only after holding for `HOLD_MS`** (Florian's wish). Handles are `role="slider"` and work with the arrow keys. Minimum length 0.01 s.
- `lib/presets.js`: **single source of quality levels.** `resolveTarget` turns preset and source into `{copy, width, height, fps, bitrate, audioBitrate, capped}`: `height` = shorter side, never upscale, even edges, **video and audio bitrate never above the original** (otherwise e.g. a 100 kbit/s lecture gets bigger when encoded). `estimateBytes` returns the size estimate per output (`OUTPUTS`: both/video/audio). `resolveQuality` dispatches to the modes; `resolveSizeTarget` turns MB (MiB, 6 % buffer) and clip length into a bitrate, picks the resolution via a bitrate ladder and never inflates beyond the original (`tooSmall` warns). HEVC/AV1 get 70 %/60 % of the bitrate for the fixed levels (custom values stay); the web version always encodes H.264. Audio bitrates 128 kbit/s AAC, 192 kbit/s MP3 – must match the backend (`VideoCalculator.AudioBitrateKbps`, `FFmpegUtils.AudioOnlyBitrateKbps`) and `ffmpeg.rs`.
- `platform/`: `index.js` picks via `"__TAURI_INTERNALS__" in window` between `web.js` (HTTP to the backend) and `desktop.js` (Tauri `invoke`). `desktop.js` is only imported dynamically so Jest never loads the Tauri ESM packages. Both modules share one interface, described in `index.js`.
- Design tokens in `index.css`: night blue, glass surfaces (`--glass-blur`), accent gradient `--violet`→`--blue` for actions, light lavender `--trim` (#c9bfff, formerly orange) for the trim bracket. Theme and accent variants only override tokens (`--well`, `--shade`, `--popover`, `--accent-rgb` …); **no hard-coded colours in CSS**, or the light theme breaks. Menus/dialogs use `--popover` (almost opaque), because glass doesn't stack well in the header. Careful: `.app > :not(.backdrop)` sets `position: relative; z-index: 1` – own layers need `.app > .x` (see `.topbar`, `.modal-backdrop`). Background `.backdrop` with four blurred colour spots: they fade in one after another on start (`bloom`), then follow closed paths (`drift-*`, 23–37 s) and pulse in brightness (`breathe`, base value `--o`); still with "reduce motion". System font, numbers with `tabular-nums`.
- On the desktop, dimensions come from ffprobe (`video.ref.info`), not from the `<video>` element.
- "Other video" calls `resetAll()` (everything including settings is reset). The workspace has `key={video.src}` so player and film strip are recreated per video.
- After an export the export button steps back (`.btn-primary.is-done`) until a setting changes.
- `web.js` follows the backend protocol: `mode=original|custom`, `output=both|video|audio`; on `status: "missing"` upload the original again and resend; `/check` returns `status` ready/computing/error/unknown; download via a direct link with `?name=` (no RAM buffer).
- `src/editor/` (editor tab: clips, audio track, overlays, zoom, `POST /render`) dates from the October version. It hangs off `App.js` via the "Trim / Editor" switch in the header, on the web and on the desktop. On the desktop the "originalId" is the file path (no upload, no keepalive), clips come via `platform.pick/open`, export via `platform.renderEdit` → Rust `render_edit` (overlays as Base64 PNG). Both views are kept when switching (`hidden`). The editor is its own bundle (`React.lazy`), preloaded on hovering or focusing the tab; tests therefore need `findBy…`. Colours in `Editor.css` use the design tokens. `src/presets.js` belongs to the editor only.

### Desktop (`frontend/src-tauri/src/`)

- `ffmpeg.rs`: pure logic without processes. `find_tool` (first next to the own executable = bundled ffmpeg, then PATH + Homebrew folders, because Finder apps don't inherit the shell PATH; on Windows `.exe`, winget links, `C:\ffmpeg\bin`), encoders as family × codec (`encoder_for("amf", "av1")` → `av1_amf`; CPU only `libx264`), `listed_hw_encoders_all` + `encoder_test_args` (every hardware encoder is checked with a test encode at **640×480** – ffmpeg lists NVENC even without a card, and `hevc_amf` rejects 320×240), `pick_encoder` (preferred device + codec → otherwise other hardware with that codec → H.264 → libx264), `encoder_args` (**NVENC always with `-bf 0`**, otherwise a grey picture at 29.97 fps; HEVC with `-tag:v hvc1` for Apple players), `parse_probe`, `build_args` (`streams` both/video/audio), `progress_from_line`.
- `edit.rs`: editor export, counterpart of `EditRenderer.scala` (concat, zoompan, overlay, amix), pure logic with tests; `render_edit` in `lib.rs` checks the sources with ffprobe and, like `export_video`, falls back from hardware to libx264.
- `media_server.rs`: preview videos are served by an own HTTP server on `127.0.0.1` (random port, token in the URL, only files allowed via `media_url`). **Don't go back to the Tauri asset protocol:** it answers ranges with at most 1 MB, and for long videos the `moov` index is bigger, so WebKit only shows 0 × 0 without a picture.
- Bundled ffmpeg (Windows and macOS): `scripts/build-ffmpeg.sh` builds a slim, static ffmpeg/ffprobe (GPL because of libx264) into `binaries/` (not in Git): on Windows in MSYS2 UCRT64 (~18 MB), on the Mac with Homebrew tools (~11 MB each, app 27 MB, DMG ~14 MB). `tauri.windows.conf.json`/`tauri.macos.conf.json` put it next to the executable via `externalBin`. **Without these files `desktop` and `desktop:build` fail.** Mac specifics: ld always takes the `.dylib` if it sits next to the `.a`, so the script copies the `.a` of x264/lame/mpg123 into a separate folder and builds dav1d statically itself; according to `otool -L` the result may only need `/usr/lib` and `/System` (the release workflow checks this too). Homebrew libs are built for the current macOS version (linker warning "built for newer macOS"); untested on macOS 11–14. New formats/filters: extend the lists in the script (the filters used by code in `ffmpeg.rs`/`edit.rs`, plus `transpose`/`hflip`/`vflip`/`rotate` for auto-rotating portrait phone videos). If ffmpeg can't decode a codec, `probe` says so right when opening (`check_decodable` against `ffmpeg -codecs`); ffprobe errors on unknown extensions go through `unreadable_file_message`.
- `lib.rs`: all ffmpeg calls go through `tool_command` (stdin null, on Windows `CREATE_NO_WINDOW`, otherwise the GUI app flashes a console window on every call). `encoder_info` is async: synchronous commands run on the main thread and would freeze the window until the encoder test is done. Tauri commands `encoder_info`, `initial_file`, `frontend_log` (UI messages to stderr, useful for debugging without a window), `probe`, `media_url`, `export_video` (progress via `Channel<f64>`; `codec`/`encoder` from the settings; if a hardware encoder fails, automatic retry with libx264), `cancel_export`. Saving in the background: without a default folder, `desktop.js` starts the export right away into `temp_output` (temp folder, prefix `trimly-export-`) while the save dialog is open; afterwards `finalize_export` (rename, copy across drives) or on cancel `cancel_export` + `discard_temp`. Both only touch their own temp files. At most one export runs at a time. Cancelling returns the error `"cancelled"`, which the frontend swallows silently. `TRIMLY_ENCODER=cpu` forces libx264.
- "Open with": `bundle.fileAssociations` (role Viewer, rank `Alternate` → never the default app). Windows passes the file as a start argument, macOS as `RunEvent::Opened` → remembered in `PendingFile` and reported as the `open-file` event; the UI fetches it via `initial_file` (returns each file only once). Testing on the Mac: `open --stderr log.txt -a …/Trimly.app video.mp4`. Single instance: `tauri-plugin-single-instance` (must be the first plugin) passes the file of a second launch to the running window via `PendingFile` + `open-file` (tested on Windows). Careful when testing: two builds with the same `identifier` share this.
- Debugging without screen access: `cargo build && ./target/debug/trimly /path/video.mp4 2>&1 | grep '\[ui\]'` (the debug build loads the UI from `localhost:3000`).
- `tauri.conf.json`: macOS title bar as an overlay (`.is-desktop.is-mac .topbar` leaves 84 px for the traffic-light buttons; Windows has a normal title bar).
- **Linux (tested November 2026 in a UTM VM: Ubuntu 24.04 ARM64, libx264; VA-API on real hardware still untested):** builds as `.deb`, `.rpm` and AppImage (release workflow, ubuntu-22.04 x64 + ARM64). ffmpeg comes from the system (the `.deb` depends on `ffmpeg`). Under WebKitGTK the preview needs the GStreamer plugins good/bad/libav, otherwise the picture stays black; the AppImage ships them via `bundleMediaFramework`. Hardware: family `vaapi` (Intel/AMD) – needs `-vaapi_device` before the inputs (`hw_init_args`), the filter `format=nv12,hwupload` at the end (`final_format_filter`) and **no** `-pix_fmt` (`pix_fmt_args`); device via `TRIMLY_VAAPI_DEVICE` (default `/dev/dri/renderD128`). NVENC and QSV work on Linux as usual. "Open with": own desktop template `linux/trimly.desktop` with `Exec=… %F` (Tauri's default passes no file), MIME types from `fileAssociations`; the file arrives as a start argument like on Windows. A UTM VM on the Mac has no GPU, so only libx264 runs there.

### Backend (`backend/app/video/`)

- `VideoController.scala`: HTTP endpoints (see `conf/routes`).
- `VideoService.scala`: file storage, status map (`Computing`/`Ready`/`Failed(msg)`), cleanup timers, `/keepalive` for the editor. State lives **in memory only**.
- `VideoCalculator.scala`: fills in missing parameters from ffprobe, validates start/end, caps the bitrate.
- `FFmpegUtils.scala`: `trimVideo` (original mode, `-c copy`), `extractAudio` (MP3), `processVideo` (NVENC with CUDA decoding if the test encode works, otherwise/fallback libx264 veryfast).
- `EditRenderer.scala`: filter graph for the editor (`POST /render`).

### API (web only)

| Route | Purpose |
|---|---|
| `POST /store` | multipart `video` → `{originalId}` |
| `POST /process` | `originalId`, `mode` (`original` = trim only), `output` (`both`/`video`/`audio`), `startTime`/`endTime` (ms), `volume`, `framerate`, `bitrate` (kbit/s), `resolution` (`WxH`) → `{filename}`; unknown original → 404 `{status: "missing"}` |
| `GET /check/:filename` | `{status: ready, size}` / `computing` / `error` + `message` / `unknown` |
| `GET /download/:filename?name=` | finished file, streamed, with the requested file name |
| `POST /render`, `POST /keepalive` | editor |

## Running and testing

On the Mac, Node, Rust and ffmpeg are installed via Homebrew; sbt only exists in the backend container. **Check `git pull` / `git fetch` before working** – the code is also pushed from a Windows machine; in November 2026 seven commits were missing locally.

```bash
cd frontend && npm run desktop                  # desktop app with hot reload
cd frontend && npm run desktop:build            # .app/.dmg in src-tauri/target/release/bundle/
docker compose up --build                       # web: frontend :3000, backend :9000
```

```bash
cd frontend && CI=true npm test -- --watchAll=false      # Jest
cd frontend/src-tauri && cargo test                      # Rust, including real ffmpeg
docker compose run --rm backend sbt -batch test          # Scala
```

Tests with a real video use `backend/test/resources/testVideo.mp4` (2560×1440, 60 fps, 19.05 s, stereo audio; generated, 1.8 MB) and are skipped if it or ffmpeg is missing. To regenerate it: `ffmpeg -f lavfi -i "gradients=size=2560x1440:rate=60:duration=19.05:speed=0.02:seed=7" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=19.05" -ac 2 -c:v libx264 -preset slow -crf 40 -g 120 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart -shortest testVideo.mp4`. `.github/workflows/test.yml` runs all three test suites on Linux on every push and PR (badge in the README). In Scala, always evaluate futures with `Await`/`futureValue`, never inside `fut.map { assert }`.

README screenshots in `docs/images/` come from Playwright/WebKit against `docker compose up`, with a neutral video generated via `ffmpeg -f lavfi -i gradients=…` (no game scenes/weapons). Store them as JPEG.

### Release

`.github/workflows/release.yml` builds the desktop app on every `v*` tag for Windows (`windows-latest`) and macOS (`macos-latest`, Apple Silicon, only ad-hoc signed), both with bundled ffmpeg (cached by the hash of `build-ffmpeg.sh`), and for Linux (`ubuntu-22.04` and `ubuntu-22.04-arm`, `.deb`/`.rpm`/AppImage, without ffmpeg), and uploads the installers to a draft release. Once all builds are green, **the `publish` job publishes it automatically** (tags with a hyphen like `v0.3.0-beta.1` as a pre-release). The release text (unsigned, SmartScreen/Gatekeeper, GPL notice with the ffmpeg version) lives in the `create-release` job, which also checks that the tag, `package.json` and `Cargo.toml` have the same version.

1. Bump the version in `frontend/package.json` and `frontend/src-tauri/Cargo.toml` (then run `cargo check` in `src-tauri` so `Cargo.lock` follows). `tauri.conf.json` reads the version from `package.json` (`"version": "../package.json"`).
2. Commit and push on master, then create and push the tag:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. Wait for the run under GitHub → Actions (the first run after a change to `build-ffmpeg.sh` builds ffmpeg and takes much longer). After that the release is public.
4. If a run failed, it stays a draft: delete the draft, delete the tag (`git push --delete origin v0.2.0 && git tag -d v0.2.0`), fix the problem, tag again.

License: GPL-3.0-or-later (`LICENSE`), matching the bundled libx264 ffmpeg. `frontend/.env.production` (in Git, exception in `.gitignore`) turns off source maps in the build.

## Known issues

- Editor speed: video and audio segments have `speed` (0.25–4, `SPEEDS` in `editor/project.js`), timeline length = (srcEnd − srcStart) / speed (`segLen`). Rendered with `setpts=(PTS-STARTPTS)/speed` and an `atempo` chain (each link 0.5–2), the same in `edit.rs` and `EditRenderer.scala`.
- The editor renderer exists twice: `EditRenderer.scala` (web) and `src-tauri/src/edit.rs` (desktop). Make filter graph changes in both; enable new ffmpeg filters in `scripts/build-ffmpeg.sh` too. The editor still has its own presets (`src/presets.js`) instead of `lib/presets.js`.
- The Windows build works (November 2026, Node 26, Rust 1.99, VS Build Tools 2022). H.264/HEVC/AV1 tested via AMF. Untested: NVENC/Quick Sync with the bundled ffmpeg, the desktop parts of the settings menu by clicking (only viewed in the browser).
- Windows build environment: `winget install` of `OpenJS.NodeJS.LTS`, `Rustlang.Rustup`, `Microsoft.VisualStudio.2022.BuildTools` (workload VCTools), `MSYS2.MSYS2` (for ffmpeg). A terminal that was open before the installation doesn't know `npm`.
- On Windows, installers started from Claude's shell end up in `AppData\Local\Packages\Claude_…\LocalCache` (MSIX redirection), not in Florian's real AppData. So let Florian start installers by double-clicking.
- The Linux container has no VideoToolbox; the server can only do NVENC or CPU.
- The web version doesn't know the source frame rate and sends the preset fps unchanged.
- The old 63 MB `testVideo.mp4` is still in the Git history (cloning downloads it); getting rid of it would require rewriting history with a force push.

## Conventions

- **Everything in English** (since November 2026, Florian's wish): UI texts, error messages, code comments, commit messages and this file. Sentence case, no all-caps labels.
- Error messages say what to do (e.g. `brew install ffmpeg`).
- Times: frontend and Rust in seconds, web API in milliseconds. Bitrates always in kbit/s.
- The backend logs with `println` and prefixes like `[PROCESS]`, `[FFMPEG]`.
