# Task Breakdown: Pipeline Inspector Graph

**Generated:** 2026-05-17
**Source:** [`specs/feat-pipeline-inspector-graph.md`](feat-pipeline-inspector-graph.md)
**Tracker:** STM (Simple Task Manager)

## Overview

Replace the vertical-scroll inspect SPA with a single-tab React Flow pipeline graph. Lightweight stages (Discovery, Coordinator, Cross-Pollination) expand in place; Working Group and Forum drill into sub-canvases; leaf content opens in a right-anchored `Drawer`. v5-only — v4 ideas land on an empty state.

The work is split into 14 tasks across two phases plus a foundation slice. Most P1 tasks are sequential along the dependency chain `tokens → routes → shell → top-level → sub-canvases → drawer → cleanup`. The test-tooling task and several leaf-shape tasks can run in parallel.

## Dependency graph

```
P0.1 (test tooling) ──┐                                   ┌─→ P2.3 (tests)
P0.2 (theme tokens) ──┼─→ P1.1 (route parsing) ──┐        │
                      │     │                    │        │
                      │     ├─→ P1.2 (hooks) ────┼──┐     │
                      │     │                    │  │     │
                      │     └─→ P1.3 (shell+V4) ─┘  │     │
                      │           │                 │     │
                      └─→ P1.4 (layout+pip) ────────┤     │
                            │                       │     │
                            └─→ P1.5 (nodes) ──┐    │     │
                                                ├─→ P1.6 (TopLevelCanvas)
                                                │     │
                                                │     ├─→ P1.7 (WGCanvas)
                                                │     │
                                                │     └─→ P1.8 (ForumCanvas)
                                                │             │
                                                └─→ P1.9 (DetailDrawer)
                                                          │
                                                          └─→ P1.10 (cleanup)
                                                                │
                                                                ├─→ P2.1 (expand)
                                                                ├─→ P2.2 (banner)
                                                                └─→ P2.3 (tests)
```

## Phase 0 — Foundation

### Task P0.1: Add vitest + RTL + jsdom test tooling

**Description:** Install dev-only test deps for the SPA, add a `vitest.config.ts` under `src/inspect-app/`, and wire `npm run test:app`. The CLI keeps `node --test`.
**Size:** Small
**Priority:** High
**Dependencies:** None
**Can run parallel with:** P0.2, P1.1

**Technical Requirements** (spec §7):

| Package | Version | Purpose |
|---|---|---|
| `vitest` | `^2` | Test runner for the SPA |
| `@testing-library/react` | `^16` | Component rendering + interaction queries |
| `@testing-library/user-event` | `^14` | Keyboard + click simulation |
| `jsdom` | `^25` | DOM environment for vitest |
| `@vitest/coverage-v8` | `^2` | Optional — coverage reporting |

Added under `devDependencies` only. Vitest config lives under `src/inspect-app/` so the project root continues to delegate `npm test` to `node --test` for the CLI.

**Implementation steps:**

1. `npm install --save-dev vitest @testing-library/react @testing-library/user-event jsdom @vitest/coverage-v8`.
2. Create `src/inspect-app/vitest.config.ts`:
    ```ts
    import { defineConfig } from 'vitest/config';
    import react from '@vitejs/plugin-react';

    export default defineConfig({
      plugins: [react()],
      test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./test-setup.ts'],
        include: ['**/*.test.ts', '**/*.test.tsx'],
      },
    });
    ```
3. Create `src/inspect-app/test-setup.ts`:
    ```ts
    import '@testing-library/jest-dom/vitest';
    // Polyfill ResizeObserver for ReactFlow under jsdom.
    if (!(globalThis as any).ResizeObserver) {
      (globalThis as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    if (!(globalThis as any).DOMRect) {
      (globalThis as any).DOMRect = class {
        constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
        static fromRect(r?: { x?: number; y?: number; width?: number; height?: number }) {
          return new (globalThis as any).DOMRect(r?.x, r?.y, r?.width, r?.height);
        }
      };
    }
    ```
4. Add `@testing-library/jest-dom` to devDeps (used by setup; matchers).
5. Add to root `package.json` scripts: `"test:app": "vitest --root src/inspect-app --config src/inspect-app/vitest.config.ts run"`.
6. Add a smoke test `src/inspect-app/test-setup.smoke.test.ts`:
    ```ts
    import { describe, it, expect } from 'vitest';
    describe('smoke', () => {
      it('jsdom is active', () => {
        expect(typeof document).toBe('object');
        expect(typeof (globalThis as any).ResizeObserver).toBe('function');
      });
    });
    ```

**Acceptance Criteria:**

- [ ] `npm run test:app` exits 0 with the smoke test passing.
- [ ] `npm test` (root, `node --test`) still exits 0 — no regression to the CLI test surface.
- [ ] `jsdom` is the test environment (`document`, `window` globals available).
- [ ] `ResizeObserver` shim present so ReactFlow doesn't throw under jsdom.

---

### Task P0.2: Extend `theme/tokens.ts` for graph nodes

**Description:** Add node sizing, status pip glyph + colour, drawer width tokens to the existing theme module. No new file; extend the existing tiny one.
**Size:** Small
**Priority:** High
**Dependencies:** None
**Can run parallel with:** P0.1, P1.1

**Current file** (`src/inspect-app/theme/tokens.ts`, 13 lines, includes existing `edgeColors`):

Extend with:

```ts
import type { StageStatus } from '../../inspect/types';

export const tokens = {
  navbarWidth: 220,
  sectionGap: 'xl',
  graphHeight: 520,
  drawerWidth: 520,
  pipelineColumnX: {
    discovery: 0,
    coordinator: 220,
    workingGroup: 440,
    crossPollination: 720,
    forum: 940,
    synthesis: 1140,
  },
  pipelineRowY: 220,           // y of the middle row (single-row stages)
  stageBox: { width: 180, heightCollapsed: 110 },
  wgBox: { width: 200, heightCollapsed: 96 },
  wgStackGap: 30,              // vertical gap between fanned-out WGs
  subStageBox: { width: 170, height: 92 },
  subStageGap: 30,
  headerHeight: 56,
  bannerHeight: 44,
} as const;

export const edgeColors = {
  contradiction: '#dc2626',
  crossPollination: '#9333ea',
  intraCluster: '#9ca3af',
  stageFlow: '#374151',
};

export const stageStatusGlyph: Record<StageStatus, string> = {
  done: '●',
  partial: '◐',
  failed: '✕',
  skipped: '○',
  not_run: '○',
};

export const stageStatusColor: Record<StageStatus, string> = {
  done: '#16a34a',
  partial: '#d97706',
  failed: '#dc2626',
  skipped: '#9ca3af',
  not_run: '#9ca3af',
};
```

**Acceptance Criteria:**

- [ ] Type-checks (`tsc --noEmit` over `src/inspect-app/`) cleanly.
- [ ] Existing consumers of `tokens` (e.g., `ForumGraph` uses `tokens.graphHeight`) still compile.
- [ ] Glyph + colour tables cover all five `StageStatus` enum values from `src/inspect/types.d.ts`.

---

## Phase 1 — MVP: graph replaces scroll

### Task P1.1: Hash route parsing — `parseCanvasRoute` + `formatCanvasRoute`

**Description:** Extend `src/inspect-app/hooks/useHashRoute.ts` with the structured `CanvasRoute` types and round-trippable parse/format functions. Includes `node --test` unit tests.
**Size:** Medium
**Priority:** High
**Dependencies:** None
**Can run parallel with:** P0.1, P0.2

**Technical Requirements** (spec §8.5):

```ts
export type ExpandedStage = 'discovery' | 'coordinator' | 'cross_pollination';

export type WorkingGroupSubstage =
  | 'ideation' | 'adversarial' | 'alignment'
  | 'researcher' | 'observation' | 'debate';

export type LeafRef =
  | { kind: 'persona'; id: string }
  | { kind: 'territory'; id: string }
  | { kind: 'candidate'; id: string }
  | { kind: 'aligned'; id: string }
  | { kind: 'report'; id: string }
  | { kind: 'observation'; id: string }
  | { kind: 'move'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'synthesis' };

export type CanvasRoute =
  | { canvas: 'pipeline'; expanded: ExpandedStage[]; leaf?: LeafRef }
  | { canvas: 'wg'; territoryId: string; substage?: WorkingGroupSubstage; leaf?: LeafRef }
  | { canvas: 'forum'; leaf?: LeafRef };

export function parseCanvasRoute(hash: string): CanvasRoute;
export function formatCanvasRoute(route: CanvasRoute): string;
```

