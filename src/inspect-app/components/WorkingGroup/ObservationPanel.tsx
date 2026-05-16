import { Stack, Text, Group, Badge } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { Card } from '../../primitives/Card';
import { PersonaChip } from '../../primitives/PersonaChip';
import { personaColor } from '../../theme/personas';

export function ObservationPanel({
  wg,
  personaName,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
}) {
  const { observations, researcher_reports } = wg;

  if (!observations.length) {
    return <Text c="dimmed" size="sm">No observations recorded.</Text>;
  }

  const findingMap = new Map(
    researcher_reports.flatMap((r) => r.findings.map((f) => [f.finding_id, f]))
  );

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {observations.length} observation{observations.length === 1 ? '' : 's'} synthesised from research findings.
      </Text>
      {observations.map((obs) => (
        <Card key={obs.observation_id} accentColor={personaColor(obs.by_persona_id)}>
          <Stack gap="xs">
            <Group gap="xs">
              <Text size="xs" c="dimmed" fw={600}>{obs.observation_id}</Text>
              <PersonaChip personaId={obs.by_persona_id} label={personaName(obs.by_persona_id)} />
            </Group>
            <Text size="sm" lh={1.5}>{obs.content}</Text>
            {obs.cited_finding_ids.length > 0 ? (
              <Group gap="xs">
                <Text size="xs" c="dimmed">cites:</Text>
                {obs.cited_finding_ids.map((fid) => {
                  const f = findingMap.get(fid);
                  return (
                    <Badge key={fid} size="xs" variant="outline" color="gray" title={f?.content ?? ''}>
                      {fid}
                    </Badge>
                  );
                })}
              </Group>
            ) : null}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
