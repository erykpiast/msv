import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('jsdom is active', () => {
    expect(typeof document).toBe('object');
    expect(typeof (globalThis as any).ResizeObserver).toBe('function');
  });
});
