import { Table, Text, Anchor } from '@mantine/core';
import { useMemo } from 'react';
import { useViewContext } from '../../ViewContext';
import { usePersonaName } from '../../hooks/usePersonaName';
import { personaColor } from '../../theme/personas';
import { Empty } from '../../primitives/Empty';

const TYPE_LETTER: Record<string, string> = {
  Rebut: 'R',
  Concede: 'C',
  Question: 'Q',
  Support: 'S',
};

function formatCell(cell: { Rebut: number; Concede: number; Question: number; Support: number } | undefined) {
  if (!cell) return '0';
  const parts = (['Rebut', 'Concede', 'Question', 'Support'] as const)
    .filter((t) => cell[t] > 0)
    .map((t) => `${cell[t]}${TYPE_LETTER[t]}`);
  if (!parts.length) return '0';
  return parts.join('/');
}

function totalCell(cell: { Rebut: number; Concede: number; Question: number; Support: number } | undefined) {
  if (!cell) return 0;
  return cell.Rebut + cell.Concede + cell.Question + cell.Support;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function PersonaMatrix() {
  const view = useViewContext();
  const interactions = view.persona_interactions;
  const personaName = usePersonaName();

  const personaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const fromId of Object.keys(interactions)) {
      ids.add(fromId);
      for (const toId of Object.keys(interactions[fromId])) ids.add(toId);
    }
    return [...ids].sort();
  }, [interactions]);

  const pairToSqId = useMemo(() => {
    const m = new Map<string, string>();
    for (const [sqId, debate] of Object.entries(view.debates)) {
      const ids = debate.pair.map((p) => p.id);
      if (ids.length !== 2) continue;
      m.set(pairKey(ids[0], ids[1]), sqId);
    }
    return m;
  }, [view.debates]);

  const maxTotal = useMemo(() => {
    let max = 1;
    for (const from of personaIds) {
      for (const to of personaIds) {
        const t = totalCell(interactions[from]?.[to]);
        if (t > max) max = t;
      }
    }
    return max;
  }, [interactions, personaIds]);

  if (!personaIds.length) {
    return <Empty message="No persona interactions to display." />;
  }

  return (
    <Table withTableBorder withColumnBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          {personaIds.map((id) => (
            <Table.Th key={id} style={{ color: personaColor(id) }}>
              <Text size="xs" fw={600}>
                {personaName(id)}
              </Text>
              <Text size="xs" c="dimmed">
                {id}
              </Text>
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {personaIds.map((fromId) => (
          <Table.Tr key={fromId}>
            <Table.Th style={{ color: personaColor(fromId) }}>
              <Text size="xs" fw={600}>
                {personaName(fromId)}
              </Text>
              <Text size="xs" c="dimmed">
                {fromId}
              </Text>
            </Table.Th>
            {personaIds.map((toId) => {
              if (fromId === toId) {
                return (
                  <Table.Td key={toId} style={{ background: '#f3f4f6', textAlign: 'center' }}>
                    —
                  </Table.Td>
                );
              }
              const cell = interactions[fromId]?.[toId];
              const total = totalCell(cell);
              const opacity = total === 0 ? 0.2 : 0.25 + Math.min(0.75, total / maxTotal);
              const sqId = total > 0 ? pairToSqId.get(pairKey(fromId, toId)) ?? null : null;
              const text = formatCell(cell);
              return (
                <Table.Td
                  key={toId}
                  style={{
                    background: total ? `rgba(59,130,246,${opacity * 0.5})` : 'transparent',
                    textAlign: 'center',
                  }}
                >
                  {sqId ? (
                    <Anchor href={`#debate-${sqId}`} size="xs" fw={600}>
                      {text}
                    </Anchor>
                  ) : (
                    <Text size="xs">{text}</Text>
                  )}
                </Table.Td>
              );
            })}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
