import { use } from 'react';
import type { InvestigationView } from '../../inspect/types';

// Lazy init — the fetch only fires when useView() is first called, so
// other entry points (tests, isolated component imports) don't trigger it.
let viewPromise: Promise<InvestigationView> | null = null;

function loadView(): Promise<InvestigationView> {
  if (!viewPromise) {
    viewPromise = fetch('/inspect-view.json').then((r) => {
      if (!r.ok) throw new Error(`Failed to load inspect-view.json (${r.status})`);
      return r.json() as Promise<InvestigationView>;
    });
  }
  return viewPromise;
}

export function useView(): InvestigationView {
  return use(loadView());
}
