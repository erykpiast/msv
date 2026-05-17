import { describe, it, expect } from 'vitest';
import { pipelineLayout } from '../layout/pipelineLayout';
import { loadFixture } from './fixtures';
import type { InvestigationView, WorkingGroupView } from '../../../inspect/types';
import { tokens } from '../../theme/tokens';

describe('pipelineLayout collision', () => {
  it('discovery expansion shifts downstream columns to the right', () => {
    const view = loadFixture('ready-v5');
    const baseline = pipelineLayout(view);
    const expanded = pipelineLayout(view, new Set<'discovery' | 'coordinator' | 'cross_pollination'>(['discovery']));
    const coordBaseline = baseline.nodes.find((n) => n.id === 'coordinator')!;
    const coordExpanded = expanded.nodes.find((n) => n.id === 'coordinator')!;
    // Expanded discovery (300px) > default column gap (220px), so coordinator
    // must shift right to maintain a positive gap.
    expect(coordExpanded.position.x).toBeGreaterThan(coordBaseline.position.x);
  });

  it('no expansion leaves coordinator at its default x', () => {
    const view = loadFixture('ready-v5');
    const baseline = pipelineLayout(view);
    const coord = baseline.nodes.find((n) => n.id === 'coordinator')!;
    expect(coord.position.x).toBe(220);
  });

  it('returns discovery node, coordinator node, forum node and synthesis node', () => {
    const view = loadFixture('ready-v5');
    const { nodes } = pipelineLayout(view);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('discovery');
    expect(ids).toContain('coordinator');
    expect(ids).toContain('forum');
    expect(ids).toContain('synthesis');
  });

  it('WG nodes have edges from coordinator and to crossPollination', () => {
    const view = loadFixture('ready-v5');
    const { nodes, edges } = pipelineLayout(view);
    const wgIds = nodes.filter((n) => n.id.startsWith('wg:')).map((n) => n.id);
    expect(wgIds.length).toBeGreaterThan(0);
    for (const wgId of wgIds) {
      expect(edges.some((e) => e.source === 'coordinator' && e.target === wgId)).toBe(true);
      expect(edges.some((e) => e.source === wgId && e.target === 'crossPollination')).toBe(true);
    }
  });

  it('stacks multiple WGs in the same column with at least the wgBox height between them', () => {
    const base = loadFixture('ready-v5');
    const wg1 = base.working_groups['t_001']!;
    const wg2: WorkingGroupView = { ...wg1, territory: wg1.territory ? { ...wg1.territory, id: 't_002', territory_id: 't_002', name: 'T2' } : null };
    const view: InvestigationView = {
      ...base,
      working_groups: { t_001: wg1, t_002: wg2 },
      coordinator: {
        ...base.coordinator,
        territories: [
          ...base.coordinator.territories,
          { ...base.coordinator.territories[0]!, id: 't_002', territory_id: 't_002', name: 'T2' },
        ],
      },
    };
    const { nodes } = pipelineLayout(view);
    const wg1Node = nodes.find((n) => n.id === 'wg:t_001')!;
    const wg2Node = nodes.find((n) => n.id === 'wg:t_002')!;
    // They share a column.
    expect(wg1Node.position.x).toBe(wg2Node.position.x);
    // wg2 sits below wg1 by at least the collapsed wgBox height (so no overlap).
    expect(wg2Node.position.y - wg1Node.position.y).toBeGreaterThanOrEqual(tokens.wgBox.heightCollapsed);
  });
});
