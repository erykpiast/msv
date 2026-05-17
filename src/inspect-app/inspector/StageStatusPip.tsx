import { Text, Tooltip } from '@mantine/core';
import type { StageStatus } from '../../inspect/types';
import { stageStatusColor, stageStatusGlyph } from '../theme/tokens';

export function StageStatusPip({
  status, label,
}: { status: StageStatus; label?: string }) {
  return (
    <Tooltip label={label ?? status} withArrow>
      <Text
        component="span"
        size="lg"
        fw={700}
        c={stageStatusColor[status]}
        aria-label={`status: ${status}`}
      >
        {stageStatusGlyph[status]}
      </Text>
    </Tooltip>
  );
}
