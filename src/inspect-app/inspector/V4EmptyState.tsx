import { Center, Stack, Text } from '@mantine/core';

export function V4EmptyState({ id }: { id: string }) {
  return (
    <Center mih="80vh">
      <Stack align="center" gap="xs" maw={520}>
        <Text fw={600} size="lg">
          This inspect view supports v5 investigations only.
        </Text>
        <Text c="dimmed" ta="center">
          The loaded idea ({id}) was produced by the v4 pipeline. Re-run with
          the current pipeline to regenerate it.
        </Text>
      </Stack>
    </Center>
  );
}
