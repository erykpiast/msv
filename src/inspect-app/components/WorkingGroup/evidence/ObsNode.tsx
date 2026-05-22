import type { NodeProps, Node } from '@xyflow/react';
import { Text, Stack } from '@mantine/core';
import type { Observation } from '../../../../inspect/types';
import { PersonaChip } from '../../../primitives/PersonaChip';
import { FlowCard } from '../FlowCard';

type ObsNodeData = {
  observation: Observation;
};

type ObsNodeType = Node<ObsNodeData, 'evidenceObs'>;

export function ObsNode({ data }: NodeProps<ObsNodeType>) {
  const { observation } = data;
  const label = observation.nickname ?? observation.observation_id;

  return (
    <FlowCard
      borderColor="#ae3ec9"
      popover={
        <Stack gap="xs">
          <Text size="xs" c="dimmed" fw={600}>
            Observation: {observation.observation_id}
          </Text>
          <PersonaChip personaId={observation.by_persona_id} size="xs" />
          <Text size="sm">{observation.content}</Text>
        </Stack>
      }
    >
      <Text size="xs" fw={600} lineClamp={1} title={label}>
        {label}
      </Text>
      <PersonaChip personaId={observation.by_persona_id} size="xs" />
    </FlowCard>
  );
}
