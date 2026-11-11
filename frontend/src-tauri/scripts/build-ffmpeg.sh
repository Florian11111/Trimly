#!/usr/bin/env bash
# Baut ein schlankes, statisch gelinktes ffmpeg + ffprobe, das Trimly mitliefert.
# Nur was Trimly braucht: H.264-Encoder (libx264, NVENC, Quick Sync, AMF, VideoToolbox),
# AAC/MP3, MP4/MOV/MKV/WebM/AVI lesen, MP4/MOV/MP3 schreiben.
#
# Windows: in MSYS2 (UCRT64) ausführen, vorher einmal:
#   pacman -S --needed make diffutils git mingw-w64-ucrt-x86_64-{gcc,nasm,pkgconf,x264,lame,dav1d,amf-headers,ffnvcodec-headers,libvpl}
# macOS: brew install nasm pkgconf meson ninja x264 lame mpg123   (dav1d baut das Skript selbst statisch)
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
# Zweite Zeile: Kameras und Schnittprogramme (ProRes, DNxHD, DV), alte Handys (H.263, AMR)
DECODERS="wrapped_avframe,rawvideo,h264,hevc,vp8,vp9,libdav1d,mpeg4,mpeg2video,mpeg1video,mjpeg,h263,wmv3,vc1,theora,\
prores,dnxhd,dvvideo,amrnb,amrwb,\
png,aac,aac_latm,mp3,mp3float,mp2,opus,vorbis,ac3,eac3,dca,truehd,flac,alac,wmav2,\
pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_s32be,pcm_f32be,pcm_u8,pcm_alaw,pcm_mulaw"
ENCODERS="libx264,aac,libmp3lame,rawvideo,wrapped_avframe,pcm_s16le"
# image2/png_pipe: Overlays des Editors (-loop 1 -i overlay_0.png)
DEMUXERS="mov,matroska,avi,mpegts,mpegps,mp3,aac,wav,flac,ogg,flv,asf,h264,hevc,m4v,lavfi,image2,png_pipe"
MUXERS="mp4,mov,ipod,mp3,null,matroska,webm"
PARSERS="h264,hevc,aac,aac_latm,mpegaudio,mpeg4video,mpegvideo,vp8,vp9,av1,opus,vorbis,ac3,dca,mlp,flac,mjpeg,dvd_nav"
BSFS="h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe,av1_frame_split,null"
# Zweite Zeile: Editor (src/edit.rs). Dritte: automatisches Drehen von Hochkant-Handyvideos
# (ffmpeg setzt sie selbst ein, ohne sie bricht der Export bei solchen Videos ab)
FILTERS="scale,fps,volume,aresample,aformat,format,null,anull,setpts,asetpts,trim,atrim,color,anullsrc,copy,acopy,\
pad,setsar,concat,zoompan,overlay,adelay,amix,atempo,crop,\
transpose,hflip,vflip,rotate"

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
  # Gleiche Mindestversion wie die App (tauri.conf.json → macOS.minimumSystemVersion)
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

  # Statisch linken geht auf dem Mac nur über Umwege: ld nimmt immer die .dylib, wenn sie im
  # selben Ordner wie die .a liegt, und Homebrew hat dav1d nur dynamisch. Darum ein eigener
  # Ordner nur mit .a-Dateien; sonst hinge das fertige ffmpeg von /opt/homebrew ab.
  DEPS="$WORK/deps-static"
  rm -rf "$DEPS"
  mkdir -p "$DEPS/lib/pkgconfig" "$DEPS/include"
  # mpg123: Homebrew-lame dekodiert damit (wie unter MSYS2), statisch muss es mit dazu
  for p in x264 lame mpg123; do
    pre="$(brew --prefix "$p")"
    cp "$pre"/lib/*.a "$DEPS/lib/"
    cp -R "$pre/include/." "$DEPS/include/"
  done
  # x264.pc mit neuem Pfad; ohne X264_API_IMPORTS (das ist nur für DLLs gedacht)
  sed -e "s|^prefix=.*|prefix=$DEPS|" -e "s| -DX264_API_IMPORTS||" \
    "$(brew --prefix x264)/lib/pkgconfig/x264.pc" > "$DEPS/lib/pkgconfig/x264.pc"

  DAV1D_VERSION="${DAV1D_VERSION:-1.5.1}"
  DAV1D_SRC="$WORK/dav1d-$DAV1D_VERSION"
  if [ ! -d "$DAV1D_SRC" ]; then
    echo "Lade dav1d $DAV1D_VERSION …"
    FETCH=(curl -fsSL --retry 4 --retry-all-errors --connect-timeout 30 --max-time 300)
    "${FETCH[@]}" "https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.xz" -o "$WORK/dav1d.tar" \
      || "${FETCH[@]}" "https://github.com/videolan/dav1d/archive/refs/tags/$DAV1D_VERSION.tar.gz" -o "$WORK/dav1d.tar"
    mkdir -p "$DAV1D_SRC"
    tar -xf "$WORK/dav1d.tar" -C "$DAV1D_SRC" --strip-components=1
  fi
  rm -rf "$DAV1D_SRC/build"
  meson setup "$DAV1D_SRC/build" "$DAV1D_SRC" --buildtype=release --default-library=static \
    --prefix="$DEPS" --libdir=lib -Denable_tools=false -Denable_tests=false -Denable_examples=false
  ninja -C "$DAV1D_SRC/build" install

  export PKG_CONFIG_PATH="$DEPS/lib/pkgconfig"
  EXTRA+=(--enable-videotoolbox --enable-audiotoolbox
          --pkg-config-flags=--static
          "--extra-cflags=-I$DEPS/include -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
          "--extra-ldflags=-L$DEPS/lib -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
          "--extra-libs=-lmpg123")
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
