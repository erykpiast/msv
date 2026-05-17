import { Anchor, Box, Stack, Text } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { ForumGraph } from '../../components/Forum/ForumGraph';
import type { CanvasRoute } from '../../hooks/useHashRoute';

export function ForumCanvas({
  route: _route,
  setRoute,
}: {
  route: Extract<CanvasRoute, { canvas: 'forum' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  const onNodeSelect = (nodeId: string) =>
    setRoute({ canvas: 'forum', leaf: { kind: 'node', id: nodeId } });
  const deadEnds =
    view.schema_version === 'v5' && 'dead_end_questions' in view.forum
      ? view.forum.dead_end_questions
      : [];
  return (
    <Stack gap="sm">
      <Box>
        <ForumGraph view={view} onNodeSelect={onNodeSelect} />
      </Box>
      {deadEnds.length > 0 && (
        <Stack gap={4}>
          <Text fw={600} size="sm">Dead-end questions ({deadEnds.length})</Text>
          {deadEnds.map((d) => (
            <Anchor
              key={d.aligned_id}
              onClick={() =>
                setRoute({ canvas: 'forum', leaf: { kind: 'aligned', id: d.aligned_id } })
              }
            >
              {d.outcome_summary}
            </Anchor>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
