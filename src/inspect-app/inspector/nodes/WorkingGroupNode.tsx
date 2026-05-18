import { memo } from 'react';
import { Badge, Group, Stack } from '@mantine/core';
import { type Node, type NodeProps } from '@xyflow/react';
import { StageNodeShell } from './StageNodeShell';
import { PersonaChip } from '../../primitives/PersonaChip';
import { usePersonaName } from '../../hooks/usePersonaName';
import { useSetRoute } from '../../hooks/useHashRoute';
import { useProgressOverlay } from '../../ViewContext';
import { tokens } from '../../theme/tokens';
import type { InvestigationView, StageStatus } from '../../../inspect/types';

type WorkingGroupNodeData = { view: InvestigationView; territoryId: string; status: StageStatus };
type WorkingGroupNodeType = Node<WorkingGroupNodeData, 'workingGroup'>;

export const WorkingGroupNode = memo(function WorkingGroupNode({ data }: NodeProps<WorkingGroupNodeType>) {
  const { view, territoryId, status } = data;
  const wg = view.working_groups?.[territoryId];
  const setRoute = useSetRoute();
  const personaName = usePersonaName();
  const overlay = useProgressOverlay();
  const isLive = overlay.inProgressWg.has(territoryId);
  if (!wg) return null;
  const aligned = wg.aligned_questions?.length ?? 0;
  const claims = wg.surviving_claims?.length ?? 0;
  const deadEnds = (wg.researcher_reports ?? []).filter((r) => r.outcome === 'dead_end').length;
  const pair = wg.pair ?? [];
  return (
    <StageNodeShell
      title={`WG: ${wg.territory?.name ?? territoryId}`}
      status={status}
      isLive={isLive}
      width={tokens.wgBox.width}
      summary={
        <Stack gap={2}>
          <Group gap={4}>
            <Badge size="xs" variant="light">{aligned} aligned</Badge>
            <Badge size="xs" color="green" variant="light">{claims} claims</Badge>
            {deadEnds > 0 && (
              <Badge size="xs" color="orange" variant="light">{deadEnds} dead-end</Badge>
            )}
          </Group>
        </Stack>
      }
      footer={
        <Group gap={4} mt={4}>
          {pair.map((p) => <PersonaChip key={p.id} personaId={p.id} label={personaName(p.id)} />)}
        </Group>
      }
      onActivate={() => setRoute({ canvas: 'wg', territoryId })}
    />
  );
});
