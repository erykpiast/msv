import type { Move } from '../../../inspect/types';

export type MoveNode = { move: Move; children: MoveNode[] };

export function buildMoveTree(moves: Move[]): MoveNode[] {
  const byId = new Map(moves.map(m => [m.move_id, { move: m, children: [] as MoveNode[] }]));
  const roots: MoveNode[] = [];

  // Investigation logs can contain circular references_move_id chains (early
  // pipeline bug, plus attacker-style moves that explicitly cycle back).
  // Guarding here prevents an infinite parent-walk during tree construction.
  function wouldCreateCycle(fromId: string, startId: string): boolean {
    let current: string | null = fromId;
    const visited = new Set<string>();
    while (current !== null) {
      if (current === startId) return true;
      if (visited.has(current)) break;
      visited.add(current);
      current = byId.get(current)?.move.references_move_id ?? null;
    }
    return false;
  }

  for (const node of byId.values()) {
    const parentId = node.move.references_move_id;
    if (parentId && byId.has(parentId) && !wouldCreateCycle(parentId, node.move.move_id)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
