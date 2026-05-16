import { Stack, Text, Group, Badge, Spoiler } from '@mantine/core';
import type { Persona } from '../../../inspect/types';
import { personaColor } from '../../theme/personas';
import { Card } from '../../primitives/Card';

export function PersonaCard({
  persona,
  selected,
  distinctness,
}: {
  persona: Persona;
  selected: boolean;
  distinctness?: number;
}) {
  const color = personaColor(persona.id);
  return (
    <Card accentColor={color} style={{ opacity: selected ? 1 : 0.65 }}>
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Text fw={600}>{persona.name}</Text>
            <Text size="xs" c="dimmed">
              {persona.id}
            </Text>
          </Stack>
          <Group gap={6}>
            {selected ? (
              <Badge color="green" variant="light" size="sm">
                selected
              </Badge>
            ) : (
              <Badge color="gray" variant="light" size="sm">
                cut
              </Badge>
            )}
            {typeof distinctness === 'number' ? (
              <Badge color="blue" variant="outline" size="sm">
                δ {distinctness.toFixed(2)}
              </Badge>
            ) : null}
          </Group>
        </Group>
        {persona.tradition ? (
          <Text size="sm" fw={500} c="dimmed">
            {persona.tradition}
          </Text>
        ) : null}
        {persona.stance ? (
          <Text size="sm" lh={1.5}>
            <Text component="span" fw={600}>
              Stance.{' '}
            </Text>
            {persona.stance}
          </Text>
        ) : null}
        {persona.description ? (
          <Spoiler maxHeight={72} showLabel="More" hideLabel="Less">
            <Text size="sm" lh={1.5}>
              {persona.description}
            </Text>
          </Spoiler>
        ) : null}
      </Stack>
    </Card>
  );
}
