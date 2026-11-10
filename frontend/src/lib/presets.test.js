import { estimateBytes, findPreset, presetsFor, resolveTarget, sourceVideoKbps } from "./presets";

const landscape = { width: 2560, height: 1440, fps: 60, duration: 20, size: 60_000_000 };
const portrait = { width: 1080, height: 1920, fps: 30, duration: 10, size: 20_000_000 };

describe("resolveTarget", () => {
  test("scales down to the preset height and keeps the aspect ratio", () => {
    expect(resolveTarget(findPreset("medium"), {}, landscape)).toEqual({
      copy: false,
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 2500,
      audioBitrate: 160,
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
    expect(t).toEqual({ copy: false, width: 2560, height: 1440, fps: 24, bitrate: 8000, audioBitrate: 160, capped: false });
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
  });

  test("keeps the preset bitrate when the source is richer", () => {
    const t = resolveTarget(findPreset("medium"), {}, { ...landscape, videoKbps: 26000 });
    expect(t).toMatchObject({ bitrate: 2500, capped: false });
  });

  test("copy preset needs no encoding settings", () => {
    expect(resolveTarget(findPreset("copy"), {}, landscape)).toEqual({ copy: true });
  });
});

describe("estimateBytes", () => {
  test("uses video plus audio bitrate for encoded output", () => {
    const target = { copy: false, bitrate: 2500 };
    // (2500 + 160) kbit/s * 8 s / 8 = 2 660 000 Bytes
    expect(estimateBytes(target, 8, landscape)).toBe(2_660_000);
  });

  test("scales the original size for copy mode", () => {
    expect(estimateBytes({ copy: true }, 5, landscape)).toBe(15_000_000);
  });

  test("is zero for an empty clip", () => {
    expect(estimateBytes({ copy: false, bitrate: 2500 }, 0, landscape)).toBe(0);
  });
});

test("the web version hides desktop-only presets", () => {
  expect(presetsFor(false).map((p) => p.id)).not.toContain("copy");
  expect(presetsFor(true).map((p) => p.id)).toContain("copy");
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
