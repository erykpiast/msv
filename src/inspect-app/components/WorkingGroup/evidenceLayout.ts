import type { Node, Edge } from '@xyflow/react';
import type { Move, Observation, Finding } from '../../../inspect/types';
import { NODE_W, NODE_H, V_GAP } from './wgLayoutTokens';

const H_GAP = 16;

function rowPositions(count: number, y: number): Array<{ x: number; y: number }> {
  const totalW = count * NODE_W + (count - 1) * H_GAP;
  const startX = -totalW / 2;
  return Array.from({ length: count }, (_, i) => ({
    x: startX + i * (NODE_W + H_GAP),
    y,
  }));
}

export function layoutEvidenceGraph(
  move: Move,
  allObs: Observation[],
  allFindings: Map<string, Finding>,
): { nodes: Node[]; edges: Edge[] } {
  const obsRefs = (move.evidence_refs ?? [])
    .filter((r): r is { observation_id: string } => 'observation_id' in r);
  const directFindingRefs = (move.evidence_refs ?? [])
    .filter((r): r is { finding_id: string } => 'finding_id' in r);

  const citedObs = obsRefs
    .map(r => allObs.find(o => o.observation_id === r.observation_id))
    .filter((o): o is Observation => o !== undefined);

  const allCitedFindingIds = new Set([
    ...directFindingRefs.map(r => r.finding_id),
    ...citedObs.flatMap(o => o.cited_finding_ids),
  ]);

  const findingNodes = [...allCitedFindingIds]
    .map(id => allFindings.get(id))
    .filter((f): f is Finding => f !== undefined);

  const fPos = rowPositions(findingNodes.length, 0);
  const oPos = rowPositions(citedObs.length, NODE_H + V_GAP);
  const mPos = { x: -NODE_W / 2, y: (NODE_H + V_GAP) * 2 };

  const nodes: Node[] = [
    ...findingNodes.map((f, i) => ({
      id: `f:${f.finding_id}`,
      type: 'evidenceFinding',
      position: fPos[i],
      data: { finding: f },
      draggable: false,
    })),
    ...citedObs.map((o, i) => ({
      id: `o:${o.observation_id}`,
      type: 'evidenceObs',
      position: oPos[i],
      data: { observation: o },
      draggable: false,
    })),
    {
      id: `m:${move.move_id}`,
      type: 'evidenceMove',
      position: mPos,
      data: { move },
      draggable: false,
    },
  ];

  const edges: Edge[] = [
    ...citedObs.map(o => ({
      id: `e:o→m:${o.observation_id}`,
      source: `o:${o.observation_id}`,
      target: `m:${move.move_id}`,
    })),
    ...directFindingRefs.map(r => ({
      id: `e:f→m:${r.finding_id}`,
      source: `f:${r.finding_id}`,
      target: `m:${move.move_id}`,
    })),
    ...citedObs.flatMap(o =>
      o.cited_finding_ids
        .filter(fid => allCitedFindingIds.has(fid))
        .map(fid => ({
          id: `e:f→o:${fid}→${o.observation_id}`,
          source: `f:${fid}`,
          target: `o:${o.observation_id}`,
        }))
    ),
  ];

  return { nodes, edges };
}
