import { Badge } from '@mantine/core';
import { personaColor } from '../theme/personas';

export function PersonaChip({
  personaId,
  label,
  size = 'sm',
}: {
  personaId: string | undefined | null;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
}) {
  const color = personaColor(personaId);
  return (
    <Badge
      size={size}
      variant="light"
      style={{
        backgroundColor: `${color}1f`,
        color,
        border: `1px solid ${color}55`,
        textTransform: 'none',
      }}
    >
      {label ?? personaId ?? 'unknown'}
    </Badge>
  );
}