**Hash formats** (spec §8.1):

```
#pipeline                                  default top-level
#pipeline/expand=discovery                 Discovery expanded in place
#pipeline/expand=discovery,coordinator     two stages expanded
#pipeline/leaf=persona:p_oncologist        top-level + side panel
#wg:tech                                   drilled into WG with territory id `tech`
#wg:tech/substage=researcher               drilled into WG, sub-stage focused
#wg:tech/leaf=move:m_004                   drilled in + side panel
#forum                                     drilled into Forum contradiction graph
#forum/leaf=node:n_007                     drilled in + side panel
```

(Spec §8.5 sketch had `expand=discovery,wg:tech` — interpret strictly: `expanded` only contains `ExpandedStage` values; `wg:*` is a separate canvas, not an expansion item.)

**Implementation steps:**

1. Keep the existing `useHashRoute()` + `parseRoute()` for any remaining short-term references, but deprecate via JSDoc. Remove after P1.10.
2. Add the new types and `parseCanvasRoute(hash)`:
    - Strip leading `#`.
    - Split on `/`. First segment is canvas head (`pipeline`, `wg:<id>`, `forum`); remaining are `key=value` params.
    - For `pipeline`: parse `expand=a,b` into an array filtered to known `ExpandedStage`. Unknown values are dropped silently.
    - For `wg:<id>`: validate id is `^[A-Za-z0-9_-]+$`. Reject otherwise → default pipeline route. Parse `substage=<key>` against the enum.
    - For all canvases: parse `leaf=<kind>[:<id>]`. Validate kind against `LeafRef['kind']` enum; if `kind === 'synthesis'`, no id required. Sanitise id: alphanumeric + `_-` only.
    - Anything malformed or unknown → return `{ canvas: 'pipeline', expanded: [] }` (safe default per spec §12).
3. Add `formatCanvasRoute(route)`:
    - `pipeline` → `#pipeline` (if no params) else `#pipeline/expand=…/leaf=…`.
    - `wg` → `#wg:<id>` plus optional `/substage=…` and `/leaf=…`.
    - `forum` → `#forum` plus optional `/leaf=…`.
    - Order is fixed: `expand`, `substage`, `leaf` — preserves round-trip stability.
4. Add `useCanvasRoute()` hook that returns `{ route, setRoute }`:
    - Reads from `window.location.hash` (subscribes to `hashchange`).
    - `setRoute(next)` writes `formatCanvasRoute(next)` only if different (idempotent).
5. Unit tests `src/inspect-app/hooks/useHashRoute.test.mjs` (using `node --test`):
    - Round-trip: each canonical hash in the table above parses then formats to the same string.
    - Malformed: `#xyz`, `#wg:`, `#wg:bad/garbage`, `#pipeline/leaf=unknown:foo` all return `{ canvas: 'pipeline', expanded: [] }`.
    - Sanitisation: id with `..` or `/` is rejected.
    - Idempotence: `setRoute(route)` with identical route does not change `window.location.hash`.

**Acceptance Criteria:**

- [ ] All canonical hash strings round-trip.
- [ ] Malformed inputs do not throw and return the safe default.
- [ ] Leaf ids constrained to `^[A-Za-z0-9_-]+$`; unknown kinds rejected.
- [ ] `useCanvasRoute()` exposes `{ route, setRoute }` and updates only on real change.
- [ ] Node `--test` suite for `useHashRoute.test.mjs` passes.

---

### Task P1.2: `useExpandedStages` + integration into route

**Description:** Hook that derives the expanded-stage set from `route.expanded` and exposes a `toggle` helper. Thin convenience on top of P1.1.
**Size:** Small
**Priority:** Medium
**Dependencies:** P1.1
**Can run parallel with:** P0.1, P0.2, P1.3 (once P1.1 is done)

**Implementation:**

```ts
// src/inspect-app/hooks/useExpandedStages.ts
import { useCanvasRoute, type ExpandedStage } from './useHashRoute';

export function useExpandedStages(): {
  expanded: Set<ExpandedStage>;
  toggle: (stage: ExpandedStage) => void;
  isExpanded: (stage: ExpandedStage) => boolean;
} {
  const { route, setRoute } = useCanvasRoute();
  if (route.canvas !== 'pipeline') {
    return {
      expanded: new Set(),
      isExpanded: () => false,
      toggle: () => {
        // Toggling while on a sub-canvas snaps back to pipeline view.
        setRoute({ canvas: 'pipeline', expanded: [] });
      },
    };
  }
  const expanded = new Set(route.expanded);
  return {
    expanded,
    isExpanded: (s) => expanded.has(s),
    toggle: (s) => {
      const next = expanded.has(s)
        ? route.expanded.filter((x) => x !== s)
        : [...route.expanded, s];
      setRoute({ ...route, expanded: next });
    },
  };
}
```

**Tests** (`useExpandedStages.test.mjs`, node --test):
- Given a hash with `expand=discovery`, `expanded.has('discovery')` is true.
- `toggle('discovery')` removes it; toggling again adds it back.
- On `#wg:tech`, calling `toggle('discovery')` snaps back to pipeline view (acceptable side-effect documented).

**Acceptance Criteria:**

- [ ] Toggling is idempotent (toggle twice returns to original hash).
- [ ] Works correctly when current route is non-pipeline.
- [ ] Hash update goes through `setRoute` — no direct `window.location.hash` writes here.

---

### Task P1.3: `InspectorGraph` shell + `Header` integration + `<V4EmptyState />`

**Description:** Rewrite `App.tsx` to host the new graph shell. Add `InspectorGraph.tsx` that switches between the three canvases by route, mounts the sticky header and the side `DetailDrawer` slot. Add a `<V4EmptyState />` for v4 ideas.
**Size:** Medium
**Priority:** High
**Dependencies:** P0.2, P1.1, P1.2
**Can run parallel with:** P1.4 (layout work can proceed independently)

**Files to create/modify:**

- Rewrite `src/inspect-app/App.tsx`.
- Create `src/inspect-app/inspector/InspectorGraph.tsx`.
- Create `src/inspect-app/inspector/V4EmptyState.tsx`.
- Create `src/inspect-app/inspector/CanvasBreadcrumb.tsx`.

**App.tsx (rewritten):**

```tsx
import { Suspense } from 'react';
import { Center, Loader } from '@mantine/core';
import { ViewProvider } from './ViewContext';
import { useView } from './hooks/useView';
import { ErrorBoundary } from './ErrorBoundary';
import { InspectorGraph } from './inspector/InspectorGraph';
import { V4EmptyState } from './inspector/V4EmptyState';

function Body() {
  const view = useView();
  if (view.schema_version === 'v4') {
    return <V4EmptyState id={view.id} />;
  }
  return (
    <ViewProvider view={view}>
      <InspectorGraph />
    </ViewProvider>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Center mih="100vh"><Loader /></Center>}>
        <Body />
      </Suspense>
    </ErrorBoundary>
  );
}
```

**InspectorGraph.tsx:**

```tsx
import { AppShell, Stack } from '@mantine/core';
import { useCanvasRoute } from '../hooks/useHashRoute';
import { Header } from '../components/Header/Header';
import { CanvasBreadcrumb } from './CanvasBreadcrumb';
import { TopLevelCanvas } from './TopLevelCanvas';
import { WorkingGroupCanvas } from './canvases/WorkingGroupCanvas';
import { ForumCanvas } from './canvases/ForumCanvas';
import { DetailDrawer } from './DetailDrawer';

export function InspectorGraph() {
  const { route, setRoute } = useCanvasRoute();
  const closeDrawer = () =>
    setRoute({ ...route, leaf: undefined } as typeof route);
  return (
    <AppShell padding="md">
      <AppShell.Main>
        <Stack gap="md">
          <Header />
          <CanvasBreadcrumb route={route} setRoute={setRoute} />
          {route.canvas === 'pipeline' && (
            <TopLevelCanvas route={route} setRoute={setRoute} />
          )}
          {route.canvas === 'wg' && (
            <WorkingGroupCanvas route={route} setRoute={setRoute} />
          )}
          {route.canvas === 'forum' && (
            <ForumCanvas route={route} setRoute={setRoute} />
          )}
        </Stack>
      </AppShell.Main>
      <DetailDrawer leaf={route.leaf} onClose={closeDrawer} />
    </AppShell>
  );
}
```

**V4EmptyState.tsx:**

```tsx
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
```

**CanvasBreadcrumb.tsx:**

