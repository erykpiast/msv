import type { Edge, Node } from '@xyflow/react';
import type { WorkingGroupView, StageStatus } from '../../../inspect/types';
import { edgeColors, tokens } from '../../theme/tokens';
import type { WorkingGroupSubstage } from '../../hooks/useHashRoute';

const STAGES: WorkingGroupSubstage[] = [
  'ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate',
];

export function workingGroupLayout(wg: WorkingGroupView, territoryId: string): {
  nodes: Node[];
  edges: Edge[];
} {
  const { subStageBox, subStageGap } = tokens;
  const nodes: Node[] = STAGES.map((substage, i) => ({
    id: `substage:${substage}`,
    type: 'subStage',
    position: { x: i * (subStageBox.width + subStageGap), y: 0 },
    data: { wg, substage, status: substageStatus(wg, substage), territoryId },
    draggable: false,
    selectable: true,
  }));
  const edges: Edge[] = STAGES.slice(0, -1).map((s, i) => ({
    id: `${s}->${STAGES[i + 1]}`,
    source: `substage:${s}`,
    target: `substage:${STAGES[i + 1]}`,
    style: { stroke: edgeColors.stageFlow, strokeWidth: 1.5 },
  }));
  return { nodes, edges };
}

function substageStatus(wg: WorkingGroupView, key: WorkingGroupSubstage): StageStatus {
  switch (key) {
    case 'ideation':     return wg.candidate_questions?.length ? 'done' : 'not_run';
    case 'adversarial':  return wg.adversarial_marks?.length ? 'done' : 'not_run';
    case 'alignment':    return wg.aligned_questions?.length ? 'done' : 'not_run';
    case 'researcher':   return wg.researcher_reports?.length ? 'done' : 'not_run';
    case 'observation':  return wg.observations?.length ? 'done' : 'not_run';
    case 'debate':       return wg.moves?.length ? 'done' : 'not_run';
  }
}
