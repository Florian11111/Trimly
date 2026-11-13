import { useCallback, useEffect, useRef, useState } from "react";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Undo/redo for a state made of several values.
 * Changes only become a step after `delay` ms of quiet, so dragging a handle
 * doesn't create hundreds of entries. `apply(snapshot)` restores all values.
 * `rebase(next)`: `next` (object or function of the current state) becomes the new starting point,
 * and the history starts over (new video, metadata loaded).
 */
export function useUndo(state, apply, delay = 500) {
  const committed = useRef(state);
  const current = useRef(state);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const applying = useRef(false);
  const timer = useRef(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  current.current = state;

  const key = JSON.stringify(state);
  useEffect(() => {
    clearTimeout(timer.current);
    if (applying.current) {
      applying.current = false;
      bump();
      return undefined;
    }
    bump(); // "Undo" is possible right away, even before the delay is over
    timer.current = setTimeout(() => {
      if (same(current.current, committed.current)) return;
      undoStack.current.push(committed.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      committed.current = current.current;
      bump();
    }, delay);
    return () => clearTimeout(timer.current);
  }, [key, delay]);

  const go = useCallback(
    (target) => {
      clearTimeout(timer.current);
      applying.current = true;
      committed.current = target;
      apply(target);
      bump();
    },
    [apply]
  );

  const undo = useCallback(() => {
    if (!same(current.current, committed.current)) {
      // change not yet recorded: back to the last state
      redoStack.current.push(current.current);
      go(committed.current);
    } else if (undoStack.current.length) {
      redoStack.current.push(committed.current);
      go(undoStack.current.pop());
    }
  }, [go]);

  const redo = useCallback(() => {
    if (!redoStack.current.length) return;
    undoStack.current.push(current.current);
    go(redoStack.current.pop());
  }, [go]);

  const rebase = useCallback((next) => {
    clearTimeout(timer.current);
    undoStack.current = [];
    redoStack.current = [];
    committed.current = typeof next === "function" ? next(current.current) : next;
    bump();
  }, []);

  return {
    undo,
    redo,
    rebase,
    canUndo: undoStack.current.length > 0 || !same(state, committed.current),
    canRedo: redoStack.current.length > 0,
  };
}
