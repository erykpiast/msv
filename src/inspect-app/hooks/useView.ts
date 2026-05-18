import { useEffect, useState } from 'react';
import type { InvestigationView } from '../../inspect/types';

/**
 * Fetches the initial InvestigationView from /inspect-view.json once on mount.
 * Returns null until the fetch resolves.
 *
 * Uses useEffect (not Suspense) because App.tsx also accepts SSE-pushed view
 * updates — two concurrent sources require owned useState. The SSE view takes
 * precedence once the connection opens.
 *
 * The previous Suspense-based `useView` export was removed when live preview
 * was added in feat-inspect-live-preview.
 */
export function useInitialView(): InvestigationView | null {
  const [view, setView] = useState<InvestigationView | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/inspect-view.json')
      .then((r) => {
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        return r.json() as Promise<InvestigationView>;
      })
      .then((v) => { if (!cancelled) setView(v); })
      .catch((err) => { if (!cancelled) console.error('initial view load failed', err); });
    return () => { cancelled = true; };
  }, []);
  return view;
}
