import { useCallback, useMemo } from 'react';
import { useViewContext } from '../ViewContext';

export function usePersonaName(): (id: string) => string {
  const view = useViewContext();
  const map = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of view.discovery.candidate_personas) m.set(p.id, p.name);
    return m;
  }, [view.discovery.candidate_personas]);
  return useCallback((id: string) => map.get(id) ?? id, [map]);
}
