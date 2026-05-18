import { createContext, useContext, type ReactNode } from 'react';
import type { InvestigationView } from '../inspect/types';
import type { ProgressOverlay } from './hooks/useLiveProgress';

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

// Three separate contexts so updates to progress (10/sec) don't re-render
// components that only consume the stable view or rare sseStatus.
const ViewCtx = createContext<InvestigationView | null>(null);
const ProgressCtx = createContext<ProgressOverlay | null>(null);
const SseCtx = createContext<SseStatus>('connecting');

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
  return (
    <ViewCtx.Provider value={view}>
      <SseCtx.Provider value={sseStatus}>
        <ProgressCtx.Provider value={progress}>
          {children}
        </ProgressCtx.Provider>
      </SseCtx.Provider>
    </ViewCtx.Provider>
  );
}

export function useViewContext(): InvestigationView {
  const ctx = useContext(ViewCtx);
  if (!ctx) throw new Error('useViewContext must be used inside <ViewProvider>');
  return ctx;
}

export function useProgressOverlay(): ProgressOverlay {
  const ctx = useContext(ProgressCtx);
  if (!ctx) throw new Error('useProgressOverlay must be used inside <ViewProvider>');
  return ctx;
}

export function useSseStatus(): SseStatus {
  return useContext(SseCtx);
}
