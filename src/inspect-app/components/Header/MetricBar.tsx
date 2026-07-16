import { Progress, Group, Text, Tooltip } from '@mantine/core';
import { formatNumber, formatPercent } from '../../utils/format';

// These render tracked usage against a reference point, not an enforced ceiling —
// nothing in the pipeline stops the run when `used` exceeds `target`. The bar stays
// a single neutral color regardless of how far over the reference point usage goes.
export function MetricBar({
  label,
  used,
  target,
  formatter = formatNumber,
}: {
  label: string;
  used: number;
  target: number;
  formatter?: (n: number) => string;
}) {
  const pct = target ? Math.min(100, (used / target) * 100) : 0;
  return (
    <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 200 }}>
      <Text
        size="xs"
        fw={500}
        c="dimmed"
        tt="uppercase"
        style={{ whiteSpace: 'nowrap' }}
      >
        {label}
      </Text>
      <Tooltip
        label={`${formatter(used)} tracked · reference point ${formatter(target)} (${formatPercent(used, target)}, not an enforced limit)`}
      >
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
          {formatter(used)} / {formatter(target)}
        </Text>
      </Tooltip>
      <Progress
        value={pct}
        color="blue"
        radius="sm"
        size="xs"
        style={{ flex: 1, minWidth: 60 }}
      />
    </Group>
  );
}
