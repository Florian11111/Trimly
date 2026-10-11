import * as P from './project';
import { zoomAt } from './overlays';

const base = () => P.addClip(P.emptyProject(), 'main', { url: 'blob:a', name: 'a.mp4', duration: 10 });

test('split video at playhead keeps total length', () => {
  const p = P.splitVideoAt(base(), 4);
  expect(p.videoSegs).toHaveLength(2);
  expect(p.videoSegs[0]).toMatchObject({ srcStart: 0, srcEnd: 4 });
  expect(p.videoSegs[1]).toMatchObject({ srcStart: 4, srcEnd: 10 });
  expect(P.totalDuration(p)).toBe(10);
});

test('linked audio follows video cuts, detached audio stays put', () => {
  let p = P.splitVideoAt(base(), 4);
  p = P.removeItem(p, 'video', p.videoSegs[0].id);
  // verbunden: Ton des gelöschten Teils ist ebenfalls weg
  expect(P.effectiveAudio(p)).toEqual([expect.objectContaining({ srcStart: 4, srcEnd: 10, tlStart: 0 })]);

  let d = P.detachAudio(P.splitVideoAt(base(), 4));
  d = P.removeItem(d, 'video', d.videoSegs[0].id);
  // getrennt: Tonspur bleibt komplett erhalten
  expect(P.effectiveAudio(d)).toHaveLength(2);
  expect(P.effectiveAudio(d)[1]).toMatchObject({ srcStart: 4, tlStart: 4 });
});

test('detached audio can be split and moved independently', () => {
  let p = P.detachAudio(base());
  const id = p.audioSegs[0].id;
  p = P.splitAudioAt(p, id, 3);
  expect(p.audioSegs.map(s => [s.srcStart, s.srcEnd, s.tlStart])).toEqual([[0, 3, 0], [3, 10, 3]]);
  const moved = P.dragPatch('audio', 'move', p.audioSegs[1], 2, { clipDuration: 10, total: 10 });
  expect(moved).toEqual({ tlStart: 5 });
  // Video unverändert
  expect(p.videoSegs).toHaveLength(1);
});

test('drag patches respect clip and project bounds', () => {
  const seg = { srcStart: 2, srcEnd: 8 };
  expect(P.dragPatch('video', 'start', seg, -5, { clipDuration: 10 })).toEqual({ srcStart: 0 });
  expect(P.dragPatch('video', 'end', seg, 5, { clipDuration: 10 })).toEqual({ srcEnd: 10 });
  const ov = { start: 7, end: 9 };
  expect(P.dragPatch('overlay', 'move', ov, 5, { total: 10 })).toEqual({ start: 8, end: 10 });
  expect(P.dragPatch('overlay', 'start', ov, 5, { total: 10 }).start).toBeCloseTo(8.9);
});

test('adding a clip appends video and (if detached) audio', () => {
  let p = P.detachAudio(base());
  p = P.addClip(p, 'c2', { url: 'blob:b', name: 'b.mp4', duration: 5 });
  expect(P.totalDuration(p)).toBe(15);
  expect(p.audioSegs[1]).toMatchObject({ clipId: 'c2', tlStart: 10 });
});

test('render project uses server ids and drops items past the end', () => {
  let p = P.addClip(base(), 'c2', { url: 'blob:b', name: 'b.mp4', duration: 5 });
  p = { ...p, overlays: [
    { id: 'o1', type: 'text', start: 1, end: 3 },
    { id: 'o2', type: 'text', start: 20, end: 22 },
  ], zooms: [{ id: 'z1', start: 14, end: 18, x: 0, y: 0, w: 0.5 }] };
  const { body, overlays } = P.buildRenderProject(p, { width: 1280, height: 720, fps: 30, bitrate: 2500 },
    { main: 'srvA', c2: 'srvB' });
  expect(body.video).toEqual([
    { originalId: 'srvA', start: 0, end: 10 },
    { originalId: 'srvB', start: 0, end: 5 },
  ]);
  expect(body.audio[1]).toEqual({ originalId: 'srvB', start: 0, end: 5, at: 10, volume: 1 });
  expect(overlays.map(o => o.id)).toEqual(['o1']);
  expect(body.overlays).toEqual([{ file: 'overlay_0', start: 1, end: 3 }]);
  expect(body.zooms[0].end).toBe(15);
});

test('zoomAt ramps in and out like the backend expression', () => {
  const zooms = [{ start: 1, end: 3, x: 0.5, y: 0.5, w: 0.5 }];
  expect(zoomAt(zooms, 0.5)).toEqual({ z: 1, x: 0, y: 0 });
  const mid = zoomAt(zooms, 2);
  expect(mid.z).toBeCloseTo(2);
  expect(mid.x).toBeCloseTo(0.5);
  expect(mid.y).toBeCloseTo(0.5);
  expect(zoomAt(zooms, 1.15).z).toBeCloseTo(1.5);
});
