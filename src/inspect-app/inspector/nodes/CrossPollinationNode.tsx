import { memo, useMemo } from 'react';
import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import type { Node, NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { useExpandedStages } from '../../hooks/useExpandedStages';
import { useCanvasRoute } from '../../hooks/useHashRoute';
import { useIsStageInProgress } from '../../ViewContext';
import { expandedWidth } from '../layout/pipelineLayout';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type CrossPollinationNodeData = { view: InvestigationView; status: StageStatus };
type CrossPollinationNodeType = Node<CrossPollinationNodeData, 'crossPollination'>;

export const CrossPollinationNode = memo(function CrossPollinationNode({ data }: NodeProps<CrossPollinationNodeType>) {
  const { view, status } = data;
  const { toggle, isExpanded } = useExpandedStages();
  const { route, setRoute } = useCanvasRoute();
  const isLive = useIsStageInProgress('cross_pollination');
  const exp = isExpanded('cross_pollination');

  const claimsWithReactions = useMemo(
    () =>
      view.cross_pollination.map((cp) => {
        const counts: Record<string, number> = { Rebut: 0, Concede: 0, Question: 0, Support: 0 };
        for (const r of cp.reactions) counts[r.type] = (counts[r.type] ?? 0) + 1;
        return { claim_id: cp.claim_id, target_node_id: cp.target_node_id, counts };
      }),
    [view.cross_pollination]
  );

  const summary = exp ? (
    <Stack gap={6}>
      <Group gap={4}>
        <Badge size="xs" color="red" variant="light">R</Badge>
        <Badge size="xs" color="orange" variant="light">C</Badge>
        <Badge size="xs" color="yellow" variant="light">Q</Badge>
        <Badge size="xs" color="green" variant="light">S</Badge>
        <Text size="xs" c="dimmed">rebut · concede · question · support</Text>
      </Group>
      {claimsWithReactions.map((row) => (
        <Group
          key={row.claim_id}
          gap={4}
          wrap="nowrap"
          onClick={(e) => {
            e.stopPropagation();
            if (route.canvas === 'pipeline') {
              setRoute({ ...route, leaf: { kind: 'claim', id: row.claim_id } });
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          <Text size="xs" c="dimmed" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.claim_id}
          </Text>
          <Badge size="xs" color="red" variant="light">{row.counts['Rebut'] ?? 0}</Badge>
          <Badge size="xs" color="orange" variant="light">{row.counts['Concede'] ?? 0}</Badge>
          <Badge size="xs" color="yellow" variant="light">{row.counts['Question'] ?? 0}</Badge>
          <Badge size="xs" color="green" variant="light">{row.counts['Support'] ?? 0}</Badge>
        </Group>
      ))}
      <Anchor onClick={(e) => { e.stopPropagation(); toggle('cross_pollination'); }} size="xs">
        [collapse]
      </Anchor>
    </Stack>
  ) : (
    <Text size="sm" c="dimmed">{view.cross_pollination.length} reaction batches</Text>
  );

  return (
    <StageNodeShell
      title="Cross-Pollination"
      status={status}
      isLive={isLive}
      summary={summary}
      width={exp ? expandedWidth.cross_pollination : undefined}
      onActivate={exp ? undefined : () => toggle('cross_pollination')}
      ariaExpanded={exp}
    />
  );
});
