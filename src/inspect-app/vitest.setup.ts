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
