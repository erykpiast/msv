import { Paper, type PaperProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { tokens } from '../theme/tokens';

export function Card({
  children,
  accentColor,
  ...rest
}: PaperProps & { children: ReactNode; accentColor?: string }) {
  return (
    <Paper
      withBorder
      shadow="xs"
      p="md"
      radius={tokens.cardRadius}
      {...rest}
      style={{
        borderLeft: accentColor ? `${tokens.personaRail}px solid ${accentColor}` : undefined,
        ...rest.style,
      }}
    >
      {children}
    </Paper>
  );
}
