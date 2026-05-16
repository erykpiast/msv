import { Stack, Title, Alert, Text, Badge, Group } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { usePersonaName } from '../../hooks/usePersonaName';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { SubQuestionCard } from './SubQuestionCard';
import { Card } from '../../primitives/Card';
import { PersonaChip } from '../../primitives/PersonaChip';
import type { Territory } from '../../../inspect/types';

function TerritoryCard({
  territory,
  personaName,
}: {
  territory: Territory;
  personaName: (id: string) => string;
}) {
  const tid = territory.id ?? territory.territory_id;
  return (
    <Card>
      <Stack gap="xs">
        <Group gap="xs" justify="space-between">
          <Text size="xs" c="dimmed" fw={600}>{tid}</Text>
          {territory.pair_distinctness_score != null ? (
            <Badge size="xs" variant="light" color="gray">
              distinctness {territory.pair_distinctness_score}
            </Badge>
          ) : null}
        </Group>
        <Text fw={600}>{territory.name}</Text>
        {territory.description ? (
          <Text size="sm" c="dimmed" lh={1.5}>{territory.description}</Text>
        ) : null}
        {territory.rationale ? (
          <Text size="xs" c="dimmed" lh={1.4}>{territory.rationale}</Text>
        ) : null}
        {territory.assigned_pair?.length > 0 ? (
          <Group gap="xs">
            <Text size="xs" c="dimmed">assigned:</Text>
            {territory.assigned_pair.map((pid: string) => (
              <PersonaChip key={pid} personaId={pid} label={personaName(pid)} />
            ))}
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}

export function Coordinator() {
  const view = useViewContext();
  const { coordinator } = view;
  const personaName = usePersonaName();
  const isV5 = view.schema_version === 'v5';

  const initial = coordinator.initial;
  const spawn = coordinator.spawn;
  const territories = coordinator.territories ?? [];

  if (isV5) {
    return (
      <Section title="Coordinator — territories">
        {territories.length > 0 ? (
          <Stack gap="sm">
            {territories.map((t) => (
              <TerritoryCard key={t.id ?? t.territory_id} territory={t} personaName={personaName} />
            ))}
          </Stack>
        ) : (
          <Empty message="Coordinator has not produced territories yet." />
        )}
      </Section>
    );
  }

  return (
    <Section title="Coordinator decisions">
      <Stack gap="lg">
        <Stack gap="xs">
          <Title order={4}>Initial decomposition</Title>
          {initial && initial.sub_questions.length > 0 ? (
            <Stack gap="sm">
              {initial.sub_questions.map((sq) => (
                <SubQuestionCard key={sq.id} sq={sq} personaName={personaName} />
              ))}
            </Stack>
          ) : (
            <Empty message="Coordinator has not produced an initial decomposition yet." />
          )}
        </Stack>

        <Stack gap="xs">
          <Title order={4}>Spawn round</Title>
          {!spawn ? (
            <Empty message="Spawn round has not been executed for this investigation." />
          ) : spawn.declined ? (
            <Alert color="gray" variant="light" title="Spawn declined">
              <Text size="sm">
                {spawn.reason ? `Reason: ${spawn.reason}` : 'Coordinator chose not to spawn new sub-questions.'}
              </Text>
            </Alert>
          ) : spawn.sub_questions.length > 0 ? (
            <Stack gap="sm">
              {spawn.sub_questions.map((sq) => (
                <SubQuestionCard key={sq.id} sq={sq} personaName={personaName} />
              ))}
            </Stack>
          ) : (
            <Empty message="Spawn round has not been executed for this investigation." />
          )}
        </Stack>
      </Stack>
    </Section>
  );
}