```tsx
import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import type { CanvasRoute } from '../hooks/useHashRoute';
import { useViewContext } from '../ViewContext';

export function CanvasBreadcrumb({
  route,
  setRoute,
}: { route: CanvasRoute; setRoute: (r: CanvasRoute) => void }) {
  const view = useViewContext();
  if (route.canvas === 'pipeline') return null;
  const items = [
    <Anchor key="pipeline" onClick={() => setRoute({ canvas: 'pipeline', expanded: [] })}>
      Pipeline
    </Anchor>,
  ];
  if (route.canvas === 'wg') {
    const wg = view.working_groups?.[route.territoryId];
    items.push(<Text key="wg">WG: {wg?.territory?.name ?? route.territoryId}</Text>);
  } else if (route.canvas === 'forum') {
    items.push(<Text key="forum">Forum</Text>);
  }
  return <Breadcrumbs separator="/">{items}</Breadcrumbs>;
}
```

**Notes:**

- The existing `Header` component in `src/inspect-app/components/Header/Header.tsx` is reused unchanged.
- Until P1.6 / P1.7 / P1.8 land, the three canvas components are stubs that render a placeholder; this task is correct when the shell + v4 empty state + breadcrumb all mount cleanly.

**Acceptance Criteria:**

- [ ] v5 fixture (`ready-v5`) boots the SPA without runtime errors, renders the `Header` and an empty pipeline placeholder.
- [ ] v4 fixture (`ready`) renders the `<V4EmptyState />` — no React Flow mounts.
- [ ] Breadcrumb appears only on `wg` / `forum` canvases; `Pipeline` link returns to `#pipeline`.
- [ ] Browser back/forward across canvases works (driven entirely by hash).
- [ ] `App.tsx` imports compile; `ErrorBoundary` still wraps the tree.

---

### Task P1.4: `pipelineLayout.ts` (collapsed-only) + `StageStatusPip`

**Description:** Hand-written deterministic layout for the top-level pipeline canvas (collapsed nodes only — expanded heights deferred to P2.1). Plus the small `StageStatusPip` component.
**Size:** Medium
**Priority:** High
**Dependencies:** P0.2
**Can run parallel with:** P1.3

**`StageStatusPip.tsx`:**

```tsx
import { Text, Tooltip } from '@mantine/core';
import type { StageStatus } from '../../inspect/types';
import { stageStatusColor, stageStatusGlyph } from '../theme/tokens';

export function StageStatusPip({
  status,
  label,
}: { status: StageStatus; label?: string }) {
  return (
    <Tooltip label={label ?? status} withArrow>
      <Text
        component="span"
        size="lg"
        fw={700}
        c={stageStatusColor[status]}
        aria-label={`status: ${status}`}
      >
        {stageStatusGlyph[status]}
      </Text>
    </Tooltip>
  );
}
```

**`pipelineLayout.ts`:**

```ts
// src/inspect-app/inspector/layout/pipelineLayout.ts
import type { Edge, Node } from '@xyflow/react';
import type { InvestigationView } from '../../../inspect/types';
import { tokens, edgeColors } from '../../theme/tokens';

export type StageNodeKey =
  | 'discovery' | 'coordinator' | 'crossPollination' | 'forum' | 'synthesis'
  | `wg:${string}`;

export function pipelineLayout(view: InvestigationView): {
  nodes: Node[];
  edges: Edge[];
} {
  const { pipelineColumnX: col, pipelineRowY: y, stageBox, wgBox, wgStackGap } = tokens;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Discovery
  nodes.push({
    id: 'discovery',
    type: 'discovery',
    position: { x: col.discovery, y },
    data: { view, status: stageStatus(view, 'discovery') },
    draggable: false,
    selectable: true,
  });

  // Coordinator
  nodes.push({
    id: 'coordinator',
    type: 'coordinator',
    position: { x: col.coordinator, y },
    data: { view, status: stageStatus(view, 'coordinator_initial') },
    draggable: false,
    selectable: true,
  });

  edges.push(edge('discovery', 'coordinator'));

  // Working Groups — coordinator-order, vertically centred around `y`.
  const territoryIds = Object.keys(view.working_groups ?? {});
  const stackCount = territoryIds.length;
  const stackTotalHeight =
    stackCount * wgBox.heightCollapsed + Math.max(stackCount - 1, 0) * wgStackGap;
  const stackTop =
    y + stageBox.heightCollapsed / 2 - stackTotalHeight / 2;
  territoryIds.forEach((tid, idx) => {
    const wgY = stackTop + idx * (wgBox.heightCollapsed + wgStackGap);
    const wg = view.working_groups[tid];
    const status: 'done' | 'partial' | 'not_run' =
      wg.terminated_by === 'completed'
        ? 'done'
        : wg.terminated_by
        ? 'partial'
        : wg.aligned_questions.length
        ? 'partial'
        : 'not_run';
    nodes.push({
      id: `wg:${tid}`,
      type: 'workingGroup',
      position: { x: col.workingGroup, y: wgY },
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
    data: { view, status: stageStatus(view, 'cross_pollination') },
    draggable: false,
    selectable: true,
  });

  // Forum
  nodes.push({
    id: 'forum',
    type: 'forumStage',
    position: { x: col.forum, y },
    data: { view, status: stageStatus(view, 'forum') },
    draggable: false,
    selectable: true,
  });
  edges.push(edge('crossPollination', 'forum'));

  // Synthesis
  nodes.push({
    id: 'synthesis',
    type: 'synthesis',
    position: { x: col.synthesis, y },
    data: { view, status: stageStatus(view, 'synthesis') },
    draggable: false,
    selectable: true,
  });
  edges.push(edge('forum', 'synthesis'));

  return { nodes, edges };
}

function stageStatus(view: InvestigationView, key: string) {
  return view.stages.find((s) => s.key === key)?.status ?? 'not_run';
}

function edge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    style: { stroke: edgeColors.stageFlow, strokeWidth: 1.5 },
  };
}
```

**Tests** (`pipelineLayout.test.mjs`, node --test):
- For the `ready-v5` fixture, returns nodes with ids `['discovery','coordinator','wg:*','crossPollination','forum','synthesis']` — assert ids set.
- For the `investigating` fixture (partial), the in-flight WG carries `status: 'partial'` and later stages `'not_run'`.
- Edges: every WG has incoming edge from `coordinator` and outgoing to `crossPollination`. `forum->synthesis` and `crossPollination->forum` always present.

**Acceptance Criteria:**

- [ ] Layout is deterministic — identical input produces identical positions.
- [ ] WGs are vertically centred around the middle row.
- [ ] Edge ids unique; sources/targets always point to existing node ids.
- [ ] Status mapping for partial / not_run honours `view.stages[*].status`.

---

### Task P1.5: Six stage nodes (collapsed)

**Description:** Implement the six React Flow custom node components used by `TopLevelCanvas`. Each renders only the collapsed state for P1 — expanded renderings are added in P2.1.
**Size:** Medium
**Priority:** High
**Dependencies:** P0.2, P1.4 (StageStatusPip)
**Can run parallel with:** P1.3 (App shell)

**Files** under `src/inspect-app/inspector/nodes/`:

- `DiscoveryNode.tsx`
- `CoordinatorNode.tsx`
- `WorkingGroupNode.tsx`
- `CrossPollinationNode.tsx`
- `ForumStageNode.tsx`
- `SynthesisNode.tsx`

Each shares a shared shell. Suggested base:

```tsx
// src/inspect-app/inspector/nodes/StageNodeShell.tsx
import { Group, Paper, Stack, Text } from '@mantine/core';
import { Handle, Position } from '@xyflow/react';
import type { ReactNode, MouseEvent, KeyboardEvent } from 'react';
import { StageStatusPip } from '../StageStatusPip';
import { tokens } from '../../theme/tokens';
import type { StageStatus } from '../../../inspect/types';

export function StageNodeShell({
  title, status, summary, footer, onActivate, ariaExpanded,
}: {
  title: string;
  status: StageStatus;
  summary?: ReactNode;
  footer?: ReactNode;
  onActivate?: () => void;
  ariaExpanded?: boolean;
}) {
  const handleClick = (e: MouseEvent) => { e.stopPropagation(); onActivate?.(); };
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate?.(); }
  };
  return (
    <Paper
      withBorder p="sm" w={tokens.stageBox.width} mih={tokens.stageBox.heightCollapsed}
      role="button" tabIndex={0} aria-expanded={ariaExpanded}
      onClick={handleClick} onKeyDown={handleKey}
      style={{ cursor: onActivate ? 'pointer' : 'default' }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Stack gap={4}>
        <Group justify="space-between" gap="xs">
          <Text fw={600}>{title}</Text>
          <StageStatusPip status={status} />
        </Group>
        {summary}
        {footer}
      </Stack>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </Paper>
  );
}
```

