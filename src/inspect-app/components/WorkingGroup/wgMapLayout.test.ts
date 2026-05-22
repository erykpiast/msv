import { describe, it, expect } from 'vitest';
import { layoutWgMap } from './wgMapLayout';
import { NODE_W } from './wgLayoutTokens';
import type { WorkingGroupView, Territory, AlignedQuestion, Finding, ResearcherReport, Observation } from '../../../inspect/types';

function makeTerritory(id: string): Territory {
  return {
    id,
    territory_id: id,
    name: `Territory ${id}`,
    description: 'Test territory',
    assigned_pair: ['p1', 'p2'],
  };
}

function makeAQ(id: string): AlignedQuestion {
  return {
    aligned_id: id,
    question: `Question ${id}`,
    origin: 'aligned',
    source_candidate_ids: [],
  };
}

function makeFinding(id: string): Finding {
  return {
    finding_id: id,
    content: `Finding ${id}`,
  };
}

function makeReport(aligned_id: string, findings: Finding[]): ResearcherReport {
  return {
    report_id: `report-${aligned_id}`,
    aligned_id,
    outcome: 'useful',
    findings,
    search_trace: [],
  };
}

function makeObservation(id: string, cited_finding_ids: string[]): Observation {
  return {
    observation_id: id,
    by_persona_id: 'p1',
    report_id: 'report-1',
    content: `Observation ${id}`,
    cited_finding_ids,
  };
}

function makeWG(overrides: Partial<WorkingGroupView> = {}): WorkingGroupView {
  return {
    territory: null,
    pair: [],
    candidate_questions: [],
    adversarial_marks: [],
    aligned_questions: [],
    researcher_reports: [],
    observations: [],
    moves: [],
    surviving_claims: [],
    terminated_by: null,
    confidence_trajectory: [],
    ...overrides,
  };
}

describe('layoutWgMap', () => {
  it('produces correct node/edge count for a 2-AQ, 3-finding, 2-obs WG with no duplicate node IDs', () => {
    // AQ1 → F1, F2; AQ2 → F3
    // Obs1 cites F1; Obs2 cites F3
    const territory = makeTerritory('t1');
    const aq1 = makeAQ('aq1');
    const aq2 = makeAQ('aq2');
    const f1 = makeFinding('f1');
    const f2 = makeFinding('f2');
    const f3 = makeFinding('f3');
    const obs1 = makeObservation('obs1', ['f1']);
    const obs2 = makeObservation('obs2', ['f3']);

    const wg = makeWG({
      territory,
      aligned_questions: [aq1, aq2],
      researcher_reports: [
        makeReport('aq1', [f1, f2]),
        makeReport('aq2', [f3]),
      ],
      observations: [obs1, obs2],
    });

    const { nodes } = layoutWgMap(wg);

    // 1 territory + 2 AQ + 3 findings + 2 observations = 8
    expect(nodes).toHaveLength(8);

    // No duplicate IDs
    const ids = nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Check node types are present
    expect(nodes.some(n => n.type === 'mapTerritory')).toBe(true);
    expect(nodes.filter(n => n.type === 'mapAligned')).toHaveLength(2);
    expect(nodes.filter(n => n.type === 'mapFinding')).toHaveLength(3);
    expect(nodes.filter(n => n.type === 'mapObservation')).toHaveLength(2);
  });

  it('territory x-position is centred over the aligned-question row within ±NODE_W/2', () => {
    const territory = makeTerritory('t1');
    const aq1 = makeAQ('aq1');
    const aq2 = makeAQ('aq2');
    const f1 = makeFinding('f1');

    const wg = makeWG({
      territory,
      aligned_questions: [aq1, aq2],
      researcher_reports: [makeReport('aq1', [f1])],
      observations: [],
    });

    const { nodes } = layoutWgMap(wg);

    const territoryNode = nodes.find(n => n.type === 'mapTerritory');
    const aqNodes = nodes.filter(n => n.type === 'mapAligned');

    expect(territoryNode).toBeDefined();
    expect(aqNodes.length).toBeGreaterThan(0);

    // AQ row spans from left edge of first AQ node to right edge of last AQ node
    const aqXPositions = aqNodes.map(n => n.position.x);
    const aqRowLeft = Math.min(...aqXPositions);
    const aqRowRight = Math.max(...aqXPositions) + NODE_W;
    const aqRowCenter = (aqRowLeft + aqRowRight) / 2;

    // Territory node center
    const territoryCenter = territoryNode!.position.x + NODE_W / 2;

    expect(Math.abs(territoryCenter - aqRowCenter)).toBeLessThanOrEqual(NODE_W / 2);
  });

  it('an observation citing two findings appears exactly once in the output', () => {
    const territory = makeTerritory('t1');
    const aq1 = makeAQ('aq1');
    const f1 = makeFinding('f1');
    const f2 = makeFinding('f2');
    // obs1 cites both f1 and f2
    const obs1 = makeObservation('obs1', ['f1', 'f2']);

    const wg = makeWG({
      territory,
      aligned_questions: [aq1],
      researcher_reports: [makeReport('aq1', [f1, f2])],
      observations: [obs1],
    });

    const { nodes } = layoutWgMap(wg);

    const obsNodes = nodes.filter(n => n.id === 'o:obs1');
    expect(obsNodes).toHaveLength(1);
  });

  it('empty aligned_questions and researcher_reports produces only the territory node and no edges', () => {
    const territory = makeTerritory('t1');

    const wg = makeWG({
      territory,
      aligned_questions: [],
      researcher_reports: [],
      observations: [],
    });

    const { nodes, edges } = layoutWgMap(wg);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('mapTerritory');
    expect(edges).toHaveLength(0);
  });

  it('aligned_questions with empty researcher_reports produces territory + AQ nodes with t→aq edges and no finding/observation nodes', () => {
    const territory = makeTerritory('t1');
    const aq1 = makeAQ('aq1');

    const wg = makeWG({
      territory,
      aligned_questions: [aq1],
      researcher_reports: [],
      observations: [],
    });

    const { nodes, edges } = layoutWgMap(wg);

    expect(nodes).toHaveLength(2);
    expect(nodes.some(n => n.type === 'mapTerritory')).toBe(true);
    expect(nodes.filter(n => n.type === 'mapAligned')).toHaveLength(1);
    expect(nodes.some(n => n.type === 'mapFinding')).toBe(false);
    expect(nodes.some(n => n.type === 'mapObservation')).toBe(false);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('t:t1');
    expect(edges[0].target).toBe('aq:aq1');
  });
});
