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

  it('stacks vertically-co-located WGs with at least the wgBox height between them', () => {
    // 3 working groups: bin-packing puts ceil(sqrt(3))=2 columns, so two of
    // them necessarily share a column. Locate that pair and assert they don't
    // overlap.
    const base = loadFixture('ready-v5');
    const wg1 = base.working_groups['t_001']!;
    const wg2: WorkingGroupView = { ...wg1, territory: wg1.territory ? { ...wg1.territory, id: 't_002', territory_id: 't_002', name: 'T2' } : null };
    const wg3: WorkingGroupView = { ...wg1, territory: wg1.territory ? { ...wg1.territory, id: 't_003', territory_id: 't_003', name: 'T3' } : null };
    const view: InvestigationView = {
      ...base,
      working_groups: { t_001: wg1, t_002: wg2, t_003: wg3 },
      coordinator: {
        ...base.coordinator,
        territories: [
          ...base.coordinator.territories,
          { ...base.coordinator.territories[0]!, id: 't_002', territory_id: 't_002', name: 'T2' },
          { ...base.coordinator.territories[0]!, id: 't_003', territory_id: 't_003', name: 'T3' },
        ],
      },
    };
    const { nodes } = pipelineLayout(view);
    const wgNodes = nodes.filter((n) => n.id.startsWith('wg:'));
    const byColumn = new Map<number, typeof wgNodes>();
    for (const n of wgNodes) {
      const list = byColumn.get(n.position.x) ?? [];
      list.push(n);
      byColumn.set(n.position.x, list);
    }
    const stackedColumns = [...byColumn.values()].filter((c) => c.length >= 2);
    expect(stackedColumns.length).toBeGreaterThan(0);
    for (const col of stackedColumns) {
      col.sort((a, b) => a.position.y - b.position.y);
      for (let i = 1; i < col.length; i++) {
        expect(col[i]!.position.y - col[i - 1]!.position.y).toBeGreaterThanOrEqual(
          tokens.wgBox.heightCollapsed,
        );
      }
    }
  });
});
