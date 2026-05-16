import { Stack, List, Alert, Title, Text, Badge, Group } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { Markdown } from './Markdown';

const ORIGIN_COLOR: Record<string, string> = {
  aligned: 'blue',
};

function originColor(origin: string): string {
  return ORIGIN_COLOR[origin] ?? 'grape';
}

export function Synthesis() {
  const view = useViewContext();
  const synth = view.synthesis;

  if (!synth) {
    return (
      <Section title="Synthesis">
        <Empty
          message="Synthesis has not run yet."
          hint="It produces after the forum stage completes."
        />
      </Section>
    );
  }

  return (
    <Section title="Synthesis">
      <Stack gap="lg">
        {synth.headline_findings.length ? (
          <Stack gap="xs">
            <Title order={4}>Headline findings</Title>
            <List type="ordered" size="sm" spacing="xs">
              {synth.headline_findings.map((f, idx) => (
                <List.Item key={idx}>
                  <Text fw={500} lh={1.5}>
                    {f}
                  </Text>
                </List.Item>
              ))}
            </List>
          </Stack>
        ) : null}

        {synth.open_tensions.length ? (
          <Alert color="yellow" variant="light" title="Open tensions">
            <List size="sm" spacing={4}>
              {synth.open_tensions.map((t, idx) => (
                <List.Item key={idx}>{t}</List.Item>
              ))}
            </List>
          </Alert>
        ) : null}

        {synth.question_landscape && synth.question_landscape.length > 0 ? (
          <Stack gap="xs">
            <Title order={4}>Question landscape</Title>
            <Stack gap="md">
              {synth.question_landscape.map((territory) => (
                <Stack key={territory.territory_id} gap="xs">
                  <Text fw={600} size="sm">
                    [{territory.territory_name || territory.territory_id}]
                  </Text>
                  <Stack gap={4}>
                    {territory.questions.map((q, qi) => (
                      <Group key={qi} gap="xs" wrap="nowrap" align="flex-start">
                        <Badge
                          size="xs"
                          variant="light"
                          color={originColor(q.origin)}
                          style={{ flexShrink: 0, marginTop: 2 }}
                        >
                          {q.origin === 'aligned' ? 'aligned' : q.origin.replace('minority_', 'minority ')}
                        </Badge>
                        <Text size="sm" lh={1.5}>{q.question}</Text>
                      </Group>
                    ))}
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Stack>
        ) : null}

        {synth.dead_end_summary ? (
          <Alert color="orange" variant="light" title="Dead ends">
            <Text size="sm">{synth.dead_end_summary}</Text>
          </Alert>
        ) : null}

        {synth.report ? (
          <Stack gap="xs">
            <Title order={4}>Report</Title>
            <Markdown>{synth.report}</Markdown>
          </Stack>
        ) : null}
      </Stack>
    </Section>
  );
}
