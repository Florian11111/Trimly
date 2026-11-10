# Trimly

Videos schneiden und verkleinern. Eine React-Oberfläche, zwei Betriebsarten:

- **Desktop (Tauri 2, macOS + Windows):** Rust ruft ffmpeg direkt auf der lokalen Datei auf, mit Hardware-Encoding (VideoToolbox, NVENC, Quick Sync, AMF).
- **Web:** Upload an ein Scala/Play-Backend, das ffmpeg im Docker-Container ausführt (optional NVENC über `docker-compose.gpu.yml`, Windows-Start per `start-trimly.bat`).

Florian nutzt beides: Mac (M5) und Windows mit NVIDIA-Karte.

## Aufbau

| Teil | Technik | Ort |
|---|---|---|
| Oberfläche | React 19, Create React App (`react-scripts` 5), reines JS | `frontend/src/` |
| Desktop | Tauri 2, Rust, Plugins `dialog` und `opener` | `frontend/src-tauri/` |
| Backend | Scala 2.13, Play Framework 3.0.7 (Pekko), sbt 1.10 | `backend/` |
| Video | `ffmpeg` / `ffprobe` als externe Prozesse | |
| Prod (Web) | nginx vor Frontend (statisch) und Backend | `nginx.conf`, `docker-compose.prod.yml` |

### Frontend (`frontend/src/`)

- `App.js`: gesamter Zustand. Video öffnen, Wiedergabe (rAF-Abspielkopf, stoppt am Ausschnittende), Tastenkürzel, Export.
- `components/Timeline.js`: Filmstreifen. Vorschaubilder werden mit einem versteckten `<video>` per Seek direkt in einen Canvas gezeichnet (ohne Auslesen). **Kurzer Klick auf einen Griff springt nur dorthin, erst nach `HOLD_MS` Gedrückthalten wird er verschiebbar** (Wunsch von Florian). Griffe sind `role="slider"` und per Pfeiltasten bedienbar. Mindestlänge 0,01 s.
- `lib/presets.js`: **einzige Quelle für Qualitätsstufen.** `resolveTarget` rechnet Preset und Quelle in `{copy, width, height, fps, bitrate, audioBitrate, capped}` um: `height` = kürzere Seite, nie hochskalieren, gerade Kanten, **Video- und Tonbitrate nie über dem Original** (sonst wird z. B. eine 100-kbit/s-Vorlesung beim Kodieren größer). `estimateBytes` liefert die Größenschätzung je Ausgabe (`OUTPUTS`: both/video/audio). Tonbitraten 128 kbit/s AAC, 192 kbit/s MP3 – müssen zu Backend (`VideoCalculator.AudioBitrateKbps`, `FFmpegUtils.AudioOnlyBitrateKbps`) und `ffmpeg.rs` passen.
- `platform/`: `index.js` wählt per `"__TAURI_INTERNALS__" in window` zwischen `web.js` (HTTP an das Backend) und `desktop.js` (Tauri `invoke`). `desktop.js` wird nur dynamisch importiert, damit Jest die Tauri-ESM-Pakete nie lädt. Beide Module haben dieselbe Schnittstelle, beschrieben in `index.js`.
- Design-Tokens in `index.css`: Nachtblau, Glasflächen (`--glass-blur`), Blau-Violett-Verlauf für Aktionen, Orange `--trim` für die Schnittklammer. Hintergrund `.backdrop` mit drei weichgezeichneten, langsam treibenden Farbflecken (steht bei „Bewegung reduzieren“). Systemschrift, Zahlen mit `tabular-nums`.
- Abmessungen kommen auf dem Desktop von ffprobe (`video.ref.info`), nicht vom `<video>`-Element.
- „Anderes Video“ ruft `resetAll()` auf (alles inkl. Einstellungen zurück). Der Arbeitsbereich hat `key={video.src}`, damit Player und Filmstreifen pro Video neu entstehen.
- Nach einem Export tritt der Export-Knopf zurück (`.btn-primary.is-done`), bis sich eine Einstellung ändert.
- `web.js` folgt dem Backend-Protokoll: `mode=original|custom`, `output=both|video|audio`, bei `status: "missing"` Original neu hochladen und erneut senden, `/check` liefert `status` ready/computing/error/unknown, Download per Direktlink mit `?name=` (kein RAM-Puffer).
- `src/editor/` (Editor-Tab: Clips, Tonspur, Overlays, Zoom, `POST /render`) stammt aus dem Oktober-Stand. Er hängt über den Umschalter „Schneiden / Editor“ in der Kopfzeile an `App.js`, **nur in der Web-Version** (die Desktop-App hat keinen Renderer dafür). Beide Ansichten bleiben beim Umschalten erhalten (`hidden`). Farben in `Editor.css` nutzen die Design-Tokens. `src/presets.js` gehört nur zum Editor.

