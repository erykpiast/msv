import { Title, Stack, Box, Text } from '@mantine/core';
import type { ReactNode } from 'react';

export function Section({
  title,
  description,
  children,
  rightSlot,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  rightSlot?: ReactNode;
}) {
  return (
    <Stack gap="md">
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
        }}
      >
        <div>
          <Title order={2}>{title}</Title>
          {description ? (
            <Text c="dimmed" size="sm" mt={4}>
              {description}
            </Text>
          ) : null}
        </div>
        {rightSlot}
      </Box>
      {children}
    </Stack>
  );
}
