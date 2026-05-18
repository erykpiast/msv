import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { ViewProvider } from '../../ViewContext';
import { emptyProgress } from '../../hooks/useLiveProgress';
import type { ProgressOverlay } from '../../hooks/useLiveProgress';
import type { SseStatus } from '../../ViewContext';
import type { InvestigationView } from '../../../inspect/types';

export function renderWithView(ui: ReactElement, view: InvestigationView) {
  return render(
    <MantineProvider>
      <ViewProvider view={view} progress={emptyProgress()} sseStatus="connecting">{ui}</ViewProvider>
    </MantineProvider>
  );
}

export function renderWithProgress(
  ui: ReactElement,
  view: InvestigationView,
  progress: ProgressOverlay,
  sseStatus: SseStatus = 'connecting',
) {
  return render(
    <MantineProvider>
      <ViewProvider view={view} progress={progress} sseStatus={sseStatus}>{ui}</ViewProvider>
    </MantineProvider>
  );
}
