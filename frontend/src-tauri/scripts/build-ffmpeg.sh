#!/usr/bin/env bash
# Baut ein schlankes, statisch gelinktes ffmpeg + ffprobe, das Trimly mitliefert.
# Nur was Trimly braucht: H.264-Encoder (libx264, NVENC, Quick Sync, AMF, VideoToolbox),
# AAC/MP3, MP4/MOV/MKV/WebM/AVI lesen, MP4/MOV/MP3 schreiben.
#
# Windows: in MSYS2 (UCRT64) ausführen, vorher einmal:
#   pacman -S --needed make diffutils git mingw-w64-ucrt-x86_64-{gcc,nasm,pkgconf,x264,lame,dav1d,amf-headers,ffnvcodec-headers,libvpl}
# macOS (ungetestet): brew install nasm pkg-config x264 lame dav1d
#
# Ergebnis: ../binaries/ffmpeg-<target-triple>[.exe] und ffprobe-…, wie Tauri es für externalBin erwartet.
# Achtung: Mit libx264 ist das Ergebnis GPL-lizenziert (siehe binaries/README.md).
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-9.0.2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../binaries"
WORK="${WORK:-$HERE/../target/ffmpeg-build}"
mkdir -p "$OUT" "$WORK"

case "$(uname -s)" in
  MINGW*|MSYS*) TRIPLE="x86_64-pc-windows-msvc"; EXE=".exe"; OS=windows ;;
  Darwin)       TRIPLE="$(uname -m | sed 's/arm64/aarch64/')-apple-darwin"; EXE=""; OS=macos ;;
  *) echo "Nicht unterstütztes System: $(uname -s)"; exit 1 ;;
esac

SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
if [ ! -d "$SRC" ]; then
  echo "Lade ffmpeg $FFMPEG_VERSION …"
  # ffmpeg.org ist manchmal sehr langsam (Release v0.2.0 brach mit curl-Timeout ab),
  # darum mehrere Versuche und danach der offizielle Spiegel auf GitHub (gleicher Quelltext)
  FETCH=(curl -fsSL --retry 4 --retry-all-errors --connect-timeout 30 --max-time 600)
  if "${FETCH[@]}" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$WORK/ffmpeg.tar"; then
    echo "  von ffmpeg.org"
  else
    echo "  ffmpeg.org nicht erreichbar, nehme github.com/FFmpeg/FFmpeg"
    "${FETCH[@]}" "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$FFMPEG_VERSION.tar.gz" -o "$WORK/ffmpeg.tar"
  fi
  # beide Archive haben genau einen obersten Ordner (anders benannt)
  mkdir -p "$SRC"
  tar -xf "$WORK/ffmpeg.tar" -C "$SRC" --strip-components=1
fi

# wrapped_avframe/rawvideo: für den Encoder-Test mit -f lavfi color=…
DECODERS="wrapped_avframe,rawvideo,h264,hevc,vp8,vp9,libdav1d,mpeg4,mpeg2video,mpeg1video,mjpeg,prores,h263,wmv3,vc1,\
png,aac,aac_latm,mp3,mp3float,mp2,opus,vorbis,ac3,eac3,flac,alac,wmav2,\
pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_u8,pcm_alaw,pcm_mulaw"
ENCODERS="libx264,aac,libmp3lame,rawvideo,wrapped_avframe,pcm_s16le"
# image2/png_pipe: Overlays des Editors (-loop 1 -i overlay_0.png)
DEMUXERS="mov,matroska,avi,mpegts,mpegps,mp3,aac,wav,flac,ogg,flv,asf,h264,hevc,m4v,lavfi,image2,png_pipe"
MUXERS="mp4,mov,ipod,mp3,null,matroska,webm"
PARSERS="h264,hevc,aac,aac_latm,mpegaudio,mpeg4video,mpegvideo,vp8,vp9,av1,opus,vorbis,ac3,flac,mjpeg"
BSFS="h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe,av1_frame_split,null"
# Zweite Zeile: Editor (src/edit.rs)
FILTERS="scale,fps,volume,aresample,aformat,format,null,anull,setpts,asetpts,trim,atrim,color,anullsrc,copy,acopy,\
pad,setsar,concat,zoompan,overlay,adelay,amix,atempo"

EXTRA=()
if [ "$OS" = windows ]; then
  # H.264, HEVC und AV1 je Hersteller; ob die Karte es kann, prüft Trimly per Test-Encode
  ENCODERS="$ENCODERS,h264_nvenc,h264_qsv,h264_amf,hevc_nvenc,hevc_qsv,hevc_amf,av1_nvenc,av1_qsv,av1_amf"
  EXTRA+=(--enable-ffnvcodec --enable-nvenc --enable-cuda --enable-libvpl --enable-amf --enable-d3d11va --enable-dxva2
          --extra-ldflags=-static --pkg-config-flags=--static
          # Statisch fehlen sonst Abhängigkeiten: libvpl ist C++, MSYS2-lame nutzt mpg123
          "--extra-libs=-lstdc++ -lmpg123 -lshlwapi")
else
  ENCODERS="$ENCODERS,h264_videotoolbox,hevc_videotoolbox"
  EXTRA+=(--enable-videotoolbox --enable-audiotoolbox)
fi

cd "$SRC"
make distclean >/dev/null 2>&1 || true
./configure \
  --prefix="$WORK/install" \
  --enable-gpl --enable-version3 \
  --disable-everything --disable-autodetect --disable-doc --disable-debug \
  --disable-ffplay --disable-network --disable-shared --enable-static \
  --enable-ffmpeg --enable-ffprobe \
  --enable-libx264 --enable-libmp3lame --enable-libdav1d --enable-zlib \
  --enable-protocol=file,pipe \
  --enable-indev=lavfi \
  --enable-decoder="$DECODERS" \
  --enable-encoder="$ENCODERS" \
  --enable-demuxer="$DEMUXERS" \
  --enable-muxer="$MUXERS" \
  --enable-parser="$PARSERS" \
  --enable-bsf="$BSFS" \
  --enable-filter="$FILTERS" \
  "${EXTRA[@]}"

make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
strip "ffmpeg$EXE" "ffprobe$EXE"
cp "ffmpeg$EXE" "$OUT/ffmpeg-$TRIPLE$EXE"
cp "ffprobe$EXE" "$OUT/ffprobe-$TRIPLE$EXE"
ls -lh "$OUT"
