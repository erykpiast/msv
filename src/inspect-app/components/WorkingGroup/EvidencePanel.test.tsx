import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { Move, Observation, Finding } from '../../../inspect/types';
import { EvidencePanel } from './EvidencePanel';

function makeMove(overrides: Partial<Move> = {}): Move {
  return {
    move_id: 'm1',
    by_persona_id: 'persona-a',
    type: 'Claim',
    content: 'test move',
    confidence: 0.8,
    references_move_id: null,
    ...overrides,
  };
}

function makeObs(
  observation_id: string,
  cited_finding_ids: string[],
  overrides: Partial<Observation> = {},
): Observation {
  return {
    observation_id,
    by_persona_id: 'persona-a',
    report_id: 'r1',
    content: `Observation ${observation_id}`,
    cited_finding_ids,
    ...overrides,
  };
}

function makeFinding(finding_id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id,
    content: `Finding ${finding_id}`,
    ...overrides,
  };
}

function renderPanel(props: Parameters<typeof EvidencePanel>[0]) {
  return render(
    <MantineProvider>
      <EvidencePanel {...props} />
    </MantineProvider>,
  );
}

describe('EvidencePanel', () => {
  it('renders "Select a move..." when selectedMoveId is null', () => {
    renderPanel({
      selectedMoveId: null,
      moves: [],
      observations: [],
      findings: [],
    });
    expect(screen.getByText(/Select a move to see its evidence trail\./)).toBeInTheDocument();
  });

  it('renders "Move not found." when selectedMoveId is not in moves', () => {
    renderPanel({
      selectedMoveId: 'missing-move',
      moves: [],
      observations: [],
      findings: [],
    });
    expect(screen.getByText(/Move not found\./)).toBeInTheDocument();
  });

  it('renders "no recorded evidence references" when move has empty evidence_refs', () => {
    const move = makeMove({ move_id: 'm1', evidence_refs: [] });
    renderPanel({
      selectedMoveId: 'm1',
      moves: [move],
      observations: [],
      findings: [],
    });
    expect(
      screen.getByText(/This move has no recorded evidence references\./),
    ).toBeInTheDocument();
  });

  it('renders "no recorded evidence references" when move has no evidence_refs', () => {
    const move = makeMove({ move_id: 'm1', evidence_refs: undefined });
    renderPanel({
      selectedMoveId: 'm1',
      moves: [move],
      observations: [],
      findings: [],
    });
    expect(
      screen.getByText(/This move has no recorded evidence references\./),
    ).toBeInTheDocument();
  });

  it('renders ReactFlow container when move has valid evidence refs', () => {
    const move = makeMove({
      move_id: 'm1',
      evidence_refs: [{ observation_id: 'obs1' }],
    });
    const obs1 = makeObs('obs1', ['f1']);
    const finding1 = makeFinding('f1');

    const { container } = renderPanel({
      selectedMoveId: 'm1',
      moves: [move],
      observations: [obs1],
      findings: [finding1],
    });

    // ReactFlow renders a div with class react-flow
    expect(container.querySelector('.react-flow')).not.toBeNull();
  });

  it('correct node count for a known fixture: one obs citing two findings → 4 nodes', () => {
    // Same fixture as evidenceLayout.test.ts "one obs citing two findings" case:
    // move cites obs1, obs1 cites f1 and f2 → nodes: f1, f2, obs1, move = 4
    const move = makeMove({
      move_id: 'm1',
      evidence_refs: [{ observation_id: 'obs1' }],
    });
    const obs1 = makeObs('obs1', ['f1', 'f2']);
    const finding1 = makeFinding('f1');
    const finding2 = makeFinding('f2');

    const { container } = renderPanel({
      selectedMoveId: 'm1',
      moves: [move],
      observations: [obs1],
      findings: [finding1, finding2],
    });

    // ReactFlow renders a node for each item; each node gets data-id attribute
    const reactFlowEl = container.querySelector('.react-flow');
    expect(reactFlowEl).not.toBeNull();

    // There should be 4 nodes rendered (f1, f2, obs1, move)
    const nodeEls = container.querySelectorAll('.react-flow__node');
    expect(nodeEls).toHaveLength(4);
  });
});
