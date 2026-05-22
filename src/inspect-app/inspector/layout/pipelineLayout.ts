import type { Edge, Node } from '@xyflow/react';
import type { InvestigationView, StageStatus } from '../../../inspect/types';
import { tokens, edgeColors } from '../../theme/tokens';
import type { ExpandedStage } from '../../hooks/useHashRoute';

export type ExpandedSet = Set<ExpandedStage>;

// Layout constants.
const PER_ROW_PX = 36;
const COLUMN_GAP_PX = 40;
const COLLISION_GAP_PX = 16;
const WG_COL_GAP_PX = 24;                    // horizontal gap between WG sub-columns
const EXPANDED_DISCOVERY_HEADER_PX = 80;     // title + spoiler chrome above persona rows
const EXPANDED_TERRITORY_ROW_PX = 60;        // one coordinator territory row
const EXPANDED_PADDING_PX = 40;              // generic bottom padding for expanded blocks
const SEARCH_QUERY_ROW_PX = 22;
const SEARCH_QUERY_HEADING_PX = 24;

// Widths each stage takes when expanded. Must match the `width` prop passed
// to StageNodeShell inside the corresponding *Node component.
export const expandedWidth: Record<ExpandedStage, number> = {
  discovery: 300,
  coordinator: 280,
  cross_pollination: 320,
};

function expandedHeight(view: InvestigationView, stage: ExpandedStage): number {
  switch (stage) {
    case 'discovery': {
      const personaRows = Math.max(view.discovery.selected_persona_ids.length, 1) * PER_ROW_PX;
      const queryCount = view.discovery.search_queries.length;
      const queryRows = queryCount * SEARCH_QUERY_ROW_PX + (queryCount > 0 ? SEARCH_QUERY_HEADING_PX : 0);
      return personaRows + queryRows + EXPANDED_DISCOVERY_HEADER_PX;
    }
    case 'coordinator':
      return Math.max(view.coordinator.territories.length, 1) * EXPANDED_TERRITORY_ROW_PX + EXPANDED_PADDING_PX;
    case 'cross_pollination':
      return Math.max(view.cross_pollination.length, 1) * PER_ROW_PX + EXPANDED_PADDING_PX;
  }
}

function stageFromId(id: string): ExpandedStage | null {
  if (id === 'discovery' || id === 'coordinator') return id as ExpandedStage;
  if (id === 'crossPollination') return 'cross_pollination';
  return null;
}

type ColumnKey = 'discovery' | 'coordinator' | 'workingGroup' | 'crossPollination' | 'forum' | 'synthesis';

const COLUMN_ORDER: ColumnKey[] = [
  'discovery', 'coordinator', 'workingGroup', 'crossPollination', 'forum', 'synthesis',
];

function computeColumnX(expanded: ExpandedSet, wgBlockWidth: number): Record<ColumnKey, number> {
  const { pipelineColumnX: col, stageBox } = tokens;
  const widths: Record<ColumnKey, number> = {
    discovery: expanded.has('discovery') ? expandedWidth.discovery : stageBox.width,
    coordinator: expanded.has('coordinator') ? expandedWidth.coordinator : stageBox.width,
    workingGroup: wgBlockWidth,
    crossPollination: expanded.has('cross_pollination') ? expandedWidth.cross_pollination : stageBox.width,
    forum: stageBox.width,
    synthesis: stageBox.width,
  };
  const x: Record<ColumnKey, number> = { ...col };
  for (let i = 1; i < COLUMN_ORDER.length; i++) {
    const prev = COLUMN_ORDER[i - 1]!;
    const cur = COLUMN_ORDER[i]!;
    const requiredX = x[prev] + widths[prev] + COLUMN_GAP_PX;
    if (x[cur] < requiredX) x[cur] = requiredX;
  }
  return x;
}

type ExpandableNodeData = { expanded?: boolean; expandedHeight?: number };

// Place N uniform-height items in a 2-column staggered pattern (the right
// column's cards slot vertically between the left column's cards, like
// fish-scales). For N items each at full card height H with a small in-column
// gap g, the vertical extent is ((N - 1) * (H + g) / 2) + H — roughly 60% of
// a single-column stack of the same N.
function planWgStagger(n: number): {
  positions: { col: number; staggerStep: number }[]; // step is i; visual y = stepUnit * step
  numCols: number;
  staggerSteps: number; // number of half-rows the layout spans (= n - 1 when n > 0)
} {
  if (n === 0) {
    return { positions: [], numCols: 1, staggerSteps: 0 };
  }
  if (n === 1) {
    return {
      positions: [{ col: 0, staggerStep: 0 }],
      numCols: 1,
      staggerSteps: 0,
    };
  }
  const positions = Array.from({ length: n }, (_, i) => ({
    col: i % 2,
    staggerStep: i,
  }));
  return { positions, numCols: 2, staggerSteps: n - 1 };
}

