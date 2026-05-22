import type { Node, Edge } from '@xyflow/react';
import type { AlignmentMove, CandidateQuestion } from '../../../inspect/types';
import { CHAIN_NODE_W, CHAIN_NODE_H, CHAIN_V_GAP, CHAIN_H_GAP } from './debateGraphLayout';

type LayoutOptions = {
  candidates: CandidateQuestion[];
  moves: AlignmentMove[];
  alignedSourceCandidateIds: Set<string>;
  isExpanded: boolean;
  selectedMoveId: string | null;
  personaName: (id: string) => string;
  parentRect: { x: number; y: number; width: number; height: number };
  parentNodeId: string;
};

// Group alignment moves by the candidate column they belong to.
// - Non-Merge moves go under their candidate_id.
// - Merge moves go under the FIRST candidate in merged_candidate_ids; additional
//   edges from the other merged candidates are drawn separately. This keeps each
//   move in exactly one column while still showing the multi-parent relationship.
function bucketMoves(
  moves: AlignmentMove[],
  candidates: CandidateQuestion[],
): Map<string, AlignmentMove[]> {
  const byCandidate = new Map<string, AlignmentMove[]>();
  for (const c of candidates) byCandidate.set(c.candidate_id, []);

  for (const m of moves) {
    if (m.type === 'Merge' && m.merged_candidate_ids?.length) {
      const primary = m.merged_candidate_ids[0];
      if (byCandidate.has(primary)) {
        byCandidate.get(primary)!.push(m);
      }
    } else if (m.candidate_id && byCandidate.has(m.candidate_id)) {
      byCandidate.get(m.candidate_id)!.push(m);
    }
  }
  return byCandidate;
}

type Chain = {
  candidate: CandidateQuestion;
  chainMoves: AlignmentMove[];
  length: number; // 1 (root) + chainMoves.length
};

type Placement = {
  chain: Chain;
  col: number; // 0-based column index, leftmost = 0
  depth: number; // 0-based row index of this chain's candidate root within its column
};

// Bin-pack chains into a roughly square grid:
// - sort chains by length DESC,
// - place each into the currently shortest column (longest-first ⇒ tallest column anchors itself),
// - reorder columns lightest-left, heaviest-right.
// One empty row separates stacked chains in the same column.
const STACK_GAP_ROWS = 1;

function planColumns(chains: Chain[]): { placements: Placement[]; maxHeight: number } {
  if (chains.length === 0) return { placements: [], maxHeight: 0 };

  const totalLength = chains.reduce((s, c) => s + c.length, 0);
  const numCols = Math.max(
    1,
    Math.min(chains.length, Math.ceil(Math.sqrt(totalLength))),
  );

  const sorted = [...chains].sort((a, b) => b.length - a.length);

  type Bin = { entries: { chain: Chain; depth: number }[]; height: number };
  const bins: Bin[] = Array.from({ length: numCols }, () => ({ entries: [], height: 0 }));

  for (const chain of sorted) {
    let minIdx = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].height < bins[minIdx].height) minIdx = i;
    }
    const bin = bins[minIdx];
    const startDepth = bin.entries.length === 0 ? 0 : bin.height + STACK_GAP_ROWS;
    bin.entries.push({ chain, depth: startDepth });
    bin.height = startDepth + chain.length;
  }

  // Lightest column leftmost, heaviest rightmost. When two columns are tied on
  // height (e.g. one tall single chain vs several short stacked chains), the
  // one containing the longest single chain goes further right so the eye can
  // follow the "main" path.
  const maxChainLen = (b: Bin) => b.entries.reduce((m, e) => Math.max(m, e.chain.length), 0);
  const ordered = [...bins].sort((a, b) => {
    if (a.height !== b.height) return a.height - b.height;
    return maxChainLen(a) - maxChainLen(b);
  });

  const placements: Placement[] = [];
  ordered.forEach((bin, colIdx) => {
    for (const { chain, depth } of bin.entries) {
      placements.push({ chain, col: colIdx, depth });
    }
  });

  const maxHeight = ordered.reduce((m, b) => Math.max(m, b.height), 0);
  return { placements, maxHeight };
}

