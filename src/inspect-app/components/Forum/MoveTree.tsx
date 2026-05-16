import { Stack, Box, Group, Text, Badge } from '@mantine/core';
import type { Move } from '../../../inspect/types';
import { personaColor } from '../../theme/personas';
import { PersonaChip } from '../../primitives/PersonaChip';

function MoveLine({ move, personaName }: { move: Move; personaName: (id: string) => string }) {
  const color = personaColor(move.by_persona_id);
  return (
    <Box
      style={{
        borderLeft: `3px solid ${color}`,
        background: `${color}0a`,
        borderRadius: 4,
        padding: '8px 10px',
      }}
    >
      <Group justify="space-between" align="flex-start">
        <Group gap={6}>
          <Text size="xs" fw={600} c="dimmed">
            {move.move_id}
          </Text>
          <PersonaChip personaId={move.by_persona_id} label={personaName(move.by_persona_id)} size="xs" />
          <Badge size="xs" variant="light">
            {move.type}
          </Badge>
          <Text size="xs" c="dimmed">
            conf {move.confidence}
          </Text>
        </Group>
      </Group>
      <Text size="sm" mt={4} lh={1.4}>
        {move.content}
      </Text>
    </Box>
  );
}

export function MoveTree({
  rootId,
  moves,
  personaName,
}: {
  rootId: string | null;
  moves: Move[];
  personaName: (id: string) => string;
}) {
  const children = moves.filter((m) => m.references_move_id === rootId);
  if (!children.length) return null;
  return (
    <Stack gap="xs" pl={rootId ? 'md' : 0} style={rootId ? { borderLeft: '1px dashed #d1d5db' } : undefined}>
      {children.map((m) => (
        <Box key={m.move_id}>
          <MoveLine move={m} personaName={personaName} />
          <MoveTree rootId={m.move_id} moves={moves} personaName={personaName} />
        </Box>
      ))}
    </Stack>
  );
}
