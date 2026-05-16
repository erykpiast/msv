import { Tabs, Stack, Group, Badge, Text, Anchor, List, Alert } from '@mantine/core';
import { useState, useEffect } from 'react';
import { useViewContext } from '../../ViewContext';
import { Section } from '../../primitives/Section';
import { Empty } from '../../primitives/Empty';
import { ForumGraph } from './ForumGraph';
import { NodeDrawer } from './NodeDrawer';
import { PersonaMatrix } from './PersonaMatrix';
import { useHashRoute, parseRoute } from '../../hooks/useHashRoute';

export function Forum() {
  const view = useViewContext();
  const hasNodes = view.forum.nodes.length > 0;
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>('graph');
  const { route } = useHashRoute();

  useEffect(() => {
    const parsed = parseRoute(route);
    if (parsed.kind === 'node') {
      setActiveTab('graph');
      setSelectedNode(parsed.nodeId);
    } else if (parsed.kind === 'persona') {
      setActiveTab('matrix');
    } else if (parsed.kind === 'debate') {
      // Don't switch — the Debate section is rendered separately. But if the user
      // is already in Forum and clicks a matrix cell, the hash change should leave
      // them on the matrix tab; debates render in the parent section.
    }
  }, [route]);

  if (!hasNodes) {
    return (
      <Section title="Forum">
        <Empty message="Forum has not been constructed yet — no surviving claims to display." />
      </Section>
    );
  }

  const deadEnds =
    'dead_end_questions' in view.forum ? view.forum.dead_end_questions : [];

  return (
    <Section
      title="Forum"
      rightSlot={
        <Group gap="xs">
          <Badge color="blue" variant="light">
            {view.forum.nodes.length} nodes
          </Badge>
          <Badge color="red" variant="light">
            {view.forum.contradiction_edges.length} contradictions
          </Badge>
          {deadEnds.length > 0 ? (
            <Badge color="orange" variant="light">
              {deadEnds.length} dead end{deadEnds.length === 1 ? '' : 's'}
            </Badge>
          ) : null}
        </Group>
      }
    >
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List>
          <Tabs.Tab value="graph">Graph</Tabs.Tab>
          <Tabs.Tab value="threads">Debate threads</Tabs.Tab>
          <Tabs.Tab value="matrix">Persona matrix</Tabs.Tab>
          {deadEnds.length > 0 ? <Tabs.Tab value="dead_ends">Dead ends</Tabs.Tab> : null}
        </Tabs.List>
        <Tabs.Panel value="graph" pt="md">
          <Stack gap="md">
            <ForumGraph view={view} onNodeSelect={setSelectedNode} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="threads" pt="md">
          <Text size="sm" c="dimmed">
            Debate transcripts are rendered once in the{' '}
            <Anchor href="#debates">Pair debates section</Anchor> — clicking it scrolls to the
            full accordion without duplicating the move cards here.
          </Text>
        </Tabs.Panel>
        <Tabs.Panel value="matrix" pt="md">
          <PersonaMatrix />
        </Tabs.Panel>
        {deadEnds.length > 0 ? (
          <Tabs.Panel value="dead_ends" pt="md">
            <Alert color="orange" variant="light" title={`${deadEnds.length} question${deadEnds.length === 1 ? '' : 's'} reached dead ends`} mb="md">
              These questions were researched but yielded no usable findings.
            </Alert>
            <List spacing="sm">
              {deadEnds.map((d) => (
                <List.Item key={d.aligned_id}>
                  <Text size="sm" fw={500}>{d.aligned_id}</Text>
                  <Text size="xs" c="dimmed">{d.outcome_summary}</Text>
                </List.Item>
              ))}
            </List>
          </Tabs.Panel>
        ) : null}
      </Tabs>
      <NodeDrawer nodeId={selectedNode} onClose={() => setSelectedNode(null)} />
    </Section>
  );
}
