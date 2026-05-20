import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { InvestigationView } from '../inspect/types';
import { emptyProgress, type ProgressOverlay } from './hooks/useLiveProgress';

export type SseStatus = 'connecting' | 'live' | 'error';

/**
 * Connection state of the /events/stream SSE channel.
 *
 * State machine:
 *   'connecting' — initial state, before EventSource fires onopen.
 *                  Note: this state is NOT re-entered on reconnect;
 *                  auto-reconnect cycles go 'live' → 'error' → 'live'.
 *   'live'       — onopen has fired; SSE stream is active.
 *   'error'      — onerror fired; EventSource is auto-reconnecting.
 *                  Transitions back to 'live' if reconnect succeeds.
 *
 * The 'idle' distinction (no in-progress stages for >5 s) is not yet implemented.
 */

// ── Progress store ──────────────────────────────────────────────────────────
//
// The previous implementation used a React context whose value was the full
// `ProgressOverlay` object. Every SSE event that produced a new overlay
// rebuilt the context value, which forced every consumer to re-render —
// including memoized node components that only cared about one slice
// (H8 in the code review).
//
// Replacement: a tiny external store backed by `useSyncExternalStore`.
// `ViewProvider` keeps a stable store instance for the whole app lifetime
// and pushes new snapshots into it whenever the `progress` prop changes.
// Selector hooks (e.g. `useIsWgInProgress`) subscribe to the store and
// React only re-renders the component when the selected slice changes
// (compared by `===`). For Set/Map membership, the selector returns a
// boolean/string so the comparison is trivial.

type ProgressStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ProgressOverlay;
};

type MutableProgressStore = ProgressStore & {
  setProgress(p: ProgressOverlay): void;
};

function createProgressStore(initial: ProgressOverlay): MutableProgressStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    setProgress(p) {
      if (p === snapshot) return;
      snapshot = p;
      for (const l of listeners) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

// Three separate contexts so updates to progress (10/sec) don't re-render
// components that only consume the stable view or rare sseStatus.
const ViewCtx = createContext<InvestigationView | null>(null);
const ProgressStoreCtx = createContext<ProgressStore | null>(null);
const SseCtx = createContext<SseStatus>('connecting');

// Server-side / pre-mount fallback snapshot. Sharing one frozen-ish empty
// overlay keeps `useSyncExternalStore`'s `getServerSnapshot` stable across
// calls (the function is required to return a referentially stable value
// or React will warn).
const EMPTY_OVERLAY: ProgressOverlay = emptyProgress();
const getEmptyOverlay = () => EMPTY_OVERLAY;

export function ViewProvider({
  view,
  progress,
  sseStatus,
  children,
}: {
  view: InvestigationView;
  progress: ProgressOverlay;
  sseStatus: SseStatus;
  children: ReactNode;
}) {
  // The store instance is created once per ViewProvider lifetime. We push
  // each new `progress` value into it via an effect; we cannot do it during
  // render because that would mutate external state during render and risk
  // tearing under concurrent React.
  const storeRef = useRef<MutableProgressStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createProgressStore(progress);
  }
  useEffect(() => {
    storeRef.current!.setProgress(progress);
  }, [progress]);

  return (
    <ViewCtx.Provider value={view}>
      <SseCtx.Provider value={sseStatus}>
        <ProgressStoreCtx.Provider value={storeRef.current}>
          {children}
        </ProgressStoreCtx.Provider>
      </SseCtx.Provider>
    </ViewCtx.Provider>
  );
}

export function useViewContext(): InvestigationView {
  const ctx = useContext(ViewCtx);
  if (!ctx) throw new Error('useViewContext must be used inside <ViewProvider>');
  return ctx;
}

function useProgressStore(): ProgressStore {
  const store = useContext(ProgressStoreCtx);
  if (!store) throw new Error('progress hooks must be used inside <ViewProvider>');
  return store;
}

/**
 * Returns the full `ProgressOverlay`.
 *
 * @deprecated Re-renders on every progress event, regardless of which slice
 * changed. Prefer the per-entity selector hooks below
 * (`useIsStageInProgress`, `useIsWgInProgress`, `useWgSubstage`) when you
 * only care about one stage / working group. Still useful for code paths
 * that need to read multiple slices at once (e.g. skeleton rendering in
 * `leafRenderers`).
 */
export function useProgressOverlay(): ProgressOverlay {
  const store = useProgressStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getEmptyOverlay);
}

/** True iff `stage` is currently in `inProgressStages`. */
export function useIsStageInProgress(stage: string): boolean {
  const store = useProgressStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().inProgressStages.has(stage),
    () => false,
  );
}

/** True iff `territoryId`'s working group is currently in progress. */
export function useIsWgInProgress(territoryId: string): boolean {
  const store = useProgressStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().inProgressWg.has(territoryId),
    () => false,
  );
}

/** The current substage label for `territoryId`, or `undefined`. */
export function useWgSubstage(territoryId: string): string | undefined {
  const store = useProgressStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().wgSubstage.get(territoryId),
    () => undefined,
  );
}

export function useSseStatus(): SseStatus {
  return useContext(SseCtx);
}
