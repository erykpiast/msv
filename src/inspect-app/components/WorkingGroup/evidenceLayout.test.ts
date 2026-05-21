import { describe, it, expect } from 'vitest';
import { layoutEvidenceGraph } from './evidenceLayout';
import type { Move, Observation, Finding } from '../../../inspect/types';

function makeMove(overrides: Partial<Move> = {}): Move {
  return {
    move_id: 'm1',
    by_persona_id: 'persona-a',
    type: 'Claim',
    content: 'test move',
    confidence: 0.8,
    references_move_id: null,
    ...overrides,
  };
}

function makeObs(
  observation_id: string,
  cited_finding_ids: string[],
  overrides: Partial<Observation> = {},
): Observation {
  return {
    observation_id,
    by_persona_id: 'persona-a',
    report_id: 'r1',
    content: `Observation ${observation_id}`,
    cited_finding_ids,
    ...overrides,
  };
}

function makeFinding(finding_id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id,
    content: `Finding ${finding_id}`,
    ...overrides,
  };
}

describe('layoutEvidenceGraph', () => {
  it('one obs citing two findings → 4 nodes, 3 edges', () => {
    const move = makeMove({
      evidence_refs: [{ observation_id: 'obs1' }],
    });
    const obs1 = makeObs('obs1', ['f1', 'f2']);
    const finding1 = makeFinding('f1');
    const finding2 = makeFinding('f2');

    const allObs = [obs1];
    const allFindings = new Map([
      ['f1', finding1],
      ['f2', finding2],
    ]);

    const { nodes, edges } = layoutEvidenceGraph(move, allObs, allFindings);

    expect(nodes).toHaveLength(4); // f1, f2, obs1, move
    expect(edges).toHaveLength(3); // obs1→move, f1→obs1, f2→obs1

    // Verify edge directionality for the observation-mediated case
    const obsToMove = edges.find(e => e.source === 'o:obs1' && e.target === 'm:m1');
    expect(obsToMove).toBeDefined();
    const findingToObs = edges.find(e => e.source === 'f:f1' && e.target === 'o:obs1');
    expect(findingToObs).toBeDefined();
  });

  it('direct finding ref, no observations → 2 nodes, 1 edge', () => {
    const move = makeMove({
      evidence_refs: [{ finding_id: 'f1' }],
    });
    const finding1 = makeFinding('f1');

    const allObs: Observation[] = [];
    const allFindings = new Map([['f1', finding1]]);

    const { nodes, edges } = layoutEvidenceGraph(move, allObs, allFindings);

    expect(nodes).toHaveLength(2); // f1, move
    expect(edges).toHaveLength(1); // f1→move
    expect(edges[0].source).toBe('f:f1');
    expect(edges[0].target).toBe('m:m1');
  });

  it('no evidence_refs → 1 node (move only), 0 edges', () => {
    const move = makeMove({ evidence_refs: undefined });

    const allObs: Observation[] = [];
    const allFindings = new Map<string, Finding>();

    const { nodes, edges } = layoutEvidenceGraph(move, allObs, allFindings);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('m:m1');
    expect(nodes[0].type).toBe('evidenceMove');
    expect(edges).toHaveLength(0);
  });

  it('finding cited directly and via obs → deduplicated, appears once', () => {
    const move = makeMove({
      evidence_refs: [
        { finding_id: 'f1' },
        { observation_id: 'obs1' },
      ],
    });
    const obs1 = makeObs('obs1', ['f1']); // obs1 also cites f1
    const finding1 = makeFinding('f1');

    const allObs = [obs1];
    const allFindings = new Map([['f1', finding1]]);

    const { nodes, edges } = layoutEvidenceGraph(move, allObs, allFindings);

    const findingNodes = nodes.filter(n => n.type === 'evidenceFinding');
    expect(findingNodes).toHaveLength(1); // f1 appears only once
    expect(findingNodes[0].id).toBe('f:f1');

    // Should have: obs1→move, f1→move (direct), f1→obs1 (via citation)
    expect(edges).toHaveLength(3);
  });
});
