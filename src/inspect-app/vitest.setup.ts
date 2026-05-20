import '@testing-library/jest-dom/vitest';

if (!(globalThis as any).window?.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!(globalThis as any).DOMRect) {
  (globalThis as any).DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    static fromRect(r?: { x?: number; y?: number; width?: number; height?: number }) {
      return new (globalThis as any).DOMRect(r?.x, r?.y, r?.width, r?.height);
    }
  };
}

// jsdom 29 does not implement EventSource. Stub it so tests that render
// components using useEventSource don't throw ReferenceError.
if (!(globalThis as unknown as Record<string, unknown>)['EventSource']) {
  class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    // Tracks every instance constructed during a test so tests can assert
    // on the connection lifecycle (e.g. reconnect creating a second instance).
    static instances: MockEventSource[] = [];
    readyState = MockEventSource.CONNECTING;
    url: string;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private listeners: Record<string, ((e: MessageEvent) => void)[]> = {};

    constructor(url: string) {
      this.url = url;
      MockEventSource.instances.push(this);
    }

    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    removeEventListener(type: string, fn: (e: MessageEvent) => void) {
      this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn);
    }
    /**
     * Convenience helper used by useEventSource tests: marks the source as
     * open, fires `onopen`, and then dispatches a named SSE event to any
     * matching `addEventListener` subscribers.
     */
    dispatchMessage(type: string, data: string) {
      this.readyState = MockEventSource.OPEN;
      this.onopen?.({} as Event);
      for (const fn of this.listeners[type] ?? []) {
        fn(new MessageEvent(type, { data }));
      }
    }
    /** Fire `onopen` without delivering a named event. */
    open() {
      this.readyState = MockEventSource.OPEN;
      this.onopen?.({} as Event);
    }
    /** Dispatch a named event without forcing `onopen`. */
    dispatchEventNamed(type: string, data: string) {
      for (const fn of this.listeners[type] ?? []) {
        fn(new MessageEvent(type, { data }));
      }
    }
    /** Trigger `onerror` so the hook closes and schedules a reconnect. */
    triggerError() {
      this.onerror?.({} as Event);
    }
    close() { this.readyState = MockEventSource.CLOSED; }
  }
  (globalThis as unknown as Record<string, unknown>)['EventSource'] = MockEventSource;
}
