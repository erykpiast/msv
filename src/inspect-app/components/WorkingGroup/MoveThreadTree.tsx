import { useMemo, useState } from 'react';
import { Box, Group, Badge, Text } from '@mantine/core';
import type { Move } from '../../../inspect/types';
import { PersonaChip } from '../../primitives/PersonaChip';
import { MoveCard } from '../Debate/MoveCard';
import { buildMoveTree, type MoveNode } from './moveTree';

const TYPE_COLOR: Record<Move['type'], string> = {
  Claim: 'blue',
  Support: 'teal',
  Rebut: 'red',
  Concede: 'orange',
  Question: 'grape',
};

const MAX_DEPTH = 6;
const INDENT_PX = 20;

function MoveRow({
  node,
  depth,
  personaName,
  survivingIds,
  selectedMoveId,
  expandedIds,
  onSelect,
  onToggleExpand,
}: {
  node: MoveNode;
  depth: number;
  personaName: (id: string) => string;
  survivingIds: Set<string>;
  selectedMoveId: string | null;
  expandedIds: Set<string>;
  onSelect: (moveId: string) => void;
  onToggleExpand: (moveId: string) => void;
}) {
  const { move, children } = node;
  const isExpanded = expandedIds.has(move.move_id);
  const isSelected = selectedMoveId === move.move_id;
  const isSurviving = survivingIds.has(move.move_id);

  const cappedDepth = Math.min(depth, MAX_DEPTH);
  const paddingLeft = cappedDepth * INDENT_PX;

  const preview =
    move.content.length > 90 ? move.content.slice(0, 90) + '…' : move.content;

  function handleClick() {
    onSelect(move.move_id);
    onToggleExpand(move.move_id);
  }

  return (
    <Box>
      <Box
        onClick={handleClick}
        style={{
          paddingLeft,
          paddingTop: 6,
          paddingBottom: 6,
          paddingRight: 8,
          cursor: 'pointer',
          background: isSelected ? 'var(--mantine-color-blue-light)' : undefined,
          borderLeft: depth > 0 ? '1px solid var(--mantine-color-gray-3)' : undefined,
        }}
        data-move-id={move.move_id}
        data-depth={depth}
      >
        {isExpanded ? (
          <MoveCard move={move} personaName={personaName} isSurviving={isSurviving} />
        ) : (
          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Group gap="xs" wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
              <Badge color={TYPE_COLOR[move.type] ?? 'gray'} variant="light" size="sm">
                {move.type}
              </Badge>
              <PersonaChip
                personaId={move.by_persona_id}
                label={personaName(move.by_persona_id)}
                size="xs"
              />
              <Text size="xs" c="dimmed" style={{ flexShrink: 1, minWidth: 0 }}>
                {preview}
              </Text>
            </Group>
            {isSurviving ? (
              <Box
                data-testid={`surviving-dot-${move.move_id}`}
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
        )}
      </Box>

      {children.map((child) => (
        <MoveRow
          key={child.move.move_id}
          node={child}
          depth={depth + 1}
          personaName={personaName}
          survivingIds={survivingIds}
          selectedMoveId={selectedMoveId}
          expandedIds={expandedIds}
          onSelect={onSelect}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </Box>
  );
}

export function MoveThreadTree({
  moves,
  personaName,
  survivingIds,
  selectedMoveId,
  onSelect,
}: {
  moves: Move[];
  personaName: (id: string) => string;
  survivingIds: Set<string>;
  selectedMoveId: string | null;
  onSelect: (moveId: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function handleToggleExpand(moveId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(moveId)) {
        next.delete(moveId);
      } else {
        next.add(moveId);
      }
      return next;
    });
  }

  const roots = useMemo(() => buildMoveTree(moves), [moves]);

  return (
    <Box>
      {roots.map((node) => (
        <MoveRow
          key={node.move.move_id}
          node={node}
          depth={0}
          personaName={personaName}
          survivingIds={survivingIds}
          selectedMoveId={selectedMoveId}
          expandedIds={expandedIds}
          onSelect={onSelect}
          onToggleExpand={handleToggleExpand}
        />
      ))}
    </Box>
  );
}
