import { Stack, Text } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { MoveCard } from '../Debate/MoveCard';

export function DebatePanel({
  wg,
  personaName,
  survivingIds,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
  survivingIds: Set<string>;
}) {
  const { moves } = wg;

  if (!moves.length) {
    return <Text c="dimmed" size="sm">No debate moves recorded.</Text>;
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {moves.length} move{moves.length === 1 ? '' : 's'} — evidence-grounded debate on aligned questions.
      </Text>
      {moves.map((move) => (
        <MoveCard
          key={move.move_id}
          move={move}
          personaName={personaName}
          isSurviving={survivingIds.has(move.move_id)}
        />
      ))}
    </Stack>
  );
}
