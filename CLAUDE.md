# Trimly

Videos schneiden und verkleinern. Eine React-Oberfläche, zwei Betriebsarten:

- **Desktop (Tauri 2, macOS + Windows + Linux):** Rust ruft ffmpeg direkt auf der lokalen Datei auf, mit Hardware-Encoding (VideoToolbox, NVENC, Quick Sync, AMF, unter Linux VA-API).
- **Web:** Upload an ein Scala/Play-Backend, das ffmpeg im Docker-Container ausführt (optional NVENC über `docker-compose.gpu.yml`, Windows-Start per `start-trimly.bat`).

Florian nutzt beides: Mac (M5) und Windows-PC mit AMD Radeon RX 9070 XT (AMF, kein NVENC).

## Aufbau

| Teil | Technik | Ort |
|---|---|---|
| Oberfläche | React 19, Create React App (`react-scripts` 5), reines JS | `frontend/src/` |
| Desktop | Tauri 2, Rust, Plugins `dialog` und `opener` | `frontend/src-tauri/` |
| Backend | Scala 2.13, Play Framework 3.0.7 (Pekko), sbt 1.10 | `backend/` |
| Video | `ffmpeg` / `ffprobe` als externe Prozesse | |
| Prod (Web) | nginx vor Frontend (statisch) und Backend | `nginx.conf`, `docker-compose.prod.yml` |

### Frontend (`frontend/src/`)

