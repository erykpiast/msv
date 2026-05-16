import { Stack, Group, Text, Badge, Anchor, Code, Alert } from '@mantine/core';
import type { Move } from '../../../inspect/types';
import { Card } from '../../primitives/Card';
import { personaColor } from '../../theme/personas';
import { PersonaChip } from '../../primitives/PersonaChip';

const TYPE_COLOR: Record<Move['type'], string> = {
  Claim: 'blue',
  Support: 'teal',
  Rebut: 'red',
  Concede: 'orange',
  Question: 'grape',
};

export function MoveCard({
  move,
  personaName,
  isSurviving,
}: {
  move: Move;
  personaName: (id: string) => string;
  isSurviving: boolean;
}) {
  const color = personaColor(move.by_persona_id);

  return (
    <div id={`move-${move.move_id}`}>
      <Card accentColor={color}>
        <Stack gap="xs">
          <Group justify="space-between" align="flex-start">
            <Group gap="xs" wrap="wrap">
              <Text size="xs" fw={600} c="dimmed">
                {move.move_id}
              </Text>
              <PersonaChip personaId={move.by_persona_id} label={personaName(move.by_persona_id)} />
              <Badge color={TYPE_COLOR[move.type] ?? 'gray'} variant="light">
                {move.type}
              </Badge>
              <Text size="xs" c="dimmed">
                confidence {move.confidence}
              </Text>
              {move.references_move_id ? (
                <Anchor href={`#move-${move.references_move_id}`} size="xs">
                  refs {move.references_move_id}
                </Anchor>
              ) : null}
            </Group>
            {isSurviving ? (
              <Badge color="green" variant="light">
                surviving claim
              </Badge>
            ) : null}
          </Group>

          <Text size="sm" lh={1.5}>
            {move.content}
          </Text>

          {move.evidence_basis ? (
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={2}>
                Evidence basis
              </Text>
              <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                {move.evidence_basis}
              </Code>
            </div>
          ) : null}

          {move.synthesized ? (
            <Alert color="yellow" variant="light" title="Calcification synthesis">
              This move was produced by the calcification validator after the debate showed signs
              of looping. It summarises the agreed surface rather than originating new content.
            </Alert>
          ) : null}
        </Stack>
      </Card>
    </div>
  );
}
