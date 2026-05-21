import { describe, expect, it } from 'vitest';
import type { Move } from '../../../inspect/types';
import { buildMoveTree } from './moveTree';

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

describe('buildMoveTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildMoveTree([])).toEqual([]);
  });

  it('builds correct parent-child nesting for a simple chain', () => {
    // m1 <- m2 <- m3, m4 is an independent root
    const m1 = makeMove('m1');
    const m2 = makeMove('m2', 'm1');
    const m3 = makeMove('m3', 'm2');
    const m4 = makeMove('m4');

    const tree = buildMoveTree([m1, m2, m3, m4]);

    expect(tree).toHaveLength(2);

    const root1 = tree.find(n => n.move.move_id === 'm1');
    const root4 = tree.find(n => n.move.move_id === 'm4');
    expect(root1).toBeDefined();
    expect(root4).toBeDefined();

    expect(root1!.children).toHaveLength(1);
    expect(root1!.children[0].move.move_id).toBe('m2');

    expect(root1!.children[0].children).toHaveLength(1);
    expect(root1!.children[0].children[0].move.move_id).toBe('m3');

    expect(root4!.children).toHaveLength(0);
  });

  it('treats a move with an unknown references_move_id as a root', () => {
    const m1 = makeMove('m1', 'nonexistent-id');
    const m2 = makeMove('m2');

    const tree = buildMoveTree([m1, m2]);

    expect(tree).toHaveLength(2);
    const ids = tree.map(n => n.move.move_id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m2');
  });

  it('handles circular references without infinite recursion — both become roots', () => {
    // A refs B, B refs A — cycle detection ensures both become roots
    const a = makeMove('A', 'B');
    const b = makeMove('B', 'A');

    const tree = buildMoveTree([a, b]);

    // Both nodes become roots (no infinite loop, no cycle in result tree)
    expect(tree).toHaveLength(2);
    const ids = tree.map(n => n.move.move_id);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    // Neither has children (no cycle in output tree)
    for (const node of tree) {
      expect(node.children).toHaveLength(0);
    }
  });
});
