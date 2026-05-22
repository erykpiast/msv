import { describe, expect, it } from 'vitest';
import type { AlignmentMove, CandidateQuestion } from '../../../inspect/types';
import {
  alignmentTreeDepth,
  layoutAlignmentChain,
} from './alignmentGraphLayout';
import { CHAIN_NODE_H, CHAIN_V_GAP } from './debateGraphLayout';

function makeCandidate(candidate_id: string, by = 'persona-1'): CandidateQuestion {
  return {
    candidate_id,
    by_persona_id: by,
    predicted_confidence: 5,
    question: `Candidate ${candidate_id}`,
  };
}

function makeMove(
  move_id: string,
  type: AlignmentMove['type'],
  fields: Partial<AlignmentMove> = {},
): AlignmentMove {
  return {
    move_id,
    by_persona_id: 'persona-1',
    type,
    content: `${type} ${move_id}`,
    stage: 'alignment',
    ...fields,
  };
}

const PARENT_RECT = { x: 1000, y: 0, width: 170, height: 92 };
const PARENT_ID = 'substage:alignment';
const ROW_STEP = CHAIN_NODE_H + CHAIN_V_GAP;

const defaults = {
  parentRect: PARENT_RECT,
  parentNodeId: PARENT_ID,
  selectedMoveId: null,
  personaName: (id: string) => id,
  alignedSourceCandidateIds: new Set<string>(),
};

