import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { ViewProvider } from '../../ViewContext';
import type { InvestigationView } from '../../../inspect/types';

export function renderWithView(ui: ReactElement, view: InvestigationView) {
  return render(
    <MantineProvider>
      <ViewProvider view={view}>{ui}</ViewProvider>
    </MantineProvider>
  );
}
