import { describe, it, expect } from 'vitest';
import {
  parseCanvasRoute,
  formatCanvasRoute,
  type CanvasRoute,
} from './useHashRoute';

describe('parseCanvasRoute', () => {
  it('returns SAFE_DEFAULT for empty hash', () => {
    expect(parseCanvasRoute('')).toEqual({ canvas: 'pipeline', expanded: [] });
  });

  it('returns SAFE_DEFAULT for garbage', () => {
    expect(parseCanvasRoute('#garbage')).toEqual({ canvas: 'pipeline', expanded: [] });
  });

  it('parses bare pipeline', () => {
    expect(parseCanvasRoute('#pipeline')).toEqual({ canvas: 'pipeline', expanded: [] });
  });

  it('parses pipeline with expand', () => {
    expect(parseCanvasRoute('#pipeline/expand=discovery,coordinator')).toEqual({
      canvas: 'pipeline',
      expanded: ['discovery', 'coordinator'],
    });
  });

  it('ignores unknown expand values', () => {
    expect(parseCanvasRoute('#pipeline/expand=discovery,bogus')).toEqual({
      canvas: 'pipeline',
      expanded: ['discovery'],
    });
  });

  it('parses synthesis leaf without id', () => {
    expect(parseCanvasRoute('#pipeline/leaf=synthesis')).toEqual({
      canvas: 'pipeline',
      expanded: [],
      leaf: { kind: 'synthesis' },
    });
  });

  it('parses persona leaf with id', () => {
    expect(parseCanvasRoute('#pipeline/leaf=persona:abc-123')).toEqual({
      canvas: 'pipeline',
      expanded: [],
      leaf: { kind: 'persona', id: 'abc-123' },
    });
  });

  it('rejects leaf id with invalid characters → SAFE_DEFAULT', () => {
    expect(parseCanvasRoute('#pipeline/leaf=persona:bad id!')).toEqual({
      canvas: 'pipeline',
      expanded: [],
    });
  });

  it('rejects script-injection-style leaf id → SAFE_DEFAULT', () => {
    expect(parseCanvasRoute('#wg:<script>alert(1)</script>')).toEqual({
      canvas: 'pipeline',
      expanded: [],
    });
  });

  it('parses wg with territoryId only', () => {
    expect(parseCanvasRoute('#wg:t_001')).toEqual({
      canvas: 'wg',
      territoryId: 't_001',
    });
  });

  it('parses wg with substage', () => {
    expect(parseCanvasRoute('#wg:t_001/substage=ideation')).toEqual({
      canvas: 'wg',
      territoryId: 't_001',
      substage: 'ideation',
    });
  });

  it('rejects wg with bogus substage → SAFE_DEFAULT', () => {
    expect(parseCanvasRoute('#wg:t_001/substage=bogus')).toEqual({
      canvas: 'pipeline',
      expanded: [],
    });
  });

  it('parses wg with substage and leaf', () => {
    expect(parseCanvasRoute('#wg:t_001/substage=researcher/leaf=move:m_004')).toEqual({
      canvas: 'wg',
      territoryId: 't_001',
      substage: 'researcher',
      leaf: { kind: 'move', id: 'm_004' },
    });
  });

  it('parses wgPanel leaf', () => {
    expect(parseCanvasRoute('#wg:t_001/leaf=wgPanel:debate')).toEqual({
      canvas: 'wg',
      territoryId: 't_001',
      leaf: { kind: 'wgPanel', substage: 'debate' },
    });
  });

  it('rejects wgPanel with bad substage → SAFE_DEFAULT', () => {
    expect(parseCanvasRoute('#wg:t_001/leaf=wgPanel:bogus')).toEqual({
      canvas: 'pipeline',
      expanded: [],
    });
  });

  it('parses bare forum', () => {
    expect(parseCanvasRoute('#forum')).toEqual({ canvas: 'forum' });
  });

  it('parses forum with node leaf', () => {
    expect(parseCanvasRoute('#forum/leaf=node:n_001')).toEqual({
      canvas: 'forum',
      leaf: { kind: 'node', id: 'n_001' },
    });
  });

  it('silently ignores unknown modifiers', () => {
    expect(parseCanvasRoute('#pipeline/wat=foo/expand=discovery')).toEqual({
      canvas: 'pipeline',
      expanded: ['discovery'],
    });
  });
});

describe('formatCanvasRoute', () => {
  it('formats bare pipeline as #pipeline (no trailing slash)', () => {
    expect(formatCanvasRoute({ canvas: 'pipeline', expanded: [] })).toBe('#pipeline');
  });

  it('formats pipeline with expand', () => {
    expect(
      formatCanvasRoute({ canvas: 'pipeline', expanded: ['discovery', 'coordinator'] })
    ).toBe('#pipeline/expand=discovery,coordinator');
  });

  it('formats pipeline with synthesis leaf', () => {
    expect(
      formatCanvasRoute({ canvas: 'pipeline', expanded: [], leaf: { kind: 'synthesis' } })
    ).toBe('#pipeline/leaf=synthesis');
  });

  it('formats wg without modifiers', () => {
    expect(formatCanvasRoute({ canvas: 'wg', territoryId: 't_001' })).toBe('#wg:t_001');
  });

  it('formats wg with substage and leaf', () => {
    expect(
      formatCanvasRoute({
        canvas: 'wg',
        territoryId: 't_001',
        substage: 'researcher',
        leaf: { kind: 'move', id: 'm_004' },
      })
    ).toBe('#wg:t_001/substage=researcher/leaf=move:m_004');
  });

  it('formats forum with leaf', () => {
    expect(
      formatCanvasRoute({ canvas: 'forum', leaf: { kind: 'node', id: 'n_001' } })
    ).toBe('#forum/leaf=node:n_001');
  });
});

describe('round-trip format → parse → format', () => {
  const cases: CanvasRoute[] = [
    { canvas: 'pipeline', expanded: [] },
    { canvas: 'pipeline', expanded: ['discovery'] },
    { canvas: 'pipeline', expanded: ['discovery', 'coordinator', 'cross_pollination'] },
    { canvas: 'pipeline', expanded: [], leaf: { kind: 'synthesis' } },
    { canvas: 'pipeline', expanded: [], leaf: { kind: 'persona', id: 'abc-123' } },
    { canvas: 'wg', territoryId: 't_001' },
    { canvas: 'wg', territoryId: 't_001', substage: 'debate' },
    {
      canvas: 'wg',
      territoryId: 't_001',
      substage: 'researcher',
      leaf: { kind: 'move', id: 'm_004' },
    },
    { canvas: 'wg', territoryId: 't_001', leaf: { kind: 'wgPanel', substage: 'ideation' } },
    { canvas: 'forum' },
    { canvas: 'forum', leaf: { kind: 'node', id: 'n_001' } },
  ];

  for (const route of cases) {
    it(`round-trips ${JSON.stringify(route)}`, () => {
      const formatted = formatCanvasRoute(route);
      const parsed = parseCanvasRoute(formatted);
      expect(formatCanvasRoute(parsed)).toBe(formatted);
    });
  }
});