**Per-node specifics** (collapsed-only renderings; full data examples below):

**DiscoveryNode** — `data: { view, status }`. Summary: `{candidates.length} → {selected.length}` and a `{search_queries.length} queries` badge. Activation toggles `expand: 'discovery'` via `useExpandedStages`.

```tsx
export function DiscoveryNode({ data }: NodeProps<NodeData>) {
  const { view, status } = data;
  const { toggle, isExpanded } = useExpandedStages();
  const cand = view.discovery.candidate_personas.length;
  const sel = view.discovery.selected_persona_ids.length;
  return (
    <StageNodeShell
      title="Discovery"
      status={status}
      summary={
        <>
          <Text size="sm" c="dimmed">{cand} → {sel}</Text>
          <Badge size="xs" variant="light">{view.discovery.search_queries.length} queries</Badge>
        </>
      }
      onActivate={() => toggle('discovery')}
      ariaExpanded={isExpanded('discovery')}
    />
  );
}
```

**CoordinatorNode** — Summary: `{territories.length} territories`. Activation toggles `expand: 'coordinator'`.

**WorkingGroupNode** — `data: { view, territoryId, status }`. Summary:
- `WG: <territory.name ?? territoryId>` (as title — override).
- `{wg.aligned_questions.length} aligned`.
- `{wg.surviving_claims.length} claims`.
- Orange badge if any `wg.researcher_reports.some(r => r.outcome === 'dead_end')`.
- Footer: pair chips (reuse `PersonaChip`).

Activation: `setRoute({ canvas: 'wg', territoryId })`.

**CrossPollinationNode** — Summary: `{view.cross_pollination.length} reaction batches`. Activation toggles `expand: 'cross_pollination'`.

**ForumStageNode** — Summary: `{forum.nodes.length} nodes`. Red badge for `forum.contradiction_edges.length`. Yellow badge for `forum.nodes.filter(n => n.has_open_question).length`. Activation: `setRoute({ canvas: 'forum' })`.

**SynthesisNode** — Summary: `{headline_findings.length} findings`. Activation: open synthesis leaf — `setRoute({ canvas: 'pipeline', expanded: [], leaf: { kind: 'synthesis' } })`.

**Acceptance Criteria:**

- [ ] All six components export with `NodeProps<NodeData>` signatures, no type errors.
- [ ] Each renders correctly for the `ready-v5` fixture in isolation (smoke test).
- [ ] Click + Enter both fire activation.
- [ ] `aria-expanded` attribute reflects expansion state where applicable.
- [ ] Source/target React Flow handles are invisible but functional.

---

### Task P1.6: `TopLevelCanvas` wiring

**Description:** ReactFlow canvas that consumes `pipelineLayout` + the six node components and wires click handlers to hash routes.
**Size:** Small
**Priority:** High
**Dependencies:** P1.3 (shell), P1.4 (layout), P1.5 (nodes)
**Can run parallel with:** P1.7, P1.8 (different canvases)

**Implementation:**

```tsx
// src/inspect-app/inspector/TopLevelCanvas.tsx
import { useMemo } from 'react';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box } from '@mantine/core';
import { useViewContext } from '../ViewContext';
import { pipelineLayout } from './layout/pipelineLayout';
import { DiscoveryNode } from './nodes/DiscoveryNode';
import { CoordinatorNode } from './nodes/CoordinatorNode';
import { WorkingGroupNode } from './nodes/WorkingGroupNode';
import { CrossPollinationNode } from './nodes/CrossPollinationNode';
import { ForumStageNode } from './nodes/ForumStageNode';
import { SynthesisNode } from './nodes/SynthesisNode';
import { tokens } from '../theme/tokens';
import type { CanvasRoute } from '../hooks/useHashRoute';

const nodeTypes = {
  discovery: DiscoveryNode,
  coordinator: CoordinatorNode,
  workingGroup: WorkingGroupNode,
  crossPollination: CrossPollinationNode,
  forumStage: ForumStageNode,
  synthesis: SynthesisNode,
};

export function TopLevelCanvas({
  route, setRoute,
}: {
  route: Extract<CanvasRoute, { canvas: 'pipeline' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  const { nodes, edges } = useMemo(() => pipelineLayout(view), [view]);
  return (
    <Box style={{ height: tokens.graphHeight, border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} color="#f3f4f6" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}
```

Note: `route` and `setRoute` are accessed inside each node component via the hooks (`useCanvasRoute`, `useExpandedStages`) — the canvas itself does not need them. They're kept on the prop signature for parity with the WG/Forum canvases and possible future use (e.g., `<Controls>` injection).

**Acceptance Criteria:**

- [ ] On the `ready-v5` fixture, exactly 5 fixed nodes + N WG nodes mount; edges connect them in the spec topology.
- [ ] Clicking a WG node updates hash to `#wg:<id>`; the canvas switches via `InspectorGraph` (verified at integration level).
- [ ] `Controls` (zoom + fit) visible; no MiniMap (per spec §6).
- [ ] No console errors under jsdom (ResizeObserver shim from P0.1 must be active).

---

### Task P1.7: `WorkingGroupCanvas` + `workingGroupLayout`

**Description:** Drilled-into canvas for a single WG. Six sub-stage nodes in a horizontal row; per-WG footer with persona pair chips and `ConfidenceChart`. Click on a sub-stage opens the relevant Panel in the drawer (reuses existing `IdeationPanel`, `AdversarialPanel`, etc.).
**Size:** Medium
**Priority:** High
**Dependencies:** P1.3, P1.4 (StageStatusPip), P1.5 (depends on P1.5 pattern; not strict — uses shared shell idea)
**Can run parallel with:** P1.6, P1.8

**Files:**

- `src/inspect-app/inspector/layout/workingGroupLayout.ts`
- `src/inspect-app/inspector/canvases/WorkingGroupCanvas.tsx`
- `src/inspect-app/inspector/nodes/SubStageNode.tsx` (one shared component for all six sub-stages)

**`workingGroupLayout.ts`:**

```ts
import type { Edge, Node } from '@xyflow/react';
import type { WorkingGroupView } from '../../../inspect/types';
import { edgeColors, tokens } from '../../theme/tokens';
import type { WorkingGroupSubstage } from '../../hooks/useHashRoute';

const STAGES: WorkingGroupSubstage[] = [
  'ideation', 'adversarial', 'alignment', 'researcher', 'observation', 'debate',
];

export function workingGroupLayout(wg: WorkingGroupView): { nodes: Node[]; edges: Edge[] } {
  const { subStageBox, subStageGap } = tokens;
  const nodes: Node[] = STAGES.map((substage, i) => ({
    id: `substage:${substage}`,
    type: 'subStage',
    position: { x: i * (subStageBox.width + subStageGap), y: 0 },
    data: { wg, substage, status: substageStatus(wg, substage) },
    draggable: false,
    selectable: true,
  }));
  const edges: Edge[] = STAGES.slice(0, -1).map((s, i) => ({
    id: `${s}->${STAGES[i+1]}`,
    source: `substage:${s}`,
    target: `substage:${STAGES[i+1]}`,
    style: { stroke: edgeColors.stageFlow, strokeWidth: 1.5 },
  }));
  return { nodes, edges };
}

function substageStatus(wg: WorkingGroupView, key: WorkingGroupSubstage) {
  switch (key) {
    case 'ideation':     return wg.candidate_questions.length ? 'done' : 'not_run';
    case 'adversarial':  return wg.adversarial_marks.length ? 'done' : 'not_run';
    case 'alignment':    return wg.aligned_questions.length ? 'done' : 'not_run';
    case 'researcher':   return wg.researcher_reports.length ? 'done' : 'not_run';
    case 'observation':  return wg.observations.length ? 'done' : 'not_run';
    case 'debate':       return wg.moves.length ? 'done' : 'not_run';
  }
}
```

**`SubStageNode.tsx`:**

