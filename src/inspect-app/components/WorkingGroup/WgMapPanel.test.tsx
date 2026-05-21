import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type {
  WorkingGroupView,
  Territory,
  AlignedQuestion,
  Finding,
  ResearcherReport,
} from '../../../inspect/types';
import { WgMapPanel } from './WgMapPanel';

function makeTerritory(id: string): Territory {
  return {
    id,
    territory_id: id,
    name: `Territory ${id}`,
    description: 'Test territory',
    assigned_pair: ['p1', 'p2'],
  };
}

function makeAQ(id: string): AlignedQuestion {
  return {
    aligned_id: id,
    question: `Question ${id}`,
    origin: 'aligned',
    source_candidate_ids: [],
  };
}

function makeFinding(id: string): Finding {
  return {
    finding_id: id,
    content: `Finding ${id}`,
  };
}

function makeReport(aligned_id: string, findings: Finding[]): ResearcherReport {
  return {
    report_id: `report-${aligned_id}`,
    aligned_id,
    outcome: 'useful',
    findings,
    search_trace: [],
  };
}

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

function renderPanel(props: Parameters<typeof WgMapPanel>[0]) {
  return render(
    <MantineProvider>
      <WgMapPanel {...props} />
    </MantineProvider>,
  );
}

describe('WgMapPanel', () => {
  it('renders "No research structure to display." when aligned_questions is empty', () => {
    const wg = makeWG({ aligned_questions: [] });
    renderPanel({ wg });
    expect(screen.getByText(/No research structure to display\./)).toBeInTheDocument();
  });

  it('renders a ReactFlow container when aligned_questions is non-empty', () => {
    const territory = makeTerritory('t1');
    const aq1 = makeAQ('aq1');
    const f1 = makeFinding('f1');

    const wg = makeWG({
      territory,
      aligned_questions: [aq1],
      researcher_reports: [makeReport('aq1', [f1])],
      observations: [],
    });

    const { container } = renderPanel({ wg });
    expect(container.querySelector('.react-flow')).not.toBeNull();
  });
});
