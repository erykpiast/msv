import { Stack, Text, Badge, Group } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { Card } from '../../primitives/Card';
import { PersonaChip } from '../../primitives/PersonaChip';
import { personaColor } from '../../theme/personas';

export function IdeationPanel({
  wg,
  personaName,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
}) {
  const { candidate_questions } = wg;

  if (!candidate_questions.length) {
    return <Text c="dimmed" size="sm">No candidate questions recorded.</Text>;
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {candidate_questions.length} candidate question{candidate_questions.length === 1 ? '' : 's'} generated independently before adversarial pre-check.
      </Text>
      {candidate_questions.map((cq) => (
        <Card key={cq.candidate_id} accentColor={personaColor(cq.by_persona_id)}>
          <Stack gap="xs">
            <Group gap="xs">
              <Text size="xs" c="dimmed" fw={600}>{cq.candidate_id}</Text>
              <PersonaChip personaId={cq.by_persona_id} label={personaName(cq.by_persona_id)} />
              <Badge variant="light" color="blue" size="xs">
                confidence {cq.predicted_confidence}
              </Badge>
            </Group>
            <Text size="sm" lh={1.5}>{cq.question}</Text>
            {cq.rationale ? (
              <Text size="xs" c="dimmed" lh={1.4}>{cq.rationale}</Text>
            ) : null}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
