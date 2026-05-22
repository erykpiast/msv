import type { NodeProps, Node } from '@xyflow/react';
import { Text, Badge, Stack, Anchor } from '@mantine/core';
import type { Finding } from '../../../../inspect/types';
import { FlowCard } from '../FlowCard';

type FindingNodeData = {
  finding: Finding;
};

type FindingNodeType = Node<FindingNodeData, 'evidenceFinding'>;

export function FindingNode({ data }: NodeProps<FindingNodeType>) {
  const { finding } = data;
  const label = finding.nickname ?? finding.finding_id;

  return (
    <FlowCard
      borderColor="#339af0"
      popover={
        <Stack gap="xs">
          <Text size="xs" c="dimmed" fw={600}>
            Finding: {finding.finding_id}
          </Text>
          {finding.quality ? (
            <Badge size="xs" color="blue" variant="light">
              {finding.quality}
            </Badge>
          ) : null}
          <Text size="sm">{finding.content}</Text>
          {finding.source_url ? (
            <Anchor href={finding.source_url} target="_blank" rel="noopener noreferrer" size="xs">
              {finding.source_title ?? finding.source_url}
            </Anchor>
          ) : null}
        </Stack>
      }
    >
      <Text size="xs" fw={600} lineClamp={1} title={label}>
        {label}
      </Text>
      {finding.quality ? (
        <Badge size="xs" color="blue" variant="light">
          {finding.quality}
        </Badge>
      ) : null}
    </FlowCard>
  );
}