```tsx
import { Group, Paper, Stack, Text } from '@mantine/core';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { StageStatusPip } from '../StageStatusPip';
import { useCanvasRoute, type CanvasRoute, type WorkingGroupSubstage } from '../../hooks/useHashRoute';
import type { WorkingGroupView, StageStatus } from '../../../inspect/types';
import { tokens } from '../../theme/tokens';

type Data = {
  wg: WorkingGroupView;
  substage: WorkingGroupSubstage;
  status: StageStatus;
};

const LABEL: Record<WorkingGroupSubstage, string> = {
  ideation: 'Ideation', adversarial: 'Adversarial', alignment: 'Alignment',
  researcher: 'Researcher', observation: 'Observations', debate: 'Debate',
};

const SUMMARY: Record<WorkingGroupSubstage, (wg: WorkingGroupView) => string> = {
  ideation:    (w) => `${w.candidate_questions.length} candidates`,
  adversarial: (w) => `${w.adversarial_marks.length} flagged`,
  alignment:   (w) => `${w.aligned_questions.length} aligned questions`,
  researcher:  (w) => `${w.researcher_reports.length} reports`,
  observation: (w) => `${w.observations.length} observations`,
  debate:      (w) => `${w.moves.length} moves`,
};

export function SubStageNode({ data }: NodeProps<Data>) {
  const { wg, substage, status } = data;
  const { route, setRoute } = useCanvasRoute();
  if (route.canvas !== 'wg') return null;
  const onActivate = () => {
    setRoute({ ...route, substage });
    // Also open a leaf representative of this substage; defer to leafRenderers for the panel mapping.
  };
  return (
    <Paper
      withBorder p="sm" w={tokens.subStageBox.width} h={tokens.subStageBox.height}
      role="button" tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); } }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Stack gap={2}>
        <Group justify="space-between"><Text fw={600}>{LABEL[substage]}</Text><StageStatusPip status={status} /></Group>
        <Text size="sm" c="dimmed">{SUMMARY[substage](wg)}</Text>
      </Stack>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </Paper>
  );
}
```

**`WorkingGroupCanvas.tsx`:**

```tsx
import { useMemo } from 'react';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { Box, Group, Stack } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { workingGroupLayout } from '../layout/workingGroupLayout';
import { SubStageNode } from '../nodes/SubStageNode';
import { PersonaChip } from '../../primitives/PersonaChip';
import { usePersonaName } from '../../hooks/usePersonaName';
import { ConfidenceChart } from '../../components/Debate/ConfidenceChart';
import { Empty } from '../../primitives/Empty';
import { tokens } from '../../theme/tokens';
import type { CanvasRoute } from '../../hooks/useHashRoute';

const nodeTypes = { subStage: SubStageNode };

export function WorkingGroupCanvas({
  route,
}: {
  route: Extract<CanvasRoute, { canvas: 'wg' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  const personaName = usePersonaName();
  const wg = view.working_groups?.[route.territoryId];
  if (!wg) return <Empty message={`Working group "${route.territoryId}" not found in this view.`} />;
  const { nodes, edges } = useMemo(() => workingGroupLayout(wg), [wg]);
  return (
    <Stack gap="md">
      <Box style={{ height: 220, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          fitView fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false} nodesConnectable={false}
          edgesFocusable={false} zoomOnScroll={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="#f3f4f6" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </Box>
      <Group gap="xs">
        <Text size="sm" c="dimmed">pair:</Text>
        {wg.pair.map((p) => <PersonaChip key={p.id} personaId={p.id} label={personaName(p.id)} />)}
      </Group>
      <ConfidenceChart trajectory={wg.confidence_trajectory} />
    </Stack>
  );
}
```

The sub-stage click sets `substage` in the hash; the actual panel content (Ideation / Adversarial / …) appears in the side drawer dispatched by P1.9. The mapping `substage → leaf kind` is added in P1.9 (`leafRenderers.tsx`).

**Acceptance Criteria:**

- [ ] Navigating to `#wg:<id>` with `<id>` matching a real territory renders the six-stage canvas + pair chips + sparkline.
- [ ] Clicking a sub-stage updates hash to include `substage=<key>`.
- [ ] Missing/unknown territoryId renders the empty state gracefully.
- [ ] Sub-stage status pips reflect emptiness of the relevant arrays (correct partial-render under `investigating` fixture).

---

### Task P1.8: `ForumCanvas`

**Description:** Drilled-into canvas wrapping the existing `<ForumGraph>` component. Route node selections into the global drawer via the new hash format.
**Size:** Small
**Priority:** High
**Dependencies:** P1.3 (shell), no other strict deps
**Can run parallel with:** P1.6, P1.7

**Implementation:**

```tsx
// src/inspect-app/inspector/canvases/ForumCanvas.tsx
import { Box, Stack, Text, Anchor } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { ForumGraph } from '../../components/Forum/ForumGraph';
import type { CanvasRoute } from '../../hooks/useHashRoute';

export function ForumCanvas({
  route, setRoute,
}: {
  route: Extract<CanvasRoute, { canvas: 'forum' }>;
  setRoute: (r: CanvasRoute) => void;
}) {
  const view = useViewContext();
  const onNodeSelect = (nodeId: string) =>
    setRoute({ canvas: 'forum', leaf: { kind: 'node', id: nodeId } });
  const deadEnds = view.schema_version === 'v5'
    ? ('dead_end_questions' in view.forum ? view.forum.dead_end_questions : [])
    : [];
  return (
    <Stack gap="sm">
      <Box>
        <ForumGraph view={view} onNodeSelect={onNodeSelect} />
      </Box>
      {deadEnds.length > 0 && (
        <Stack gap={4}>
          <Text fw={600} size="sm">Dead-end questions ({deadEnds.length})</Text>
          {deadEnds.map((d) => (
            <Anchor
              key={d.aligned_id}
              onClick={() => setRoute({ canvas: 'forum', leaf: { kind: 'aligned', id: d.aligned_id } })}
            >
              {d.outcome_summary}
            </Anchor>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
```

**Acceptance Criteria:**

- [ ] `#forum` mounts `<ForumGraph>` unchanged (its existing `MiniMap`, intra-cluster toggle, etc. work).
- [ ] Clicking a forum node sets hash to `#forum/leaf=node:<id>`.
- [ ] v5 dead-end list appears when present; clicking opens the corresponding `aligned` leaf in the drawer.
- [ ] No regressions to `ForumGraph` itself (it remains the canonical contradiction graph; existing tests stay green).

---

### Task P1.9: `DetailDrawer` + `leafRenderers`

**Description:** Right-anchored Mantine `Drawer` that opens whenever `route.leaf` is set. Dispatches to renderers for each of the 10 leaf kinds. Implements `Esc` close, raw-content copy button, and cross-leaf links.
**Size:** Large
**Priority:** High
**Dependencies:** P1.3 (shell), P1.1 (route types)
**Can run parallel with:** P1.6, P1.7, P1.8

**Files:**

- `src/inspect-app/inspector/DetailDrawer.tsx`
- `src/inspect-app/inspector/leafRenderers.tsx`

**`DetailDrawer.tsx`:**

```tsx
import { Button, Drawer, Group, ScrollArea, Stack } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { useViewContext } from '../ViewContext';
import { renderLeaf } from './leafRenderers';
import type { LeafRef } from '../hooks/useHashRoute';
import { tokens } from '../theme/tokens';

export function DetailDrawer({
  leaf, onClose,
}: { leaf?: LeafRef; onClose: () => void }) {
  const view = useViewContext();

  useEffect(() => {
    if (!leaf) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [leaf, onClose]);

  const rendered = useMemo(() => (leaf ? renderLeaf(leaf, view) : null), [leaf, view]);
  if (!leaf || !rendered) return null;

  const onCopy = () => { void navigator.clipboard.writeText(rendered.raw ?? ''); };

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size={tokens.drawerWidth}
      overlayProps={{ backgroundOpacity: 0 }}
      title={rendered.title}
      withCloseButton
      keepMounted={false}
    >
      <Stack gap="sm" h="100%">
        <ScrollArea h={'calc(100vh - 160px)'}>{rendered.body}</ScrollArea>
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={onCopy}>Copy raw</Button>
        </Group>
      </Stack>
    </Drawer>
  );
}
```

**`leafRenderers.tsx`:**

Dispatch table for all 10 kinds (per spec §8.6). Reuses existing presentational components.

