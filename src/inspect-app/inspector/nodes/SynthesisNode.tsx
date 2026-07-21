import { memo } from 'react';
import { Text } from '@mantine/core';
import { type Node, type NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { useSetRoute } from '../../hooks/useHashRoute';
import { useIsStageInProgress } from '../../ViewContext';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type SynthesisNodeData = { view: InvestigationView; status: StageStatus };
type SynthesisNodeType = Node<SynthesisNodeData, 'synthesis'>;

export const SynthesisNode = memo(function SynthesisNode({ data }: NodeProps<SynthesisNodeType>) {
  const { view, status } = data;
  const setRoute = useSetRoute();
  const isLive = useIsStageInProgress('synthesis');
  const findings = view.synthesis?.headline_findings.length ?? 0;
  const breadth = view.synthesis?.breadth;
  return (
    <StageNodeShell
      title="Synthesis"
      status={status}
      isLive={isLive}
      summary={
        <Text size="sm" c="dimmed">
          {findings} findings
          {breadth ? ` · ${breadth.n_areas} areas` : ''}
        </Text>
      }
      onActivate={() => setRoute({ canvas: 'pipeline', expanded: [], leaf: { kind: 'synthesis' } })}
    />
  );
});
