import { Stack, Group, Title, Text, Alert, Anchor, Grid } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { StatusPill } from './StatusPill';
import { BudgetBar } from './BudgetBar';
import { Section } from '../../primitives/Section';
import { formatDuration } from '../../utils/format';

export function Header() {
  const view = useViewContext();
  const investigating = view.status === 'investigating';

  return (
    <Section title="Overview">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4} style={{ maxWidth: 720 }}>
            <Title order={3} fw={500} lh={1.4}>
              {view.raw_capture}
            </Title>
            <Group gap="md">
              <StatusPill status={view.status} />
              <Text size="sm" c="dimmed">
                model: <Text component="span" fw={500}>{view.model ?? '—'}</Text>
              </Text>
              <Text size="sm" c="dimmed">
                runtime: <Text component="span" fw={500}>{formatDuration(view.budget.runtime_ms)}</Text>
              </Text>
              {view.parent_id ? (
                <Anchor href={`?id=${encodeURIComponent(view.parent_id)}`} size="sm">
                  parent ↗
                </Anchor>
              ) : null}
            </Group>
          </Stack>
        </Group>

        {investigating ? (
          <Alert color="yellow" variant="light">
            Partial transcript — investigation still in progress. Some stages may be missing or
            incomplete.
          </Alert>
        ) : null}

        <Grid gap="md">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <BudgetBar
              label="Executor calls"
              used={view.budget.used_executor_calls}
              max={view.budget.max_executor_calls}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <BudgetBar
              label="Tokens"
              used={view.budget.used_total_tokens}
              max={view.budget.max_total_tokens}
            />
          </Grid.Col>
        </Grid>
      </Stack>
    </Section>
  );
}
