# Mitgeliefertes ffmpeg

Hier legt `scripts/build-ffmpeg.sh` ein schlankes, statisch gelinktes `ffmpeg` und `ffprobe` ab
(`ffmpeg-x86_64-pc-windows-msvc.exe` usw.). Tauri packt sie als `externalBin` in den Installer
(nur Windows, siehe `tauri.windows.conf.json`); Trimly findet sie neben `trimly.exe`.

Die Programme sind nicht im Git, weil sie erzeugt werden. Vor dem ersten Windows-Build einmal in
der MSYS2-Shell „UCRT64“ ausführen:

```bash
cd frontend/src-tauri && bash scripts/build-ffmpeg.sh
```

## Lizenz

ffmpeg wird mit libx264 gebaut und steht damit unter der GPL (Version 3 wegen `--enable-version3`).
Trimly ruft es nur als eigenständiges Programm auf. Wer den Installer weitergibt, muss auf den
ffmpeg-Quellcode verweisen: https://ffmpeg.org/releases/ (Version im Build-Skript) und das
Build-Skript selbst.
