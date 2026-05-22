import { Stack, Text } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';

export function DebatePanel({
  wg,
  personaName,
  survivingIds,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
  survivingIds: Set<string>;
}) {
  const moves = wg.moves ?? [];

  if (!moves.length) {
    return <Text c="dimmed" size="sm">No debate moves recorded.</Text>;
  }

  const survivingCount = moves.reduce(
    (acc, m) => (survivingIds.has(m.move_id) ? acc + 1 : acc),
    0,
  );
  const personaIds = Array.from(new Set(moves.map((m) => m.by_persona_id)));
  const personaList = personaIds.map((id) => personaName(id)).join(', ');

  return (
    <Stack gap="xs">
      <Text size="sm">
        {moves.length} debate {moves.length === 1 ? 'move' : 'moves'} recorded;{' '}
        {survivingCount} survived.
      </Text>
      {personaIds.length > 0 ? (
        <Text size="sm">Personas active: {personaList}.</Text>
      ) : null}
      <Text size="sm" c="dimmed">
        Click the Debate stage card on the canvas to reveal the first step; each
        subsequent click on the bottom-most move reveals the next step. Select any
        step to see its details and evidence trail here.
      </Text>
    </Stack>
  );
}
