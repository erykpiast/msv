import { Drawer, Stack, Text, Group, Badge, Alert, Divider } from '@mantine/core';
import type { InvestigationView, ForumNode, Reaction } from '../../../inspect/types';
import { useViewContext } from '../../ViewContext';
import { usePersonaName } from '../../hooks/usePersonaName';
import { PersonaChip } from '../../primitives/PersonaChip';
import { Card } from '../../primitives/Card';
import { parseContradictionKey } from '../../utils/contradictionKey';
import { MoveTree } from './MoveTree';

function ReactionCard({
  reaction,
  personaName,
}: {
  reaction: Reaction;
  personaName: (id: string) => string;
}) {
  return (
    <Card>
      <Stack gap={4}>
        <Group gap={6}>
          <PersonaChip
            personaId={reaction.by_persona_id}
            label={personaName(reaction.by_persona_id)}
            size="xs"
          />
          <Badge size="xs" variant="light">
            {reaction.type}
          </Badge>
          <Text size="xs" c="dimmed">
            conf {reaction.confidence}
          </Text>
        </Group>
        <Text size="sm" lh={1.4}>
          {reaction.content}
        </Text>
      </Stack>
    </Card>
  );
}

function buildClaimToNodeId(view: InvestigationView): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of view.forum.nodes) m.set(n.claim_id, n.node_id);
  return m;
}

function findNode(view: InvestigationView, nodeId: string | null): ForumNode | null {
  if (!nodeId) return null;
  return view.forum.nodes.find((n) => n.node_id === nodeId) ?? null;
}

function relatedVerdicts(view: InvestigationView, node: ForumNode) {
  const claimToNodeId = buildClaimToNodeId(view);
  const out: Array<{
    other_node_id: string;
    contradicts: boolean;
    reason: string;
  }> = [];
  for (const [key, verdict] of Object.entries(view.forum.contradiction_verdicts)) {
    const [a, b] = parseContradictionKey(key);
    if (a !== node.claim_id && b !== node.claim_id) continue;
    const otherClaimId = a === node.claim_id ? b : a;
    const otherNodeId = claimToNodeId.get(otherClaimId);
    if (!otherNodeId || otherNodeId === node.node_id) continue;
    out.push({ other_node_id: otherNodeId, contradicts: verdict.contradicts, reason: verdict.reason });
  }
  return out;
}

export function NodeDrawer({
  nodeId,
  onClose,
}: {
  nodeId: string | null;
  onClose: () => void;
}) {
  const view = useViewContext();
  const node = findNode(view, nodeId);
  const personaName = usePersonaName();

  const debate = node ? view.debates[node.working_group_id] : null;
  const reactions = node
    ? view.cross_pollination
        .filter((cp) => cp.target_node_id === node.node_id)
        .flatMap((cp) => cp.reactions)
    : [];
  const verdicts = node ? relatedVerdicts(view, node) : [];

  return (
    <Drawer
      opened={!!node}
      onClose={onClose}
      position="right"
      size="lg"
      title={node ? `${node.node_id} · ${node.working_group_id}` : ''}
      withinPortal
    >
      {node ? (
        <Stack gap="lg">
          <Stack gap="xs">
            <Group gap="xs">
              <Badge variant="light">conf {node.aggregate_confidence.toFixed(1)}</Badge>
              {node.has_open_question ? (
                <Badge color="yellow" variant="light">
                  open question
                </Badge>
              ) : null}
              {node.contradiction_with_node_id ? (
                <Badge color="red" variant="light">
                  contradicts {node.contradiction_with_node_id}
                </Badge>
              ) : null}
            </Group>
            <Text lh={1.5} size="sm">
              {node.content}
            </Text>
          </Stack>

          <Divider label="Originating debate" labelPosition="left" />
          {debate ? (
            <MoveTree rootId={null} moves={debate.moves} personaName={personaName} />
          ) : (
            <Text c="dimmed" size="sm">
              No debate transcript available for {node.working_group_id}.
            </Text>
          )}

          <Divider label={`Cross-pollination reactions (${reactions.length})`} labelPosition="left" />
          {reactions.length ? (
            <Stack gap="xs">
              {reactions.map((r, idx) => (
                <ReactionCard
                  key={`${r.by_persona_id}-${r.type}-${idx}`}
                  reaction={r}
                  personaName={personaName}
                />
              ))}
            </Stack>
          ) : (
            <Text c="dimmed" size="sm">
              No reactions targeting this node.
            </Text>
          )}

          <Divider label={`Contradiction verdicts (${verdicts.length})`} labelPosition="left" />
          {verdicts.length ? (
            <Stack gap="xs">
              {verdicts.map((v) => (
                <Alert
                  key={v.other_node_id}
                  color={v.contradicts ? 'red' : 'gray'}
                  variant="light"
                  title={`${v.contradicts ? 'Contradicts' : 'No contradiction'} · ${v.other_node_id}`}
                >
                  <Text size="sm">{v.reason}</Text>
                </Alert>
              ))}
            </Stack>
          ) : (
            <Text c="dimmed" size="sm">
              No cross-cluster verdicts recorded for this node.
            </Text>
          )}
        </Stack>
      ) : null}
    </Drawer>
  );
}
