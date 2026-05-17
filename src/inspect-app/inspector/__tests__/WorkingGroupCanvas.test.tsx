import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithView } from './render-with-providers';
import { loadFixture } from './fixtures';
import { WorkingGroupCanvas } from '../canvases/WorkingGroupCanvas';

describe('WorkingGroupCanvas', () => {
  it('renders six sub-stage labels', () => {
    const view = loadFixture('ready-v5');
    const wgId = Object.keys(view.working_groups)[0]!;
    renderWithView(
      <WorkingGroupCanvas route={{ canvas: 'wg', territoryId: wgId }} setRoute={() => {}} />,
      view
    );
    // These labels come from the LABEL mapping in SubStageNode
    expect(screen.getByText('Ideation')).toBeInTheDocument();
    expect(screen.getByText('Adversarial')).toBeInTheDocument();
    expect(screen.getByText('Alignment')).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText('Observations')).toBeInTheDocument();
    expect(screen.getByText('Debate')).toBeInTheDocument();
  });

  it('renders unknown territory id as Empty', () => {
    const view = loadFixture('ready-v5');
    renderWithView(
      <WorkingGroupCanvas route={{ canvas: 'wg', territoryId: 'nonexistent' }} setRoute={() => {}} />,
      view
    );
    expect(screen.getByText(/Working group "nonexistent" not found/)).toBeInTheDocument();
  });
});
