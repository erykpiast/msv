import { Stack, Text, Badge, Group, Accordion, List, Anchor } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { Card } from '../../primitives/Card';

const OUTCOME_COLOR = {
  useful: 'green',
  partial: 'yellow',
  dead_end: 'red',
} as const;

export function ResearcherPanel({ wg }: { wg: WorkingGroupView }) {
  const researcher_reports = wg.researcher_reports ?? [];
  const aligned_questions = wg.aligned_questions ?? [];

  if (!researcher_reports.length) {
    return <Text c="dimmed" size="sm">No researcher reports recorded.</Text>;
  }

  const aqById = new Map(aligned_questions.map((aq) => [aq.aligned_id, aq]));

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {researcher_reports.length} researcher report{researcher_reports.length === 1 ? '' : 's'} — one per aligned question.
      </Text>
      <Accordion variant="separated" multiple>
        {researcher_reports.map((report) => {
          const aq = aqById.get(report.aligned_id);
          const outcomeColor = OUTCOME_COLOR[report.outcome] ?? 'gray';
          return (
            <Accordion.Item key={report.report_id} value={report.report_id}>
              <Accordion.Control>
                <Group gap="xs" wrap="nowrap">
                  <Badge color={outcomeColor} variant="filled" size="sm" style={{ flexShrink: 0 }}>
                    {report.outcome}
                  </Badge>
                  <Text size="sm" fw={500} lineClamp={1}>
                    {aq?.question ?? report.aligned_id}
                  </Text>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap="md">
                  {report.search_trace.length > 0 ? (
                    <div>
                      <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>
                        Search trace
                      </Text>
                      <List size="sm" spacing={2}>
                        {report.search_trace.map((q, i) => (
                          <List.Item key={i}>{q}</List.Item>
                        ))}
                      </List>
                    </div>
                  ) : null}
                  {report.findings.length > 0 ? (
                    <div>
                      <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>
                        Findings ({report.findings.length})
                      </Text>
                      <Stack gap="xs">
                        {report.findings.map((f) => (
                          <Card key={f.finding_id}>
                            <Stack gap="xs">
                              <Group gap="xs">
                                <Text size="xs" c="dimmed">{f.finding_id}</Text>
                                {f.quality ? (
                                  <Badge size="xs" variant="light" color="gray">{f.quality}</Badge>
                                ) : null}
                                {f.source_url ? (
                                  <Anchor href={f.source_url} size="xs" target="_blank">
                                    {f.source_title ?? f.source_url}
                                  </Anchor>
                                ) : null}
                              </Group>
                              <Text size="sm" lh={1.5}>{f.content}</Text>
                            </Stack>
                          </Card>
                        ))}
                      </Stack>
                    </div>
                  ) : (
                    <Text size="sm" c="dimmed">No findings.</Text>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    </Stack>
  );
}
