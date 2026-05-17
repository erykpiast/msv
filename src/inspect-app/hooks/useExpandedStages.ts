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
