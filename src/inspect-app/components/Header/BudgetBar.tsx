import { Progress, Stack, Group, Text, Tooltip } from '@mantine/core';
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
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="xs" fw={500} c="dimmed" tt="uppercase">
          {label}
        </Text>
        <Tooltip label={`${formatter(used)} / ${formatter(max)} · ${formatPercent(used, max)}`}>
          <Text size="xs" fw={600}>
            {formatter(used)} / {formatter(max)}
          </Text>
        </Tooltip>
      </Group>
      <Progress value={pct} color={color} radius="sm" size="md" />
    </Stack>
  );
}
