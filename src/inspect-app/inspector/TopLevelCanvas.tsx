import { useMemo } from 'react';
import { Background, Controls, ReactFlow, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box } from '@mantine/core';
import { useViewContext } from '../ViewContext';
import { pipelineLayout } from './layout/pipelineLayout';
import { DiscoveryNode } from './nodes/DiscoveryNode';
import { CoordinatorNode } from './nodes/CoordinatorNode';
import { WorkingGroupNode } from './nodes/WorkingGroupNode';
import { CrossPollinationNode } from './nodes/CrossPollinationNode';
import { ForumStageNode } from './nodes/ForumStageNode';
import { SynthesisNode } from './nodes/SynthesisNode';
import type { CanvasRoute } from '../hooks/useHashRoute';

const nodeTypes: NodeTypes = {
  discovery: DiscoveryNode as NodeTypes[string],
  coordinator: CoordinatorNode as NodeTypes[string],
  workingGroup: WorkingGroupNode as NodeTypes[string],
  crossPollination: CrossPollinationNode as NodeTypes[string],
  forumStage: ForumStageNode as NodeTypes[string],
  synthesis: SynthesisNode as NodeTypes[string],
};

export function TopLevelCanvas({
  route,
  setRoute: _setRoute,
}: {
  route: Extract<CanvasRoute, { canvas: 'pipeline' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  // Stable primitive key so opening/closing the drawer (which changes route.leaf)
  // does not invalidate the layout memo.
  const expandedKey = route.expanded.join(',');
  const { nodes, edges } = useMemo(
    () => pipelineLayout(view, new Set(route.expanded)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, expandedKey]
  );
  return (
    <Box
      style={{
        height: 'calc(100vh - 260px)',
        minHeight: 400,
        border: '1px solid #e5e7eb',
        borderRadius: 8,
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        zoomOnScroll={false}
      >
        <Background gap={24} color="#f3f4f6" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}
