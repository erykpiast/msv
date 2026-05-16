import { Stack, Accordion, Group, Text, Badge, Tabs } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { usePersonaName } from '../../hooks/usePersonaName';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { PersonaChip } from '../../primitives/PersonaChip';
import { ConfidenceChart } from '../Debate/ConfidenceChart';
import { IdeationPanel } from './IdeationPanel';
import { AdversarialPanel } from './AdversarialPanel';
import { AlignmentPanel } from './AlignmentPanel';
import { ResearcherPanel } from './ResearcherPanel';
import { ObservationPanel } from './ObservationPanel';
import { DebatePanel } from './DebatePanel';

export function WorkingGroupSection() {
  const view = useViewContext();
  const wgEntries = Object.entries(view.working_groups ?? {});
  const personaName = usePersonaName();

  if (!wgEntries.length) {
    return (
      <Section title="Working groups">
        <Empty message="No working groups have been executed yet." />
      </Section>
    );
  }

  return (
    <Section title="Working groups">
      <Accordion variant="separated" multiple>
        {wgEntries.map(([tid, wg]) => {
          const territoryName = wg.territory?.name ?? tid;
          const alignedCount = wg.aligned_questions.length;
          const deadEndCount = wg.researcher_reports.filter((r) => r.outcome === 'dead_end').length;
          const survivingIds = new Set(wg.surviving_claims.map((c) => c.originating_move_id));

          return (
            <Accordion.Item key={tid} value={tid} id={`wg-${tid}`}>
              <Accordion.Control>
                <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
                  <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="xs" c="dimmed" fw={600}>
                      {tid}
                    </Text>
                    <Text fw={600} lh={1.4}>
                      {territoryName}
                    </Text>
                    {wg.territory?.description ? (
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {wg.territory.description}
                      </Text>
                    ) : null}
                    <Group gap="xs">
                      {wg.pair.map((p) => (
                        <PersonaChip key={p.id} personaId={p.id} label={personaName(p.id)} />
                      ))}
                    </Group>
                  </Stack>
                  <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
                    <Badge variant="light">{alignedCount} aligned questions</Badge>
                    <Badge color="green" variant="light">
                      {wg.surviving_claims.length} surviving claims
                    </Badge>
                    {deadEndCount > 0 ? (
                      <Badge color="orange" variant="light">
                        {deadEndCount} dead end{deadEndCount === 1 ? '' : 's'}
                      </Badge>
                    ) : null}
                    {wg.terminated_by ? (
                      <Text size="xs" c="dimmed">
                        terminated: {wg.terminated_by}
                      </Text>
                    ) : null}
                  </Stack>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Tabs defaultValue="ideation" keepMounted={false}>
                  <Tabs.List>
                    <Tabs.Tab value="ideation">Ideation</Tabs.Tab>
                    <Tabs.Tab value="adversarial">Adversarial</Tabs.Tab>
                    <Tabs.Tab value="alignment">Alignment</Tabs.Tab>
                    <Tabs.Tab value="researcher">Research</Tabs.Tab>
                    <Tabs.Tab value="observations">Observations</Tabs.Tab>
                    <Tabs.Tab value="debate">Debate</Tabs.Tab>
                  </Tabs.List>

                  <Tabs.Panel value="ideation" pt="md">
                    <IdeationPanel wg={wg} personaName={personaName} />
                  </Tabs.Panel>
                  <Tabs.Panel value="adversarial" pt="md">
                    <AdversarialPanel wg={wg} personaName={personaName} />
                  </Tabs.Panel>
                  <Tabs.Panel value="alignment" pt="md">
                    <AlignmentPanel wg={wg} personaName={personaName} />
                  </Tabs.Panel>
                  <Tabs.Panel value="researcher" pt="md">
                    <ResearcherPanel wg={wg} />
                  </Tabs.Panel>
                  <Tabs.Panel value="observations" pt="md">
                    <ObservationPanel wg={wg} personaName={personaName} />
                  </Tabs.Panel>
                  <Tabs.Panel value="debate" pt="md">
                    <DebatePanel wg={wg} personaName={personaName} survivingIds={survivingIds} />
                    <ConfidenceChart trajectory={wg.confidence_trajectory} />
                  </Tabs.Panel>
                </Tabs>
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    </Section>
  );
}
