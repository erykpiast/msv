import { Box, Group, Text, Tooltip, Anchor } from '@mantine/core';
import type { Stage } from '../../../inspect/types';
import { formatDuration } from '../../utils/format';

const STATUS_COLOR: Record<string, string> = {
  done: '#10b981',
  partial: '#f59e0b',
  skipped: '#9ca3af',
  failed: '#ef4444',
  not_run: '#d1d5db',
};

const STATUS_LABEL: Record<string, string> = {
  done: 'done',
  partial: 'in progress',
  skipped: 'skipped',
  failed: 'failed',
  not_run: 'not run',
};

export function StageChip({ stage }: { stage: Stage }) {
  const color = STATUS_COLOR[stage.status] ?? STATUS_COLOR.not_run;
  const tooltipLabel = [
    `${stage.label} · ${STATUS_LABEL[stage.status] ?? stage.status} · ${formatDuration(stage.duration_ms)}`,
    stage.summary,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <Tooltip label={tooltipLabel} multiline withinPortal>
      <Anchor href={`#${stage.detail_ref}`} td="none">
        <Box
          style={{
            minWidth: 132,
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${color}55`,
            background: `${color}10`,
          }}
        >
          <Group gap="xs" align="center" wrap="nowrap">
            <Box
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: color,
                flexShrink: 0,
              }}
            />
            <div>
              <Text size="xs" fw={600} c="dark">
                {stage.label}
              </Text>
              <Text size="xs" c="dimmed">
                {formatDuration(stage.duration_ms)}
              </Text>
            </div>
          </Group>
        </Box>
      </Anchor>
    </Tooltip>
  );
}
