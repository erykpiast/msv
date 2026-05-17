import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithView } from './render-with-providers';
import { loadFixture } from './fixtures';
import { TopLevelCanvas } from '../TopLevelCanvas';
import { LastFailureBanner } from '../LastFailureBanner';
import type { InvestigationView } from '../../../inspect/types';

describe('Partial-investigation rendering', () => {
  it('shows at least one partial or not_run pip for investigating fixture', () => {
    const view = loadFixture('investigating');
    renderWithView(
      <TopLevelCanvas route={{ canvas: 'pipeline', expanded: [] }} setRoute={() => {}} />,
      view
    );
    const pips = screen.queryAllByLabelText(/^status: /);
    const labels = pips.map((p) => p.getAttribute('aria-label') ?? '');
    expect(labels.some((l) => l === 'status: partial' || l === 'status: not_run')).toBe(true);
  });

  it('renders nothing when last_failure is absent', () => {
    const view = loadFixture('investigating');
    // Sanity check: ensure the fixture does not carry last_failure, so this
    // branch is meaningful instead of dead.
    expect(view.last_failure).toBeUndefined();
    renderWithView(<LastFailureBanner />, view);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders banner when last_failure is present', () => {
    const baseView = loadFixture('investigating');
    const view: InvestigationView = {
      ...baseView,
      last_failure: {
        reason: 'anthropic_unavailable',
        stage: 'debates',
        territory_id: 't_001',
        sub_stage: 'researcher',
        at: '2026-05-16T00:03:00.000Z',
      },
    };
    renderWithView(<LastFailureBanner />, view);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/anthropic_unavailable/);
    expect(alert.textContent).toMatch(/t_001/);
    expect(alert.textContent).toMatch(/researcher/);
  });
});
