import { memo } from 'react';
import { Anchor, Stack, Text } from '@mantine/core';
import type { Node, NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { useExpandedStages } from '../../hooks/useExpandedStages';
import { useSetRoute } from '../../hooks/useHashRoute';
import { useProgressOverlay } from '../../ViewContext';
import { expandedWidth } from '../layout/pipelineLayout';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type CoordinatorNodeData = { view: InvestigationView; status: StageStatus };
type CoordinatorNodeType = Node<CoordinatorNodeData, 'coordinator'>;

export const CoordinatorNode = memo(function CoordinatorNode({ data }: NodeProps<CoordinatorNodeType>) {
  const { view, status } = data;
  const { toggle, isExpanded } = useExpandedStages();
  const setRoute = useSetRoute();
  const overlay = useProgressOverlay();
  const isLive = overlay.inProgressStages.has('coordinator');
  const exp = isExpanded('coordinator');

  const territories = view.coordinator.territories.length;

  const summary = exp ? (
    <Stack gap="xs">
      {view.coordinator.territories.map((t) => (
        <div
          key={t.territory_id}
          onClick={(e) => {
            e.stopPropagation();
            setRoute({ canvas: 'wg', territoryId: t.territory_id });
          }}
          style={{ cursor: 'pointer', padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}
        >
          <Text size="sm" fw={500}>{t.name}</Text>
          <Text size="xs" c="dimmed" lineClamp={2}>{t.description}</Text>
        </div>
      ))}
      <Anchor onClick={(e) => { e.stopPropagation(); toggle('coordinator'); }} size="xs">
        [collapse]
      </Anchor>
    </Stack>
  ) : (
    <Text size="sm" c="dimmed">{territories} territories</Text>
  );

  return (
    <StageNodeShell
      title="Coordinator"
      status={status}
      isLive={isLive}
      summary={summary}
      width={exp ? expandedWidth.coordinator : undefined}
      onActivate={exp ? undefined : () => toggle('coordinator')}
      ariaExpanded={exp}
    />
  );
});
