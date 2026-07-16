import { useState } from 'react';
import { Stack, Group, Title, Text, Alert, Anchor, Badge } from '@mantine/core';
import { useViewContext, useSseStatus } from '../../ViewContext';
import { StatusPill } from './StatusPill';
import { MetricBar } from './MetricBar';
import { formatDuration } from '../../utils/format';

export function Header() {
  const view = useViewContext();
  const sseStatus = useSseStatus();
  const investigating = view.status === 'investigating';
  const [captureExpanded, setCaptureExpanded] = useState(false);

  return (
    <Stack gap="md">
        <Stack gap={4}>
          <Group justify="space-between" align="baseline" gap="md" wrap="nowrap">
            <Title
              order={3}
              fw={500}
              lh={1.4}
              style={
                captureExpanded
                  ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                  : { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }
              }
            >
              {view.raw_capture}
            </Title>
            <Anchor
              style={{ flexShrink: 0, lineHeight: 1, display: 'flex', alignItems: 'center' }}
              onClick={(e) => { e.preventDefault(); setCaptureExpanded((v) => !v); }}
              href="#"
              aria-label={captureExpanded ? 'Collapse' : 'Expand'}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transition: 'transform 150ms ease', transform: captureExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </Anchor>
          </Group>
          <Group gap="md">
              <StatusPill status={view.status} />
              {sseStatus === 'live' && (
                <Badge color="blue" variant="light" size="sm">● LIVE</Badge>
              )}
              {sseStatus === 'error' && (
                <Badge color="red" variant="light" size="sm">● disconnected</Badge>
              )}
              <Text size="sm" c="dimmed">
                model: <Text component="span" fw={500}>{view.model ?? '—'}</Text>
              </Text>
              <Text size="sm" c="dimmed">
                runtime: <Text component="span" fw={500}>{formatDuration(view.budget.runtime_ms)}</Text>
              </Text>
              {view.parent_id ? (
                <Anchor href={`?id=${encodeURIComponent(view.parent_id)}`} size="sm">
                  parent ↗
                </Anchor>
              ) : null}
          </Group>
        </Stack>

        {investigating ? (
          <Alert color="yellow" variant="light">
            Partial transcript — investigation still in progress. Some stages may be missing or
            incomplete.
          </Alert>
        ) : null}

        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Tracked usage (reference points, not enforced limits)
          </Text>
          <Group gap="lg" wrap="wrap" align="center">
            <MetricBar
              label="Executor calls"
              used={view.budget.used_executor_calls}
              target={view.budget.max_executor_calls}
            />
            <MetricBar
              label="Tokens"
              used={view.budget.used_total_tokens}
              target={view.budget.max_total_tokens}
            />
            {view.budget.max_researcher_tool_calls != null ? (
              <MetricBar
                label="Researcher tool calls"
                used={view.budget.used_researcher_tool_calls ?? 0}
                target={view.budget.max_researcher_tool_calls}
              />
            ) : null}
          </Group>
        </Stack>
    </Stack>
  );
}
