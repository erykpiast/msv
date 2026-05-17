import { Stack, Text, Badge, Group } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { Card } from '../../primitives/Card';
import { PersonaChip } from '../../primitives/PersonaChip';
import { personaColor } from '../../theme/personas';

const ORIGIN_COLOR: Record<string, string> = {
  aligned: 'blue',
};

function originColor(origin: string): string {
  return ORIGIN_COLOR[origin] ?? 'grape';
}

function originLabel(origin: string): string {
  if (origin === 'aligned') return 'aligned (joint top)';
  if (origin.startsWith('minority_')) return `minority — ${origin.slice('minority_'.length)}`;
  return origin;
}

export function AlignmentPanel({
  wg,
  personaName,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
}) {
  const aligned_questions = wg.aligned_questions ?? [];

  if (!aligned_questions.length) {
    return <Text c="dimmed" size="sm">No aligned questions produced.</Text>;
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {aligned_questions.length} aligned question{aligned_questions.length === 1 ? '' : 's'} after deterministic minority-protection step.
      </Text>
      {aligned_questions.map((aq) => (
        <Card key={aq.aligned_id} accentColor={aq.by_persona_id ? personaColor(aq.by_persona_id) : undefined}>
          <Stack gap="xs">
            <Group gap="xs">
              <Text size="xs" c="dimmed" fw={600}>{aq.aligned_id}</Text>
              <Badge variant="light" color={originColor(aq.origin)} size="xs">
                {originLabel(aq.origin)}
              </Badge>
              {aq.by_persona_id ? (
                <PersonaChip personaId={aq.by_persona_id} label={personaName(aq.by_persona_id)} />
              ) : null}
            </Group>
            <Text size="sm" lh={1.5} fw={500}>{aq.question}</Text>
            {aq.source_candidate_ids.length > 0 ? (
              <Text size="xs" c="dimmed">
                source: {aq.source_candidate_ids.join(', ')}
              </Text>
            ) : null}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
