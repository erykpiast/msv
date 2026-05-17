'use strict';

// Replay scrubber: arrow-key seeks + two-bar progress region.
//
// The React component is a thin shell over pure reducers (applySeekPure,
// handleToggle) and pure helpers (seekByTime, seekByEvent, classifyKey,
// renderBars, computeDelay). The split exists because ink.useInput and
// ink.useStdout cannot be exercised without a real TTY; isolating the
// state transitions here lets the spec §10.9 test cases exercise the
// load-bearing logic without any ink dependency. Same pattern as
// src/tui/dashboard/reducer.js + App.js.

const React = require('react');
const { getInk } = require('../src/tui/dashboard/inkExports');

const FILLED = '█';
const EMPTY = '░';

const DELTAS = Object.freeze({
  STEP_SEC: 1000,
  STEP_BIG_SEC: 10000,
  STEP_EVENT: 1,
});

// Map an ink key descriptor to a seek directive, or null if the key isn't
// one we handle. Exposed for tests so a synthetic { leftArrow, shift }
// object can be exercised without rendering.
function classifyKey(input, key) {
  if (input === 'q' || (key && key.ctrl && input === 'c')) return { type: 'quit' };
  if (input === ' ') return { type: 'toggle' };
  if (!key) return null;
  const dir = key.rightArrow ? 1 : key.leftArrow ? -1 : 0;
  if (!dir) return null;
  if (key.meta) return { type: 'seek-event', delta: dir * DELTAS.STEP_EVENT };
  if (key.shift) return { type: 'seek-time', delta: dir * DELTAS.STEP_BIG_SEC };
  return { type: 'seek-time', delta: dir * DELTAS.STEP_SEC };
}

// Linear scan; ≤800 events per run per §11.
// Scan starts past currentIndex (not at it) so a press with delta != 0
// cannot return the current position; the spec's §8.15.5 pseudocode starts
// at currentIndex, but that would seek-to-self when the current event is
// exactly at the target ts, making the arrow press feel like a no-op.
function seekByTime(events, currentIndex, deltaMs) {
  if (events.length === 0) return 0;
  const currentTs = events[currentIndex].ts;
  const targetTs = currentTs + deltaMs;
  if (deltaMs > 0) {
    for (let i = currentIndex + 1; i < events.length; i += 1) {
      if (events[i].ts >= targetTs) return i;
    }
    return events.length - 1;
  }
  if (deltaMs < 0) {
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      if (events[i].ts <= targetTs) return i;
    }
    return 0;
  }
  return currentIndex;
}

function seekByEvent(events, currentIndex, deltaEvents) {
  const last = events.length - 1;
  const target = currentIndex + deltaEvents;
  if (target < 0) return 0;
  if (target > last) return last;
  return target;
}

function clampIndex(events, idx) {
  if (events.length === 0) return 0;
  if (idx < 0) return 0;
  if (idx > events.length - 1) return events.length - 1;
  return idx;
}

// Pure seek reducer: given previous index + target, perform the
// reset/refold (backward) or forward emit, and return the new index.
// Side effects are confined to the injected `reset` and `emitOne`
// callbacks so the function is fully testable with spies.
//
// `allowBackward` (default true) controls whether backward seeks are
// honoured. The dashboard mode refolds reducer state — safe to seek
// backward. Log mode writes to stdout — backward seek has no visual
// semantics (can't unprint), so it's clamped to a no-op.
function applySeekPure(events, prevIndex, targetIndex, { reset, emitOne, allowBackward = true }) {
  let next = clampIndex(events, targetIndex);
  if (!allowBackward && next < prevIndex) next = prevIndex;
  if (next < prevIndex) {
    reset();
    for (let i = 0; i <= next; i += 1) emitOne(events[i]);
  } else if (next > prevIndex) {
    for (let i = prevIndex + 1; i <= next; i += 1) emitOne(events[i]);
  }
  return next;
}

