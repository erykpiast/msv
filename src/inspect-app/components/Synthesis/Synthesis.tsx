import { Stack, List, Alert, Title, Text } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { Markdown } from './Markdown';

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
