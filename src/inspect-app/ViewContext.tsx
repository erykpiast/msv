import { createContext, useContext, type ReactNode } from 'react';
import type { InvestigationView } from '../inspect/types';

const ViewContext = createContext<InvestigationView | null>(null);

export function ViewProvider({
  view,
  children,
}: {
  view: InvestigationView;
  children: ReactNode;
}) {
  return <ViewContext.Provider value={view}>{children}</ViewContext.Provider>;
}

export function useViewContext(): InvestigationView {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error('useViewContext must be used inside <ViewProvider>');
  return ctx;
}
