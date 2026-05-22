import React, { memo } from 'react';
import { Group, Paper, Stack, Text } from '@mantine/core';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { StageStatusPip } from '../StageStatusPip';
import { useCanvasRoute, type WorkingGroupSubstage } from '../../hooks/useHashRoute';
import { useWgSubstage } from '../../ViewContext';
import type { WorkingGroupView, StageStatus } from '../../../inspect/types';
import { tokens } from '../../theme/tokens';

// SubStageNode is only rendered for the substages that appear in the pipeline
// (`STAGES` in workingGroupLayout.ts). 'wg-map' is no longer part of that
// pipeline — it's a top-level tab in the WG canvas — so it is excluded here.
type PipelineSubstage = Exclude<WorkingGroupSubstage, 'wg-map'>;

type SubStageNodeData = {
  wg: WorkingGroupView;
  substage: PipelineSubstage;
  status: StageStatus;
  territoryId: string;
};
type SubStageNodeType = Node<SubStageNodeData, 'subStage'>;

const LABEL: Record<PipelineSubstage, string> = {
  ideation: 'Ideation',
  adversarial: 'Adversarial',
  alignment: 'Alignment',
  researcher: 'Researcher',
  observation: 'Observations',
  debate: 'Debate',
  conclusions: 'Conclusions',
};

const SUMMARY: Record<PipelineSubstage, (wg: WorkingGroupView) => string> = {
  ideation:    (w) => `${w.candidate_questions?.length ?? 0} candidates`,
  adversarial: (w) => `${w.adversarial_marks?.length ?? 0} flagged`,
  alignment:   (w) => `${w.aligned_questions?.length ?? 0} aligned questions`,
  researcher:  (w) => `${w.researcher_reports?.length ?? 0} reports`,
  observation: (w) => `${w.observations?.length ?? 0} observations`,
  debate:      (w) => `${w.moves?.length ?? 0} moves`,
  conclusions: (w) => {
    const n = w.surviving_claims?.length ?? 0;
    return `${n} surviving claim${n === 1 ? '' : 's'}`;
  },
};

export const SubStageNode = memo(function SubStageNode({ data }: NodeProps<SubStageNodeType>) {
  const { wg, substage, status, territoryId } = data;
  const { route, setRoute } = useCanvasRoute();
  const liveSubstage = useWgSubstage(territoryId);
  const isLive = liveSubstage === substage;
  const effectiveStatus: StageStatus = isLive ? 'in_progress' : status;
  const handleInteract = () => {
    if (route.canvas === 'wg') {
      // The Debate and Alignment substages render their chains inline in the
      // canvas, so clicking them should not open the drawer. All other
      // substages still route to their wgPanel leaf, which is what renders
      // their detail body.
      const nextLeaf =
        substage === 'debate' || substage === 'alignment'
          ? undefined
          : ({ kind: 'wgPanel', substage } as const);
      setRoute({ ...route, substage, leaf: nextLeaf });
    }
  };
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleInteract(); }
  };
  return (
    <Paper
      withBorder p="sm"
      w={tokens.subStageBox.width}
      mih={tokens.subStageBox.height}
      role="button" tabIndex={0}
      onClick={handleInteract} onKeyDown={handleKey}
      data-status={effectiveStatus}
      style={{ cursor: 'pointer', opacity: effectiveStatus === 'not_run' ? 0.5 : 1 }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Stack gap={2}>
        <Group justify="space-between">
          <Text fw={600}>{LABEL[substage]}</Text>
          <StageStatusPip status={effectiveStatus} />
        </Group>
        <Text size="sm" c="dimmed">{SUMMARY[substage](wg)}</Text>
      </Stack>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="bottom" type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </Paper>
  );
});
