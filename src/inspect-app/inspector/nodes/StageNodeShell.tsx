import { Group, Paper, Stack, Text } from '@mantine/core';
import { Handle, Position } from '@xyflow/react';
import type { ReactNode, MouseEvent, KeyboardEvent } from 'react';
import { StageStatusPip } from '../StageStatusPip';
import { tokens } from '../../theme/tokens';
import type { StageStatus } from '../../../inspect/types';

export function StageNodeShell({
  title,
  status,
  summary,
  footer,
  onActivate,
  ariaExpanded,
  width,
  isLive,
}: {
  title: string;
  status: StageStatus;
  summary?: ReactNode;
  footer?: ReactNode;
  onActivate?: () => void;
  ariaExpanded?: boolean;
  width?: number;
  isLive?: boolean;
}) {
  const effectiveStatus: StageStatus = isLive ? 'in_progress' : status;
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    onActivate?.();
  };
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate?.();
    }
  };
  return (
    <Paper
      withBorder
      p="sm"
      w={width ?? tokens.stageBox.width}
      mih={tokens.stageBox.heightCollapsed}
      role="button"
      tabIndex={0}
      aria-expanded={ariaExpanded}
      onClick={handleClick}
      onKeyDown={handleKey}
      data-status={effectiveStatus}
      style={{ cursor: onActivate ? 'pointer' : 'default' }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Stack gap={4}>
        <Group justify="space-between" gap="xs">
          <Text fw={600}>{title}</Text>
          <StageStatusPip status={effectiveStatus} />
        </Group>
        {summary}
        {footer}
      </Stack>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </Paper>
  );
}
