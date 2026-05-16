import { Badge } from '@mantine/core';

const COLORS: Record<string, string> = {
  ready: 'green',
  investigating: 'yellow',
  archived: 'gray',
  pending: 'blue',
};

export function StatusPill({ status }: { status: string }) {
  const color = COLORS[status] ?? 'gray';
  return (
    <Badge color={color} size="lg" radius="sm">
      {status}
    </Badge>
  );
}
