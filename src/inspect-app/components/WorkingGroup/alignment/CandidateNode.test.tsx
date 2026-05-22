import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ReactFlowProvider, type NodeProps, type Node } from '@xyflow/react';
import type { CandidateQuestion } from '../../../../inspect/types';
import { CandidateNode } from './CandidateNode';

function makeCandidate(overrides: Partial<CandidateQuestion> = {}): CandidateQuestion {
  return {
    candidate_id: 'c1',
    by_persona_id: 'persona-a',
    predicted_confidence: 5,
    question: 'What is the question?',
    ...overrides,
  };
}

type CandidateNodeData = {
  candidate: CandidateQuestion;
  isAligned: boolean;
  personaLabel: string;
};

function renderNode(opts: Partial<CandidateNodeData> = {}) {
  const data: CandidateNodeData = {
    candidate: opts.candidate ?? makeCandidate(),
    isAligned: opts.isAligned ?? false,
    personaLabel: opts.personaLabel ?? 'Researcher',
  };
  const props = { data } as unknown as NodeProps<Node<CandidateNodeData, 'alignmentCandidate'>>;
  return render(
    <MantineProvider>
      <ReactFlowProvider>
        <CandidateNode {...props} />
      </ReactFlowProvider>
    </MantineProvider>,
  );
}

describe('CandidateNode', () => {
  it('renders the "aligned" badge when isAligned is true', () => {
    renderNode({ isAligned: true });
    expect(screen.getByText('aligned')).toBeInTheDocument();
  });

  it('does NOT render the "aligned" badge when isAligned is false', () => {
    renderNode({ isAligned: false });
    expect(screen.queryByText('aligned')).toBeNull();
  });

  it('applies green selected-aligned styling when isAligned is true', () => {
    renderNode({ candidate: makeCandidate({ candidate_id: 'c1' }), isAligned: true });
    const wrapper = screen.getByTestId('align-candidate-c1');
    expect(wrapper.getAttribute('data-aligned')).toBe('true');
    // aligned nodes get a green-tinted background
    expect(wrapper.style.background).toContain('green');
  });

  it('uses the plain background when isAligned is false', () => {
    renderNode({ candidate: makeCandidate({ candidate_id: 'c1' }), isAligned: false });
    const wrapper = screen.getByTestId('align-candidate-c1');
    expect(wrapper.getAttribute('data-aligned')).toBe('false');
    expect(wrapper.style.background).toBe('rgb(255, 255, 255)');
  });

  it('renders the candidate question text', () => {
    renderNode({
      candidate: makeCandidate({ question: 'How does X relate to Y?' }),
    });
    expect(screen.getByText('How does X relate to Y?')).toBeInTheDocument();
  });

  it('renders the persona label', () => {
    renderNode({ personaLabel: 'Researcher' });
    expect(screen.getByText('Researcher')).toBeInTheDocument();
  });
});
