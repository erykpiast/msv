import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useMemo } from 'react';
import type { ConfidencePoint } from '../../../inspect/types';
import { personaColor } from '../../theme/personas';

type Row = { x: number; move_id: string } & Record<string, number | string>;

export function ConfidenceChart({
  trajectory,
  height = 120,
}: {
  trajectory: ConfidencePoint[];
  height?: number;
}) {
  const { rows, personaIds } = useMemo(() => {
    const seenPersonas = new Set<string>();
    for (const point of trajectory) seenPersonas.add(point.persona_id);
    const personas = [...seenPersonas];

    const lastConf: Record<string, number> = {};
    const points: Row[] = trajectory.map((p, idx) => {
      lastConf[p.persona_id] = p.confidence;
      const row: Row = { x: idx + 1, move_id: p.move_id };
      for (const pid of personas) {
        row[pid] = lastConf[pid] ?? 0;
      }
      return row;
    });

    return { rows: points, personaIds: personas };
  }, [trajectory]);

  if (!rows.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 6, right: 6, bottom: 6, left: -16 }}>
        <XAxis dataKey="x" tick={{ fontSize: 10 }} stroke="#9ca3af" />
        <YAxis domain={[0, 10]} tick={{ fontSize: 10 }} stroke="#9ca3af" />
        <Tooltip
          labelFormatter={(_label, payload) => {
            const moveId = (payload?.[0]?.payload as Row | undefined)?.move_id ?? '';
            return moveId;
          }}
        />
        {personaIds.map((pid) => (
          <Line
            key={pid}
            type="monotone"
            dataKey={pid}
            stroke={personaColor(pid)}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
