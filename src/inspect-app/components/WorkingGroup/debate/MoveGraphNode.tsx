import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Group, Badge, Text, Box } from '@mantine/core';
import type { Move } from '../../../../inspect/types';
import { PersonaChip } from '../../../primitives/PersonaChip';
import { CHAIN_NODE_W, CHAIN_NODE_H } from '../debateGraphLayout';

const TYPE_COLOR: Record<Move['type'], string> = {
  Claim: 'blue',
  Support: 'teal',
  Rebut: 'red',
  Concede: 'orange',
  Question: 'grape',
};

type MoveGraphNodeData = {
  move: Move;
  stepIndex: number;
  totalMoves: number;
  isSelected: boolean;
  personaLabel: string;
  isSurviving: boolean;
};

type MoveGraphNodeType = Node<MoveGraphNodeData, 'debateChain'>;

export function MoveGraphNode({ data }: NodeProps<MoveGraphNodeType>) {
  const { move, stepIndex, totalMoves, isSelected, personaLabel, isSurviving } = data;

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        data-testid={`move-graph-node-${move.move_id}`}
        data-move-id={move.move_id}
        data-selected={isSelected}
        data-step-index={stepIndex}
        style={{
          width: CHAIN_NODE_W,
          minHeight: CHAIN_NODE_H,
          border: isSelected
            ? '2px solid var(--mantine-color-blue-5)'
            : '1px solid #dee2e6',
          borderRadius: 8,
          background: isSelected ? 'var(--mantine-color-blue-0)' : '#fff',
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
              {stepIndex + 1}/{totalMoves}
            </Badge>
            <Badge size="xs" color={TYPE_COLOR[move.type] ?? 'gray'} variant="light">
              {move.type}
            </Badge>
            <PersonaChip
              personaId={move.by_persona_id}
              label={personaLabel}
              size="xs"
            />
          </Group>
          {isSurviving ? (
            <Box
              data-testid={`graph-surviving-dot-${move.move_id}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--mantine-color-green-6)',
                flexShrink: 0,
              }}
            />
          ) : null}
        </Group>
        <Text size="sm" lineClamp={3} title={move.content}>
          {move.content}
        </Text>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
