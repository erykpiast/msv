import { Box, Text } from '@mantine/core';

export function Empty({ message, hint }: { message: string; hint?: string }) {
  return (
    <Box
      style={{
        padding: '32px 24px',
        border: '1px dashed #d1d5db',
        borderRadius: 8,
        background: '#f9fafb',
        textAlign: 'center',
      }}
    >
      <Text c="dimmed" size="sm" fw={500}>
        {message}
      </Text>
      {hint ? (
        <Text c="dimmed" size="xs" mt={4}>
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}
