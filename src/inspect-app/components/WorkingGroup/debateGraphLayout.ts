import type { Node, Edge } from '@xyflow/react';
import type { Move } from '../../../inspect/types';

export const CHAIN_NODE_W = 360;
export const CHAIN_NODE_H = 90;
export const CHAIN_V_GAP = 24;
export const CHAIN_H_GAP = 24;

type MoveTreeNode = { move: Move; children: MoveTreeNode[] };

// Investigation logs can contain circular references_move_id chains (early
// pipeline bug, plus attacker-style moves that explicitly cycle back).
// Guarding here prevents an infinite parent-walk during tree construction.
function buildMoveTree(moves: Move[]): MoveTreeNode[] {
  const byId = new Map(
    moves.map((m) => [m.move_id, { move: m, children: [] as MoveTreeNode[] }]),
  );
  const roots: MoveTreeNode[] = [];

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

  for (const m of moves) {
    const node = byId.get(m.move_id)!;
    const parentId = m.references_move_id;
    if (parentId && byId.has(parentId) && !wouldCreateCycle(parentId, m.move_id)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// Bottom-up O(N) width computation. Memoizes each node's subtree width so the
// recursive layout placement below can read widths in O(1) instead of recursing
// (which previously made placement O(N^2) on deep chains).
function buildWidthMap(roots: MoveTreeNode[]): Map<MoveTreeNode, number> {
  const cache = new Map<MoveTreeNode, number>();
  function compute(node: MoveTreeNode): number {
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    let width: number;
    if (!node.children.length) {
      width = CHAIN_NODE_W;
    } else {
      const childTotal =
        node.children.reduce((s, c) => s + compute(c), 0) +
        (node.children.length - 1) * CHAIN_H_GAP;
      width = Math.max(CHAIN_NODE_W, childTotal);
    }
    cache.set(node, width);
    return width;
  }
  roots.forEach(compute);
  return cache;
}

type LayoutOptions = {
  moves: Move[];
  isExpanded: boolean;
  selectedMoveId: string | null;
  personaName: (id: string) => string;
  survivingIds: Set<string>;
  parentRect: { x: number; y: number; width: number; height: number };
  parentNodeId: string;
};

export function layoutDebateChain(opts: LayoutOptions): { nodes: Node[]; edges: Edge[] } {
  const {
    moves,
    isExpanded,
    selectedMoveId,
    personaName,
    survivingIds,
    parentRect,
    parentNodeId,
  } = opts;

  if (!isExpanded || moves.length === 0) return { nodes: [], edges: [] };

  const tree = buildMoveTree(moves);
  const stepIndexById = new Map<string, number>();
  moves.forEach((m, i) => stepIndexById.set(m.move_id, i));

  const widthMap = buildWidthMap(tree);
  const rootWidths = tree.map((n) => widthMap.get(n)!);
  const totalRootWidth = rootWidths.length
    ? rootWidths.reduce((s, w) => s + w, 0) + (tree.length - 1) * CHAIN_H_GAP
    : 0;

  const parentCenterX = parentRect.x + parentRect.width / 2;
  const forestLeftX = parentCenterX - totalRootWidth / 2;
  const firstY = parentRect.y + parentRect.height + CHAIN_V_GAP;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  function placeNode(
    node: MoveTreeNode,
    leftX: number,
    depth: number,
    parentId: string,
    parentSourceHandle?: string,
  ) {
    const myWidth = widthMap.get(node)!;
    const myX = leftX + myWidth / 2 - CHAIN_NODE_W / 2;
    const myY = firstY + depth * (CHAIN_NODE_H + CHAIN_V_GAP);
    const moveNodeId = `chain:${node.move.move_id}`;

    nodes.push({
      id: moveNodeId,
      type: 'debateChain',
      position: { x: myX, y: myY },
      data: {
        move: node.move,
        stepIndex: stepIndexById.get(node.move.move_id) ?? 0,
        totalMoves: moves.length,
        isSelected: selectedMoveId === node.move.move_id,
        personaLabel: personaName(node.move.by_persona_id),
        isSurviving: survivingIds.has(node.move.move_id),
      },
      draggable: false,
      selectable: false,
    });

    edges.push({
      id: `e:${parentId}->${moveNodeId}`,
      source: parentId,
      target: moveNodeId,
      sourceHandle: parentSourceHandle,
    });

    const childWidths = node.children.map((c) => widthMap.get(c)!);
    const childrenTotalWidth = childWidths.length
      ? childWidths.reduce((s, w) => s + w, 0) + (node.children.length - 1) * CHAIN_H_GAP
      : 0;
    let childLeft = leftX + myWidth / 2 - childrenTotalWidth / 2;
    for (let i = 0; i < node.children.length; i++) {
      placeNode(node.children[i], childLeft, depth + 1, moveNodeId);
      childLeft += childWidths[i] + CHAIN_H_GAP;
    }
  }

  let rootLeftX = forestLeftX;
  for (let i = 0; i < tree.length; i++) {
    placeNode(tree[i], rootLeftX, 0, parentNodeId, 'bottom');
    rootLeftX += rootWidths[i] + CHAIN_H_GAP;
  }

  return { nodes, edges };
}

export function treeDepth(moves: Move[]): number {
  if (moves.length === 0) return 0;
  const tree = buildMoveTree(moves);
  function depthOf(node: MoveTreeNode): number {
    if (!node.children.length) return 1;
    return 1 + Math.max(...node.children.map(depthOf));
  }
  return Math.max(...tree.map(depthOf));
}
