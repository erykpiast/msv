import type { NodeProps, Node } from '@xyflow/react';
import { Text, Stack } from '@mantine/core';
import type { Territory } from '../../../../inspect/types';
import { FlowCard } from '../FlowCard';

type TerritoryNodeData = {
  territory: Territory | null;
};

type TerritoryNodeType = Node<TerritoryNodeData, 'mapTerritory'>;

export function TerritoryNode({ data }: NodeProps<TerritoryNodeType>) {
  const { territory } = data;
  const label = territory?.name ?? 'Territory';

  return (
    <FlowCard
      borderColor="#868e96"
      popover={
        <Stack gap="xs">
          <Text size="xs" c="dimmed" fw={600}>
            Territory: {territory?.territory_id ?? '—'}
          </Text>
          <Text size="sm" fw={600}>
            {label}
          </Text>
          {territory?.description && (
            <Text size="sm">{territory.description}</Text>
          )}
          {territory?.rationale && (
            <Text size="xs" c="dimmed">
              {territory.rationale}
            </Text>
          )}
        </Stack>
      }
    >
      <Text size="xs" c="dimmed" fw={500}>
        Territory
      </Text>
      <Text size="xs" fw={700} lineClamp={1} title={label}>
        {label}
      </Text>
    </FlowCard>
  );
}
