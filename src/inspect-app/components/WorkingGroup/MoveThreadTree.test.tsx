import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import type { Move } from '../../../inspect/types';
import { MoveThreadTree } from './MoveThreadTree';

function makeMove(
  move_id: string,
  references_move_id: string | null = null,
  overrides: Partial<Move> = {},
): Move {
  return {
    move_id,
    by_persona_id: 'persona-1',
    type: 'Claim',
    content: `Content of move ${move_id} — some text that can be longer than ninety characters to test truncation behaviour`,
    confidence: 0.8,
    references_move_id,
    ...overrides,
  };
}

function renderTree(props: Partial<Parameters<typeof MoveThreadTree>[0]> & { moves: Move[] }) {
  const defaults = {
    personaName: (id: string) => id,
    survivingIds: new Set<string>(),
    selectedMoveId: null,
    onSelect: vi.fn(),
  };
  return render(
    <MantineProvider>
      <MoveThreadTree {...defaults} {...props} />
    </MantineProvider>,
  );
}

describe('MoveThreadTree', () => {
  it('all moves are collapsed by default; expanding one does not expand siblings', async () => {
    const user = userEvent.setup();
    const m1 = makeMove('m1');
    const m2 = makeMove('m2');
    const moves = [m1, m2];

    renderTree({ moves });

    // Both previews visible (collapsed state shows truncated content)
    expect(screen.getByText(/Content of move m1/)).toBeInTheDocument();
    expect(screen.getByText(/Content of move m2/)).toBeInTheDocument();

    // Initially, MoveCard is not rendered for either move
    expect(document.getElementById('move-m1')).toBeNull();
    expect(document.getElementById('move-m2')).toBeNull();

    // Expand m1 by clicking it
    const m1Row = screen.getByText(/Content of move m1/).closest('[data-move-id]');
    expect(m1Row).not.toBeNull();
    await user.click(m1Row!);

    // m1 should now render the expanded MoveCard (identified by its #move-<id> wrapper)
    expect(document.getElementById('move-m1')).not.toBeNull();

    // m2 should still be collapsed: MoveCard not rendered, preview text still present
    expect(document.getElementById('move-m2')).toBeNull();
    expect(screen.getByText(/Content of move m2/)).toBeInTheDocument();
  });

  it('clicking an expanded row collapses it back to the preview', async () => {
    const user = userEvent.setup();
    const m1 = makeMove('m1');
    const moves = [m1];

    renderTree({ moves });

    // Initially collapsed
    expect(document.getElementById('move-m1')).toBeNull();
    const collapsedRow = screen.getByText(/Content of move m1/).closest('[data-move-id]');
    expect(collapsedRow).not.toBeNull();

    // First click: expand
    await user.click(collapsedRow!);
    expect(document.getElementById('move-m1')).not.toBeNull();

    // The row element still exists with the same data-move-id selector; grab it again
    // since the row's children have changed (preview replaced by MoveCard).
    const expandedRow = document.querySelector('[data-move-id="m1"]') as HTMLElement | null;
    expect(expandedRow).not.toBeNull();

    // Second click: collapse back
    await user.click(expandedRow!);
    expect(document.getElementById('move-m1')).toBeNull();
    expect(screen.getByText(/Content of move m1/)).toBeInTheDocument();
  });

  it('clicking a collapsed row calls onSelect with correct move_id', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const moves = [makeMove('abc-123')];

    renderTree({ moves, onSelect });

    const row = screen.getByText(/Content of move abc-123/).closest('[data-move-id]');
    expect(row).not.toBeNull();
    await user.click(row!);

    expect(onSelect).toHaveBeenCalledWith('abc-123');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('surviving move shows green dot indicator', () => {
    const moves = [makeMove('surv-1'), makeMove('non-surv-2')];
    const survivingIds = new Set(['surv-1']);

    renderTree({ moves, survivingIds });

    expect(screen.getByTestId('surviving-dot-surv-1')).toBeInTheDocument();
    expect(screen.queryByTestId('surviving-dot-non-surv-2')).toBeNull();
  });

  it('depth-3 node has paddingLeft of 60px', () => {
    // Build a chain: m1 <- m2 <- m3 <- m4 (depth 0, 1, 2, 3)
    const m1 = makeMove('m1');
    const m2 = makeMove('m2', 'm1');
    const m3 = makeMove('m3', 'm2');
    const m4 = makeMove('m4', 'm3');
    const moves = [m1, m2, m3, m4];

    renderTree({ moves });

    const depth3Row = document.querySelector('[data-move-id="m4"][data-depth="3"]') as HTMLElement | null;
    expect(depth3Row).not.toBeNull();
    expect(depth3Row!.style.paddingLeft).toBe('60px');
  });
});
