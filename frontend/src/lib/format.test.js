import { fileExtension, fileStem, formatBytes, formatTime } from "./format";

test("formatBytes uses English decimals and sensible units", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(63_115_631)).toBe("60.2 MB");
  expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
});

test("formatTime shows minutes, seconds and tenths", () => {
  expect(formatTime(0)).toBe("0:00.0");
  expect(formatTime(5.27)).toBe("0:05.2");
  expect(formatTime(83.25)).toBe("1:23.2");
  expect(formatTime(undefined)).toBe("0:00.0");
});

test("file name helpers", () => {
  expect(fileStem("Clip.final.MOV")).toBe("Clip.final");
  expect(fileExtension("Clip.final.MOV")).toBe("mov");
  expect(fileStem(".hidden")).toBe(".hidden");
  expect(fileExtension("noext")).toBe("");
});

test("exact sizes get two decimals", () => {
  expect(formatBytes(2726297, { exact: true })).toBe("2.60 MB");
  expect(formatBytes(2726297)).toBe("2.6 MB");
  expect(formatBytes(512, { exact: true })).toBe("512 B");
});
