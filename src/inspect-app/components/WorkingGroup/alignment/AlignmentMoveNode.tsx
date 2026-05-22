import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Group, Badge, Text } from '@mantine/core';
import type { AlignmentMove, AlignmentMoveType } from '../../../../inspect/types';
import { PersonaChip } from '../../../primitives/PersonaChip';
import { CHAIN_NODE_W, CHAIN_NODE_H } from '../debateGraphLayout';

const TYPE_COLOR: Record<AlignmentMoveType, string> = {
  Propose: 'blue',
  Sharpen: 'cyan',
  Merge: 'grape',
  Drop: 'red',
  Defer: 'gray',
};

type AlignmentMoveNodeData = {
  move: AlignmentMove;
  stepIndex: number;
  totalMoves: number;
  isSelected: boolean;
  personaLabel: string;
};

type AlignmentMoveNodeType = Node<AlignmentMoveNodeData, 'alignmentMove'>;

export function AlignmentMoveNode({ data }: NodeProps<AlignmentMoveNodeType>) {
  const { move, stepIndex, totalMoves, isSelected, personaLabel } = data;

  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        data-testid={`align-move-${move.move_id}`}
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
        <Group gap={6} wrap="nowrap">
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
        <Text size="sm" lineClamp={3} title={move.content}>
          {move.content}
        </Text>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
