import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ReactFlowProvider, type NodeProps, type Node } from '@xyflow/react';
import type { Move } from '../../../../inspect/types';
import { MoveGraphNode } from './MoveGraphNode';

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

type MoveGraphNodeData = {
  move: Move;
  stepIndex: number;
  totalMoves: number;
  isSelected: boolean;
  personaLabel: string;
  isSurviving: boolean;
};

type RenderOpts = Partial<MoveGraphNodeData> & { move?: Move };

function renderNode(opts: RenderOpts = {}) {
  const move = opts.move ?? makeMove();
  const data: MoveGraphNodeData = {
    move,
    stepIndex: opts.stepIndex ?? 0,
    totalMoves: opts.totalMoves ?? 1,
    isSelected: opts.isSelected ?? false,
    personaLabel: opts.personaLabel ?? 'Skeptic',
    isSurviving: opts.isSurviving ?? false,
  };
  // MoveGraphNode only reads `data` from its NodeProps; cast to satisfy types
  // without rebuilding the full xyflow internal state.
  const props = { data } as unknown as NodeProps<Node<MoveGraphNodeData, 'debateChain'>>;
  return render(
    <MantineProvider>
      <ReactFlowProvider>
        <MoveGraphNode {...props} />
      </ReactFlowProvider>
    </MantineProvider>,
  );
}

describe('MoveGraphNode', () => {
  it('renders the surviving-dot when isSurviving is true', () => {
    renderNode({ move: makeMove({ move_id: 'm1' }), isSurviving: true });
    expect(screen.getByTestId('graph-surviving-dot-m1')).toBeInTheDocument();
  });

  it('does NOT render the surviving-dot when isSurviving is false', () => {
    renderNode({ move: makeMove({ move_id: 'm1' }), isSurviving: false });
    expect(screen.queryByTestId('graph-surviving-dot-m1')).toBeNull();
  });

  it('marks the wrapper with data-selected="true" and applies selected styling when isSelected is true', () => {
    renderNode({ move: makeMove({ move_id: 'm1' }), isSelected: true });
    const wrapper = screen.getByTestId('move-graph-node-m1');
    expect(wrapper.getAttribute('data-selected')).toBe('true');
    // selected nodes get a blue background tint via the inline style
    expect(wrapper.style.background).toContain('blue');
  });

  it('marks the wrapper with data-selected="false" when isSelected is false', () => {
    renderNode({ move: makeMove({ move_id: 'm1' }), isSelected: false });
    const wrapper = screen.getByTestId('move-graph-node-m1');
    expect(wrapper.getAttribute('data-selected')).toBe('false');
    // un-selected nodes use the plain white background
    expect(wrapper.style.background).toBe('rgb(255, 255, 255)');
  });

  it('renders the persona label and move type', () => {
    renderNode({
      move: makeMove({ type: 'Rebut' }),
      personaLabel: 'Skeptic',
    });
    expect(screen.getByText('Skeptic')).toBeInTheDocument();
    expect(screen.getByText('Rebut')).toBeInTheDocument();
  });

  it('renders the move content', () => {
    renderNode({
      move: makeMove({ content: 'A specific test claim about evidence.' }),
    });
    expect(screen.getByText('A specific test claim about evidence.')).toBeInTheDocument();
  });

  it('shows the step counter as "{stepIndex+1}/{totalMoves}"', () => {
    renderNode({ stepIndex: 2, totalMoves: 5 });
    expect(screen.getByText('3/5')).toBeInTheDocument();
  });
});
