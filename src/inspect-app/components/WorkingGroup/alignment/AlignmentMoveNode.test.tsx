import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ReactFlowProvider, type NodeProps, type Node } from '@xyflow/react';
import type { AlignmentMove } from '../../../../inspect/types';
import { AlignmentMoveNode } from './AlignmentMoveNode';

function makeMove(overrides: Partial<AlignmentMove> = {}): AlignmentMove {
  return {
    move_id: 'am1',
    by_persona_id: 'persona-a',
    type: 'Propose',
    content: 'A proposal',
    stage: 'alignment',
    ...overrides,
  };
}

type AlignmentMoveNodeData = {
  move: AlignmentMove;
  stepIndex: number;
  totalMoves: number;
  isSelected: boolean;
  personaLabel: string;
};

function renderNode(opts: Partial<AlignmentMoveNodeData> = {}) {
  const data: AlignmentMoveNodeData = {
    move: opts.move ?? makeMove(),
    stepIndex: opts.stepIndex ?? 0,
    totalMoves: opts.totalMoves ?? 1,
    isSelected: opts.isSelected ?? false,
    personaLabel: opts.personaLabel ?? 'Negotiator',
  };
  const props = { data } as unknown as NodeProps<Node<AlignmentMoveNodeData, 'alignmentMove'>>;
  return render(
    <MantineProvider>
      <ReactFlowProvider>
        <AlignmentMoveNode {...props} />
      </ReactFlowProvider>
    </MantineProvider>,
  );
}

describe('AlignmentMoveNode', () => {
  it('renders the move type and persona label', () => {
    renderNode({
      move: makeMove({ type: 'Sharpen' }),
      personaLabel: 'Negotiator',
    });
    expect(screen.getByText('Sharpen')).toBeInTheDocument();
    expect(screen.getByText('Negotiator')).toBeInTheDocument();
  });

  it('renders the move content', () => {
    renderNode({
      move: makeMove({ content: 'Sharpen this candidate by adding scope.' }),
    });
    expect(
      screen.getByText('Sharpen this candidate by adding scope.'),
    ).toBeInTheDocument();
  });

  it('applies selected styling when isSelected is true', () => {
    renderNode({ move: makeMove({ move_id: 'am1' }), isSelected: true });
    const wrapper = screen.getByTestId('align-move-am1');
    expect(wrapper.getAttribute('data-selected')).toBe('true');
    expect(wrapper.style.background).toContain('blue');
  });

  it('applies the default styling when isSelected is false', () => {
    renderNode({ move: makeMove({ move_id: 'am1' }), isSelected: false });
    const wrapper = screen.getByTestId('align-move-am1');
    expect(wrapper.getAttribute('data-selected')).toBe('false');
    expect(wrapper.style.background).toBe('rgb(255, 255, 255)');
  });

  it('shows the step counter as "{stepIndex+1}/{totalMoves}"', () => {
    renderNode({ stepIndex: 1, totalMoves: 4 });
    expect(screen.getByText('2/4')).toBeInTheDocument();
  });
});
