import { Stack, Title, Alert, Text } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { usePersonaName } from '../../hooks/usePersonaName';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { SubQuestionCard } from './SubQuestionCard';

export function Coordinator() {
  const view = useViewContext();
  const { coordinator } = view;
  const personaName = usePersonaName();

  const initial = coordinator.initial;
  const spawn = coordinator.spawn;

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
