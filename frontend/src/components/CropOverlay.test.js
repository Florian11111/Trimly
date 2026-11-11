import { dragCrop } from "./CropOverlay";

const full = { x: 0, y: 0, w: 1, h: 1 };

test("corner and edge handles resize freely in any format", () => {
  expect(dragCrop(full, "se", -0.5, -0.25)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.75 });
  expect(dragCrop(full, "w", 0.3, 0.9)).toEqual({ x: 0.3, y: 0, w: 0.7, h: 1 });
  expect(dragCrop(full, "n", 0.1, 0.2)).toEqual({ x: 0, y: 0.2, w: 1, h: 0.8 });
});

test("moving keeps the size and stays inside the picture", () => {
  const box = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
  expect(dragCrop(box, "move", 0.9, -0.9)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
});

test("the box never gets smaller than 5 %", () => {
  const r = dragCrop(full, "e", -2, 0);
  expect(r.w).toBeCloseTo(0.05);
  const l = dragCrop(full, "nw", 2, 2);
  expect(l.w).toBeCloseTo(0.05);
  expect(l.h).toBeCloseTo(0.05);
  expect(l.x).toBeCloseTo(0.95);
});