### Desktop (`frontend/src-tauri/src/`)

- `ffmpeg.rs`: reine Logik ohne Prozesse. `find_tool` (PATH + Homebrew-Ordner, weil Finder-Apps den Shell-PATH nicht erben; unter Windows `.exe`, winget-Links, `C:\ffmpeg\bin`), `listed_hw_encoders` + `encoder_test_args` (Hardware-Encoder werden per Test-Encode geprüft, ffmpeg listet NVENC auch ohne Karte), `encoder_args` (**NVENC immer mit `-bf 0`**, sonst graues Bild bei 29,97 fps), `parse_probe`, `build_args` (`streams` both/video/audio), `progress_from_line`.
- `media_server.rs`: Vorschau-Videos laufen über einen eigenen HTTP-Server auf `127.0.0.1` (Zufallsport, Token in der URL, nur per `media_url` freigegebene Dateien). **Nicht zurück zum Tauri-Asset-Protokoll wechseln:** Es beantwortet Ranges mit höchstens 1 MB, und bei langen Videos ist der `moov`-Index größer, dann zeigt WebKit nur 0 × 0 ohne Bild.
- `lib.rs`: Tauri-Commands `encoder_info`, `initial_file`, `frontend_log` (UI-Meldungen nach stderr, nützlich zur Fehlersuche ohne Fenster), `probe`, `media_url`, `export_video` (Fortschritt über `Channel<f64>`; scheitert ein Hardware-Encoder, automatisch neuer Versuch mit libx264), `cancel_export`. Es läuft höchstens ein Export gleichzeitig. Abbruch liefert den Fehler `"cancelled"`, den das Frontend still schluckt. `TRIMLY_ENCODER=cpu` erzwingt libx264.
- „Öffnen mit“: `bundle.fileAssociations` (Rolle Viewer, Rang `Alternate` → nie Standardprogramm). Windows übergibt die Datei als Startargument, macOS als `RunEvent::Opened` → wird in `PendingFile` gemerkt und als Event `open-file` gemeldet; die UI holt sie per `initial_file` ab (liefert jede Datei nur einmal). Testen auf dem Mac: `open --stderr log.txt -a …/Trimly.app video.mp4`. Windows ist ungetestet; eine zweite Datei startet dort eine zweite Instanz (kein Single-Instance-Plugin).
- Fehlersuche ohne Bildschirmzugriff: `cargo build && ./target/debug/trimly /pfad/video.mp4 2>&1 | grep '\[ui\]'` (Debug-Build lädt die UI von `localhost:3000`).
- `tauri.conf.json`: macOS-Titelleiste als Overlay (`.is-desktop .topbar` lässt 84 px für die Ampel-Knöpfe frei).

### Backend (`backend/app/video/`)

