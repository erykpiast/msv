import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type {
  WorkingGroupView,
  SurvivingClaim,
  Move,
} from '../../../inspect/types';
import type { CanvasRoute } from '../../hooks/useHashRoute';

// Mock useCanvasRoute so we can drive `route` and observe `setRoute`. We keep
// `parseCanvasRoute` / `formatCanvasRoute` (and the rest of the module) intact
// in case other call paths rely on them — the panel only uses useCanvasRoute.
const setRouteSpy = vi.fn();
let currentRoute: CanvasRoute = {
  canvas: 'wg',
  territoryId: 't1',
  substage: 'conclusions',
};

vi.mock('../../hooks/useHashRoute', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useHashRoute')>(
    '../../hooks/useHashRoute',
  );
  return {
    ...actual,
    useCanvasRoute: () => ({
      route: currentRoute,
      setRoute: setRouteSpy,
    }),
  };
});

// Import AFTER vi.mock so the mock is in place.
import { ConclusionsPanel } from './ConclusionsPanel';

function makeWG(overrides: Partial<WorkingGroupView> = {}): WorkingGroupView {
  return {
    territory: null,
    pair: [],
    candidate_questions: [],
    adversarial_marks: [],
    aligned_questions: [],
    researcher_reports: [],
    observations: [],
    moves: [],
    surviving_claims: [],
    terminated_by: null,
    confidence_trajectory: [],
    ...overrides,
  };
}

function makeClaim(overrides: Partial<SurvivingClaim> = {}): SurvivingClaim {
  return {
    claim_id: 'cl1',
    originating_move_id: 'm1',
    content: 'A surviving claim',
    confidence_after_debate: 0.75,
    ...overrides,
  };
}

function makeMove(overrides: Partial<Move> = {}): Move {
  return {
    move_id: 'm1',
    by_persona_id: 'persona-a',
    type: 'Claim',
    content: 'Move content',
    confidence: 0.8,
    references_move_id: null,
    ...overrides,
  };
}

function renderPanel(props: Parameters<typeof ConclusionsPanel>[0]) {
  return render(
    <MantineProvider>
      <ConclusionsPanel {...props} />
    </MantineProvider>,
  );
}

const personaName = (id: string) =>
  id === 'persona-a' ? 'Skeptic' : id === 'persona-b' ? 'Believer' : id;

describe('ConclusionsPanel', () => {
  beforeEach(() => {
    setRouteSpy.mockReset();
    currentRoute = {
      canvas: 'wg',
      territoryId: 't1',
      substage: 'conclusions',
    };
  });

  it('renders the empty state when surviving_claims is empty', () => {
    renderPanel({
      wg: makeWG({ surviving_claims: [] }),
      personaName,
    });
    expect(
      screen.getByText(/No surviving claims recorded for this working group\./),
    ).toBeInTheDocument();
  });

  it('uses singular "1 surviving claim after debate." for one claim', () => {
    renderPanel({
      wg: makeWG({ surviving_claims: [makeClaim()] }),
      personaName,
    });
    expect(screen.getByText('1 surviving claim after debate.')).toBeInTheDocument();
  });

  it('uses plural "2 surviving claims after debate." for two claims', () => {
    renderPanel({
      wg: makeWG({
        surviving_claims: [
          makeClaim({ claim_id: 'cl1', originating_move_id: 'm1' }),
          makeClaim({ claim_id: 'cl2', originating_move_id: 'm2' }),
        ],
      }),
      personaName,
    });
    expect(screen.getByText('2 surviving claims after debate.')).toBeInTheDocument();
  });

  it('includes "· by {persona name}" when the originating move exists in wg.moves', () => {
    renderPanel({
      wg: makeWG({
        moves: [makeMove({ move_id: 'm1', by_persona_id: 'persona-a' })],
        surviving_claims: [
          makeClaim({ claim_id: 'cl1', originating_move_id: 'm1' }),
        ],
      }),
      personaName,
    });
    expect(
      screen.getByText('originating move: m1 · by Skeptic'),
    ).toBeInTheDocument();
  });

  it('omits "· by ..." when the originating move is NOT in wg.moves', () => {
    renderPanel({
      wg: makeWG({
        moves: [],
        surviving_claims: [
          makeClaim({ claim_id: 'cl1', originating_move_id: 'm-missing' }),
        ],
      }),
      personaName,
    });
    expect(screen.getByText('originating move: m-missing')).toBeInTheDocument();
    // No "· by " should appear anywhere on the page when the move is missing.
    expect(screen.queryByText(/· by /)).toBeNull();
  });

  it('clicking the claim title calls setRoute with { ...route, leaf: { kind: "claim", id } } when canvas is wg', () => {
    const claim = makeClaim({ claim_id: 'cl-clicked', originating_move_id: 'm1' });
    renderPanel({
      wg: makeWG({ surviving_claims: [claim] }),
      personaName,
    });
    // The anchor uses the claim_id (no nickname) as its label.
    fireEvent.click(screen.getByText('cl-clicked'));
    expect(setRouteSpy).toHaveBeenCalledTimes(1);
    expect(setRouteSpy).toHaveBeenCalledWith({
      canvas: 'wg',
      territoryId: 't1',
      substage: 'conclusions',
      leaf: { kind: 'claim', id: 'cl-clicked' },
    });
  });

  it('does NOT call setRoute when route.canvas is not "wg" (openClaim guard)', () => {
    currentRoute = { canvas: 'pipeline', expanded: [] };
    const claim = makeClaim({ claim_id: 'cl-guarded' });
    renderPanel({
      wg: makeWG({ surviving_claims: [claim] }),
      personaName,
    });
    fireEvent.click(screen.getByText('cl-guarded'));
    expect(setRouteSpy).not.toHaveBeenCalled();
  });
});
