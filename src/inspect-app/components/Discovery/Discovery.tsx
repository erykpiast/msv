import { Stack, Grid, Title, Group, Badge, Alert } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { SearchQueryList } from './SearchQueryList';
import { SearchResultList } from './SearchResultList';
import { PersonaCard } from './PersonaCard';

export function Discovery() {
  const view = useViewContext();
  const { discovery } = view;
  const selectedSet = new Set(discovery.selected_persona_ids);
  const selected = discovery.candidate_personas.filter((p) => selectedSet.has(p.id));
  const cut = discovery.candidate_personas.filter((p) => !selectedSet.has(p.id));

  const orderedSelected = discovery.selected_persona_ids
    .map((id) => selected.find((p) => p.id === id))
    .filter((p): p is (typeof selected)[number] => !!p);

  const zeroDiscovery = discovery.candidate_personas.length === 0;

  return (
    <Section title="Discovery">
      <Stack gap="lg">
        <Stack gap="xs">
          <Title order={4}>Search queries</Title>
          <SearchQueryList queries={discovery.search_queries} />
        </Stack>

        <Stack gap="xs">
          <Title order={4}>Web-search results</Title>
          <SearchResultList results={discovery.web_search_results} />
        </Stack>

        {zeroDiscovery ? (
          <Alert color="orange" variant="light" title="Discovery returned zero candidates">
            Discovery found no candidate personas — the selector fell back to fixed personas only
            ({discovery.fixed_personas.join(', ')}). This is almost certainly a discovery-prompt
            regression worth investigating.
          </Alert>
        ) : null}

        <Stack gap="xs">
          <Group justify="space-between">
            <Title order={4}>Personas</Title>
            <Group gap={6}>
              <Badge color="green" variant="light">
                {orderedSelected.length} selected
              </Badge>
              <Badge color="gray" variant="light">
                {cut.length} cut
              </Badge>
              {discovery.fixed_personas.length ? (
                <Badge color="blue" variant="light">
                  fixed: {discovery.fixed_personas.join(', ')}
                </Badge>
              ) : null}
            </Group>
          </Group>
          {orderedSelected.length || cut.length ? (
            <Grid gap="md">
              {[...orderedSelected, ...cut].map((p) => (
                <Grid.Col key={p.id} span={{ base: 12, md: 6, lg: 4 }}>
                  <PersonaCard
                    persona={p}
                    selected={selectedSet.has(p.id)}
                    distinctness={discovery.selection_distinctness[p.id]}
                  />
                </Grid.Col>
              ))}
            </Grid>
          ) : (
            <Empty message="No candidate personas returned by discovery." />
          )}
        </Stack>
      </Stack>
    </Section>
  );
}
