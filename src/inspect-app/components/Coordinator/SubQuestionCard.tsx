import { Stack, Group, Text, Progress, Anchor } from '@mantine/core';
import type { SubQ } from '../../../inspect/types';
import { Card } from '../../primitives/Card';
import { PersonaChip } from '../../primitives/PersonaChip';

export function SubQuestionCard({
  sq,
  personaName,
}: {
  sq: SubQ;
  personaName: (id: string) => string;
}) {
  const distinctness =
    typeof sq.pair_distinctness_score === 'number' ? sq.pair_distinctness_score : null;
  return (
    <Card>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Anchor href={`#debate-${sq.id}`} size="xs" c="dimmed" fw={600}>
            {sq.id}
          </Anchor>
          {distinctness !== null ? (
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                distinctness
              </Text>
              <Progress value={distinctness * 100} size="xs" w={80} radius="xs" />
              <Text size="xs" fw={600}>
                {distinctness.toFixed(2)}
              </Text>
            </Group>
          ) : null}
        </Group>
        <Text fw={600} lh={1.4}>
          {sq.question}
        </Text>
        {sq.rationale ? (
          <Text size="sm" c="dimmed" lh={1.5}>
            {sq.rationale}
          </Text>
        ) : null}
        {sq.assigned_pair?.length ? (
          <Group gap="xs">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Pair
            </Text>
            {sq.assigned_pair.map((pid) => (
              <PersonaChip key={pid} personaId={pid} label={personaName(pid)} />
            ))}
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}
