# Bundled ffmpeg

`scripts/build-ffmpeg.sh` puts a slim, statically linked `ffmpeg` and `ffprobe` here
(`ffmpeg-x86_64-pc-windows-msvc.exe` etc.). Tauri packs them into the installer as `externalBin`
(Windows and macOS, see `tauri.windows.conf.json` and `tauri.macos.conf.json`); Trimly finds them next to its own executable.

The binaries are not in Git because they are generated. Run this once before the first desktop build
(also before `npm run desktop`): on Windows in the MSYS2 "UCRT64" shell, on the Mac
after `brew install nasm pkgconf meson ninja x264 lame mpg123`:

```bash
cd frontend/src-tauri && bash scripts/build-ffmpeg.sh
```

## License

ffmpeg is built with libx264 and is therefore under the GPL (version 3 because of `--enable-version3`).
Trimly only calls it as a separate program. Anyone who redistributes the installer must point to the
ffmpeg source code: https://ffmpeg.org/releases/ (version in the build script) and the
build script itself.
