import { Stack, Text, Badge, Group, Table } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { PersonaChip } from '../../primitives/PersonaChip';

export function AdversarialPanel({
  wg,
  personaName,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
}) {
  const { adversarial_marks, candidate_questions } = wg;

  if (!adversarial_marks.length) {
    return <Text c="dimmed" size="sm">No adversarial marks recorded.</Text>;
  }

  const questionById = new Map(candidate_questions.map((cq) => [cq.candidate_id, cq]));
  const cannotAnswerCount = adversarial_marks.filter((m) => !m.could_answer_from_priors).length;

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {adversarial_marks.length} marks — {cannotAnswerCount} flagged as requiring external research.
      </Text>
      <Table striped withTableBorder withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Question</Table.Th>
            <Table.Th>Marked by</Table.Th>
            <Table.Th>Can answer from priors?</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {adversarial_marks.map((mark, idx) => {
            const cq = questionById.get(mark.candidate_id);
            return (
              <Table.Tr key={idx}>
                <Table.Td>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">{mark.candidate_id}</Text>
                    <Text size="sm">{cq?.question ?? mark.candidate_id}</Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <PersonaChip personaId={mark.marker_persona_id} label={personaName(mark.marker_persona_id)} />
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Badge
                      color={mark.could_answer_from_priors ? 'green' : 'orange'}
                      variant="light"
                    >
                      {mark.could_answer_from_priors ? 'yes' : 'no — needs research'}
                    </Badge>
                  </Group>
                  {mark.rationale ? (
                    <Text size="xs" c="dimmed" mt={4}>{mark.rationale}</Text>
                  ) : null}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