```tsx
import { Badge, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { InvestigationView, LeafRef } from '../../inspect/types';
// ... actually the LeafRef type lives in hooks/useHashRoute.ts in this codebase
import type { LeafRef as Leaf } from '../hooks/useHashRoute';
import { PersonaCard } from '../components/Discovery/PersonaCard';
import { SubQuestionCard } from '../components/Coordinator/SubQuestionCard';
import { MoveCard } from '../components/Debate/MoveCard';
import { Markdown } from '../components/Synthesis/Markdown';
import { PersonaChip } from '../primitives/PersonaChip';

type Rendered = { title: string; body: ReactNode; raw?: string };

export function renderLeaf(leaf: Leaf, view: InvestigationView): Rendered | null {
  switch (leaf.kind) {
    case 'persona': {
      const p = view.discovery.candidate_personas.find((x) => x.id === leaf.id);
      if (!p) return null;
      return {
        title: `${p.name}${p.tradition ? ' · ' + p.tradition : ''}`,
        body: <PersonaCard persona={p} />,
        raw: JSON.stringify(p, null, 2),
      };
    }
    case 'territory': {
      const t = view.coordinator.territories.find((x) => x.territory_id === leaf.id);
      if (!t) return null;
      return {
        title: t.name,
        body: <SubQuestionCard subQuestion={t as any} />, // territory shape mostly compatible
        raw: JSON.stringify(t, null, 2),
      };
    }
    case 'candidate': {
      const wg = findWGByCandidateId(view, leaf.id);
      const c = wg?.candidate_questions.find((x) => x.candidate_id === leaf.id);
      if (!c) return null;
      return {
        title: `Candidate ${c.candidate_id}`,
        body: (
          <Stack gap="xs">
            <Text>{c.question}</Text>
            <Group gap="xs">
              <PersonaChip personaId={c.by_persona_id} />
              <Badge variant="light">predicted {c.predicted_confidence.toFixed(2)}</Badge>
            </Group>
            {c.rationale && <Text c="dimmed">{c.rationale}</Text>}
          </Stack>
        ),
        raw: JSON.stringify(c, null, 2),
      };
    }
    case 'aligned': {
      const wg = findWGByAlignedId(view, leaf.id);
      const a = wg?.aligned_questions.find((x) => x.aligned_id === leaf.id);
      if (!a) return null;
      return {
        title: `Aligned ${a.aligned_id}`,
        body: (
          <Stack gap="xs">
            <Text>{a.question}</Text>
            <Text size="xs" c="dimmed">origin: {a.origin}</Text>
            <Text size="xs" c="dimmed">from candidates: {a.source_candidate_ids.join(', ') || '—'}</Text>
          </Stack>
        ),
        raw: JSON.stringify(a, null, 2),
      };
    }
    case 'report': {
      const wg = findWGByReportId(view, leaf.id);
      const r = wg?.researcher_reports.find((x) => x.report_id === leaf.id);
      if (!r) return null;
      return {
        title: `Report ${r.report_id} · ${r.outcome}`,
        body: (
          <Stack gap="xs">
            {r.findings.map((f) => (
              <Stack key={f.finding_id} gap={2}>
                <Text size="sm" fw={600}>{f.source_title ?? 'untitled source'}</Text>
                {f.source_url && <Text size="xs" c="dimmed">{f.source_url}</Text>}
                <Text size="sm">{f.content}</Text>
              </Stack>
            ))}
          </Stack>
        ),
        raw: JSON.stringify(r, null, 2),
      };
    }
    case 'observation': {
      const wg = findWGByObservationId(view, leaf.id);
      const o = wg?.observations.find((x) => x.observation_id === leaf.id);
      if (!o) return null;
      return {
        title: `Observation by ${o.by_persona_id}`,
        body: (
          <Stack gap="xs">
            <Text>{o.content}</Text>
            <Text size="xs" c="dimmed">cited findings: {o.cited_finding_ids.join(', ') || '—'}</Text>
          </Stack>
        ),
        raw: JSON.stringify(o, null, 2),
      };
    }
    case 'move': {
      const wg = findWGByMoveId(view, leaf.id);
      const m = wg?.moves.find((x) => x.move_id === leaf.id);
      if (!m) return null;
      return {
        title: `${m.type} · ${m.by_persona_id}`,
        body: <MoveCard move={m} />,
        raw: JSON.stringify(m, null, 2),
      };
    }
    case 'claim': {
      const wg = findWGByClaimId(view, leaf.id);
      const c = wg?.surviving_claims.find((x) => x.claim_id === leaf.id);
      if (!c) return null;
      return {
        title: `Claim ${c.claim_id}`,
        body: (
          <Stack gap="xs">
            <Text>{c.content}</Text>
            <Badge variant="light">confidence {c.confidence_after_debate.toFixed(2)}</Badge>
            {c.concession_status && <Text size="xs" c="dimmed">status: {c.concession_status}</Text>}
          </Stack>
        ),
        raw: JSON.stringify(c, null, 2),
      };
    }
    case 'node': {
      const n = view.forum.nodes.find((x) => x.node_id === leaf.id);
      if (!n) return null;
      const contradictions = view.forum.contradiction_edges.filter(
        (e) => e.from_node_id === leaf.id || e.to_node_id === leaf.id
      );
      return {
        title: `Forum node ${n.node_id}`,
        body: (
          <Stack gap="xs">
            <Text>{n.content}</Text>
            <Badge variant="light">confidence {n.aggregate_confidence.toFixed(2)}</Badge>
            {n.has_open_question && <Badge color="yellow">open question</Badge>}
            {contradictions.map((c, i) => (
              <Text key={i} size="sm">contradicts {c.from_node_id === leaf.id ? c.to_node_id : c.from_node_id}: {c.reason}</Text>
            ))}
          </Stack>
        ),
        raw: JSON.stringify({ node: n, contradictions }, null, 2),
      };
    }
    case 'synthesis': {
      const s = view.synthesis;
      if (!s) return null;
      return {
        title: 'Synthesis',
        body: (
          <Stack gap="sm">
            <Markdown>{s.report}</Markdown>
            {s.headline_findings.length > 0 && (
              <Stack gap={2}>
                <Text fw={600}>Headline findings</Text>
                {s.headline_findings.map((f, i) => <Text key={i}>· {f}</Text>)}
              </Stack>
            )}
            {s.question_landscape && (
              <Stack gap={2}>
                <Text fw={600}>Question landscape</Text>
                {s.question_landscape.map((q, i) => (
                  <Text key={i} size="sm">{q.territory_name}: {q.questions.length} questions</Text>
                ))}
              </Stack>
            )}
            {s.dead_end_summary && (
              <Stack gap={2}>
                <Text fw={600}>Dead-end summary</Text>
                <Text size="sm">{s.dead_end_summary}</Text>
              </Stack>
            )}
          </Stack>
        ),
        raw: s.report,
      };
    }
  }
}

// Helpers — search every WG for the entity carrying `id`. Linear; fine for prototype-scale data.
function findWGByCandidateId(v: InvestigationView, id: string) {
  return Object.values(v.working_groups ?? {}).find((w) => w.candidate_questions.some((c) => c.candidate_id === id));
}
function findWGByAlignedId(v: InvestigationView, id: string) {
  return Object.values(v.working_groups ?? {}).find((w) => w.aligned_questions.some((a) => a.aligned_id === id));
}
function findWGByReportId(v: InvestigationView, id: string) {
  return Object.values(v.working_groups ?? {}).find((w) => w.researcher_reports.some((r) => r.report_id === id));
}
function findWGByObservationId(v: InvestigationView, id: string) {
  return Object.values(v.working_groups ?? {}).find((w) => w.observations.some((o) => o.observation_id === id));
}
function findWGByMoveId(v: InvestigationView, id: string) {
  return Object.values(v.working_groups ?? {}).find((w) => w.moves.some((m) => m.move_id === id));
}
function findWGByClaimId(v: InvestigationView, id: string) {
  return Object.values(v.working_groups ?? {}).find((w) => w.surviving_claims.some((c) => c.claim_id === id));
}
```

**Sub-stage → leaf mapping** (called from `WorkingGroupCanvas` / `SubStageNode`): clicking a sub-stage in the WG canvas opens a leaf representative of that sub-stage's content (e.g., the first candidate question for `ideation`, the first aligned question for `alignment`, etc.). Simpler v1 approach: the sub-stage click opens the existing `<IdeationPanel>` / `<AdversarialPanel>` / etc. inline in the drawer instead of a single-entity leaf. To support that, extend `LeafRef` with `{ kind: 'wgPanel'; wgId: string; substage: WorkingGroupSubstage }` (optional — design choice, can also be a synthetic non-hash UI state). Choose one path during implementation; the simpler is to add `wgPanel` as an 11th leaf kind to the route.

**Acceptance Criteria:**

