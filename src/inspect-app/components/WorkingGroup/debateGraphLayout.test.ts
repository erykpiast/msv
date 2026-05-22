import { describe, expect, it } from 'vitest';
import type { Move } from '../../../inspect/types';
import {
  CHAIN_H_GAP,
  CHAIN_NODE_W,
  layoutDebateChain,
  treeDepth,
} from './debateGraphLayout';

function makeMove(move_id: string, references_move_id: string | null = null): Move {
  return {
    move_id,
    by_persona_id: 'persona-1',
    type: 'Claim',
    content: `Move ${move_id}`,
    confidence: 0.8,
    references_move_id,
  };
}

const PARENT_RECT = { x: 1000, y: 0, width: 170, height: 92 };
const PARENT_ID = 'substage:debate';

const defaults = {
  parentRect: PARENT_RECT,
  parentNodeId: PARENT_ID,
  selectedMoveId: null,
  personaName: (id: string) => id,
  survivingIds: new Set<string>(),
};

describe('layoutDebateChain (tree)', () => {
  it('renders nothing when not expanded', () => {
    const moves = [makeMove('m1'), makeMove('m2', 'm1')];
    const { nodes, edges } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: false,
    });
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('returns empty for an empty moves array even when expanded', () => {
    const { nodes, edges } = layoutDebateChain({
      ...defaults,
      moves: [],
      isExpanded: true,
    });
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('a single root with no children links to the parent substage via "bottom" handle', () => {
    const { edges } = layoutDebateChain({
      ...defaults,
      moves: [makeMove('m1')],
      isExpanded: true,
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: PARENT_ID,
      target: 'chain:m1',
      sourceHandle: 'bottom',
    });
  });

  it('chains a single response vertically (child below parent, same x)', () => {
    const moves = [makeMove('m1'), makeMove('m2', 'm1')];
    const { nodes, edges } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    const m1 = nodes.find((n) => n.id === 'chain:m1')!;
    const m2 = nodes.find((n) => n.id === 'chain:m2')!;
    expect(m1.position.x).toBe(m2.position.x);
    expect(m2.position.y).toBeGreaterThan(m1.position.y);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      `${PARENT_ID}->chain:m1`,
      'chain:m1->chain:m2',
    ]);
    expect(edges[1].sourceHandle).toBeUndefined();
  });

  it('siblings (children of the same parent) are placed side-by-side on the same row', () => {
    // m1 → {m2, m3}
    const moves = [makeMove('m1'), makeMove('m2', 'm1'), makeMove('m3', 'm1')];
    const { nodes } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    const m2 = nodes.find((n) => n.id === 'chain:m2')!;
    const m3 = nodes.find((n) => n.id === 'chain:m3')!;
    expect(m2.position.y).toBe(m3.position.y);
    expect(Math.abs(m3.position.x - m2.position.x)).toBe(CHAIN_NODE_W + CHAIN_H_GAP);
  });

  it('parent of two siblings is horizontally centered between them', () => {
    const moves = [makeMove('m1'), makeMove('m2', 'm1'), makeMove('m3', 'm1')];
    const { nodes } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    const m1 = nodes.find((n) => n.id === 'chain:m1')!;
    const m2 = nodes.find((n) => n.id === 'chain:m2')!;
    const m3 = nodes.find((n) => n.id === 'chain:m3')!;
    const m1Center = m1.position.x + CHAIN_NODE_W / 2;
    const childMid = (m2.position.x + m3.position.x + CHAIN_NODE_W) / 2;
    expect(Math.abs(m1Center - childMid)).toBeLessThan(1);
  });

  it('multiple roots (no references) all link to the parent substage', () => {
    // m1 and m2 are both roots; m3 is m1's child.
    const moves = [makeMove('m1'), makeMove('m2'), makeMove('m3', 'm1')];
    const { edges, nodes } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    const rootEdges = edges.filter((e) => e.source === PARENT_ID);
    expect(rootEdges.map((e) => e.target).sort()).toEqual(['chain:m1', 'chain:m2']);
    expect(rootEdges.every((e) => e.sourceHandle === 'bottom')).toBe(true);
    const m1 = nodes.find((n) => n.id === 'chain:m1')!;
    const m2 = nodes.find((n) => n.id === 'chain:m2')!;
    expect(m1.position.y).toBe(m2.position.y);
  });

  it('treats a move with an unknown references_move_id as a root', () => {
    // m1 references a non-existent parent; m2 has no reference. Both should be
    // treated as roots: edges from the parent substage, equal y (same depth).
    const moves = [
      makeMove('m1', 'm99-nonexistent'),
      makeMove('m2', null),
    ];
    const { nodes, edges } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    const rootEdges = edges.filter((e) => e.source === PARENT_ID);
    expect(rootEdges.map((e) => e.target).sort()).toEqual([
      'chain:m1',
      'chain:m2',
    ]);
    expect(rootEdges.every((e) => e.sourceHandle === 'bottom')).toBe(true);

    const m1 = nodes.find((n) => n.id === 'chain:m1')!;
    const m2 = nodes.find((n) => n.id === 'chain:m2')!;
    expect(m1.position.y).toBe(m2.position.y);
  });

  it('isolated leaf claim is shown at depth 0 with no descendants', () => {
    // m1 has no children, m2 has a chain of responses.
    const moves = [makeMove('m1'), makeMove('m2'), makeMove('m3', 'm2')];
    const { nodes } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    const m1 = nodes.find((n) => n.id === 'chain:m1')!;
    const m2 = nodes.find((n) => n.id === 'chain:m2')!;
    const m3 = nodes.find((n) => n.id === 'chain:m3')!;
    expect(m1.position.y).toBe(m2.position.y);
    expect(m3.position.y).toBeGreaterThan(m2.position.y);
  });

  it('survives circular references without infinite recursion', () => {
    const a = makeMove('A', 'B');
    const b = makeMove('B', 'A');
    expect(() => {
      layoutDebateChain({ ...defaults, moves: [a, b], isExpanded: true });
    }).not.toThrow();
  });

  it('stepIndex on each node reflects its position in the original moves array', () => {
    const moves = [makeMove('m1'), makeMove('m2', 'm1'), makeMove('m3', 'm1')];
    const { nodes } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
    });
    expect(nodes.find((n) => n.id === 'chain:m1')!.data).toMatchObject({ stepIndex: 0 });
    expect(nodes.find((n) => n.id === 'chain:m2')!.data).toMatchObject({ stepIndex: 1 });
    expect(nodes.find((n) => n.id === 'chain:m3')!.data).toMatchObject({ stepIndex: 2 });
  });

  it('marks the selected move on its node data', () => {
    const moves = [makeMove('m1'), makeMove('m2', 'm1')];
    const { nodes } = layoutDebateChain({
      ...defaults,
      moves,
      isExpanded: true,
      selectedMoveId: 'm2',
    });
    expect(nodes.find((n) => n.id === 'chain:m2')!.data).toMatchObject({ isSelected: true });
    expect(nodes.find((n) => n.id === 'chain:m1')!.data).toMatchObject({ isSelected: false });
  });

  it('bakes personaLabel and isSurviving into chain node data', () => {
    const { nodes } = layoutDebateChain({
      ...defaults,
      moves: [makeMove('m1')],
      isExpanded: true,
      personaName: () => 'Skeptic',
      survivingIds: new Set(['m1']),
    });
    expect(nodes[0].data).toMatchObject({
      personaLabel: 'Skeptic',
      isSurviving: true,
    });
  });
});

describe('treeDepth', () => {
  it('is 0 for an empty moves array', () => {
    expect(treeDepth([])).toBe(0);
  });

  it('is 1 for a single root with no children', () => {
    expect(treeDepth([makeMove('m1')])).toBe(1);
  });

  it('counts the deepest chain', () => {
    // m1 → m2 → m3
    const moves = [makeMove('m1'), makeMove('m2', 'm1'), makeMove('m3', 'm2')];
    expect(treeDepth(moves)).toBe(3);
  });

  it('uses the deepest branch when branches differ', () => {
    // m1 → {m2, m3 → m4}
    const moves = [
      makeMove('m1'),
      makeMove('m2', 'm1'),
      makeMove('m3', 'm1'),
      makeMove('m4', 'm3'),
    ];
    expect(treeDepth(moves)).toBe(3);
  });
});
