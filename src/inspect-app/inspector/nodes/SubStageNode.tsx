import React, { memo } from 'react';
import { Group, Paper, Stack, Text } from '@mantine/core';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { StageStatusPip } from '../StageStatusPip';
import { useCanvasRoute, type WorkingGroupSubstage } from '../../hooks/useHashRoute';
import type { WorkingGroupView, StageStatus } from '../../../inspect/types';
import { tokens } from '../../theme/tokens';

type SubStageNodeData = {
  wg: WorkingGroupView;
  substage: WorkingGroupSubstage;
  status: StageStatus;
};
type SubStageNodeType = Node<SubStageNodeData, 'subStage'>;

const LABEL: Record<WorkingGroupSubstage, string> = {
  ideation: 'Ideation',
  adversarial: 'Adversarial',
  alignment: 'Alignment',
  researcher: 'Researcher',
  observation: 'Observations',
  debate: 'Debate',
};

const SUMMARY: Record<WorkingGroupSubstage, (wg: WorkingGroupView) => string> = {
  ideation:    (w) => `${w.candidate_questions?.length ?? 0} candidates`,
  adversarial: (w) => `${w.adversarial_marks?.length ?? 0} flagged`,
  alignment:   (w) => `${w.aligned_questions?.length ?? 0} aligned questions`,
  researcher:  (w) => `${w.researcher_reports?.length ?? 0} reports`,
  observation: (w) => `${w.observations?.length ?? 0} observations`,
  debate:      (w) => `${w.moves?.length ?? 0} moves`,
};

export const SubStageNode = memo(function SubStageNode({ data }: NodeProps<SubStageNodeType>) {
  const { wg, substage, status } = data;
  const { route, setRoute } = useCanvasRoute();
  const handleInteract = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (route.canvas === 'wg') {
      setRoute({ ...route, substage, leaf: { kind: 'wgPanel', substage } });
    }
  };
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleInteract(e); }
  };
  return (
    <Paper
      withBorder p="sm"
      w={tokens.subStageBox.width}
      mih={tokens.subStageBox.height}
      role="button" tabIndex={0}
      onClick={handleInteract} onKeyDown={handleKey}
      style={{ cursor: 'pointer', opacity: status === 'not_run' ? 0.5 : 1 }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Stack gap={2}>
        <Group justify="space-between">
          <Text fw={600}>{LABEL[substage]}</Text>
          <StageStatusPip status={status} />
        </Group>
        <Text size="sm" c="dimmed">{SUMMARY[substage](wg)}</Text>
      </Stack>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </Paper>
  );
});
