import { useEffect, useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { Text } from '@mantine/core';
import type { Move, Observation, Finding } from '../../../inspect/types';
import { layoutEvidenceGraph } from './evidenceLayout';
import { FindingNode } from './evidence/FindingNode';
import { ObsNode } from './evidence/ObsNode';
import { MoveNode } from './evidence/MoveNode';

const nodeTypes = {
  evidenceFinding: FindingNode,
  evidenceObs: ObsNode,
  evidenceMove: MoveNode,
};

function EvidenceFlowInner({
  selectedMoveId,
  moves,
  observations,
  findings,
}: {
  selectedMoveId: string | null;
  moves: Move[];
  observations: Observation[];
  findings: Finding[];
}) {
  const { fitView } = useReactFlow();

  const findingsMap = useMemo(
    () => new Map(findings.map(f => [f.finding_id, f])),
    [findings],
  );

  const move = selectedMoveId === null
    ? undefined
    : moves.find(m => m.move_id === selectedMoveId);

  const { nodes, edges } = useMemo(() => {
    if (!move) return { nodes: [], edges: [] };
    return layoutEvidenceGraph(move, observations, findingsMap);
  }, [move, observations, findingsMap]);

  useEffect(() => {
    fitView();
  }, [selectedMoveId, fitView]);

  if (selectedMoveId === null) {
    return (
      <Text c="dimmed" size="sm">
        Select a move to see its evidence trail.
      </Text>
    );
  }

  if (!move) {
    return (
      <Text c="dimmed" size="sm">
        Move not found.
      </Text>
    );
  }

  const hasEvidenceRefs = move.evidence_refs && move.evidence_refs.length > 0;

  if (!hasEvidenceRefs) {
    return (
      <Text c="dimmed" size="sm">
        This move has no recorded evidence references.
      </Text>
    );
  }

  return (
    <div style={{ height: 420 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
      />
    </div>
  );
}

export function EvidencePanel({
  selectedMoveId,
  moves,
  observations,
  findings,
}: {
  selectedMoveId: string | null;
  moves: Move[];
  observations: Observation[];
  findings: Finding[];
}) {
  return (
    <ReactFlowProvider>
      <EvidenceFlowInner
        selectedMoveId={selectedMoveId}
        moves={moves}
        observations={observations}
        findings={findings}
      />
    </ReactFlowProvider>
  );
}
