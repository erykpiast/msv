import { memo } from 'react';
import { Badge, Group } from '@mantine/core';
import { type Node, type NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { useSetRoute } from '../../hooks/useHashRoute';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type ForumStageNodeData = { view: InvestigationView; status: StageStatus };
type ForumStageNodeType = Node<ForumStageNodeData, 'forumStage'>;

export const ForumStageNode = memo(function ForumStageNode({ data }: NodeProps<ForumStageNodeType>) {
  const { view, status } = data;
  const setRoute = useSetRoute();
  const nodes = view.forum.nodes.length;
  const contras = view.forum.contradiction_edges.length;
  const openQs = view.forum.nodes.filter((n) => n.has_open_question).length;
  return (
    <StageNodeShell
      title="Forum"
      status={status}
      summary={
        <Group gap={4}>
          <Badge size="xs" variant="light">{nodes} nodes</Badge>
          {contras > 0 && <Badge size="xs" color="red" variant="light">{contras} contra</Badge>}
          {openQs > 0 && <Badge size="xs" color="yellow" variant="light">{openQs} open</Badge>}
        </Group>
      }
      onActivate={() => setRoute({ canvas: 'forum' })}
    />
  );
});