export function pipelineLayout(
  view: InvestigationView,
  expanded: ExpandedSet = new Set()
): { nodes: Node[]; edges: Edge[] } {
  const { pipelineRowY: y, stageBox, wgBox, wgStackGap } = tokens;

  const territoryIds = Object.keys(view.working_groups ?? {});
  const stagger = planWgStagger(territoryIds.length);

  const wgBlockWidth =
    stagger.numCols * wgBox.width + (stagger.numCols - 1) * WG_COL_GAP_PX;
  const col = computeColumnX(expanded, wgBlockWidth);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Build a single status lookup so we don't linear-scan view.stages per node.
  const statusMap = new Map<string, StageStatus>(
    view.stages.map((s) => [s.key, s.status])
  );
  const stageStatus = (key: string): StageStatus => statusMap.get(key) ?? 'not_run';

  // Discovery
  nodes.push({
    id: 'discovery',
    type: 'discovery',
    position: { x: col.discovery, y },
    data: { view, status: stageStatus('discovery') },
    draggable: false,
    selectable: true,
  });

  // Coordinator
  nodes.push({
    id: 'coordinator',
    type: 'coordinator',
    position: { x: col.coordinator, y },
    data: { view, status: stageStatus('coordinator_initial') },
    draggable: false,
    selectable: true,
  });
  edges.push(edge('discovery', 'coordinator'));

  // Working Groups — staggered two-column layout centred around `y`. Each
  // stagger step shifts the y down by half a slot, so alternate cards slot
  // between the previous-column cards rather than below them.
  const staggerStepY = (wgBox.heightCollapsed + wgStackGap) / 2;
  const wgBlockHeight = stagger.staggerSteps * staggerStepY + wgBox.heightCollapsed;
  const wgBlockTop = y + stageBox.heightCollapsed / 2 - wgBlockHeight / 2;
  territoryIds.forEach((tid, idx) => {
    const { col: wgCol, staggerStep } = stagger.positions[idx]!;
    const wgX = col.workingGroup + wgCol * (wgBox.width + WG_COL_GAP_PX);
    const wgY = wgBlockTop + staggerStep * staggerStepY;
    const wg = view.working_groups[tid];
    const status: StageStatus =
      wg.terminated_by === 'completed'
        ? 'done'
        : (wg.moves?.length ?? 0) > 0 || (wg.aligned_questions?.length ?? 0) > 0
        ? 'partial'
        : 'not_run';
    nodes.push({
      id: `wg:${tid}`,
      type: 'workingGroup',
      position: { x: wgX, y: wgY },
      data: { view, territoryId: tid, status },
      draggable: false,
      selectable: true,
    });
    edges.push(edge('coordinator', `wg:${tid}`));
    edges.push(edge(`wg:${tid}`, 'crossPollination'));
  });

  // Cross-Pollination
  nodes.push({
    id: 'crossPollination',
    type: 'crossPollination',
    position: { x: col.crossPollination, y },
    data: { view, status: stageStatus('cross_pollination') },
    draggable: false,
    selectable: true,
  });

  // Forum
  nodes.push({
    id: 'forum',
    type: 'forumStage',
    position: { x: col.forum, y },
    data: { view, status: stageStatus('forum') },
    draggable: false,
    selectable: true,
  });
  edges.push(edge('crossPollination', 'forum'));

  // Synthesis
  nodes.push({
    id: 'synthesis',
    type: 'synthesis',
    position: { x: col.synthesis, y },
    data: { view, status: stageStatus('synthesis') },
    draggable: false,
    selectable: true,
  });
  edges.push(edge('forum', 'synthesis'));

  // Mark expanded nodes with estimated height (for collision detection).
  for (const n of nodes) {
    const stage = stageFromId(n.id);
    if (stage && expanded.has(stage)) {
      const h = expandedHeight(view, stage);
      n.data = { ...n.data, expanded: true, expandedHeight: h };
      n.style = { ...n.style, height: h };
    }
  }

  // Collision-shift: within each column (same x), sort by y and shift overlapping nodes down.
  // Skip WG nodes — their staggered layout is intentional and won't collide
  // within a column (each column holds either even-indexed or odd-indexed
  // items, never adjacent stagger steps).
  const byColumn = new Map<number, Node[]>();
  for (const n of nodes) {
    if (n.id.startsWith('wg:')) continue;
    const colNodes = byColumn.get(n.position.x) ?? [];
    colNodes.push(n);
    byColumn.set(n.position.x, colNodes);
  }
  for (const colNodes of byColumn.values()) {
    colNodes.sort((a, b) => a.position.y - b.position.y);
    for (let i = 0; i < colNodes.length - 1; i++) {
      const cur = colNodes[i]!;
      const next = colNodes[i + 1]!;
      const curData = cur.data as ExpandableNodeData;
      const fallbackHeight = tokens.stageBox.heightCollapsed;
      const curHeight = curData.expanded
        ? (curData.expandedHeight ?? fallbackHeight)
        : fallbackHeight;
      const overlap = cur.position.y + curHeight + COLLISION_GAP_PX - next.position.y;
      if (overlap > 0) {
        next.position = { ...next.position, y: next.position.y + overlap };
      }
    }
  }

  return { nodes, edges };
}

function edge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    style: { stroke: edgeColors.stageFlow, strokeWidth: 1.5 },
  };
}
