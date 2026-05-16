import { Group, Badge } from '@mantine/core';
import { Empty } from '../../primitives/Empty';

export function SearchQueryList({ queries }: { queries: string[] }) {
  if (!queries.length) {
    return <Empty message="No discovery search queries recorded." />;
  }
  return (
    <Group gap="xs" wrap="wrap">
      {queries.map((q, idx) => (
        <Badge
          key={`${q}-${idx}`}
          variant="light"
          color="blue"
          size="md"
          radius="sm"
          style={{ textTransform: 'none' }}
        >
          {q}
        </Badge>
      ))}
    </Group>
  );
}
