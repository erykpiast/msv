import type { NodeProps, Node } from '@xyflow/react';
import { Text, Badge, Stack } from '@mantine/core';
import type { Move } from '../../../../inspect/types';
import { FlowCard } from '../FlowCard';

const TYPE_COLOR: Record<Move['type'], string> = {
  Claim: '#339af0',
  Support: '#20c997',
  Rebut: '#fa5252',
  Concede: '#fd7e14',
  Question: '#cc5de8',
};

type MoveNodeData = {
  move: Move;
};

type MoveNodeType = Node<MoveNodeData, 'evidenceMove'>;

export function MoveNode({ data }: NodeProps<MoveNodeType>) {
  const { move } = data;
  const label = move.nickname ?? move.move_id;
  const borderColor = TYPE_COLOR[move.type] ?? '#868e96';

  return (
    <FlowCard
      borderColor={borderColor}
      popover={
        <Stack gap="xs">
          <Text size="xs" c="dimmed" fw={600}>
            Move: {move.move_id}
          </Text>
          <Badge
            size="xs"
            variant="light"
            style={{ borderColor, color: borderColor, background: `${borderColor}22` }}
          >
            {move.type}
          </Badge>
          <Text size="sm">{move.content}</Text>
          {move.evidence_basis ? (
            <Text size="xs" c="dimmed">
              Evidence basis: {move.evidence_basis}
            </Text>
          ) : null}
        </Stack>
      }
    >
      <Text size="xs" fw={600} lineClamp={1} title={label}>
        {label}
      </Text>
      <Badge
        size="xs"
        color={TYPE_COLOR[move.type] ? undefined : 'gray'}
        variant="light"
        style={{ borderColor, color: borderColor, background: `${borderColor}22` }}
      >
        {move.type}
      </Badge>
    </FlowCard>
  );
}
