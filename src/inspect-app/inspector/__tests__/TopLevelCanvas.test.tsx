import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithView } from './render-with-providers';
import { loadFixture } from './fixtures';
import { TopLevelCanvas } from '../TopLevelCanvas';

describe('TopLevelCanvas', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('renders Discovery, Coordinator, Forum, Synthesis labels', () => {
    const view = loadFixture('ready-v5');
    renderWithView(
      <TopLevelCanvas route={{ canvas: 'pipeline', expanded: [] }} setRoute={() => {}} />,
      view
    );
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('Coordinator')).toBeInTheDocument();
    expect(screen.getByText('Forum')).toBeInTheDocument();
    expect(screen.getByText('Synthesis')).toBeInTheDocument();
  });

  it('renders WG nodes for each working group', () => {
    const view = loadFixture('ready-v5');
    renderWithView(
      <TopLevelCanvas route={{ canvas: 'pipeline', expanded: [] }} setRoute={() => {}} />,
      view
    );
    for (const wgId of Object.keys(view.working_groups)) {
      const wg = view.working_groups[wgId];
      if (wg?.territory?.name) {
        expect(screen.getByText(`WG: ${wg.territory.name}`)).toBeInTheDocument();
      }
    }
  });
});
