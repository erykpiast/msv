import { AppShell, Stack } from '@mantine/core';
import { useCanvasRoute } from '../hooks/useHashRoute';
import { Header } from '../components/Header/Header';
import { CanvasBreadcrumb } from './CanvasBreadcrumb';
import { TopLevelCanvas } from './TopLevelCanvas';
import { WorkingGroupCanvas } from './canvases/WorkingGroupCanvas';
import { ForumCanvas } from './canvases/ForumCanvas';
import { DetailDrawer } from './DetailDrawer';
import { LastFailureBanner } from './LastFailureBanner';

export function InspectorGraph() {
  const { route, setRoute } = useCanvasRoute();
  const closeDrawer = () =>
    setRoute({ ...route, leaf: undefined } as typeof route);
  return (
    <AppShell padding="md">
      <AppShell.Main>
        <Stack gap="md">
          <Header />
          <LastFailureBanner />
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
