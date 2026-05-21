import { useMemo } from 'react';
import { ReactFlow, Background, Controls, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Text } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { layoutWgMap } from './wgMapLayout';
import { TerritoryNode } from './map/TerritoryNode';
import { AlignedNode } from './map/AlignedNode';
import { FindingNode } from './map/FindingNode';
import { ObservationNode } from './map/ObservationNode';

const NODE_TYPES = {
  mapTerritory: TerritoryNode,
  mapAligned: AlignedNode,
  mapFinding: FindingNode,
  mapObservation: ObservationNode,
} satisfies NodeTypes;

export function WgMapPanel({
  wg,
}: {
  wg: WorkingGroupView;
}) {
  const { nodes, edges } = useMemo(() => layoutWgMap(wg), [wg]);

  if (!(wg.aligned_questions ?? []).length) {
    return (
      <Text c="dimmed" size="sm">
        No research structure to display.
      </Text>
    );
  }

  return (
    <div style={{ height: 600 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
