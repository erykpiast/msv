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
