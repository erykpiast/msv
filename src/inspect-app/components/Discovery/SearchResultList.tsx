import { Accordion, Stack, Anchor, Text, Group } from '@mantine/core';
import type { WebSearchPayload } from '../../../inspect/types';
import { Empty } from '../../primitives/Empty';
import { safeUrl } from '../../utils/format';

export function SearchResultList({ results }: { results: WebSearchPayload[] }) {
  if (!results.length) {
    return (
      <Empty
        message="No web-search results captured yet."
        hint="Phase 2 will populate this once anthropic.js widens the response capture."
      />
    );
  }
  return (
    <Accordion variant="separated" multiple>
      {results.map((entry, idx) => (
        <Accordion.Item key={`${entry.query}-${idx}`} value={`${entry.query}-${idx}`}>
          <Accordion.Control>
            <Group justify="space-between">
              <Text fw={500}>{entry.query}</Text>
              <Text size="xs" c="dimmed">
                {entry.results.length} result{entry.results.length === 1 ? '' : 's'}
              </Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              {entry.results.map((r, j) => (
                <div key={`${r.url}-${j}`}>
                  <Anchor href={safeUrl(r.url)} target="_blank" rel="noopener noreferrer">
                    {r.title || r.url}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {r.url}
                    {r.page_age ? ` · ${r.page_age}` : ''}
                  </Text>
                </div>
              ))}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}
