import { describe, it, expect, beforeEach } from 'vitest';
import { screen, render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { renderWithView, renderWithProgress } from './render-with-providers';
import { loadFixture } from './fixtures';
import { TopLevelCanvas } from '../TopLevelCanvas';
import { Header } from '../../components/Header/Header';
import { renderLeaf } from '../leafRenderers';
import { emptyProgress } from '../../hooks/useLiveProgress';
import type { ProgressOverlay } from '../../hooks/useLiveProgress';

describe('live animations', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('Test A — data-status="in_progress" on discovery node when overlay has the discovery stage', () => {
    const view = loadFixture('ready-v5');
    const progress: ProgressOverlay = {
      ...emptyProgress(),
      inProgressStages: new Set(['discovery']),
    };
    renderWithProgress(
      <TopLevelCanvas route={{ canvas: 'pipeline', expanded: [] }} setRoute={() => {}} />,
      view,
      progress,
    );
    const inProgressEl = document.querySelector('[data-status="in_progress"]');
    expect(inProgressEl).not.toBeNull();
  });

  it('Test B — Skeleton renders for missing WG move when WG is in progress', () => {
    const view = loadFixture('ready-v5');
    const wgId = Object.keys(view.working_groups)[0]!;
    const overlay: ProgressOverlay = {
      ...emptyProgress(),
      inProgressWg: new Set([wgId]),
    };
    const result = renderLeaf(
      { kind: 'move', id: 'nonexistent-move-id-xyz' },
      view,
      { overlay },
    );
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Debate move');
    // Render the body to check the Skeleton is in the DOM.
    // Mantine Skeleton renders with data-visible when visible=true (default).
    render(<MantineProvider>{result!.body}</MantineProvider>);
    const skeleton = document.querySelector('[data-visible]');
    expect(skeleton).not.toBeNull();
  });

  it('Test C — ● LIVE badge visible when sseStatus="live", absent when "connecting"', () => {
    const view = loadFixture('ready-v5');
    const progress = emptyProgress();

    const { unmount } = renderWithProgress(<Header />, view, progress, 'live');
    expect(screen.getByText('● LIVE')).toBeInTheDocument();
    unmount();

    renderWithProgress(<Header />, view, progress, 'connecting');
    expect(screen.queryByText('● LIVE')).not.toBeInTheDocument();
  });
});
