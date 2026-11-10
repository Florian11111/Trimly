# Trimly

Videos schneiden und verkleinern. Eine React-Oberfläche, zwei Betriebsarten:

- **Desktop (Tauri 2):** Rust ruft ffmpeg direkt auf der lokalen Datei auf, mit VideoToolbox-Hardware-Encoding auf dem Mac.
- **Web:** Upload an ein Scala/Play-Backend, das ffmpeg im Docker-Container ausführt.

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
- `components/Timeline.js`: Filmstreifen. Vorschaubilder werden mit einem versteckten `<video>` per Seek direkt in einen Canvas gezeichnet, ohne Auslesen, damit auch Tauri-Asset-URLs funktionieren. Griffe sind `role="slider"` und per Pfeiltasten bedienbar.
- `lib/presets.js`: **einzige Quelle für Qualitätsstufen.** `resolveTarget` rechnet Preset und Quelle in `{copy, width, height, fps, bitrate, audioBitrate, capped}` um: `height` = kürzere Seite, nie hochskalieren, gerade Kanten, **Video- und Tonbitrate nie über dem Original** (sonst wird z. B. eine 100-kbit/s-Vorlesung beim Kodieren größer). `estimateBytes` liefert die Größenschätzung.
- `platform/`: `index.js` wählt per `"__TAURI_INTERNALS__" in window` zwischen `web.js` (HTTP an das Backend) und `desktop.js` (Tauri `invoke`). `desktop.js` wird nur dynamisch importiert, damit Jest die Tauri-ESM-Pakete nie lädt. Beide Module haben dieselbe Schnittstelle, beschrieben in `index.js`.
- Design-Tokens in `index.css`: Nachtblau, Glasflächen (`--glass-blur`), Blau-Violett-Verlauf für Aktionen, Orange `--trim` für die Schnittklammer. Hintergrund `.backdrop` mit drei weichgezeichneten, langsam treibenden Farbflecken (steht bei „Bewegung reduzieren“). Systemschrift, Zahlen mit `tabular-nums`.
- Abmessungen kommen auf dem Desktop von ffprobe (`video.ref.info`), nicht vom `<video>`-Element.
- „Anderes Video“ ruft `resetAll()` auf (alles inkl. Einstellungen zurück). Der Arbeitsbereich hat `key={video.src}`, damit Player und Filmstreifen pro Video neu entstehen.

### Desktop (`frontend/src-tauri/src/`)

- `ffmpeg.rs`: reine Logik ohne Prozesse. `find_tool` (PATH + `/opt/homebrew/bin` + `/usr/local/bin`, weil Finder-Apps den Shell-PATH nicht erben), `pick_encoder`, `parse_probe`, `build_args`, `progress_from_line` (liest `-progress pipe:1`).
- `media_server.rs`: Vorschau-Videos laufen über einen eigenen HTTP-Server auf `127.0.0.1` (Zufallsport, Token in der URL, nur per `media_url` freigegebene Dateien). **Nicht zurück zum Tauri-Asset-Protokoll wechseln:** Es beantwortet Ranges mit höchstens 1 MB, und bei langen Videos ist der `moov`-Index größer, dann zeigt WebKit nur 0 × 0 ohne Bild.
- `lib.rs`: Tauri-Commands `encoder_info`, `initial_file` (`Trimly video.mp4` öffnet direkt), `frontend_log` (UI-Meldungen nach stderr, nützlich zur Fehlersuche ohne Fenster), `probe`, `media_url`, `export_video` (Fortschritt über `Channel<f64>`), `cancel_export`. Es läuft höchstens ein Export gleichzeitig. Abbruch liefert den Fehler `"cancelled"`, den das Frontend still schluckt.
- Fehlersuche ohne Bildschirmzugriff: `cargo build && ./target/debug/trimly /pfad/video.mp4 2>&1 | grep '\[ui\]'` (Debug-Build lädt die UI von `localhost:3000`).
- `tauri.conf.json`: macOS-Titelleiste als Overlay (`.is-desktop .topbar` lässt 84 px für die Ampel-Knöpfe frei).

### Backend (`backend/app/video/`)

- `VideoController.scala`: HTTP-Endpunkte (siehe `conf/routes`).
- `VideoService.scala`: Dateiablage, Status-Map (`Computing`/`Ready`/`Failed`), Aufräum-Timer. Der Zustand liegt **nur im Speicher**.
- `VideoCalculator.scala`: füllt fehlende Parameter aus ffprobe auf, validiert Start/Ende, deckelt die Bitrate (`normalBitrate`). Die untere Hälfte ist auskommentierter Altcode.
- `FFmpegUtils.scala`: `getVideoInfo` und `processVideo` (fest `libx264`).

### API (nur Web)

| Route | Zweck |
|---|---|
| `POST /store` | Multipart `video` → `{originalId}` |
| `POST /process` | `originalId`, `startTime`/`endTime` (ms), `volume`, `framerate`, `bitrate` (kbit/s), `resolution` (`BxH`) → `{filename}`; ffmpeg läuft im Hintergrund |
| `GET /check/:filename` | `{exists, size}` oder `{exists: false, failed: true, message}` |
| `GET /download/:filename` | fertige Datei |
| `POST /upload` | Legacy, vom Frontend nicht mehr benutzt |

## Starten und testen

Node, Rust und ffmpeg sind lokal per Homebrew installiert, sbt nur im Backend-Container.

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

- `maxSizeMb` gibt es im Backend noch, das neue Frontend sendet es nicht. Ein echtes Größenlimit fehlt.
- Das Backend kodiert immer mit libx264. Im Linux-Container gibt es kein VideoToolbox.
- „Nur schneiden" gibt es nur in der Desktop-App.
- Die Web-Version kennt die Bildrate der Quelle nicht und sendet die Preset-fps unverändert.
- `backend/test/resources/testVideo.mp4` (63 MB) liegt im Git-Repo.
- `backend/build.sc` (Mill) und `.g8/` sind Überbleibsel; gebaut wird mit sbt.

## Konventionen

- UI-Texte, Kommentare und Fehlermeldungen auf Deutsch, Satzanfang groß, keine Großbuchstaben-Labels.
- Fehlermeldungen sagen, was zu tun ist (z. B. `brew install ffmpeg`).
- Zeiten: Frontend und Rust in Sekunden, Web-API in Millisekunden. Bitraten immer in kbit/s.
- Backend loggt mit `println` und Präfixen wie `[PROCESS]`, `[FFMPEG]`.
