import { Box, Group, Text } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { useCanvasRoute } from '../../hooks/useHashRoute';
import { MoveThreadTree } from './MoveThreadTree';
import { EvidencePanel } from './EvidencePanel';

export function DebatePanel({
  wg,
  personaName,
  survivingIds,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
  survivingIds: Set<string>;
}) {
  const { route, setRoute } = useCanvasRoute();

  const moves = wg.moves ?? [];

  const selectedMoveId =
    route.canvas === 'wg' && route.substage === 'debate' && route.leaf?.kind === 'move'
      ? route.leaf.id
      : null;

  const onSelect = (moveId: string) => {
    if (route.canvas === 'wg') {
      setRoute({ ...route, leaf: { kind: 'move', id: moveId } });
    }
  };

  const findings = (wg.researcher_reports ?? []).flatMap(r => r.findings);

  if (!moves.length) {
    return <Text c="dimmed" size="sm">No debate moves recorded.</Text>;
  }

  return (
    <Group align="flex-start" grow gap="md">
      <Box style={{ flex: '0 0 58%', minWidth: 0 }}>
        <MoveThreadTree
          moves={moves}
          personaName={personaName}
          survivingIds={survivingIds}
          selectedMoveId={selectedMoveId}
          onSelect={onSelect}
        />
      </Box>
      <Box style={{ flex: '0 0 42%', minWidth: 0 }}>
        <EvidencePanel
          selectedMoveId={selectedMoveId}
          moves={wg.moves ?? []}
          observations={wg.observations ?? []}
          findings={findings}
        />
      </Box>
    </Group>
  );
}
