import { useCallback, useMemo, useRef } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ActionIcon, Box, Group, Tabs, Text } from '@mantine/core';
import { WgMapPanel } from '../../components/WorkingGroup/WgMapPanel';
import { useViewContext } from '../../ViewContext';
import { workingGroupLayout } from '../layout/workingGroupLayout';
import { SubStageNode } from '../nodes/SubStageNode';
import { MoveGraphNode } from '../../components/WorkingGroup/debate/MoveGraphNode';
import { CandidateNode } from '../../components/WorkingGroup/alignment/CandidateNode';
import { AlignmentMoveNode } from '../../components/WorkingGroup/alignment/AlignmentMoveNode';
import { PersonaChip } from '../../primitives/PersonaChip';
import { usePersonaName } from '../../hooks/usePersonaName';
import { ConfidenceChart } from '../../components/Debate/ConfidenceChart';
import { Empty } from '../../primitives/Empty';
import { isAlignmentMove } from '../../utils/moveStage';
import { tokens } from '../../theme/tokens';
import type { AlignmentMove, Move } from '../../../inspect/types';
import type { CanvasRoute } from '../../hooks/useHashRoute';
import { useWgCanvasState } from './useWgCanvasState';

const nodeTypes: NodeTypes = {
  subStage: SubStageNode as NodeTypes[string],
  debateChain: MoveGraphNode as NodeTypes[string],
  alignmentCandidate: CandidateNode as NodeTypes[string],
  alignmentMove: AlignmentMoveNode as NodeTypes[string],
};