describe('layoutAlignmentChain', () => {
  it('renders nothing when not expanded', () => {
    const { nodes, edges } = layoutAlignmentChain({
      ...defaults,
      candidates: [makeCandidate('c1')],
      moves: [],
      isExpanded: false,
    });
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('renders nothing when there are no candidates', () => {
    const { nodes, edges } = layoutAlignmentChain({
      ...defaults,
      candidates: [],
      moves: [],
      isExpanded: true,
    });
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('every candidate root has a "bottom"-handle edge from the parent, regardless of depth', () => {
    // 5 candidates with no moves → bin-packed into ceil(sqrt(5))=3 columns.
    const candidates = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => makeCandidate(id));
    const { edges } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves: [],
      isExpanded: true,
    });
    const rootEdges = edges.filter((e) => e.source === PARENT_ID);
    expect(rootEdges).toHaveLength(5);
    expect(rootEdges.every((e) => e.sourceHandle === 'bottom')).toBe(true);
    expect(new Set(rootEdges.map((e) => e.target))).toEqual(
      new Set(candidates.map((c) => `align-cand:${c.candidate_id}`)),
    );
  });

  it('5 zero-move candidates pack into 3 columns (ceil(sqrt(5)))', () => {
    const candidates = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => makeCandidate(id));
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves: [],
      isExpanded: true,
    });
    const rootNodes = nodes.filter((n) => n.type === 'alignmentCandidate');
    const xs = new Set(rootNodes.map((n) => n.position.x));
    expect(xs.size).toBe(3);
  });

  it('shorter chains stack below taller chains in the same column (gap of one row)', () => {
    // 4 chains, lengths [3, 1, 1, 1].
    // ceil(sqrt(6))=3 columns: bin packing gives [3], [1,1], [1] → ordered [1], [1,1], [3].
    const candidates = ['c1', 'c2', 'c3', 'c4'].map((id) => makeCandidate(id));
    const moves = [
      makeMove('m1', 'Propose', { candidate_id: 'c1' }),
      makeMove('m2', 'Sharpen', { candidate_id: 'c1' }),
    ];
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves,
      isExpanded: true,
    });

    const c1 = nodes.find((n) => n.id === 'align-cand:c1')!;
    // c1 has the longest chain (3) and should anchor a single-chain column (rightmost).
    const c1Col = c1.position.x;
    const inSameColumn = nodes.filter(
      (n) => n.position.x === c1Col && n.type === 'alignmentCandidate',
    );
    expect(inSameColumn).toHaveLength(1);
    expect(inSameColumn[0].id).toBe('align-cand:c1');

    // The two-chain column should have two candidate roots at different depths,
    // separated by chain_length + STACK_GAP rows.
    const xs = new Set(
      nodes.filter((n) => n.type === 'alignmentCandidate').map((n) => n.position.x),
    );
    const cols = [...xs].sort((a, b) => a - b);
    // Find the column with 2 candidates (the middle one).
    const colWithTwo = cols.find(
      (x) =>
        nodes.filter((n) => n.type === 'alignmentCandidate' && n.position.x === x)
          .length === 2,
    );
    expect(colWithTwo).toBeDefined();
    const stacked = nodes
      .filter((n) => n.type === 'alignmentCandidate' && n.position.x === colWithTwo)
      .sort((a, b) => a.position.y - b.position.y);
    expect(stacked[1].position.y - stacked[0].position.y).toBe(2 * ROW_STEP);
  });

  it('longest chain anchors the rightmost column', () => {
    // Lengths: c1=3, c2=1, c3=1, c4=1 → packed into 3 cols.
    const candidates = ['c1', 'c2', 'c3', 'c4'].map((id) => makeCandidate(id));
    const moves = [
      makeMove('m1', 'Propose', { candidate_id: 'c1' }),
      makeMove('m2', 'Sharpen', { candidate_id: 'c1' }),
    ];
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves,
      isExpanded: true,
    });
    const c1Root = nodes.find((n) => n.id === 'align-cand:c1')!;
    const rootNodes = nodes.filter((n) => n.type === 'alignmentCandidate');
    const maxX = Math.max(...rootNodes.map((n) => n.position.x));
    expect(c1Root.position.x).toBe(maxX);
  });

  it('moves chain vertically below their candidate root in the same column', () => {
    const candidates = [makeCandidate('c1')];
    const moves = [
      makeMove('m1', 'Propose', { candidate_id: 'c1' }),
      makeMove('m2', 'Sharpen', { candidate_id: 'c1' }),
    ];
    const { nodes, edges } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves,
      isExpanded: true,
    });
    const root = nodes.find((n) => n.id === 'align-cand:c1')!;
    const m1 = nodes.find((n) => n.id === 'align-move:m1')!;
    const m2 = nodes.find((n) => n.id === 'align-move:m2')!;
    expect(m1.position.x).toBe(root.position.x);
    expect(m2.position.x).toBe(root.position.x);
    expect(m1.position.y).toBeGreaterThan(root.position.y);
    expect(m2.position.y).toBeGreaterThan(m1.position.y);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      `${PARENT_ID}->align-cand:c1`,
      'align-cand:c1->align-move:m1',
      'align-move:m1->align-move:m2',
    ]);
  });

  it('a single candidate occupies a single column at depth 0', () => {
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates: [makeCandidate('c1')],
      moves: [],
      isExpanded: true,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].position.y).toBe(PARENT_RECT.y + PARENT_RECT.height + CHAIN_V_GAP);
  });

  it('Merge sits under the first merged candidate; secondary edges from the others', () => {
    const candidates = [
      makeCandidate('c1'),
      makeCandidate('c2'),
      makeCandidate('c3'),
    ];
    const moves = [
      makeMove('mg', 'Merge', { merged_candidate_ids: ['c1', 'c2', 'c3'] }),
    ];
    const { nodes, edges } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves,
      isExpanded: true,
    });
    const c1 = nodes.find((n) => n.id === 'align-cand:c1')!;
    const mergeNode = nodes.find((n) => n.id === 'align-move:mg')!;
    expect(mergeNode.position.x).toBe(c1.position.x);

    const incoming = edges.filter((e) => e.target === 'align-move:mg');
    expect(incoming.map((e) => e.source).sort()).toEqual([
      'align-cand:c1',
      'align-cand:c2',
      'align-cand:c3',
    ]);
    const secondary = incoming.filter((e) => e.source !== 'align-cand:c1');
    expect(
      secondary.every((e) => (e.data as { kind?: string } | undefined)?.kind === 'merge'),
    ).toBe(true);
  });

  it('aligned candidates get isAligned=true on their root node data', () => {
    const candidates = [makeCandidate('c1'), makeCandidate('c2')];
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves: [],
      isExpanded: true,
      alignedSourceCandidateIds: new Set(['c1']),
    });
    expect(nodes.find((n) => n.id === 'align-cand:c1')!.data).toMatchObject({
      isAligned: true,
    });
    expect(nodes.find((n) => n.id === 'align-cand:c2')!.data).toMatchObject({
      isAligned: false,
    });
  });

  it('marks the selected move on its node data', () => {
    const candidates = [makeCandidate('c1')];
    const moves = [makeMove('m1', 'Propose', { candidate_id: 'c1' })];
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves,
      isExpanded: true,
      selectedMoveId: 'm1',
    });
    expect(nodes.find((n) => n.id === 'align-move:m1')!.data).toMatchObject({
      isSelected: true,
    });
  });

  it('stepIndex on a move node reflects its position in the moves array', () => {
    const candidates = [makeCandidate('c1'), makeCandidate('c2')];
    const moves = [
      makeMove('m1', 'Drop', { candidate_id: 'c2' }),
      makeMove('m2', 'Propose', { candidate_id: 'c1' }),
    ];
    const { nodes } = layoutAlignmentChain({
      ...defaults,
      candidates,
      moves,
      isExpanded: true,
    });
    expect(nodes.find((n) => n.id === 'align-move:m1')!.data).toMatchObject({
      stepIndex: 0,
    });
    expect(nodes.find((n) => n.id === 'align-move:m2')!.data).toMatchObject({
      stepIndex: 1,
    });
  });
});

describe('alignmentTreeDepth', () => {
  it('is 0 with no candidates', () => {
    expect(alignmentTreeDepth([], [])).toBe(0);
  });

  it('is the longest chain length when packing is loose enough', () => {
    // 1 candidate, 2 moves → length 3, only column height = 3.
    const c = makeCandidate('c1');
    const moves = [
      makeMove('m1', 'Propose', { candidate_id: 'c1' }),
      makeMove('m2', 'Sharpen', { candidate_id: 'c1' }),
    ];
    expect(alignmentTreeDepth([c], moves)).toBe(3);
  });

  it('packs zero-move candidates into a square-ish grid', () => {
    // 5 candidates × length 1 → ceil(sqrt(5))=3 cols → after STACK_GAP_ROWS=1
    // separator the two-candidate columns reach height 3 (rows 0 and 2).
    const cands = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => makeCandidate(id));
    expect(alignmentTreeDepth(cands, [])).toBe(3);
  });
});
