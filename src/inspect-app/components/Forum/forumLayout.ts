import type { ForumNode } from '../../../inspect/types';
import { tokens } from '../../theme/tokens';

export type LayoutNode = ForumNode & { x: number; y: number };

export function layoutRing(nodes: ForumNode[], radius = tokens.graphRingRadius): LayoutNode[] {
  if (!nodes.length) return [];

  const groups = new Map<string, ForumNode[]>();
  for (const node of nodes) {
    const key = node.working_group_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node);
  }
  const groupKeys = [...groups.keys()].sort();
  const total = nodes.length;
  let placed = 0;
  const result: LayoutNode[] = [];

  for (const key of groupKeys) {
    const group = groups.get(key)!;
    group.sort((a, b) => a.node_id.localeCompare(b.node_id));
    for (const node of group) {
      const angle = (placed / total) * Math.PI * 2 - Math.PI / 2;
      result.push({
        ...node,
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
      });
      placed += 1;
    }
  }
  return result;
}
