import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Group, Badge, Text } from '@mantine/core';
import type { CandidateQuestion } from '../../../../inspect/types';
import { PersonaChip } from '../../../primitives/PersonaChip';
import { CHAIN_NODE_W, CHAIN_NODE_H } from '../debateGraphLayout';

type CandidateNodeData = {
  candidate: CandidateQuestion;
  isAligned: boolean;
  personaLabel: string;
};

type CandidateNodeType = Node<CandidateNodeData, 'alignmentCandidate'>;

export function CandidateNode({ data }: NodeProps<CandidateNodeType>) {
  const { candidate, isAligned, personaLabel } = data;

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        data-testid={`align-candidate-${candidate.candidate_id}`}
        data-candidate-id={candidate.candidate_id}
        data-aligned={isAligned}
        style={{
          width: CHAIN_NODE_W,
          minHeight: CHAIN_NODE_H,
          border: isAligned
            ? '2px solid var(--mantine-color-green-6)'
            : '1px solid #dee2e6',
          borderRadius: 8,
          background: isAligned ? 'var(--mantine-color-green-0)' : '#fff',
          padding: '8px 10px',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <Badge size="xs" variant="light" color="gray">
              candidate
            </Badge>
            <PersonaChip
              personaId={candidate.by_persona_id}
              label={personaLabel}
              size="xs"
            />
            <Badge size="xs" variant="light" color="blue">
              p={candidate.predicted_confidence}
            </Badge>
          </Group>
          {isAligned ? (
            <Badge size="xs" color="green" variant="filled">
              aligned
            </Badge>
          ) : null}
        </Group>
        <Text size="sm" lineClamp={3} title={candidate.question}>
          {candidate.question}
        </Text>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
