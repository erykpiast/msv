import { Stack, Text, Badge, Group, Anchor } from '@mantine/core';
import type { WorkingGroupView } from '../../../inspect/types';
import { Card } from '../../primitives/Card';
import { useCanvasRoute } from '../../hooks/useHashRoute';

export function ConclusionsPanel({
  wg,
  personaName,
}: {
  wg: WorkingGroupView;
  personaName: (id: string) => string;
}) {
  const { route, setRoute } = useCanvasRoute();
  const claims = wg.surviving_claims ?? [];
  const moves = wg.moves ?? [];

  if (!claims.length) {
    return <Text c="dimmed" size="sm">No surviving claims recorded for this working group.</Text>;
  }

  const openClaim = (claim_id: string) => {
    if (route.canvas === 'wg') {
      setRoute({ ...route, leaf: { kind: 'claim', id: claim_id } });
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {claims.length} surviving claim{claims.length === 1 ? '' : 's'} after debate.
      </Text>
      {claims.map((c) => {
        const originatingMove = moves.find((m) => m.move_id === c.originating_move_id);
        return (
          <Card key={c.claim_id}>
            <Stack gap="xs">
              <Group gap="xs" wrap="wrap">
                <Anchor
                  component="button"
                  type="button"
                  onClick={() => openClaim(c.claim_id)}
                  style={{ padding: 0, fontWeight: 600 }}
                >
                  {c.nickname ? `${c.nickname} · ${c.claim_id}` : c.claim_id}
                </Anchor>
                <Badge variant="light" color="blue">
                  confidence {c.confidence_after_debate.toFixed(2)}
                </Badge>
                {c.concession_status ? (
                  <Badge variant="light" color="orange">
                    {c.concession_status}
                  </Badge>
                ) : null}
              </Group>
              <Text size="sm" lh={1.5}>{c.content}</Text>
              <Text size="xs" c="dimmed">
                {originatingMove
                  ? `originating move: ${c.originating_move_id} · by ${personaName(originatingMove.by_persona_id)}`
                  : `originating move: ${c.originating_move_id}`}
              </Text>
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}
