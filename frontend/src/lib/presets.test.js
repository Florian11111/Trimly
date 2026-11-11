import {
  DEFAULT_QUALITY,
  estimateBytes,
  findPreset,
  resolveQuality,
  resolveSizeTarget,
  resolveTarget,
  sourceVideoKbps,
} from "./presets";

const landscape = { width: 2560, height: 1440, fps: 60, duration: 20, size: 60_000_000 };
const portrait = { width: 1080, height: 1920, fps: 30, duration: 10, size: 20_000_000 };
const MiB = 1024 * 1024;

describe("resolveTarget", () => {
  test("scales down to the preset height and keeps the aspect ratio", () => {
    expect(resolveTarget(findPreset("medium"), {}, landscape)).toEqual({
      copy: false,
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2500,
      audioBitrate: 128,
      capped: false,
    });
  });

  test("never upscales a small source", () => {
    const small = { width: 640, height: 360, fps: 30 };
    const t = resolveTarget(findPreset("high"), {}, small);
    expect([t.width, t.height]).toEqual([640, 360]);
  });

  test("treats the preset height as the short side for portrait video", () => {
    const t = resolveTarget(findPreset("medium"), {}, portrait);
    expect([t.width, t.height]).toEqual([720, 1280]);
  });

  test("rounds to even dimensions for H.264", () => {
    const odd = { width: 1918, height: 1078, fps: 30 };
    const t = resolveTarget(findPreset("small"), {}, odd);
    expect(t.width % 2).toBe(0);
    expect(t.height % 2).toBe(0);
  });

  test("does not raise the frame rate above the source", () => {
    expect(resolveTarget(findPreset("high"), {}, portrait).fps).toBe(30);
  });

  test("uses the preset frame rate when the source rate is unknown (web)", () => {
    expect(resolveTarget(findPreset("high"), {}, { width: 1920, height: 1080 }).fps).toBe(60);
  });

  test("custom with height 0 keeps the original resolution", () => {
    const t = resolveTarget(findPreset("custom"), { height: 0, fps: "24", bitrate: "8000" }, landscape);
    expect(t).toEqual({ copy: false, width: 2560, height: 1440, fps: 24, bitrate: 8000, audioBitrate: 128, capped: false });
  });

  test("never raises the bitrate above the source", () => {
    const lecture = { width: 1280, height: 720, fps: 25, videoKbps: 103 };
    const t = resolveTarget(findPreset("medium"), {}, lecture);
    expect(t.bitrate).toBe(103);
    expect(t.capped).toBe(true);
  });

  test("never raises the audio bitrate above the source", () => {
    const lecture = { width: 1280, height: 720, fps: 25, videoKbps: 103, audioKbps: 65 };
    expect(resolveTarget(findPreset("medium"), {}, lecture).audioBitrate).toBe(65);
    expect(resolveTarget(findPreset("medium"), {}, { ...lecture, audioKbps: 320 }).audioBitrate).toBe(128);
  });

  test("keeps the preset bitrate when the source is richer", () => {
    const t = resolveTarget(findPreset("medium"), {}, { ...landscape, videoKbps: 26000 });
    expect(t).toMatchObject({ bitrate: 2500, capped: false });
  });

  test("HEVC and AV1 presets need less bitrate, custom values stay as typed", () => {
    expect(resolveTarget(findPreset("medium"), {}, landscape, "hevc").bitrate).toBe(1750);
    expect(resolveTarget(findPreset("medium"), {}, landscape, "av1").bitrate).toBe(1500);
    const custom = resolveTarget(findPreset("custom"), { height: 720, fps: 30, bitrate: 3000 }, landscape, "av1");
    expect(custom.bitrate).toBe(3000);
  });
});

describe("resolveQuality", () => {
  test("original mode only cuts", () => {
    expect(resolveQuality({ ...DEFAULT_QUALITY, mode: "original" }, landscape, 5)).toEqual({ copy: true });
  });

  test("compress mode uses the chosen preset", () => {
    expect(resolveQuality(DEFAULT_QUALITY, landscape, 5)).toMatchObject({ height: 720, bitrate: 2500 });
  });
});

describe("resolveSizeTarget", () => {
  test("fits the clip into the target size including audio", () => {
    const t = resolveSizeTarget(25, 20, landscape);
    const bytes = estimateBytes(t, 20, landscape);
    expect(bytes).toBeLessThanOrEqual(25 * MiB);
    expect(bytes).toBeGreaterThan(22 * MiB);
    expect(t.tooSmall).toBe(false);
  });

  test("picks a resolution that suits the bitrate", () => {
    // 10 MB in 60 s ≈ 1,2 Mbit/s → 480p
    expect(resolveSizeTarget(10, 60, landscape).height).toBe(480);
    // 100 MB in 20 s ≈ 39 Mbit/s → volle 1440p mit 60 fps
    expect(resolveSizeTarget(100, 20, landscape)).toMatchObject({ height: 1440, fps: 60 });
  });

  test("efficient codecs reach a higher resolution for the same size", () => {
    const h264 = resolveSizeTarget(10, 30, landscape, "both", "h264").height;
    const av1 = resolveSizeTarget(10, 30, landscape, "both", "av1").height;
    expect(av1).toBeGreaterThan(h264);
  });

  test("video without sound gets the whole budget", () => {
    expect(resolveSizeTarget(10, 30, landscape, "video").bitrate).toBeGreaterThan(
      resolveSizeTarget(10, 30, landscape, "both").bitrate
    );
  });

  test("flags a size that is too small for the clip", () => {
    expect(resolveSizeTarget(1, 600, landscape).tooSmall).toBe(true);
  });

  test("never goes above the source bitrate", () => {
    const lecture = { width: 1280, height: 720, fps: 25, videoKbps: 300 };
    expect(resolveSizeTarget(100, 10, lecture)).toMatchObject({ bitrate: 300, capped: true });
  });
});

describe("estimateBytes", () => {
  test("uses video plus audio bitrate for encoded output", () => {
    const target = { copy: false, bitrate: 2500 };
    // (2500 + 128) kbit/s * 8 s / 8 = 2 628 000 Bytes
    expect(estimateBytes(target, 8, landscape)).toBe(2_628_000);
  });

  test("leaves out the audio for video-only and uses MP3 bitrate for audio-only", () => {
    const target = { copy: false, bitrate: 2500, audioBitrate: 128 };
    expect(estimateBytes(target, 8, landscape, "video")).toBe(2_500_000);
    expect(estimateBytes(target, 8, landscape, "audio")).toBe(192_000);
  });

  test("scales the original size for copy mode", () => {
    expect(estimateBytes({ copy: true }, 5, landscape)).toBe(15_000_000);
  });

  test("is zero for an empty clip", () => {
    expect(estimateBytes({ copy: false, bitrate: 2500 }, 0, landscape)).toBe(0);
  });
});

test("unknown preset ids fall back to medium", () => {
  expect(findPreset("nope").id).toBe("medium");
});

test("sourceVideoKbps prefers ffprobe and otherwise estimates from size", () => {
  expect(sourceVideoKbps({ videoKbps: 103 }, 1, 1)).toBe(103);
  // 113 MB in 5448 s ≈ 174 kbit/s gesamt, minus 128 kbit/s Ton
  expect(sourceVideoKbps(null, 118_506_018, 5448)).toBe(46);
  expect(sourceVideoKbps(null, 0, 0)).toBe(0);
});
