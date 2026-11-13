import { act, fireEvent, render, screen } from "@testing-library/react";
import Timeline from "./Timeline";

// jsdom has no PointerEvent; without a polyfill clientX is missing
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerId = params.pointerId;
    }
  };
}

// The strip is 1000 px wide and 10 s long: 1 px = 0.01 s
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 64, right: 1000, bottom: 64 });
});

function setup() {
  const onSeek = jest.fn();
  const onRangeChange = jest.fn();
  render(
    <Timeline src="" duration={10} aspect={16 / 9} range={[2, 8]} current={5} onSeek={onSeek} onRangeChange={onRangeChange} />
  );
  return { onSeek, onRangeChange, start: screen.getByRole("slider", { name: "Start" }) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a short click on a handle jumps there instead of moving it", () => {
  const { onSeek, onRangeChange, start } = setup();
  fireEvent.pointerDown(start, { button: 0, clientX: 200, pointerId: 1 });
  fireEvent.pointerMove(screen.getByTestId("timeline"), { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(screen.getByTestId("timeline"), { pointerId: 1 });

  expect(onRangeChange).not.toHaveBeenCalled();
  expect(onSeek).toHaveBeenCalledWith(2);
});

test("holding a handle makes it draggable", () => {
  const { onSeek, onRangeChange, start } = setup();
  fireEvent.pointerDown(start, { button: 0, clientX: 200, pointerId: 1 });
  act(() => jest.advanceTimersByTime(250));
  fireEvent.pointerMove(screen.getByTestId("timeline"), { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(screen.getByTestId("timeline"), { pointerId: 1 });

  expect(onRangeChange).toHaveBeenLastCalledWith([4, 8]);
  expect(onSeek).not.toHaveBeenCalled();
});

test("clicking the strip seeks, shift-click sets the start", () => {
  const { onSeek, onRangeChange } = setup();
  const track = screen.getByTestId("timeline");
  fireEvent.pointerDown(track, { button: 0, clientX: 300, pointerId: 1 });
  fireEvent.pointerUp(track, { pointerId: 1 });
  expect(onSeek).toHaveBeenCalledWith(3);

  fireEvent.pointerDown(track, { button: 0, clientX: 100, shiftKey: true, pointerId: 2 });
  expect(onRangeChange).toHaveBeenCalledWith([1, 8]);
});

test("arrow keys move a focused handle by 0.1 s", () => {
  const { onRangeChange, start } = setup();
  fireEvent.keyDown(start, { key: "ArrowRight" });
  expect(onRangeChange).toHaveBeenCalledWith([2.1, 8]);
});
