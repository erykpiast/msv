import { Progress, Group, Text, Tooltip } from '@mantine/core';
import { formatNumber, formatPercent } from '../../utils/format';

function pickColor(used: number, max: number): string {
  if (!max) return 'gray';
  const pct = (used / max) * 100;
  if (pct > 100) return 'red';
  if (pct > 80) return 'yellow';
  return 'blue';
}

export function BudgetBar({
  label,
  used,
  max,
  formatter = formatNumber,
}: {
  label: string;
  used: number;
  max: number;
  formatter?: (n: number) => string;
}) {
  const pct = max ? Math.min(150, (used / max) * 100) : 0;
  const color = pickColor(used, max);
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
        label={`${formatter(used)} / ${formatter(max)} · ${formatPercent(used, max)}`}
      >
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
          {formatter(used)} / {formatter(max)}
        </Text>
      </Tooltip>
      <Progress
        value={pct}
        color={color}
        radius="sm"
        size="xs"
        style={{ flex: 1, minWidth: 60 }}
      />
    </Group>
  );
}