- `App.js`: gesamter Zustand. Video öffnen, Wiedergabe (rAF-Abspielkopf, stoppt am Ausschnittende), Tastenkürzel, Export. Qualität als `quality = {mode, presetId, custom, sizeMb}` mit drei nebeneinanderliegenden Modi **Original / Compress / Target size**, jeder klappt darunter seinen kleinen Bereich auf (Compress: Small/Medium/High/Custom, Target size: 10/25/50/100 MB + eigene Zahl). Bewusst nicht mehr als drei Hauptoptionen (Wunsch von Florian: übersichtlich, mehrere Ausschnitte pro Video gehören in den Editor, nicht hierher). Kommt per „Öffnen mit“ eine Datei, während ein Video offen ist, fragt ein Dialog „Open …?“ erst nach.
- `lib/settings.js` + `components/Settings.js`: Zahnrad-Menü in der Kopfzeile, gespeichert in `localStorage` (`trimly.settings`). Überall: Theme (Dark/Light/System) und Akzentfarbe (violet/blue/pink/green) als `data-theme`/`data-accent` an `<html>`; `public/index.html` setzt beides schon vor dem ersten Bild. Nur Desktop: Format (H.264/HEVC/AV1), Encoder (Automatic / gefundene GPUs / CPU) und Standard-Ausgabeordner. Mit Ordner wird direkt dorthin exportiert (freier Name per `unique_path`), der Ordner-Knopf neben „Export“ fragt trotzdem nach dem Ort.
- Die ganze App ist auf **Englisch** (Texte, Fehlermeldungen aus Rust, Zahlen mit Punkt). Kommentare bleiben deutsch. Ausnahme: Meldungen des Scala-Backends (nur Web) sind noch deutsch.
- `components/Timeline.js`: Filmstreifen. Vorschaubilder werden mit einem versteckten `<video>` per Seek direkt in einen Canvas gezeichnet (ohne Auslesen). **Kurzer Klick auf einen Griff springt nur dorthin, erst nach `HOLD_MS` Gedrückthalten wird er verschiebbar** (Wunsch von Florian). Griffe sind `role="slider"` und per Pfeiltasten bedienbar. Mindestlänge 0,01 s.
- `lib/presets.js`: **einzige Quelle für Qualitätsstufen.** `resolveTarget` rechnet Preset und Quelle in `{copy, width, height, fps, bitrate, audioBitrate, capped}` um: `height` = kürzere Seite, nie hochskalieren, gerade Kanten, **Video- und Tonbitrate nie über dem Original** (sonst wird z. B. eine 100-kbit/s-Vorlesung beim Kodieren größer). `estimateBytes` liefert die Größenschätzung je Ausgabe (`OUTPUTS`: both/video/audio). `resolveQuality` verteilt auf die Modi; `resolveSizeTarget` rechnet MB (MiB, 6 % Puffer) und Cliplänge in Bitrate, wählt die Auflösung über eine Bitraten-Leiter und bläht nie über das Original auf (`tooSmall` warnt). HEVC/AV1 bekommen bei festen Stufen 70 %/60 % der Bitrate (eigene Werte bleiben), die Web-Version kodiert immer H.264. Tonbitraten 128 kbit/s AAC, 192 kbit/s MP3 – müssen zu Backend (`VideoCalculator.AudioBitrateKbps`, `FFmpegUtils.AudioOnlyBitrateKbps`) und `ffmpeg.rs` passen.
- `platform/`: `index.js` wählt per `"__TAURI_INTERNALS__" in window` zwischen `web.js` (HTTP an das Backend) und `desktop.js` (Tauri `invoke`). `desktop.js` wird nur dynamisch importiert, damit Jest die Tauri-ESM-Pakete nie lädt. Beide Module haben dieselbe Schnittstelle, beschrieben in `index.js`.
- Design-Tokens in `index.css`: Nachtblau, Glasflächen (`--glass-blur`), Akzent-Verlauf `--violet`→`--blue` für Aktionen, helles Lavendel `--trim` (#c9bfff, vorher Orange) für die Schnittklammer. Theme- und Akzent-Varianten überschreiben nur Tokens (`--well`, `--shade`, `--popover`, `--accent-rgb` …); **keine festen Farben in CSS**, sonst bricht das helle Design. Menüs/Dialoge nutzen `--popover` (fast deckend), weil Glas in der Kopfzeile nicht doppelt wirkt. Achtung: `.app > :not(.backdrop)` setzt `position: relative; z-index: 1` – eigene Ebenen brauchen `.app > .x` (siehe `.topbar`, `.modal-backdrop`). Hintergrund `.backdrop` mit drei weichgezeichneten, langsam treibenden Farbflecken (steht bei „Bewegung reduzieren“). Systemschrift, Zahlen mit `tabular-nums`.
- Abmessungen kommen auf dem Desktop von ffprobe (`video.ref.info`), nicht vom `<video>`-Element.
- „Anderes Video“ ruft `resetAll()` auf (alles inkl. Einstellungen zurück). Der Arbeitsbereich hat `key={video.src}`, damit Player und Filmstreifen pro Video neu entstehen.
- Nach einem Export tritt der Export-Knopf zurück (`.btn-primary.is-done`), bis sich eine Einstellung ändert.
- `web.js` folgt dem Backend-Protokoll: `mode=original|custom`, `output=both|video|audio`, bei `status: "missing"` Original neu hochladen und erneut senden, `/check` liefert `status` ready/computing/error/unknown, Download per Direktlink mit `?name=` (kein RAM-Puffer).
- `src/editor/` (Editor-Tab: Clips, Tonspur, Overlays, Zoom, `POST /render`) stammt aus dem Oktober-Stand. Er hängt über den Umschalter „Schneiden / Editor“ in der Kopfzeile an `App.js`, im Web und auf dem Desktop. Auf dem Desktop ist die „originalId“ der Dateipfad (kein Upload, kein Keepalive), Clips kommen über `platform.pick/open`, Export über `platform.renderEdit` → Rust `render_edit` (Overlays als Base64-PNG). Beide Ansichten bleiben beim Umschalten erhalten (`hidden`). Der Editor ist ein eigenes Bundle (`React.lazy`), vorgeladen beim Zeigen auf oder Fokussieren des Tabs; Tests brauchen dafür `findBy…`. Farben in `Editor.css` nutzen die Design-Tokens. `src/presets.js` gehört nur zum Editor.

### Desktop (`frontend/src-tauri/src/`)

- `ffmpeg.rs`: reine Logik ohne Prozesse. `find_tool` (zuerst neben der eigenen Programmdatei = mitgeliefertes ffmpeg, dann PATH + Homebrew-Ordner, weil Finder-Apps den Shell-PATH nicht erben; unter Windows `.exe`, winget-Links, `C:\ffmpeg\bin`), Encoder als Familie × Codec (`encoder_for("amf", "av1")` → `av1_amf`; CPU nur `libx264`), `listed_hw_encoders_all` + `encoder_test_args` (jeder Hardware-Encoder wird per Test-Encode mit **640×480** geprüft – ffmpeg listet NVENC auch ohne Karte, und `hevc_amf` lehnt 320×240 ab), `pick_encoder` (Wunsch-Gerät + Codec → sonst andere Hardware mit dem Codec → H.264 → libx264), `encoder_args` (**NVENC immer mit `-bf 0`**, sonst graues Bild bei 29,97 fps; HEVC mit `-tag:v hvc1` für Apple-Player), `parse_probe`, `build_args` (`streams` both/video/audio), `progress_from_line`.
- `edit.rs`: Editor-Export, Gegenstück zu `EditRenderer.scala` (concat, zoompan, overlay, amix), reine Logik mit Tests; `render_edit` in `lib.rs` prüft Quellen per ffprobe und fällt wie `export_video` von Hardware auf libx264 zurück.
- `media_server.rs`: Vorschau-Videos laufen über einen eigenen HTTP-Server auf `127.0.0.1` (Zufallsport, Token in der URL, nur per `media_url` freigegebene Dateien). **Nicht zurück zum Tauri-Asset-Protokoll wechseln:** Es beantwortet Ranges mit höchstens 1 MB, und bei langen Videos ist der `moov`-Index größer, dann zeigt WebKit nur 0 × 0 ohne Bild.
- Mitgeliefertes ffmpeg (nur Windows): `scripts/build-ffmpeg.sh` baut in MSYS2 UCRT64 ein schlankes, statisches ffmpeg/ffprobe (~18 MB, GPL wegen libx264) nach `binaries/` (nicht im Git). `tauri.windows.conf.json` packt es per `externalBin` neben `trimly.exe`. Ohne diese Dateien schlägt `desktop:build` unter Windows fehl. macOS nutzt weiter Homebrew-ffmpeg (Skript dort ungetestet).
- `lib.rs`: alle ffmpeg-Aufrufe über `tool_command` (stdin null, unter Windows `CREATE_NO_WINDOW`, sonst blitzt aus der GUI-App bei jedem Aufruf ein Konsolenfenster auf). `encoder_info` ist async: synchrone Commands laufen im Haupt-Thread und hätten das Fenster bis zum Ende des Encoder-Tests eingefroren. Tauri-Commands `encoder_info`, `initial_file`, `frontend_log` (UI-Meldungen nach stderr, nützlich zur Fehlersuche ohne Fenster), `probe`, `media_url`, `export_video` (Fortschritt über `Channel<f64>`; `codec`/`encoder` aus den Einstellungen; scheitert ein Hardware-Encoder, automatisch neuer Versuch mit libx264), `cancel_export`. Speichern im Hintergrund: ohne Standardordner startet `desktop.js` den Export sofort in `temp_output` (Temp-Ordner, Präfix `trimly-export-`), während der Speichern-Dialog offen ist; danach `finalize_export` (umbenennen, über Laufwerke kopieren) oder bei Abbruch `cancel_export` + `discard_temp`. Beide fassen nur eigene Temp-Dateien an. Es läuft höchstens ein Export gleichzeitig. Abbruch liefert den Fehler `"cancelled"`, den das Frontend still schluckt. `TRIMLY_ENCODER=cpu` erzwingt libx264.
- „Öffnen mit“: `bundle.fileAssociations` (Rolle Viewer, Rang `Alternate` → nie Standardprogramm). Windows übergibt die Datei als Startargument, macOS als `RunEvent::Opened` → wird in `PendingFile` gemerkt und als Event `open-file` gemeldet; die UI holt sie per `initial_file` ab (liefert jede Datei nur einmal). Testen auf dem Mac: `open --stderr log.txt -a …/Trimly.app video.mp4`. Eine Instanz: `tauri-plugin-single-instance` (muss das erste Plugin sein) gibt die Datei eines zweiten Starts per `PendingFile` + `open-file` an das laufende Fenster weiter (unter Windows getestet). Achtung beim Testen: zwei Builds mit derselben `identifier` teilen sich das.
- Fehlersuche ohne Bildschirmzugriff: `cargo build && ./target/debug/trimly /pfad/video.mp4 2>&1 | grep '\[ui\]'` (Debug-Build lädt die UI von `localhost:3000`).
- `tauri.conf.json`: macOS-Titelleiste als Overlay (`.is-desktop.is-mac .topbar` lässt 84 px für die Ampel-Knöpfe frei; Windows hat eine normale Titelleiste).
- **Linux (November 2026 in einer UTM-VM getestet: Ubuntu 24.04 ARM64, libx264; VA-API auf echter Hardware noch ungetestet):** Builds als `.deb`, `.rpm` und AppImage (Release-Workflow, ubuntu-22.04 x64 + ARM64). ffmpeg kommt vom System (`.deb` hängt von `ffmpeg` ab). Vorschau braucht unter WebKitGTK die GStreamer-Plugins good/bad/libav, sonst bleibt das Bild schwarz; AppImage liefert sie per `bundleMediaFramework` mit. Hardware: Familie `vaapi` (Intel/AMD) – braucht `-vaapi_device` vor den Eingaben (`hw_init_args`), den Filter `format=nv12,hwupload` am Ende (`final_format_filter`) und **kein** `-pix_fmt` (`pix_fmt_args`); Gerät per `TRIMLY_VAAPI_DEVICE` (Standard `/dev/dri/renderD128`). NVENC und QSV gehen unter Linux wie gehabt. „Öffnen mit“: eigene Desktop-Vorlage `linux/trimly.desktop` mit `Exec=… %F` (Tauris Standard übergibt keine Datei), MIME-Typen aus `fileAssociations`; die Datei kommt als Startargument wie unter Windows. In einer UTM-VM auf dem Mac gibt es keine GPU, dort läuft nur libx264.

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

### Release

`.github/workflows/release.yml` baut bei jedem Tag `v*` die Desktop-App für Windows (`windows-latest`, mit mitgeliefertem ffmpeg, gecacht über den Hash von `build-ffmpeg.sh`), macOS (`macos-latest`, Apple Silicon, ohne ffmpeg, nur ad-hoc signiert) und Linux (`ubuntu-22.04` und `ubuntu-22.04-arm`, `.deb`/`.rpm`/AppImage, ohne ffmpeg) und lädt die Installer in einen Entwurfs-Release. Sind alle Builds grün, **veröffentlicht der Job `publish` ihn automatisch** (Tags mit Bindestrich wie `v0.3.0-beta.1` als Vorabversion). Der Release-Text (unsigniert, SmartScreen/Gatekeeper, GPL-Hinweis mit ffmpeg-Version) steht im Job `create-release`, der auch prüft, dass Tag, `package.json` und `Cargo.toml` dieselbe Version haben.

1. Version erhöhen in `frontend/package.json` und `frontend/src-tauri/Cargo.toml` (danach `cargo check` in `src-tauri`, damit `Cargo.lock` mitzieht). `tauri.conf.json` liest die Version aus `package.json` (`"version": "../package.json"`).
2. Auf master committen und pushen, dann Tag setzen und pushen:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. Unter GitHub → Actions den Lauf abwarten (erster Windows-Lauf baut ffmpeg, dauert deutlich länger). Danach ist der Release öffentlich.
4. Schlug ein Lauf fehl, bleibt es beim Entwurf: Entwurf löschen, Tag löschen (`git push --delete origin v0.2.0 && git tag -d v0.2.0`), Fehler beheben, neu taggen.

Lizenz: GPL-3.0-or-later (`LICENSE`), passend zum mitgelieferten libx264-ffmpeg. `frontend/.env.production` (im Git, Ausnahme in `.gitignore`) schaltet Source-Maps im Build ab.

## Bekannte Baustellen

- Editor-Tempo: Video- und Ton-Abschnitte haben `speed` (0,25–4, `SPEEDS` in `editor/project.js`), Timeline-Länge = (srcEnd − srcStart) / speed (`segLen`). Gerendert mit `setpts=(PTS-STARTPTS)/speed` und einer `atempo`-Kette (je Glied 0,5–2), in `edit.rs` und `EditRenderer.scala` gleich.
- Editor-Renderer gibt es doppelt: `EditRenderer.scala` (Web) und `src-tauri/src/edit.rs` (Desktop). Änderungen am Filtergraph in beiden machen; neue ffmpeg-Filter auch in `scripts/build-ffmpeg.sh` freischalten. Der Editor hat noch eigene Presets (`src/presets.js`) statt `lib/presets.js`.
- Windows-Build läuft (November 2026, Node 26, Rust 1.99, VS Build Tools 2022, AMF getestet). H.264/HEVC/AV1 über AMF getestet. Ungetestet: NVENC/Quick Sync mit dem mitgelieferten ffmpeg, die Desktop-Teile des Einstellungsmenüs per Klick (nur im Browser angesehen).
- Windows-Build-Umgebung: `winget install` von `OpenJS.NodeJS.LTS`, `Rustlang.Rustup`, `Microsoft.VisualStudio.2022.BuildTools` (Workload VCTools), `MSYS2.MSYS2` (für ffmpeg). Ein Terminal, das vor der Installation offen war, kennt `npm` nicht.
- Unter Windows aus Claudes Shell gestartete Installer landen in `AppData\Local\Packages\Claude_…\LocalCache` (MSIX-Umleitung), nicht in Florians echtem AppData. Installer daher von Florian per Doppelklick starten lassen.
- Im Linux-Container gibt es kein VideoToolbox; der Server kann nur NVENC oder CPU.
- Die Web-Version kennt die Bildrate der Quelle nicht und sendet die Preset-fps unverändert.
- `backend/test/resources/testVideo.mp4` (63 MB) liegt im Git-Repo.
- `backend/build.sc` (Mill) und `.g8/` sind Überbleibsel; gebaut wird mit sbt.

## Konventionen

- UI-Texte und Fehlermeldungen auf **Englisch** (seit November 2026, Wunsch von Florian), Satzanfang groß, keine Großbuchstaben-Labels. Kommentare, Commit-Nachrichten und CLAUDE.md bleiben deutsch.
- Fehlermeldungen sagen, was zu tun ist (z. B. `brew install ffmpeg`).
- Zeiten: Frontend und Rust in Sekunden, Web-API in Millisekunden. Bitraten immer in kbit/s.
- Backend loggt mit `println` und Präfixen wie `[PROCESS]`, `[FFMPEG]`.
