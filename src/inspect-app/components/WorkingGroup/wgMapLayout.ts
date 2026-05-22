import type { Node, Edge } from '@xyflow/react';
import type { WorkingGroupView } from '../../../inspect/types';
import { NODE_W, NODE_H, V_GAP } from './wgLayoutTokens';

const H_GAP = 24;

export function layoutWgMap(wg: WorkingGroupView): { nodes: Node[]; edges: Edge[] } {
  const territory = wg.territory;
  const alignedQuestions = wg.aligned_questions ?? [];
  const reports = wg.researcher_reports ?? [];
  const observations = wg.observations ?? [];

  // Map aligned_id → findings
  const findingsByAligned = new Map<string, typeof reports[0]['findings']>();
  for (const r of reports) {
    const existing = findingsByAligned.get(r.aligned_id) ?? [];
    findingsByAligned.set(r.aligned_id, [...existing, ...r.findings]);
  }

  // Build inverted index once: finding_id → observations that cite it.
  const obsByFindingId = new Map<string, typeof observations>();
  for (const obs of observations) {
    for (const fid of obs.cited_finding_ids) {
      const list = obsByFindingId.get(fid) ?? [];
      list.push(obs);
      obsByFindingId.set(fid, list);
    }
  }

  // Map finding_id → observations (first-citation wins for layout position).
  // Assign each observation to the first finding (in AQ iteration order) that cites it.
  const obsByFirstFinding = new Map<string, typeof observations>();
  const placedObs = new Set<string>();
  for (const aq of alignedQuestions) {
    for (const f of findingsByAligned.get(aq.aligned_id) ?? []) {
      const candidates = obsByFindingId.get(f.finding_id) ?? [];
      const unplaced = candidates.filter(o => !placedObs.has(o.observation_id));
      for (const o of unplaced) placedObs.add(o.observation_id);
      if (unplaced.length) obsByFirstFinding.set(f.finding_id, unplaced);
    }
  }

  // Bottom-up: compute subtree width for each AQ
  function aqSubtreeWidth(aqId: string): number {
    const findings = findingsByAligned.get(aqId) ?? [];
    if (!findings.length) return NODE_W;
    const findingWidths = findings.map(f => {
      const childObs = obsByFirstFinding.get(f.finding_id) ?? [];
      const obsWidth = childObs.length ? childObs.length * NODE_W + (childObs.length - 1) * H_GAP : NODE_W;
      return Math.max(NODE_W, obsWidth);
    });
    return findingWidths.reduce((s, w) => s + w, 0) + (findingWidths.length - 1) * H_GAP;
  }

  const aqWidths = alignedQuestions.map(aq => aqSubtreeWidth(aq.aligned_id));
  const totalAqWidth = aqWidths.reduce((s, w) => s + w, 0) + (aqWidths.length - 1) * H_GAP;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Level 0: territory
  const territoryId = territory?.territory_id ?? 'territory';
  nodes.push({
    id: `t:${territoryId}`,
    type: 'mapTerritory',
    position: { x: totalAqWidth / 2 - NODE_W / 2, y: 0 },
    data: { territory },
    draggable: false,
  });

  // Level 1: aligned questions
  let aqX = 0;
  for (let i = 0; i < alignedQuestions.length; i++) {
    const aq = alignedQuestions[i];
    const aqW = aqWidths[i];
    const aqCenterX = aqX + aqW / 2 - NODE_W / 2;
    const outcome = reports.find((r) => r.aligned_id === aq.aligned_id)?.outcome ?? 'none';
    nodes.push({
      id: `aq:${aq.aligned_id}`,
      type: 'mapAligned',
      position: { x: aqCenterX, y: NODE_H + V_GAP },
      data: { question: aq, outcome },
      draggable: false,
    });
    edges.push({ id: `e:t→aq:${aq.aligned_id}`, source: `t:${territoryId}`, target: `aq:${aq.aligned_id}` });

    // Level 2: findings under this AQ
    const findings = findingsByAligned.get(aq.aligned_id) ?? [];
    const findingWidths = findings.map(f => {
      const childObs = obsByFirstFinding.get(f.finding_id) ?? [];
      return childObs.length ? Math.max(NODE_W, childObs.length * NODE_W + (childObs.length - 1) * H_GAP) : NODE_W;
    });
    let fX = aqX;
    for (let j = 0; j < findings.length; j++) {
      const f = findings[j];
      const fW = findingWidths[j];
      const fCenterX = fX + fW / 2 - NODE_W / 2;
      nodes.push({
        id: `f:${f.finding_id}`,
        type: 'mapFinding',
        position: { x: fCenterX, y: (NODE_H + V_GAP) * 2 },
        data: { finding: f },
        draggable: false,
      });
      edges.push({ id: `e:aq→f:${f.finding_id}`, source: `aq:${aq.aligned_id}`, target: `f:${f.finding_id}` });

      // Level 3: observations under this finding
      const childObs = obsByFirstFinding.get(f.finding_id) ?? [];
      const totalObsW = childObs.length * NODE_W + (childObs.length - 1) * H_GAP;
      const obsStartX = fX + fW / 2 - totalObsW / 2;
      for (let k = 0; k < childObs.length; k++) {
        const obs = childObs[k];
        nodes.push({
          id: `o:${obs.observation_id}`,
          type: 'mapObservation',
          position: { x: obsStartX + k * (NODE_W + H_GAP), y: (NODE_H + V_GAP) * 3 },
          data: { observation: obs },
          draggable: false,
        });
        edges.push({ id: `e:f→o:${obs.observation_id}`, source: `f:${f.finding_id}`, target: `o:${obs.observation_id}` });
      }

      fX += fW + H_GAP;
    }
    aqX += aqW + H_GAP;
  }

  return { nodes, edges };
}
