import { useEffect, useState, useCallback } from 'react';

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
