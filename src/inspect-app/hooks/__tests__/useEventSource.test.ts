import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEventSource, type SseHandlers } from '../useEventSource';

// Mirror of the MockEventSource public surface defined in vitest.setup.ts.
// We only declare the bits these tests touch.
type MockEventSourceInstance = {
  url: string;
  readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  open(): void;
  dispatchMessage(type: string, data: string): void;
  dispatchEventNamed(type: string, data: string): void;
  triggerError(): void;
  close(): void;
};

type MockEventSourceCtor = {
  new (url: string): MockEventSourceInstance;
  instances: MockEventSourceInstance[];
  CONNECTING: number;
  OPEN: number;
  CLOSED: number;
};

function getMock(): MockEventSourceCtor {
  return (globalThis as unknown as { EventSource: MockEventSourceCtor }).EventSource;
}

function makeHandlers(overrides: Partial<SseHandlers> = {}): SseHandlers {
  return {
    onView: vi.fn(),
    onEvent: vi.fn(),
    onOpen: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  // Reset per-test instance log so we can assert reconnect-count precisely.
  getMock().instances.length = 0;
});

afterEach(() => {
  // Make sure we always return to real timers even if a test throws after
  // enabling fake timers, otherwise later tests deadlock.
  vi.useRealTimers();
});

describe('useEventSource', () => {
  it('opens an EventSource at the given URL on mount', () => {
    const handlers = makeHandlers();
    renderHook(() => useEventSource('/events/stream', handlers));

    const instances = getMock().instances;
    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe('/events/stream');
  });

  it('calls onView when a "view" named SSE event arrives', () => {
    const onView = vi.fn();
    renderHook(() => useEventSource('/events/stream', makeHandlers({ onView })));

    const es = getMock().instances[0]!;
    act(() => {
      es.dispatchEventNamed('view', JSON.stringify({ canvas: 'pipeline' }));
    });

    expect(onView).toHaveBeenCalledTimes(1);
    expect(onView).toHaveBeenCalledWith({ canvas: 'pipeline' });
  });

  it('calls onEvent when an "event" named SSE event arrives', () => {
    const onEvent = vi.fn();
    renderHook(() => useEventSource('/events/stream', makeHandlers({ onEvent })));

    const es = getMock().instances[0]!;
    act(() => {
      es.dispatchEventNamed('event', JSON.stringify({ name: 'pipeline.stage.start', stage: 'discovery' }));
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ name: 'pipeline.stage.start', stage: 'discovery' });
  });

  it('swallows JSON parse errors from malformed event payloads (does not call handlers)', () => {
    const onView = vi.fn();
    const onEvent = vi.fn();
    renderHook(() => useEventSource('/events/stream', makeHandlers({ onView, onEvent })));

    const es = getMock().instances[0]!;
    expect(() => {
      act(() => {
        es.dispatchEventNamed('view', 'not-json');
        es.dispatchEventNamed('event', '{broken');
      });
    }).not.toThrow();

    expect(onView).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('calls onOpen on connection open', () => {
    const onOpen = vi.fn();
    renderHook(() => useEventSource('/events/stream', makeHandlers({ onOpen })));

    const es = getMock().instances[0]!;
    act(() => {
      es.open();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onError and reconnects after onerror (3-second retry)', () => {
    vi.useFakeTimers();

    const onError = vi.fn();
    renderHook(() => useEventSource('/events/stream', makeHandlers({ onError })));

    const first = getMock().instances[0]!;
    expect(getMock().instances).toHaveLength(1);

    act(() => {
      first.triggerError();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(first.readyState).toBe(getMock().CLOSED);
    // No reconnect has happened yet — the hook waits 3s.
    expect(getMock().instances).toHaveLength(1);

    // Just before the retry window — still one instance.
    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(getMock().instances).toHaveLength(1);

    // Cross the 3s boundary — a second EventSource should be created.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getMock().instances).toHaveLength(2);
    expect(getMock().instances[1]?.url).toBe('/events/stream');
  });

  it('closes the EventSource on unmount', () => {
    const { unmount } = renderHook(() =>
      useEventSource('/events/stream', makeHandlers())
    );

    const es = getMock().instances[0]!;
    expect(es.readyState).toBe(getMock().CONNECTING);

    unmount();

    expect(es.readyState).toBe(getMock().CLOSED);
  });

  it('passes the latest handlers via ref (no reconnect on handler identity change)', () => {
    const onViewA = vi.fn();
    const onViewB = vi.fn();

    const { rerender } = renderHook(
      ({ handlers }: { handlers: SseHandlers }) =>
        useEventSource('/events/stream', handlers),
      { initialProps: { handlers: makeHandlers({ onView: onViewA }) } }
    );

    expect(getMock().instances).toHaveLength(1);
    const es = getMock().instances[0]!;

    // Swap to a brand new handlers object — the hook should NOT reconnect
    // because URL is unchanged.
    rerender({ handlers: makeHandlers({ onView: onViewB }) });
    expect(getMock().instances).toHaveLength(1);

    act(() => {
      es.dispatchEventNamed('view', JSON.stringify({ canvas: 'forum' }));
    });

    expect(onViewA).not.toHaveBeenCalled();
    expect(onViewB).toHaveBeenCalledTimes(1);
    expect(onViewB).toHaveBeenCalledWith({ canvas: 'forum' });
  });

  it('reconnects when the URL changes', () => {
    const { rerender } = renderHook(
      ({ url }: { url: string }) => useEventSource(url, makeHandlers()),
      { initialProps: { url: '/events/stream' } }
    );

    expect(getMock().instances).toHaveLength(1);
    const first = getMock().instances[0]!;
    expect(first.url).toBe('/events/stream');

    rerender({ url: '/events/stream?since=42' });

    expect(getMock().instances).toHaveLength(2);
    expect(first.readyState).toBe(getMock().CLOSED);
    expect(getMock().instances[1]?.url).toBe('/events/stream?since=42');
  });

  it('does not reconnect after unmount even if the retry timer would fire', () => {
    vi.useFakeTimers();

    const { unmount } = renderHook(() =>
      useEventSource('/events/stream', makeHandlers())
    );

    const first = getMock().instances[0]!;

    // Fire an error so a retry timer is scheduled.
    act(() => {
      first.triggerError();
    });
    expect(getMock().instances).toHaveLength(1);

    // Unmount before the 3s retry window elapses — cleanup must cancel the timer.
    unmount();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(getMock().instances).toHaveLength(1);
    expect(first.readyState).toBe(getMock().CLOSED);
  });
});