export function WorkingGroupCanvas({
  route,
  setRoute,
}: {
  route: Extract<CanvasRoute, { canvas: 'wg' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  const personaName = usePersonaName();
  const wg = view.working_groups?.[route.territoryId];

  const isDebateActive = route.substage === 'debate';
  const isAlignmentActive = route.substage === 'alignment';

  const debateMoves: Move[] = useMemo(
    () => (wg?.moves ?? []).filter((m): m is Move => !isAlignmentMove(m)),
    [wg],
  );

  const alignmentMoves: AlignmentMove[] = useMemo(
    () => (wg?.moves ?? []).filter(isAlignmentMove),
    [wg],
  );

  const candidates = useMemo(() => wg?.candidate_questions ?? [], [wg]);

  const alignedSourceCandidateIds = useMemo(() => {
    if (!isAlignmentActive) return new Set<string>();
    return new Set(
      (wg?.aligned_questions ?? []).flatMap((aq) => aq.source_candidate_ids ?? []),
    );
  }, [isAlignmentActive, wg]);

  const survivingIds = useMemo(
    () => new Set((wg?.surviving_claims ?? []).map((c) => c.originating_move_id)),
    [wg],
  );

  const {
    isDebateExpanded,
    setIsDebateExpanded,
    isAlignmentExpanded,
    setIsAlignmentExpanded,
    isChartCollapsed,
    setIsChartCollapsed,
    isAnyChainExpanded,
  } = useWgCanvasState({ isDebateActive, isAlignmentActive });

  const selectedMoveId =
    route.leaf?.kind === 'move' ? route.leaf.id : null;

  // Positional layout depends on graph topology only — never on selection.
  // Clicking a move flips `isSelected` on a node's data; positions don't move.
  // Keeping selectedMoveId out of this memo avoids re-running the whole
  // `buildMoveTree`/`subtreeWidth`/`planColumns` pipeline per click.
  const positionalLayout = useMemo(() => {
    if (!wg) return null;
    return workingGroupLayout(
      wg,
      route.territoryId,
      isDebateActive
        ? {
            moves: debateMoves,
            isExpanded: isDebateExpanded,
            selectedMoveId: null,
            personaName,
            survivingIds,
          }
        : undefined,
      isAlignmentActive
        ? {
            candidates,
            moves: alignmentMoves,
            alignedSourceCandidateIds,
            isExpanded: isAlignmentExpanded,
            selectedMoveId: null,
            personaName,
          }
        : undefined,
    );
  }, [
    wg,
    route.territoryId,
    isDebateActive,
    isAlignmentActive,
    debateMoves,
    alignmentMoves,
    candidates,
    alignedSourceCandidateIds,
    isDebateExpanded,
    isAlignmentExpanded,
    personaName,
    survivingIds,
  ]);

  // Cheap selection overlay: only re-maps node data when the selected move
  // changes. Candidate nodes always render `isSelected: false` in the layout,
  // so we only patch move/alignment-move chain nodes here.
  const nodes = useMemo<Node[]>(() => {
    if (!positionalLayout) return [];
    return positionalLayout.nodes.map((n) => {
      if (n.type === 'debateChain' || n.type === 'alignmentMove') {
        const d = n.data as { move: { move_id: string } } & Record<string, unknown>;
        return { ...n, data: { ...d, isSelected: d.move.move_id === selectedMoveId } };
      }
      return n;
    });
  }, [positionalLayout, selectedMoveId]);

  const edges = positionalLayout?.edges ?? [];

  // `handleNodeClick` reads the route lazily through a ref so the callback
  // identity stays stable across route changes. Without this, every URL change
  // would invalidate ReactFlow's onNodeClick prop.
  const routeRef = useRef(route);
  routeRef.current = route;

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === 'subStage') {
        const substage = (node.data as { substage?: string }).substage;
        if (substage === 'debate') {
          setIsDebateExpanded((v) => !v);
        } else if (substage === 'alignment') {
          setIsAlignmentExpanded((v) => !v);
        }
        return;
      }
      const current = routeRef.current;
      if (node.type === 'debateChain' || node.type === 'alignmentMove') {
        const data = node.data as { move: { move_id: string } };
        if (current.canvas === 'wg') {
          setRoute({ ...current, leaf: { kind: 'move', id: data.move.move_id } });
        }
        return;
      }
      if (node.type === 'alignmentCandidate') {
        const data = node.data as { candidate: { candidate_id: string } };
        if (current.canvas === 'wg') {
          setRoute({ ...current, leaf: { kind: 'candidate', id: data.candidate.candidate_id } });
        }
      }
    },
    [setRoute, setIsDebateExpanded, setIsAlignmentExpanded],
  );

  if (!wg || !positionalLayout) {
    return <Empty message={`Working group "${route.territoryId}" not found.`} />;
  }

  // Research Map is its own tab. Tab state is derived from route.substage so
  // the URL stays a faithful deep-link target; switching tabs writes the
  // route and clears any leaf the previous tab opened.
  const activeTab = route.substage === 'wg-map' ? 'map' : 'pipeline';
  const handleTabChange = (value: string | null) => {
    if (route.canvas !== 'wg') return;
    if (value === 'map') {
      setRoute({ ...route, substage: 'wg-map', leaf: undefined });
    } else {
      setRoute({ ...route, substage: undefined, leaf: undefined });
    }
  };

  // Give an expanded chain a comfortable minimum height; collapsed chains
  // don't need the extra room.
  const minDiagramHeight = isAnyChainExpanded ? 320 : 260;

  // When the chart is hidden, the diagram can claim the chart's slot too.
  const pipelineDiagramHeight = isChartCollapsed
    ? `calc(100vh - ${tokens.canvasChrome.base}px)`
    : `calc(100vh - ${tokens.canvasChrome.withChart}px)`;

  return (
    <Tabs value={activeTab} onChange={handleTabChange} keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="pipeline">Pipeline</Tabs.Tab>
        <Tabs.Tab value="map">Research Map</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="pipeline">
        <Box
          style={{
            height: pipelineDiagramHeight,
            minHeight: minDiagramHeight,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.1}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            zoomOnScroll={false}
            onNodeClick={handleNodeClick}
          >
            <Background gap={24} color="#f3f4f6" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Box>

        <Group gap="xs" mt="md" wrap="nowrap" align="center">
          <Text size="sm" c="dimmed">pair:</Text>
          {wg.pair.map((p) => (
            <PersonaChip key={p.id} personaId={p.id} label={personaName(p.id)} />
          ))}
          <ActionIcon
            variant="subtle"
            size="sm"
            ml="auto"
            aria-label={
              isChartCollapsed ? 'Show confidence chart' : 'Hide confidence chart'
            }
            aria-expanded={!isChartCollapsed}
            onClick={() => setIsChartCollapsed((v) => !v)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transition: 'transform 150ms ease',
                transform: isChartCollapsed ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </ActionIcon>
        </Group>

        {!isChartCollapsed ? (
          <Box mt="sm">
            <ConfidenceChart trajectory={wg.confidence_trajectory} />
          </Box>
        ) : null}
      </Tabs.Panel>

      <Tabs.Panel value="map">
        <Box
          style={{
            height: `calc(100vh - ${tokens.canvasChrome.base}px)`,
            minHeight: 500,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
          }}
        >
          <WgMapPanel wg={wg} height="100%" />
        </Box>
      </Tabs.Panel>
    </Tabs>
  );
}
