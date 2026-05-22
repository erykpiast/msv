import type { Edge, Node } from '@xyflow/react';
import type {
  WorkingGroupView,
  StageStatus,
  Move,
  AlignmentMove,
  CandidateQuestion,
} from '../../../inspect/types';
import { edgeColors, tokens } from '../../theme/tokens';
import type { WorkingGroupSubstage } from '../../hooks/useHashRoute';
import { layoutDebateChain } from '../../components/WorkingGroup/debateGraphLayout';
import { layoutAlignmentChain } from '../../components/WorkingGroup/alignmentGraphLayout';

// Research Map is no longer part of the linear substage sequence — it's a
// separate tab inside the WG canvas. The pipeline now ends with Conclusions,
// which surfaces the surviving claims that are the WG's main output.
const STAGES: WorkingGroupSubstage[] = [
  'ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate', 'conclusions',
];

export type DebateChainState = {
  moves: Move[];
  isExpanded: boolean;
  selectedMoveId: string | null;
  personaName: (id: string) => string;
  survivingIds: Set<string>;
};

export type AlignmentChainState = {
  candidates: CandidateQuestion[];
  moves: AlignmentMove[];
  alignedSourceCandidateIds: Set<string>;
  isExpanded: boolean;
  selectedMoveId: string | null;
  personaName: (id: string) => string;
};

export function workingGroupLayout(
  wg: WorkingGroupView,
  territoryId: string,
  debateChainState?: DebateChainState,
  alignmentChainState?: AlignmentChainState,
): {
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

  function applyDefaultEdgeStyle(e: Edge): Edge {
    // Preserve any pre-set style (e.g. dashed merge edges); only fill in defaults.
    if (e.style) return e;
    return { ...e, style: { stroke: edgeColors.stageFlow, strokeWidth: 1.5 } };
  }

  if (debateChainState && debateChainState.isExpanded) {
    const debateIdx = STAGES.indexOf('debate');
    const debateX = debateIdx * (subStageBox.width + subStageGap);
    const chain = layoutDebateChain({
      ...debateChainState,
      parentRect: { x: debateX, y: 0, width: subStageBox.width, height: subStageBox.height },
      parentNodeId: `substage:debate`,
    });
    nodes.push(...chain.nodes);
    edges.push(...chain.edges.map(applyDefaultEdgeStyle));
  }

  if (alignmentChainState && alignmentChainState.isExpanded) {
    const alignmentIdx = STAGES.indexOf('alignment');
    const alignmentX = alignmentIdx * (subStageBox.width + subStageGap);
    const chain = layoutAlignmentChain({
      ...alignmentChainState,
      parentRect: {
        x: alignmentX,
        y: 0,
        width: subStageBox.width,
        height: subStageBox.height,
      },
      parentNodeId: `substage:alignment`,
    });
    nodes.push(...chain.nodes);
    edges.push(...chain.edges.map(applyDefaultEdgeStyle));
  }

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
    case 'conclusions':  return wg.surviving_claims?.length ? 'done' : 'not_run';
    // 'wg-map' is no longer part of STAGES, but WorkingGroupSubstage still
    // includes it (for URL backward-compat). This call site only passes
    // pipeline substages, so the default just guards the type.
    default:             return 'not_run';
  }
}