// Pure toggle reducer: given current playing-state + cursor position,
// return the new playing-state. The end-of-stream guard lives here so
// "space at last event" is a no-op without scheduler involvement.
function handleToggle({ playing, currentIndex, lastIndex }) {
  if (playing) return { playing: false };
  if (currentIndex >= lastIndex) return { playing: false };
  return { playing: true };
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `t+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Render a single horizontal bar. Filled portion uses U+2588, empty U+2591.
// Width is the number of cells; ratio is clamped to [0, 1].
//
// The bar fill agrees with the displayed percentage label: when the
// rounded percentage is 100 the bar is fully filled; when 0 it is fully
// empty. Without this special-case, ratio=0.997 would round the label
// to 100% while flooring the bar to 99/100 cells (visible mismatch).
function renderBar(width, ratio) {
  if (width <= 0) return '';
  const clamped = Math.max(0, Math.min(1, ratio));
  const pct = Math.round(clamped * 100);
  if (pct >= 100) return FILLED.repeat(width);
  if (pct <= 0) return EMPTY.repeat(width);
  const filled = Math.floor(clamped * width);
  return FILLED.repeat(filled) + EMPTY.repeat(width - filled);
}

// Compose both bars + labels for a given terminal width. Returns
// `{ timeLine, eventLine }` as strings so tests can assert exact contents.
const LABEL_PREFIX_COLS = 7; // ' time  ' / ' event ' — 7 cols per spec §8.15.5
// ' (NNN%)' — 7 cols. Three-digit padding so the suffix width is constant
// across 0%, 50%, and 100%; otherwise the line wraps at 100%.
const PCT_SUFFIX_COLS = 7;
const BAR_BREATHING = 2;     // breathing room between bar and right label
function renderBars({ columns, events, currentIndex }) {
  if (events.length === 0) {
    return { timeLine: '', eventLine: '', timeBarWidth: 0, eventBarWidth: 0 };
  }
  const first = events[0].ts;
  const last = events[events.length - 1].ts;
  const span = Math.max(1, last - first);
  const elapsed = events[currentIndex].ts - first;
  const lastIndex = events.length - 1;

  // Pin endpoints exactly: 0/0 at the start, 1/1 at the end. Both bars
  // MUST agree there even if floating-point math or a one-event corner
  // case would drift one ratio off. Mid-stream the two ratios diverge
  // legitimately (e.g. 40% time vs 52% events) — that asymmetry is what
  // makes both bars informative.
  let timeRatio;
  let eventRatio;
  if (currentIndex <= 0) {
    timeRatio = 0;
    eventRatio = 0;
  } else if (currentIndex >= lastIndex) {
    timeRatio = 1;
    eventRatio = 1;
  } else {
    timeRatio = elapsed / span;
    eventRatio = currentIndex / lastIndex;
  }

  const timeLabel = `${formatTime(elapsed)} / ${formatTime(span)}`;
  const eventLabel = `${currentIndex + 1} / ${events.length} events`;
  const labelWidth = Math.max(timeLabel.length, eventLabel.length);

  const barWidth = Math.max(
    4,
    columns - LABEL_PREFIX_COLS - labelWidth - PCT_SUFFIX_COLS - BAR_BREATHING
  );

  const timeBar = renderBar(barWidth, timeRatio);
  const eventBar = renderBar(barWidth, eventRatio);

  const timePct = ` (${String(Math.round(timeRatio * 100)).padStart(3, ' ')}%)`;
  const eventPct = ` (${String(Math.round(eventRatio * 100)).padStart(3, ' ')}%)`;

  const timeLine = ` time  ${timeBar}  ${timeLabel.padStart(labelWidth)}${timePct}`;
  const eventLine = ` event ${eventBar}  ${eventLabel.padStart(labelWidth)}${eventPct}`;

  return { timeLine, eventLine, timeBarWidth: barWidth, eventBarWidth: barWidth };
}

// Compute the delay until the next scheduled event, in ms, given the
// anchoring (currentIndex, anchorWall) and the next index. Exposed for
// tests so timer math can be asserted without real timers.
function computeDelay(events, anchorIndex, anchorWall, nextIndex, nowMs) {
  if (nextIndex >= events.length) return 0;
  const targetTs = events[nextIndex].ts;
  const anchorTs = events[anchorIndex].ts;
  return Math.max(0, (targetTs - anchorTs) - (nowMs - anchorWall));
}

function useTerminalColumns() {
  const ink = getInk();
  const { useState, useEffect } = React;
  const { stdout } = ink.useStdout();
  const initial = (stdout && stdout.columns) || 120;
  const [columns, setColumns] = useState(initial);
  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = () => setColumns(stdout.columns || initial);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return columns;
}

// React component. Owns autoplay scheduling + key input. Caller passes:
//   events            — full in-memory event array
//   emitOne(env)      — push one envelope into the bus
//   reset()           — clear dashboard reducer state (for backward seeks)
//   onExit()          — invoked on q / Ctrl-C
//   mode              — 'dashboard' (default) or 'log'. In log mode,
//                       backward seeks are ignored because the underlying
//                       output is stdout text that cannot be unprinted.
function Scrubber({ events, emitOne, reset, onExit, mode = 'dashboard' }) {
  const allowBackward = mode === 'dashboard';
  const { useInput, useStdout: _useStdout, Box, Text } = getInk();
  const { useState, useEffect, useRef } = React;

  // Cursor: index of the last event that has been emitted. Starts at 0
  // because replay() in replay.js emits events[0] before mounting. The ref
  // mirrors React state so useInput and the scheduler can read the latest
  // value without depending on the render closure (was a stale-closure
  // hazard in the prior revision — see code review).
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentIndexRef = useRef(0);
  const [playing, setPlaying] = useState(true);
  const timerRef = useRef(null);
  // null until the first startPlayingFrom() runs; scheduleNext guards on it.
  const anchorRef = useRef(null);

  const eventsRef = useRef(events);
  eventsRef.current = events;

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function setIndex(next) {
    currentIndexRef.current = next;
    setCurrentIndex(next);
  }

  function applySeek(targetIndex) {
    const evs = eventsRef.current;
    const next = applySeekPure(evs, currentIndexRef.current, targetIndex, {
      reset,
      emitOne,
      allowBackward,
    });
    setIndex(next);
  }

  function scheduleNext(fromIndex) {
    clearTimer();
    if (!anchorRef.current) return;
    const evs = eventsRef.current;
    const nextIdx = fromIndex + 1;
    if (nextIdx >= evs.length) return;
    const delay = computeDelay(
      evs,
      anchorRef.current.index,
      anchorRef.current.wall,
      nextIdx,
      Date.now()
    );
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const ev = eventsRef.current[nextIdx];
      if (!ev) return;
      emitOne(ev);
      setIndex(nextIdx);
      scheduleNext(nextIdx);
    }, delay);
  }

  function startPlayingFrom(idx) {
    // Re-anchor to now so the scheduler doesn't sprint through the gap
    // between the seek target and wherever the old anchor would have
    // placed the next event.
    anchorRef.current = { index: idx, wall: Date.now() };
    scheduleNext(idx);
  }

  useEffect(() => {
    if (playing) startPlayingFrom(currentIndexRef.current);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useInput((input, key) => {
    const directive = classifyKey(input, key);
    if (!directive) return;
    if (directive.type === 'quit') {
      clearTimer();
      onExit();
      return;
    }
    if (directive.type === 'toggle') {
      clearTimer();
      const { playing: nextPlaying } = handleToggle({
        playing,
        currentIndex: currentIndexRef.current,
        lastIndex: events.length - 1,
      });
      setPlaying(nextPlaying);
      return;
    }
    // Any seek auto-pauses; resume is via `space`.
    if (playing) {
      clearTimer();
      setPlaying(false);
    }
    if (directive.type === 'seek-time') {
      applySeek(seekByTime(events, currentIndexRef.current, directive.delta));
    } else if (directive.type === 'seek-event') {
      applySeek(seekByEvent(events, currentIndexRef.current, directive.delta));
    }
  });

  const columns = useTerminalColumns();
  const { timeLine, eventLine } = renderBars({ columns, events, currentIndex });

  const stateGlyph = playing ? '▸ playing' : '⏸ paused';
  const spaceLabel = playing ? 'space pause' : 'space play';
  // Dashboard shows leftward hints; spec §8.15.5 documents both directions.
  // Log mode swaps to rightward hints because backward seeks are disabled.
  const HINTS_FIXED = allowBackward
    ? '← 1s   ⇧← 10s   ⌥← 1e'
    : '→ 1s   ⇧→ 10s   ⌥→ 1e';
  const hints = `${stateGlyph}    ${HINTS_FIXED}   ${spaceLabel}   q quit`;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, null, timeLine),
    React.createElement(Text, null, eventLine),
    React.createElement(Text, { dimColor: true }, ` ${hints}`)
  );
}

module.exports = {
  Scrubber,
  classifyKey,
  seekByTime,
  seekByEvent,
  clampIndex,
  applySeekPure,
  handleToggle,
  renderBar,
  renderBars,
  computeDelay,
  DELTAS,
  FILLED,
  EMPTY,
};
