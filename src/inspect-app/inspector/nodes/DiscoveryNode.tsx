import { memo } from 'react';
import { Anchor, Badge, List, Spoiler, Stack, Text } from '@mantine/core';
import type { Node, NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { useExpandedStages } from '../../hooks/useExpandedStages';
import { useCanvasRoute } from '../../hooks/useHashRoute';
import { useProgressOverlay } from '../../ViewContext';
import { expandedWidth } from '../layout/pipelineLayout';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type DiscoveryNodeData = { view: InvestigationView; status: StageStatus };
type DiscoveryNodeType = Node<DiscoveryNodeData, 'discovery'>;

export const DiscoveryNode = memo(function DiscoveryNode({ data }: NodeProps<DiscoveryNodeType>) {
  const { view, status } = data;
  const { toggle, isExpanded } = useExpandedStages();
  const { route, setRoute } = useCanvasRoute();
  const overlay = useProgressOverlay();
  const isLive = overlay.inProgressStages.has('discovery');
  const exp = isExpanded('discovery');

  const cand = view.discovery.candidate_personas.length;
  const sel = view.discovery.selected_persona_ids.length;
  const queries = view.discovery.search_queries.length;

  const selectedSet = new Set(view.discovery.selected_persona_ids);
  const selectedPersonas = view.discovery.candidate_personas.filter((p) => selectedSet.has(p.id));
  const rejectedPersonas = view.discovery.candidate_personas.filter((p) => !selectedSet.has(p.id));

  const renderPersonaItem = (p: typeof view.discovery.candidate_personas[number], selected: boolean) => {
    const dist = view.discovery.selection_distinctness[p.id];
    return (
      <List.Item
        key={p.id}
        c={selected ? undefined : 'dimmed'}
        onClick={(e) => {
          e.stopPropagation();
          if (route.canvas === 'pipeline') {
            setRoute({ ...route, leaf: { kind: 'persona', id: p.id } });
          }
        }}
        style={{ cursor: 'pointer' }}
      >
        {p.name} · {dist?.toFixed(2) ?? '—'}
      </List.Item>
    );
  };

  const listStyles = { itemWrapper: { paddingLeft: 0 } };

  const summary = exp ? (
    <Stack gap="xs">
      {queries > 0 && (
        <Stack gap={2}>
          <Text size="xs" c="dimmed" fw={600}>Search queries ({queries})</Text>
          <List size="sm" spacing={2} pl="md" styles={listStyles}>
            {view.discovery.search_queries.map((q, i) => (
              <List.Item key={i}>{q}</List.Item>
            ))}
          </List>
        </Stack>
      )}
      <Stack gap={2}>
        <Text size="xs" c="dimmed" fw={600}>Personas ({sel})</Text>
        <List size="sm" spacing={2} pl="md" styles={listStyles}>
          {selectedPersonas.map((p) => renderPersonaItem(p, true))}
        </List>
      </Stack>
      {rejectedPersonas.length > 0 && (
        <Spoiler
          maxHeight={0}
          showLabel={`Show rejected personas (${rejectedPersonas.length})`}
          hideLabel="Hide rejected personas"
        >
          <List size="sm" spacing={2} pl="md" styles={listStyles}>
            {rejectedPersonas.map((p) => renderPersonaItem(p, false))}
          </List>
        </Spoiler>
      )}
      <Anchor onClick={(e) => { e.stopPropagation(); toggle('discovery'); }} size="xs">
        [collapse]
      </Anchor>
    </Stack>
  ) : (
    <>
      <Text size="sm" c="dimmed">{cand} candidates → {sel} selected</Text>
      <Badge size="xs" variant="light">{queries} queries</Badge>
    </>
  );

  return (
    <StageNodeShell
      title="Discovery"
      status={status}
      isLive={isLive}
      summary={summary}
      width={exp ? expandedWidth.discovery : undefined}
      onActivate={exp ? undefined : () => toggle('discovery')}
      ariaExpanded={exp}
    />
  );
});
