import { Anchor, Breadcrumbs, Text } from '@mantine/core';
import type { CanvasRoute } from '../hooks/useHashRoute';
import { useViewContext } from '../ViewContext';

export function CanvasBreadcrumb({
  route,
  setRoute,
}: {
  route: CanvasRoute;
  setRoute: (r: CanvasRoute) => void;
}) {
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
