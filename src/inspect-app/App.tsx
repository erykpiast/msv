import { useCallback, useEffect, useState } from 'react';
import { Center, Loader } from '@mantine/core';
import { ViewProvider } from './ViewContext';
import { useInitialView } from './hooks/useView';
import { useEventSource } from './hooks/useEventSource';
import { emptyProgress, reduceProgress, type ProgressOverlay, type BusEnvelope } from './hooks/useLiveProgress';
import type { SseStatus } from './ViewContext';
import { ErrorBoundary } from './ErrorBoundary';
import { InspectorGraph } from './inspector/InspectorGraph';
import { V4EmptyState } from './inspector/V4EmptyState';
import type { InvestigationView } from '../inspect/types';

function Body() {
  const initial = useInitialView();
  const [view, setView] = useState<InvestigationView | null>(null);
  const [progress, setProgress] = useState<ProgressOverlay>(() => emptyProgress());
  const [sseStatus, setSseStatus] = useState<SseStatus>('connecting');

  useEffect(() => {
    if (initial && !view) setView(initial);
  }, [initial, view]);

  // Stable handler identities (M14). `useEventSource` reads handlers through
  // a ref so it tolerates fresh literals today, but stable callbacks make
  // the contract explicit and avoid relying on the hook's internal shape.
  const handleView = useCallback((v: unknown) => setView(v as InvestigationView), []);
  const handleEvent = useCallback(
    (e: unknown) => setProgress((p) => reduceProgress(p, e as BusEnvelope)),
    [],
  );
  const handleOpen = useCallback(() => setSseStatus('live'), []);
  const handleError = useCallback(() => setSseStatus('error'), []);

  useEventSource('/events/stream', {
    onView: handleView,
    onEvent: handleEvent,
    onOpen: handleOpen,
    onError: handleError,
  });

  if (!view) return <Center mih="100vh"><Loader /></Center>;
  if (view.schema_version === 'v4') return <V4EmptyState id={view.id} />;
  return (
    <ViewProvider view={view} progress={progress} sseStatus={sseStatus}>
      <InspectorGraph />
    </ViewProvider>
  );
}

export function App() {
  return <ErrorBoundary><Body /></ErrorBoundary>;
}