- [ ] All 10 leaf kinds render without throwing on the `ready-v5` fixture.
- [ ] Esc closes the drawer; the listener is cleaned up on unmount.
- [ ] Copy button copies `raw` JSON to clipboard.
- [ ] Missing entity (e.g., leaf id not found) renders a graceful empty state, not a crash.
- [ ] Cross-leaf links (e.g., observation → cited finding) work — they update the hash and trigger re-render.

---

### Task P1.10: Delete obsolete files + update README

**Description:** Remove the section-wrapper components that the graph replaces, plus `useAnchorScroll`. Update the README's `msv inspect <id>` paragraph. Run typecheck to verify nothing else imports the deleted files.
**Size:** Small
**Priority:** High
**Dependencies:** P1.6, P1.7, P1.8, P1.9 (all replacement code in place)
**Can run parallel with:** Nothing (gates the merge)

**Files to delete:**

- `src/inspect-app/components/Discovery/Discovery.tsx`
- `src/inspect-app/components/Coordinator/Coordinator.tsx`
- `src/inspect-app/components/WorkingGroup/WorkingGroupSection.tsx`
- `src/inspect-app/components/Forum/Forum.tsx`
- `src/inspect-app/components/Forum/NodeDrawer.tsx` (absorbed by `DetailDrawer`)
- `src/inspect-app/components/Synthesis/Synthesis.tsx`
- `src/inspect-app/components/Timeline/Timeline.tsx`
- `src/inspect-app/components/Timeline/StageChip.tsx`
- `src/inspect-app/components/Debate/DebateSection.tsx`
- `src/inspect-app/utils/anchorScroll.ts`

**Files to retain** (reused by the inspector):

- `src/inspect-app/components/Discovery/PersonaCard.tsx`, `SearchQueryList.tsx`, `SearchResultList.tsx`
- `src/inspect-app/components/Coordinator/SubQuestionCard.tsx`
- `src/inspect-app/components/WorkingGroup/IdeationPanel.tsx`, `AdversarialPanel.tsx`, `AlignmentPanel.tsx`, `ResearcherPanel.tsx`, `ObservationPanel.tsx`, `DebatePanel.tsx`
- `src/inspect-app/components/Debate/MoveCard.tsx`, `ConfidenceChart.tsx`
- `src/inspect-app/components/Forum/ForumGraph.tsx`, `forumLayout.ts`, `ForumNode.tsx`
- `src/inspect-app/components/Synthesis/Markdown.tsx`
- `src/inspect-app/components/Header/*`

**README update** (in `README.md`, the `### msv inspect <id>` section):

Replace the existing description with a paragraph describing the graph UX. The current bulleted list of stages stays as a "what you see in the canvas" description. Suggested copy:

```markdown
### `msv inspect <id>`

Boots a local Vite dev server with a React SPA that visualises the investigation
as an interactive pipeline graph. Stages render as boxes; lightweight stages
(Discovery, Coordinator, Cross-Pollination) expand in place; Working Groups and
the Forum drill into sub-canvases. Clicking a leaf (a debate move, a finding, a
forum claim) opens a side panel with the full content. Deep links survive
reload via the URL hash.

What you see in the canvas, by stage:

- Discovery: search queries, candidate personas, selection scores.
- Coordinator: territories with assigned persona pairs.
- Working groups: six sub-stages (Ideation, Adversarial, Alignment,
  Researcher, Observations, Debate) per territory.
- Cross-Pollination: reactions to surviving claims.
- Forum: surviving-claims graph with contradiction edges, dead-end list (v5).
- Synthesis: headline findings, question landscape (v5), dead-end summary
  (v5), full Markdown report.

The inspector detects `schema_version`. v4 ideas render a one-line empty state;
v5 ideas land on the graph.
```

**Implementation steps:**

1. Delete the files listed above.
2. Run `npx tsc --noEmit -p src/inspect-app/tsconfig.json` (or equivalent). Fix dangling imports.
3. Update `README.md`.
4. Spot-check each fixture (`ready`, `ready-v5`, `degraded-discovery`, `investigating`) by running `npx msv inspect <fixture-id>` and walking through the manual checklist in spec §10.4.

**Acceptance Criteria:**

- [ ] Listed files no longer exist.
- [ ] Typecheck passes for `src/inspect-app/`.
- [ ] Each v5 fixture loads and the spec §10.4 manual checklist passes.
- [ ] v4 fixture renders the empty state without a React Flow mount.
- [ ] README's `msv inspect` paragraph reflects the new UX.

---

## Phase 2 — Expand-in-place, banner, tests

### Task P2.1: Expanded views + collision-shift in `pipelineLayout`

**Description:** Implement the expanded renderings for `DiscoveryNode`, `CoordinatorNode`, `CrossPollinationNode`, and extend `pipelineLayout` with vertical-only growth + column-collision y-shift.
**Size:** Medium
**Priority:** Medium
**Dependencies:** P1.5, P1.4, P1.9
**Can run parallel with:** P2.2

**Expanded renderings:**

**DiscoveryNode (expanded):** vertical list of `PersonaCard`s with `selected`/`rejected` badges plus distinctness score; collapsible search-queries panel underneath; `[collapse]` link at the bottom calls `toggle('discovery')`. Each persona row clicks → `setRoute({ ..., leaf: { kind: 'persona', id } })`.

```tsx
// inside DiscoveryNode when isExpanded('discovery'):
<Stack gap="xs">
  <Spoiler maxHeight={0} showLabel={`Search queries (${view.discovery.search_queries.length})`} hideLabel="Hide queries">
    <Stack gap={2}>{view.discovery.search_queries.map((q, i) => <Text key={i} size="sm">{q}</Text>)}</Stack>
  </Spoiler>
  {view.discovery.candidate_personas.map((p) => {
    const selected = view.discovery.selected_persona_ids.includes(p.id);
    return (
      <Group key={p.id} onClick={(e) => { e.stopPropagation(); setRoute({ ...route, leaf: { kind: 'persona', id: p.id }}); }}>
        <Text size="sm" c={selected ? undefined : 'dimmed'}>{selected ? '✓' : '✗'}  {p.name} · {view.discovery.selection_distinctness[p.id]?.toFixed(2) ?? '—'}</Text>
        <Badge size="xs" variant="light" c={selected ? undefined : 'dimmed'}>{selected ? 'selected' : 'rejected'}</Badge>
      </Group>
    );
  })}
  <Anchor onClick={(e) => { e.stopPropagation(); toggle('discovery'); }} size="xs">[collapse]</Anchor>
</Stack>
```

**CoordinatorNode (expanded):** vertical list of `<SubQuestionCard>` for each territory; click → drill into the WG canvas.

**CrossPollinationNode (expanded):** table — one row per claim with reactions; columns Rebut / Concede / Question / Support with counts; click row → `leaf: { kind: 'claim', id }`.

**Collision-shift in `pipelineLayout`:**

Extend the layout function signature: `pipelineLayout(view, expanded?: Set<ExpandedStage>) → { nodes, edges }`. Per spec §8.9 step 4:

> Expansion grows boxes vertically only. When a stage is in the `expanded` set, its height increases by the expanded-content height (computed from data: candidate count × persona-card height; territory count × territory-card height; etc.). Other stages stay at their original positions. Collision rule: if an expanded stage's bottom edge crosses another stage's top edge (vertically overlapping in the same column), shift the lower stage down by the overlap delta; downstream columns are unaffected because expansion does not change x-positions.

Implementation:

```ts
function expandedHeight(view: InvestigationView, stage: ExpandedStage) {
  const PER_ROW = 28; // persona-card or territory-card row height
  switch (stage) {
    case 'discovery': return Math.max(view.discovery.candidate_personas.length, 1) * PER_ROW + 80;
    case 'coordinator': return Math.max(view.coordinator.territories.length, 1) * 60 + 40;
    case 'cross_pollination': return Math.max(view.cross_pollination.length, 1) * PER_ROW + 40;
  }
}

function applyCollisionShift(nodes: Node[], expanded: Set<ExpandedStage>, view: InvestigationView): Node[] {
  const byColumn = new Map<number, Node[]>();
  for (const n of nodes) {
    const col = byColumn.get(n.position.x) ?? [];
    col.push(n);
    byColumn.set(n.position.x, col);
  }
  // Apply height delta to expanded stages.
  const result = nodes.map((n) => {
    const stage = stageFromId(n.id);
    if (stage && expanded.has(stage)) {
      const h = expandedHeight(view, stage);
      return { ...n, data: { ...n.data, expanded: true, expandedHeight: h } };
    }
    return n;
  });
  // For each column, sweep top-to-bottom; if a node's expanded bottom collides with the next node's top, shift it down.
  for (const col of byColumn.values()) {
    col.sort((a, b) => a.position.y - b.position.y);
    for (let i = 0; i < col.length - 1; i++) {
      const cur = result.find((n) => n.id === col[i].id)!;
      const next = result.find((n) => n.id === col[i + 1].id)!;
      const curHeight = cur.data.expanded ? cur.data.expandedHeight : tokens.stageBox.heightCollapsed;
      const overlap = cur.position.y + curHeight + 16 - next.position.y;
      if (overlap > 0) {
        next.position = { ...next.position, y: next.position.y + overlap };
      }
    }
  }
  return result;
}
```