export function layoutAlignmentChain(opts: LayoutOptions): { nodes: Node[]; edges: Edge[] } {
  const {
    candidates,
    moves,
    alignedSourceCandidateIds,
    isExpanded,
    selectedMoveId,
    personaName,
    parentRect,
    parentNodeId,
  } = opts;

  if (!isExpanded || candidates.length === 0) return { nodes: [], edges: [] };

  const buckets = bucketMoves(moves, candidates);
  const moveIndexById = new Map<string, number>();
  moves.forEach((m, i) => moveIndexById.set(m.move_id, i));

  const chains: Chain[] = candidates.map((c) => {
    const chainMoves = buckets.get(c.candidate_id) ?? [];
    return { candidate: c, chainMoves, length: 1 + chainMoves.length };
  });

  const { placements } = planColumns(chains);
  const numCols = placements.reduce((m, p) => Math.max(m, p.col), 0) + 1;

  const totalWidth = numCols * CHAIN_NODE_W + (numCols - 1) * CHAIN_H_GAP;
  const parentCenterX = parentRect.x + parentRect.width / 2;
  const firstColX = parentCenterX - totalWidth / 2;
  const rootY = parentRect.y + parentRect.height + CHAIN_V_GAP;
  const rowStep = CHAIN_NODE_H + CHAIN_V_GAP;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const { chain, col, depth: rootDepth } of placements) {
    const cand = chain.candidate;
    const colX = firstColX + col * (CHAIN_NODE_W + CHAIN_H_GAP);
    const rootNodeId = `align-cand:${cand.candidate_id}`;
    const rootRowY = rootY + rootDepth * rowStep;

    nodes.push({
      id: rootNodeId,
      type: 'alignmentCandidate',
      position: { x: colX, y: rootRowY },
      data: {
        candidate: cand,
        isAligned: alignedSourceCandidateIds.has(cand.candidate_id),
        personaLabel: personaName(cand.by_persona_id),
      },
      draggable: false,
      selectable: false,
    });

    edges.push({
      id: `e:${parentNodeId}->${rootNodeId}`,
      source: parentNodeId,
      target: rootNodeId,
      sourceHandle: 'bottom',
    });

    let prevId = rootNodeId;
    chain.chainMoves.forEach((m, moveIdx) => {
      const moveNodeId = `align-move:${m.move_id}`;
      const y = rootY + (rootDepth + 1 + moveIdx) * rowStep;

      nodes.push({
        id: moveNodeId,
        type: 'alignmentMove',
        position: { x: colX, y },
        data: {
          move: m,
          stepIndex: moveIndexById.get(m.move_id) ?? 0,
          totalMoves: moves.length,
          isSelected: selectedMoveId === m.move_id,
          personaLabel: personaName(m.by_persona_id),
        },
        draggable: false,
        selectable: false,
      });

      edges.push({
        id: `e:${prevId}->${moveNodeId}`,
        source: prevId,
        target: moveNodeId,
      });
      prevId = moveNodeId;

      // Secondary merge edges from the other merged candidates' roots.
      if (
        m.type === 'Merge' &&
        m.merged_candidate_ids &&
        m.merged_candidate_ids.length > 1
      ) {
        for (let i = 1; i < m.merged_candidate_ids.length; i++) {
          const otherCandId = m.merged_candidate_ids[i];
          const otherRootId = `align-cand:${otherCandId}`;
          edges.push({
            id: `e:${otherRootId}->${moveNodeId}:merge`,
            source: otherRootId,
            target: moveNodeId,
            sourceHandle: 'bottom',
            style: { strokeDasharray: '4 3', stroke: '#cc5de8' },
            data: { kind: 'merge' },
          });
        }
      }
    });
  }

  return { nodes, edges };
}

export function alignmentTreeDepth(
  candidates: CandidateQuestion[],
  moves: AlignmentMove[],
): number {
  if (candidates.length === 0) return 0;
  const buckets = bucketMoves(moves, candidates);
  const chains: Chain[] = candidates.map((c) => {
    const chainMoves = buckets.get(c.candidate_id) ?? [];
    return { candidate: c, chainMoves, length: 1 + chainMoves.length };
  });
  return planColumns(chains).maxHeight;
}