- `VideoController.scala`: HTTP-Endpunkte (siehe `conf/routes`).
- `VideoService.scala`: Dateiablage, Status-Map (`Computing`/`Ready`/`Failed(msg)`), Aufräum-Timer, `/keepalive` für den Editor. Der Zustand liegt **nur im Speicher**.
- `VideoCalculator.scala`: füllt fehlende Parameter aus ffprobe auf, validiert Start/Ende, deckelt die Bitrate.
- `FFmpegUtils.scala`: `trimVideo` (Original-Modus, `-c copy`), `extractAudio` (MP3), `processVideo` (NVENC mit CUDA-Dekodierung, wenn der Test-Encode klappt, sonst/Fallback libx264 veryfast).
- `EditRenderer.scala`: Filtergraph für den Editor (`POST /render`).

### API (nur Web)

| Route | Zweck |
|---|---|
| `POST /store` | Multipart `video` → `{originalId}` |
| `POST /process` | `originalId`, `mode` (`original` = nur schneiden), `output` (`both`/`video`/`audio`), `startTime`/`endTime` (ms), `volume`, `framerate`, `bitrate` (kbit/s), `resolution` (`BxH`) → `{filename}`; unbekanntes Original → 404 `{status: "missing"}` |
| `GET /check/:filename` | `{status: ready, size}` / `computing` / `error` + `message` / `unknown` |
| `GET /download/:filename?name=` | fertige Datei, gestreamt, mit Wunsch-Dateiname |
| `POST /render`, `POST /keepalive` | Editor |
| `POST /upload` | Legacy, vom Frontend nicht mehr benutzt |

## Starten und testen

Auf dem Mac sind Node, Rust und ffmpeg per Homebrew installiert, sbt nur im Backend-Container. **Vor Arbeiten `git pull` bzw. `git fetch` prüfen** – der Stand wird auch von einem Windows-Rechner gepusht; im November 2026 fehlten hier lokal 7 Commits.

```bash
cd frontend && npm run desktop                  # Desktop-App mit Hot Reload
cd frontend && npm run desktop:build            # .app/.dmg in src-tauri/target/release/bundle/
docker compose up --build                       # Web: Frontend :3000, Backend :9000
```

```bash
cd frontend && CI=true npm test -- --watchAll=false      # Jest
cd frontend/src-tauri && cargo test                      # Rust, inkl. echtes ffmpeg
docker compose run --rm backend sbt -batch test          # Scala
```

Tests mit echtem Video nutzen `backend/test/resources/testVideo.mp4` (2560×1440, 60 fps, 19,05 s) und werden übersprungen, wenn es oder ffmpeg fehlt. In Scala Futures immer mit `Await`/`futureValue` auswerten, nie in `fut.map { assert }`.

README-Screenshots in `docs/images/` stammen von Playwright/WebKit gegen `docker compose up`, mit einem neutralen, per `ffmpeg -f lavfi -i gradients=…` erzeugten Video (keine Spielszenen/Waffen). Als JPEG ablegen.

## Bekannte Baustellen

- Editor nur im Web; für die Desktop-App bräuchte `EditRenderer.scala` ein Gegenstück in Rust. Der Editor hat noch eigene Presets (`src/presets.js`) statt `lib/presets.js`.
- Windows-Build und „Öffnen mit“ unter Windows sind ungetestet (kein Windows-Rechner in der Entwicklungsumgebung).
- Im Linux-Container gibt es kein VideoToolbox; der Server kann nur NVENC oder CPU.
- Die Web-Version kennt die Bildrate der Quelle nicht und sendet die Preset-fps unverändert.
- `backend/test/resources/testVideo.mp4` (63 MB) liegt im Git-Repo.
- `backend/build.sc` (Mill) und `.g8/` sind Überbleibsel; gebaut wird mit sbt.

## Konventionen

- UI-Texte, Kommentare und Fehlermeldungen auf Deutsch, Satzanfang groß, keine Großbuchstaben-Labels.
- Fehlermeldungen sagen, was zu tun ist (z. B. `brew install ffmpeg`).
- Zeiten: Frontend und Rust in Sekunden, Web-API in Millisekunden. Bitraten immer in kbit/s.
- Backend loggt mit `println` und Präfixen wie `[PROCESS]`, `[FFMPEG]`.
