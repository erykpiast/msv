import { useEffect, useState, useCallback, useMemo } from 'react';

/**
 * @deprecated Use useCanvasRoute instead.
 */
export function useHashRoute(): {
  route: string;
  setRoute: (next: string) => void;
} {
  const [route, setRouteState] = useState<string>(() =>
    typeof window === 'undefined' ? '' : window.location.hash
  );

  useEffect(() => {
    const handler = () => setRouteState(window.location.hash);
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const setRoute = useCallback((next: string) => {
    const value = next.startsWith('#') ? next : `#${next}`;
    if (window.location.hash === value) return;
    window.location.hash = value;
  }, []);

  return { route, setRoute };
}

export type ParsedRoute =
  | { kind: 'stage'; key: string }
  | { kind: 'debate'; sqId: string }
  | { kind: 'move'; moveId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'persona'; personaId: string }
  | { kind: 'none' };

/**
 * @deprecated Use parseCanvasRoute instead.
 */
export function parseRoute(hash: string): ParsedRoute {
  if (!hash) return { kind: 'none' };
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  if (id.startsWith('stage-')) return { kind: 'stage', key: id.slice('stage-'.length) };
  if (id.startsWith('debate-')) return { kind: 'debate', sqId: id.slice('debate-'.length) };
  if (id.startsWith('move-')) return { kind: 'move', moveId: id.slice('move-'.length) };
  if (id.startsWith('node-')) return { kind: 'node', nodeId: id.slice('node-'.length) };
  if (id.startsWith('persona-')) return { kind: 'persona', personaId: id.slice('persona-'.length) };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// New typed canvas routing
// ---------------------------------------------------------------------------

export type ExpandedStage = 'discovery' | 'coordinator' | 'cross_pollination';

export type WorkingGroupSubstage =
  | 'ideation'
  | 'adversarial'
  | 'alignment'
  | 'researcher'
  | 'observation'
  | 'debate';

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
  | { kind: 'synthesis' }
  | { kind: 'wgPanel'; substage: WorkingGroupSubstage };

export type CanvasRoute =
  | { canvas: 'pipeline'; expanded: ExpandedStage[]; leaf?: LeafRef }
  | { canvas: 'wg'; territoryId: string; substage?: WorkingGroupSubstage; leaf?: LeafRef }
  | { canvas: 'forum'; leaf?: LeafRef };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAFE_DEFAULT: CanvasRoute = { canvas: 'pipeline', expanded: [] };

const KNOWN_EXPANDED_STAGES = new Set<ExpandedStage>([
  'discovery',
  'coordinator',
  'cross_pollination',
]);

const KNOWN_WG_SUBSTAGES = new Set<WorkingGroupSubstage>([
  'ideation',
  'adversarial',
  'alignment',
  'researcher',
  'observation',
  'debate',
]);

const KNOWN_LEAF_KINDS_WITH_ID = new Set<string>([
  'persona',
  'territory',
  'candidate',
  'aligned',
  'report',
  'observation',
  'move',
  'claim',
  'node',
]);

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const WG_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Leaf parsing / formatting
// ---------------------------------------------------------------------------

function parseLeaf(value: string): LeafRef | undefined {
  const colonIdx = value.indexOf(':');
  if (colonIdx === -1) {
    // No colon — only 'synthesis' is valid here
    if (value === 'synthesis') return { kind: 'synthesis' };
    return undefined;
  }

  const kind = value.slice(0, colonIdx);
  const rest = value.slice(colonIdx + 1);

  if (kind === 'synthesis') {
    // synthesis never has an id; treat as malformed
    return undefined;
  }

  if (kind === 'wgPanel') {
    if (!KNOWN_WG_SUBSTAGES.has(rest as WorkingGroupSubstage)) return undefined;
    return { kind: 'wgPanel', substage: rest as WorkingGroupSubstage };
  }

  if (KNOWN_LEAF_KINDS_WITH_ID.has(kind)) {
    if (!rest || !ID_PATTERN.test(rest)) return undefined;
    return { kind: kind as LeafRef['kind'], id: rest } as LeafRef;
  }

  return undefined;
}

function formatLeaf(leaf: LeafRef): string {
  if (leaf.kind === 'synthesis') return 'leaf=synthesis';
  if (leaf.kind === 'wgPanel') return `leaf=wgPanel:${leaf.substage}`;
  return `leaf=${leaf.kind}:${leaf.id}`;
}

// ---------------------------------------------------------------------------
// parseCanvasRoute
// ---------------------------------------------------------------------------

export function parseCanvasRoute(hash: string): CanvasRoute {
  try {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!raw) return SAFE_DEFAULT;

    const segments = raw.split('/');
    const head = segments[0]!;
    const modifiers = segments.slice(1);

    // ---- pipeline ----
    if (head === 'pipeline') {
      let expanded: ExpandedStage[] = [];
      let leaf: LeafRef | undefined;

      for (const mod of modifiers) {
        if (mod.startsWith('expand=')) {
          const parts = mod.slice('expand='.length).split(',');
          expanded = parts.filter((p): p is ExpandedStage =>
            KNOWN_EXPANDED_STAGES.has(p as ExpandedStage)
          );
        } else if (mod.startsWith('leaf=')) {
          const parsed = parseLeaf(mod.slice('leaf='.length));
          if (parsed === undefined) return SAFE_DEFAULT;
          leaf = parsed;
        }
        // unknown modifiers are silently ignored
      }

      return { canvas: 'pipeline', expanded, ...(leaf !== undefined && { leaf }) };
    }

    // ---- wg:<id> ----
    if (head.startsWith('wg:')) {
      const territoryId = head.slice('wg:'.length);
      if (!territoryId || !WG_ID_PATTERN.test(territoryId)) return SAFE_DEFAULT;

      let substage: WorkingGroupSubstage | undefined;
      let leaf: LeafRef | undefined;

      for (const mod of modifiers) {
        if (mod.startsWith('substage=')) {
          const val = mod.slice('substage='.length);
          if (!KNOWN_WG_SUBSTAGES.has(val as WorkingGroupSubstage)) return SAFE_DEFAULT;
          substage = val as WorkingGroupSubstage;
        } else if (mod.startsWith('leaf=')) {
          const parsed = parseLeaf(mod.slice('leaf='.length));
          if (parsed === undefined) return SAFE_DEFAULT;
          leaf = parsed;
        }
      }

      return {
        canvas: 'wg',
        territoryId,
        ...(substage !== undefined && { substage }),
        ...(leaf !== undefined && { leaf }),
      };
    }

    // ---- forum ----
    if (head === 'forum') {
      let leaf: LeafRef | undefined;

      for (const mod of modifiers) {
        if (mod.startsWith('leaf=')) {
          const parsed = parseLeaf(mod.slice('leaf='.length));
          if (parsed === undefined) return SAFE_DEFAULT;
          leaf = parsed;
        }
      }

      return { canvas: 'forum', ...(leaf !== undefined && { leaf }) };
    }

    return SAFE_DEFAULT;
  } catch {
    return SAFE_DEFAULT;
  }
}

// ---------------------------------------------------------------------------
// formatCanvasRoute
// ---------------------------------------------------------------------------

export function formatCanvasRoute(route: CanvasRoute): string {
  if (route.canvas === 'pipeline') {
    const parts: string[] = ['#pipeline'];
    if (route.expanded.length > 0) {
      parts.push(`expand=${route.expanded.join(',')}`);
    }
    if (route.leaf !== undefined) {
      parts.push(formatLeaf(route.leaf));
    }
    if (parts.length === 1) return '#pipeline';
    return `#pipeline/${parts.slice(1).join('/')}`;
  }

  if (route.canvas === 'wg') {
    const parts: string[] = [`#wg:${route.territoryId}`];
    if (route.substage !== undefined) {
      parts.push(`substage=${route.substage}`);
    }
    if (route.leaf !== undefined) {
      parts.push(formatLeaf(route.leaf));
    }
    if (parts.length === 1) return `#wg:${route.territoryId}`;
    return `#wg:${route.territoryId}/${parts.slice(1).join('/')}`;
  }

  // forum
  if (route.leaf !== undefined) {
    return `#forum/${formatLeaf(route.leaf)}`;
  }
  return '#forum';
}

// ---------------------------------------------------------------------------
// useCanvasRoute hook
// ---------------------------------------------------------------------------

export function useCanvasRoute(): {
  route: CanvasRoute;
  setRoute: (next: CanvasRoute) => void;
} {
  const [hash, setHash] = useState<string>(() =>
    typeof window === 'undefined' ? '' : window.location.hash
  );
  useEffect(() => {
    const handler = () => setHash(window.location.hash);
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const route = useMemo(() => parseCanvasRoute(hash), [hash]);
  const setRoute = useSetRoute();
  return { route, setRoute };
}

/**
 * Write-only counterpart of useCanvasRoute. Use this in components that only
 * navigate (e.g., node click handlers) and never read the current route — it
 * does not subscribe to hashchange events, so consumers stay re-render-free
 * when the URL changes elsewhere.
 */
export function useSetRoute(): (next: CanvasRoute) => void {
  return useCallback((next: CanvasRoute) => {
    const formatted = formatCanvasRoute(next);
    if (window.location.hash === formatted) return;
    window.location.hash = formatted;
  }, []);
}
