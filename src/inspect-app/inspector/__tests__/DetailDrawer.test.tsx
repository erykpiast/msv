import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithView } from './render-with-providers';
import { loadFixture } from './fixtures';
import { DetailDrawer } from '../DetailDrawer';

describe('DetailDrawer', () => {
  it('renders nothing when no leaf is provided', () => {
    const view = loadFixture('ready-v5');
    renderWithView(<DetailDrawer onClose={() => {}} />, view);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders synthesis content for synthesis leaf', () => {
    const view = loadFixture('ready-v5');
    // Fail loudly if the fixture ever regresses to no synthesis — the test
    // would otherwise silently pass on the previous skip-guard pattern.
    expect(view.synthesis).toBeTruthy();
    renderWithView(<DetailDrawer leaf={{ kind: 'synthesis' }} onClose={() => {}} />, view);
    expect(screen.getByText('Synthesis')).toBeInTheDocument();
  });

  it('calls onClose when Escape is pressed', async () => {
    const view = loadFixture('ready-v5');
    expect(view.synthesis).toBeTruthy();
    const onClose = vi.fn();
    renderWithView(<DetailDrawer leaf={{ kind: 'synthesis' }} onClose={onClose} />, view);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('returns null body for unknown persona id', () => {
    const view = loadFixture('ready-v5');
    renderWithView(
      <DetailDrawer leaf={{ kind: 'persona', id: 'does-not-exist' }} onClose={() => {}} />,
      view
    );
    // renderLeaf returns null → drawer renders nothing
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
