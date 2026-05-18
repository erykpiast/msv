import { memo } from 'react';
import { Text } from '@mantine/core';
import { type Node, type NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { useSetRoute } from '../../hooks/useHashRoute';
import { useProgressOverlay } from '../../ViewContext';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type SynthesisNodeData = { view: InvestigationView; status: StageStatus };
type SynthesisNodeType = Node<SynthesisNodeData, 'synthesis'>;

export const SynthesisNode = memo(function SynthesisNode({ data }: NodeProps<SynthesisNodeType>) {
  const { view, status } = data;
  const setRoute = useSetRoute();
  const overlay = useProgressOverlay();
  const isLive = overlay.inProgressStages.has('synthesis');
  const findings = view.synthesis?.headline_findings.length ?? 0;
  return (
    <StageNodeShell
      title="Synthesis"
      status={status}
      isLive={isLive}
      summary={<Text size="sm" c="dimmed">{findings} findings</Text>}
      onActivate={() => setRoute({ canvas: 'pipeline', expanded: [], leaf: { kind: 'synthesis' } })}
    />
  );
});
