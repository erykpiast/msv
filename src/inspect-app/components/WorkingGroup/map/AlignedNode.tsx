import type { NodeProps, Node } from '@xyflow/react';
import { Text, Badge, Stack } from '@mantine/core';
import type { AlignedQuestion } from '../../../../inspect/types';
import { FlowCard } from '../FlowCard';

type AlignedNodeData = {
  question: AlignedQuestion;
  outcome: 'useful' | 'partial' | 'dead_end' | 'none';
};

type AlignedNodeType = Node<AlignedNodeData, 'mapAligned'>;

const OUTCOME_COLOR: Record<string, string> = {
  useful: '#2f9e44',
  partial: '#e67700',
  dead_end: '#e03131',
  none: '#868e96',
};

const OUTCOME_LABEL: Record<string, string> = {
  useful: 'useful',
  partial: 'partial',
  dead_end: 'dead end',
  none: 'no outcome',
};

export function AlignedNode({ data }: NodeProps<AlignedNodeType>) {
  const { question, outcome } = data;
  const borderColor = OUTCOME_COLOR[outcome ?? 'none'] ?? OUTCOME_COLOR.none;

  return (
    <FlowCard
      borderColor={borderColor}
      popover={
        <Stack gap="xs">
          <Text size="xs" c="dimmed" fw={600}>
            Aligned: {question.aligned_id}
          </Text>
          <Badge
            size="xs"
            variant="light"
            style={{
              borderColor,
              color: borderColor,
              background: `${borderColor}22`,
            }}
          >
            {OUTCOME_LABEL[outcome ?? 'none'] ?? outcome}
          </Badge>
          <Text size="sm">{question.question}</Text>
          <Text size="xs" c="dimmed">
            origin: {question.origin}
          </Text>
        </Stack>
      }
    >
      <Text size="xs" c="dimmed" fw={500}>
        Research Question
      </Text>
      <Text size="xs" fw={600} lineClamp={1} title={question.question}>
        {question.question}
      </Text>
    </FlowCard>
  );
}