**Tests:**

- `pipelineLayout.test.mjs` — given `expanded = new Set(['discovery'])`, the Coordinator's x position is unchanged but the WGs (in column 2) may shift if the expanded Discovery height pushes anything down via vertical re-flow… Actually, Discovery is in column 0; downstream columns are unaffected. The collision rule only matters when two nodes share an x (i.e., the WG stack in column 2). To exercise collision properly, write a synthetic test with two stub nodes in the same column.
- Component-level: rendering `<DiscoveryNode>` with `isExpanded('discovery') = true` shows the persona list.

**Acceptance Criteria:**

- [ ] Expanded Discovery shows full candidate list with selected/rejected and distinctness scores.
- [ ] `[collapse]` link round-trips correctly via the hash.
- [ ] Collision shifts the lower node by exactly the overlap delta when stages share a column.
- [ ] Downstream columns retain their original x positions.

---

### Task P2.2: `last_failure` banner + partial-investigation rendering

**Description:** Add a sticky red banner above the canvas when `view.last_failure` (or equivalent — see `feat-investigation-resumption.md`) is present. Verify partial pips and grey `not_run` boxes render correctly under the `investigating` fixture.
**Size:** Small
**Priority:** Medium
**Dependencies:** P1.3, P1.4, P1.5
**Can run parallel with:** P2.1

**Banner component** (place inside `<InspectorGraph>` between `<Header>` and `<CanvasBreadcrumb>`):

```tsx
// src/inspect-app/inspector/LastFailureBanner.tsx
import { Alert, Text } from '@mantine/core';
import { useViewContext } from '../ViewContext';

export function LastFailureBanner() {
  const view = useViewContext();
  const failure = (view as any).last_failure;
  if (!failure) return null;
  const where =
    failure.territory_id ? `WG: ${failure.territory_id}${failure.sub_stage ? ' / ' + failure.sub_stage : ''}`
    : failure.stage ?? '';
  return (
    <Alert color="red" title={`interrupted: ${failure.reason}`}>
      <Text size="sm">{where}{failure.at ? ' · ' + failure.at : ''}</Text>
      <Text size="sm">resume with: <code>msv run {view.id}</code></Text>
    </Alert>
  );
}
```

The actual field name and shape on the view depends on what `feat-investigation-resumption.md` Phase 1 ships. The current `inspect-view.json` types in `src/inspect/types.d.ts` do not yet have a `last_failure` field. Read the resumption spec at implementation time and align; if the field is not yet wired through the view-builder, hide the banner safely (`if (!failure) return null`).

**Acceptance Criteria:**

- [ ] On a fixture without `last_failure`, no banner renders.
- [ ] On the `investigating` fixture (when `last_failure` is wired), banner shows the failure reason, location, and resume hint.
- [ ] Partial WG nodes show amber pip; later stages show grey `not_run`.

---

### Task P2.3: Component tests (vitest)

**Description:** The component tests listed in spec §10.2. Add fixture loaders, run under `npm run test:app`.
**Size:** Large
**Priority:** Medium
**Dependencies:** P0.1 (vitest tooling), P1.6, P1.7, P1.8, P1.9
**Can run parallel with:** P2.1, P2.2

**Tests (one file each under `src/inspect-app/inspector/__tests__/`):**

1. **`TopLevelCanvas.test.tsx`** — renders 6+ nodes for a v5 fixture; clicking a `WorkingGroupNode` updates hash to `#wg:<id>`; clicking Discovery sets `expand=discovery` in hash. Uses `userEvent.click`.
2. **`DetailDrawer.test.tsx`** — given `leaf = { kind: 'move', id: <real-id> }`, `MoveCard` renders the right move content. Pressing `Esc` invokes `onClose`. Copy button calls `navigator.clipboard.writeText` (mock).
3. **`WorkingGroupCanvas.test.tsx`** — renders six sub-stage nodes; clicking each updates `substage`; pair chips visible; sparkline mounts (recharts under jsdom may need a width/height fallback — provide a `<div style={{ width: 600, height: 200 }}>` wrapper).
4. **`PartialInvestigation.test.tsx`** — given the `investigating` fixture, amber pip on the in-flight stage; grey "not_run" on later stages; banner with `last_failure` text when present.
5. **`V4EmptyState.test.tsx`** — given the `ready` v4 fixture, `<V4EmptyState />` renders; no `.react-flow__renderer` node mounts.
6. **`PipelineLayoutCollision.test.tsx`** — render `<TopLevelCanvas>` with two adjacent stages expanded (same column); assert the lower stage's `style.transform` y-offset reflects the overlap delta.

**Fixture loader pattern:**

```ts
// src/inspect-app/__tests__/fixtures.ts
import path from 'node:path';
import fs from 'node:fs';

export function loadFixture(name: 'ready-v5' | 'ready' | 'investigating' | 'degraded-discovery') {
  const root = path.resolve(__dirname, '../../../test/fixtures/inspect', name);
  return JSON.parse(fs.readFileSync(path.join(root, 'inspect-view.json'), 'utf8'));
}
```

**Wrapper pattern for components needing `ViewProvider` and `MantineProvider`:**

```tsx
// src/inspect-app/__tests__/render-with-providers.tsx
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { ViewProvider } from '../ViewContext';
import type { InvestigationView } from '../../inspect/types';

export function renderWithView(ui: React.ReactElement, view: InvestigationView) {
  return render(
    <MantineProvider>
      <ViewProvider view={view}>{ui}</ViewProvider>
    </MantineProvider>
  );
}
```

**Acceptance Criteria:**

- [ ] All six tests pass under `npm run test:app`.
- [ ] No flakes — tests use `findBy` / `await` for any async (drawer open, navigation).
- [ ] Tests are independent — order doesn't matter.
- [ ] Clipboard usage is mocked, not stubbed at the navigator object level (use `vi.spyOn`).

---

## Summary

| ID | Title | Phase | Size | Deps |
|---|---|---|---|---|
| P0.1 | Test tooling | 0 | S | — |
| P0.2 | Theme tokens | 0 | S | — |
| P1.1 | Route parsing | 1 | M | — |
| P1.2 | useExpandedStages | 1 | S | P1.1 |
| P1.3 | InspectorGraph shell + V4 empty state | 1 | M | P0.2, P1.1, P1.2 |
| P1.4 | pipelineLayout + StageStatusPip | 1 | M | P0.2 |
| P1.5 | Six stage nodes (collapsed) | 1 | M | P0.2, P1.4 |
| P1.6 | TopLevelCanvas | 1 | S | P1.3, P1.4, P1.5 |
| P1.7 | WorkingGroupCanvas + layout | 1 | M | P1.3, P1.4 |
| P1.8 | ForumCanvas | 1 | S | P1.3 |
| P1.9 | DetailDrawer + leafRenderers | 1 | L | P1.3, P1.1 |
| P1.10 | Cleanup + README | 1 | S | P1.6, P1.7, P1.8, P1.9 |
| P2.1 | Expanded views + collision | 2 | M | P1.5, P1.4, P1.9 |
| P2.2 | last_failure banner | 2 | S | P1.3 |
| P2.3 | Component tests | 2 | L | P0.1, P1.6, P1.7, P1.8, P1.9 |

Total: 15 tasks.

**Parallel batches:**

- **B0** (foundation): P0.1, P0.2, P1.1 in parallel.
- **B1** (after B0): P1.2, P1.4, P1.8, P1.9 in parallel (each only needs P1.1 / P0.2 / P1.3).
- **B2** (after B1): P1.3, P1.5 → then P1.6 + P1.7 in parallel.
- **B3**: P1.10 sequential.
- **B4** (P2): P2.1, P2.2, P2.3 in parallel.

**Critical path:** P0.2 → P1.4 → P1.5 → P1.6 → P1.10. Estimated four batches end-to-end.
