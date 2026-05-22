import { useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Text } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { layoutWgMap } from './wgMapLayout';
import { TerritoryNode } from './map/TerritoryNode';
import { AlignedNode } from './map/AlignedNode';
import { FindingNode } from './map/FindingNode';
import { ObservationNode } from './map/ObservationNode';
import { useCanvasRoute, type LeafRef } from '../../hooks/useHashRoute';

const NODE_TYPES = {
  mapTerritory: TerritoryNode,
  mapAligned: AlignedNode,
  mapFinding: FindingNode,
  mapObservation: ObservationNode,
} satisfies NodeTypes;

// Each map node id is `<prefix>:<id>` (see layoutWgMap). Translate that into
// a drawer leaf ref.
export function nodeIdToLeaf(nodeId: string): LeafRef | null {
  const colon = nodeId.indexOf(':');
  if (colon === -1) return null;
  const prefix = nodeId.slice(0, colon);
  const id = nodeId.slice(colon + 1);
  switch (prefix) {
    case 't':  return { kind: 'territory', id };
    case 'aq': return { kind: 'aligned', id };
    case 'f':  return { kind: 'finding', id };
    case 'o':  return { kind: 'observation', id };
    default:   return null;
  }
}

export function WgMapPanel({
  wg,
  height = 600,
}: {
  wg: WorkingGroupView;
  height?: number | string;
}) {
  const { nodes, edges } = useMemo(() => layoutWgMap(wg), [wg]);
  const { route, setRoute } = useCanvasRoute();

  // Read the route lazily through a ref so the callback identity stays stable
  // across route changes; ReactFlow keeps the same onNodeClick prop reference.
  const routeRef = useRef(route);
  routeRef.current = route;

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      const leaf = nodeIdToLeaf(node.id);
      const current = routeRef.current;
      if (leaf && current.canvas === 'wg') {
        setRoute({ ...current, leaf });
      }
    },
    [setRoute],
  );

  if (!(wg.aligned_questions ?? []).length) {
    return (
      <Text c="dimmed" size="sm">
        No research structure to display.
      </Text>
    );
  }

  return (
    <div style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={handleNodeClick}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
