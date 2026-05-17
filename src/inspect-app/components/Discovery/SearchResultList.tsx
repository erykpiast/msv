import { Accordion, Stack, Anchor, Text, Group, Badge } from '@mantine/core';
import type { WebSearchPayload } from '../../../inspect/types';
import { Empty } from '../../primitives/Empty';
import { safeUrl } from '../../utils/format';

export function SearchResultList({ results }: { results: WebSearchPayload[] }) {
  if (!results.length) {
    return <Empty message="No web-search results captured for this discovery run." />;
  }
  return (
    <Accordion variant="separated" multiple>
      {results.map((entry, idx) => {
        const n = entry.results.length;
        const err = entry.error ?? null;
        return (
          <Accordion.Item key={`${entry.query}-${idx}`} value={`${entry.query}-${idx}`}>
            <Accordion.Control>
              <Group justify="space-between">
                <Text fw={500}>{entry.query}</Text>
                {err ? (
                  <Badge color="red" variant="light">
                    error: {err.code || 'unknown'}
                  </Badge>
                ) : (
                  <Text size="xs" c="dimmed">
                    {n} result{n === 1 ? '' : 's'}
                  </Text>
                )}
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              {err ? (
                <Text size="sm" c="red">
                  The Anthropic web_search tool returned an error
                  {err.code ? ` (${err.code})` : ''}. No results were captured.
                </Text>
              ) : n === 0 ? (
                <Text size="sm" c="dimmed">
                  The query returned zero results.
                </Text>
              ) : (
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
              )}
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}
