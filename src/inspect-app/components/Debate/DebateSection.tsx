import { Stack, Accordion, Group, Text, Badge } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { usePersonaName } from '../../hooks/usePersonaName';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { PersonaChip } from '../../primitives/PersonaChip';
import { ConfidenceChart } from './ConfidenceChart';
import { MoveCard } from './MoveCard';

export function DebateSection() {
  const view = useViewContext();
  const debateEntries = Object.entries(view.debates);
  const personaName = usePersonaName();

  if (!debateEntries.length) {
    return (
      <Section title="Pair debates">
        <Empty message="No pair debates have been executed yet." />
      </Section>
    );
  }

  return (
    <Section title="Pair debates">
      <Accordion variant="separated" multiple>
        {debateEntries.map(([sqId, debate]) => {
          const survivingIds = new Set(debate.surviving_claims.map((c) => c.originating_move_id));
          return (
            <Accordion.Item key={sqId} value={sqId} id={`debate-${sqId}`}>
              <Accordion.Control>
                <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="xs" c="dimmed" fw={600}>
                      {sqId}
                    </Text>
                    <Text fw={600} lh={1.4}>
                      {debate.sub_question?.question ?? 'Untitled sub-question'}
                    </Text>
                    <Group gap="xs">
                      {debate.pair.map((p) => (
                        <PersonaChip key={p.id} personaId={p.id} label={p.name} />
                      ))}
                    </Group>
                  </Stack>
                  <Stack gap={4} align="flex-end">
                    <Badge variant="light">{debate.moves.length} moves</Badge>
                    <Badge color="green" variant="light">
                      {debate.surviving_claims.length} surviving
                    </Badge>
                    {debate.terminated_by ? (
                      <Text size="xs" c="dimmed">
                        terminated by {debate.terminated_by}
                      </Text>
                    ) : null}
                  </Stack>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="md">
                  <ConfidenceChart trajectory={debate.confidence_trajectory} />
                  <Stack gap="sm">
                    {debate.moves.map((move) => (
                      <MoveCard
                        key={move.move_id}
                        move={move}
                        personaName={personaName}
                        isSurviving={survivingIds.has(move.move_id)}
                      />
                    ))}
                  </Stack>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    </Section>
  );
}
