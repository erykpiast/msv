import { useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box, Group, Switch, Text } from '@mantine/core';
import type { InvestigationView } from '../../../inspect/types';
import { layoutRing } from './forumLayout';
import { personaColor } from '../../theme/personas';
import { tokens, edgeColors } from '../../theme/tokens';
import { ForumNodeView } from './ForumNode';

const nodeTypes = { forumNode: ForumNodeView };

// Working-group ids feed into the same hash palette as personas so a debate's
// surviving-claim cluster carries the same colour as its sub-question chip.
const groupColor = personaColor;

function pickClusterAnchor(nodes: { node_id: string; working_group_id: string; survival_rank: number | null }[], groupId: string): string | null {
  const inGroup = nodes
    .filter((n) => n.working_group_id === groupId)
    .sort((a, b) => (a.survival_rank ?? 0) - (b.survival_rank ?? 0));
  return inGroup[0]?.node_id ?? null;
}

export function ForumGraph({
  view,
  onNodeSelect,
}: {
  view: InvestigationView;
  onNodeSelect?: (nodeId: string) => void;
}) {
  const [showIntraCluster, setShowIntraCluster] = useState(false);

  const positioned = useMemo(() => layoutRing(view.forum.nodes), [view.forum.nodes]);

  const rfNodes = useMemo<Node[]>(
    () =>
      positioned.map((n) => ({
        id: n.node_id,
        type: 'forumNode',
        position: { x: n.x, y: n.y },
        data: {
          nodeLabel: n.node_id,
          nickname: n.nickname,
          groupId: n.working_group_id,
          color: groupColor(n.working_group_id),
          content: n.content,
          confidence: n.aggregate_confidence,
          hasOpenQuestion: n.has_open_question,
        },
        draggable: false,
        selectable: true,
      })),
    [positioned]
  );

  const moveToNodeId = useMemo(() => {
    const m = new Map<string, string>();
    for (const node of view.forum.nodes) {
      // Map originating move + every move in the debate whose surviving claim equals node.claim_id.
      const debate = view.debates[node.working_group_id];
      if (!debate) continue;
      for (const claim of debate.surviving_claims) {
        if (claim.claim_id === node.claim_id) m.set(claim.originating_move_id, node.node_id);
      }
    }
    return m;
  }, [view.forum.nodes, view.debates]);

  const personaToHomeNode = useMemo(() => {
    const m = new Map<string, string>();
    for (const [sqId, debate] of Object.entries(view.debates)) {
      for (const p of debate.pair) {
        if (m.has(p.id)) continue;
        const anchor = pickClusterAnchor(view.forum.nodes, sqId);
        if (anchor) m.set(p.id, anchor);
      }
    }
    return m;
  }, [view.debates, view.forum.nodes]);

  const rfEdges = useMemo<Edge[]>(() => {
    const edges: Edge[] = [];

    view.forum.contradiction_edges.forEach((edge, idx) => {
      edges.push({
        id: `contra-${idx}`,
        source: edge.from_node_id,
        target: edge.to_node_id,
        style: { stroke: edgeColors.contradiction, strokeWidth: 2 },
        label: 'contradicts',
        labelStyle: { fill: edgeColors.contradiction, fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#fff' },
        data: { reason: edge.reason, kind: 'contradiction' },
      });
    });

    view.cross_pollination.forEach((cp, cpIdx) => {
      if (!cp.target_node_id) return;
      cp.reactions.forEach((reaction, rIdx) => {
        const home = personaToHomeNode.get(reaction.by_persona_id);
        if (!home || home === cp.target_node_id) return;
        edges.push({
          id: `cp-${cpIdx}-${rIdx}`,
          source: home,
          target: cp.target_node_id!,
          style: { stroke: edgeColors.crossPollination, strokeWidth: 1.5, strokeDasharray: '4 3' },
          animated: false,
          data: {
            kind: 'reaction',
            persona: reaction.by_persona_id,
            type: reaction.type,
            content: reaction.content,
            confidence: reaction.confidence,
          },
        });
      });
    });

    if (showIntraCluster) {
      for (const [, debate] of Object.entries(view.debates)) {
        for (const move of debate.moves) {
          if (!move.references_move_id) continue;
          if (move.type === 'Claim') continue;
          const fromNode = moveToNodeId.get(move.references_move_id);
          const toNode = moveToNodeId.get(move.move_id);
          if (!fromNode || !toNode || fromNode === toNode) continue;
          edges.push({
            id: `intra-${move.move_id}`,
            source: fromNode,
            target: toNode,
            style: { stroke: edgeColors.intraCluster, strokeWidth: 1, opacity: 0.6 },
            data: { kind: 'intra' },
          });
        }
      }
    }

    return edges;
  }, [
    view.forum.contradiction_edges,
    view.cross_pollination,
    view.debates,
    personaToHomeNode,
    moveToNodeId,
    showIntraCluster,
  ]);

  if (!positioned.length) return null;

  return (
    <Box>
      <Group justify="space-between" mb="xs">
        <Group gap="md">
          <Group gap={4}>
            <Box style={{ width: 12, height: 2, background: edgeColors.contradiction }} />
            <Text size="xs">contradiction</Text>
          </Group>
          <Group gap={4}>
            <Box style={{ width: 12, height: 0, borderTop: `2px dashed ${edgeColors.crossPollination}` }} />
            <Text size="xs">cross-pollination</Text>
          </Group>
          {showIntraCluster ? (
            <Group gap={4}>
              <Box style={{ width: 12, height: 2, background: edgeColors.intraCluster }} />
              <Text size="xs">intra-cluster ref</Text>
            </Group>
          ) : null}
        </Group>
        <Switch
          size="xs"
          label="Show intra-cluster references"
          checked={showIntraCluster}
          onChange={(e) => setShowIntraCluster(e.currentTarget.checked)}
        />
      </Group>
      <Box style={{ height: tokens.graphHeight, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          onNodeClick={(_e, node) => onNodeSelect?.(node.id)}
        >
          <Background gap={24} color="#f3f4f6" />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      </Box>
    </Box>
  );
}
