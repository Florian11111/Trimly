#!/usr/bin/env bash
# Builds a slim, statically linked ffmpeg + ffprobe that ships with Trimly.
# Only what Trimly needs: H.264 encoders (libx264, NVENC, Quick Sync, AMF, VideoToolbox),
# AAC/MP3, reading MP4/MOV/MKV/WebM/AVI, writing MP4/MOV/MP3.
#
# Windows: run in MSYS2 (UCRT64), once beforehand:
#   pacman -S --needed make diffutils git mingw-w64-ucrt-x86_64-{gcc,nasm,pkgconf,x264,lame,dav1d,amf-headers,ffnvcodec-headers,libvpl}
# macOS: brew install nasm pkgconf meson ninja x264 lame mpg123   (the script builds dav1d statically itself)
#
# Result: ../binaries/ffmpeg-<target-triple>[.exe] and ffprobe-…, as Tauri expects for externalBin.
# Note: with libx264 the result is GPL-licensed (see binaries/README.md).
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-9.0.2}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../binaries"
WORK="${WORK:-$HERE/../target/ffmpeg-build}"
mkdir -p "$OUT" "$WORK"

case "$(uname -s)" in
  MINGW*|MSYS*) TRIPLE="x86_64-pc-windows-msvc"; EXE=".exe"; OS=windows ;;
  Darwin)       TRIPLE="$(uname -m | sed 's/arm64/aarch64/')-apple-darwin"; EXE=""; OS=macos ;;
  *) echo "Unsupported system: $(uname -s)"; exit 1 ;;
esac

SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
if [ ! -d "$SRC" ]; then
  echo "Downloading ffmpeg $FFMPEG_VERSION …"
  # ffmpeg.org is sometimes very slow (release v0.2.0 failed with a curl timeout),
  # so several attempts, then the official mirror on GitHub (same source)
  FETCH=(curl -fsSL --retry 4 --retry-all-errors --connect-timeout 30 --max-time 600)
  if "${FETCH[@]}" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$WORK/ffmpeg.tar"; then
    echo "  from ffmpeg.org"
  else
    echo "  ffmpeg.org not reachable, using github.com/FFmpeg/FFmpeg"
    "${FETCH[@]}" "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$FFMPEG_VERSION.tar.gz" -o "$WORK/ffmpeg.tar"
  fi
  # both archives have exactly one top-level folder (named differently)
  mkdir -p "$SRC"
  tar -xf "$WORK/ffmpeg.tar" -C "$SRC" --strip-components=1
fi

# wrapped_avframe/rawvideo: for the encoder test with -f lavfi color=…
# Second line: cameras and editing software (ProRes, DNxHD, DV), old phones (H.263, AMR)
DECODERS="wrapped_avframe,rawvideo,h264,hevc,vp8,vp9,libdav1d,mpeg4,mpeg2video,mpeg1video,mjpeg,h263,wmv3,vc1,theora,\
prores,dnxhd,dvvideo,amrnb,amrwb,\
png,aac,aac_latm,mp3,mp3float,mp2,opus,vorbis,ac3,eac3,dca,truehd,flac,alac,wmav2,\
pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_s32be,pcm_f32be,pcm_u8,pcm_alaw,pcm_mulaw"
ENCODERS="libx264,aac,libmp3lame,rawvideo,wrapped_avframe,pcm_s16le"
# image2/png_pipe: editor overlays (-loop 1 -i overlay_0.png)
DEMUXERS="mov,matroska,avi,mpegts,mpegps,mp3,aac,wav,flac,ogg,flv,asf,h264,hevc,m4v,lavfi,image2,png_pipe"
MUXERS="mp4,mov,ipod,mp3,null,matroska,webm"
PARSERS="h264,hevc,aac,aac_latm,mpegaudio,mpeg4video,mpegvideo,vp8,vp9,av1,opus,vorbis,ac3,dca,mlp,flac,mjpeg,dvd_nav"
BSFS="h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe,av1_frame_split,null"
# Second line: editor (src/edit.rs). Third: automatic rotation of portrait phone videos
# (ffmpeg inserts them itself; without them, exporting such videos fails)
FILTERS="scale,fps,volume,aresample,aformat,format,null,anull,setpts,asetpts,trim,atrim,color,anullsrc,copy,acopy,\
pad,setsar,concat,zoompan,overlay,adelay,amix,atempo,crop,\
transpose,hflip,vflip,rotate"

EXTRA=()
if [ "$OS" = windows ]; then
  # H.264, HEVC and AV1 per vendor; Trimly checks with a test encode whether the card can do it
  ENCODERS="$ENCODERS,h264_nvenc,h264_qsv,h264_amf,hevc_nvenc,hevc_qsv,hevc_amf,av1_nvenc,av1_qsv,av1_amf"
  EXTRA+=(--enable-ffnvcodec --enable-nvenc --enable-cuda --enable-libvpl --enable-amf --enable-d3d11va --enable-dxva2
          --extra-ldflags=-static --pkg-config-flags=--static
          # Otherwise static linking misses dependencies: libvpl is C++, MSYS2 lame uses mpg123
          "--extra-libs=-lstdc++ -lmpg123 -lshlwapi")
else
  ENCODERS="$ENCODERS,h264_videotoolbox,hevc_videotoolbox"
  # Same minimum version as the app (tauri.conf.json → macOS.minimumSystemVersion)
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

  # Static linking on the Mac needs a detour: ld always picks the .dylib if it sits in the
  # same folder as the .a, and Homebrew only has dav1d as a shared library. Hence a separate
  # folder with only .a files; otherwise the finished ffmpeg would depend on /opt/homebrew.
  DEPS="$WORK/deps-static"
  rm -rf "$DEPS"
  mkdir -p "$DEPS/lib/pkgconfig" "$DEPS/include"
  # mpg123: Homebrew lame decodes with it (as on MSYS2), so it must be linked statically too
  for p in x264 lame mpg123; do
    pre="$(brew --prefix "$p")"
    cp "$pre"/lib/*.a "$DEPS/lib/"
    cp -R "$pre/include/." "$DEPS/include/"
  done
  # x264.pc with the new path; without X264_API_IMPORTS (that is only meant for DLLs)
  sed -e "s|^prefix=.*|prefix=$DEPS|" -e "s| -DX264_API_IMPORTS||" \
    "$(brew --prefix x264)/lib/pkgconfig/x264.pc" > "$DEPS/lib/pkgconfig/x264.pc"

  DAV1D_VERSION="${DAV1D_VERSION:-1.5.1}"
  DAV1D_SRC="$WORK/dav1d-$DAV1D_VERSION"
  if [ ! -d "$DAV1D_SRC" ]; then
    echo "Downloading dav1d $DAV1D_VERSION …"
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
