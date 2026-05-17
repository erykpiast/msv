import { useMemo } from 'react';
import { Background, Controls, ReactFlow, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box, Group, Stack, Text } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { workingGroupLayout } from '../layout/workingGroupLayout';
import { SubStageNode } from '../nodes/SubStageNode';
import { PersonaChip } from '../../primitives/PersonaChip';
import { usePersonaName } from '../../hooks/usePersonaName';
import { ConfidenceChart } from '../../components/Debate/ConfidenceChart';
import { Empty } from '../../primitives/Empty';
import type { CanvasRoute } from '../../hooks/useHashRoute';

const nodeTypes: NodeTypes = { subStage: SubStageNode as NodeTypes[string] };

export function WorkingGroupCanvas({
  route,
  setRoute: _setRoute,
}: {
  route: Extract<CanvasRoute, { canvas: 'wg' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  const personaName = usePersonaName();
  const wg = view.working_groups?.[route.territoryId];
  const layout = useMemo(
    () => (wg ? workingGroupLayout(wg) : null),
    [wg]
  );
  if (!wg || !layout) {
    return <Empty message={`Working group "${route.territoryId}" not found.`} />;
  }
  const { nodes, edges } = layout;
  return (
    <Stack gap="md">
      <Box style={{ height: 220, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
        >
          <Background gap={24} color="#f3f4f6" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </Box>
      <Group gap="xs">
        <Text size="sm" c="dimmed">pair:</Text>
        {wg.pair.map((p) => (
          <PersonaChip key={p.id} personaId={p.id} label={personaName(p.id)} />
        ))}
      </Group>
      <ConfidenceChart trajectory={wg.confidence_trajectory} />
    </Stack>
  );
}
