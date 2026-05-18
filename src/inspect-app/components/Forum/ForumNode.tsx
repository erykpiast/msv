import { Handle, Position, type NodeProps } from '@xyflow/react';
import { HoverCard, Text, Stack, Box } from '@mantine/core';

type ForumNodeData = {
  nodeLabel: string;
  nickname?: string;
  groupId: string;
  color: string;
  content: string;
  confidence: number;
  hasOpenQuestion: boolean;
};

export function ForumNodeView({ data }: NodeProps) {
  const d = data as unknown as ForumNodeData;
  const size = Math.max(34, Math.min(78, 34 + d.confidence * 4.5));
  const header = d.nickname ? `${d.nickname} · ${d.nodeLabel}` : d.nodeLabel;
  return (
    <HoverCard width={340} shadow="md" withinPortal position="top" openDelay={120}>
      <HoverCard.Target>
        <Box style={{ position: 'relative' }}>
          <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
          <div
            style={{
              width: size,
              height: size,
              borderRadius: '50%',
              background: d.color,
              opacity: 0.85,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 600,
              fontSize: 11,
              border: '2px solid #fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
            }}
          >
            {d.nodeLabel}
          </div>
          {d.hasOpenQuestion ? (
            <div
              style={{
                position: 'absolute',
                top: -6,
                right: -6,
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: '#f59e0b',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '2px solid #fff',
              }}
            >
              ?
            </div>
          ) : null}
          <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </Box>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={600}>
            {header} · {d.groupId} · conf {d.confidence.toFixed(1)}
          </Text>
          <Text size="sm" lh={1.4}>
            {d.content}
          </Text>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
