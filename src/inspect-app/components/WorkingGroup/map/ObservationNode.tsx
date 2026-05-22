import type { NodeProps, Node } from '@xyflow/react';
import { Text, Stack } from '@mantine/core';
import type { Observation } from '../../../../inspect/types';
import { PersonaChip } from '../../../primitives/PersonaChip';
import { FlowCard } from '../FlowCard';

type ObservationNodeData = {
  observation: Observation;
};

type ObservationNodeType = Node<ObservationNodeData, 'mapObservation'>;

export function ObservationNode({ data }: NodeProps<ObservationNodeType>) {
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
          {observation.cited_finding_ids.length > 0 && (
            <Text size="xs" c="dimmed">
              cites: {observation.cited_finding_ids.join(', ')}
            </Text>
          )}
        </Stack>
      }
    >
      <Text size="xs" c="dimmed" fw={500}>
        Observation
      </Text>
      <Text size="xs" fw={600} lineClamp={1} title={label}>
        {label}
      </Text>
      <PersonaChip personaId={observation.by_persona_id} size="xs" />
    </FlowCard>
  );
}
