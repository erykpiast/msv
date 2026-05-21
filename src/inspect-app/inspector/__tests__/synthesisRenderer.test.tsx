import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { renderLeaf } from '../leafRenderers';
import { loadFixture } from './fixtures';
import type { InvestigationView, SynthesisView } from '../../../inspect/types';

function renderBody(body: ReactElement) {
  return render(<MantineProvider>{body}</MantineProvider>);
}

function viewWithSynthesis(synthesis: SynthesisView): InvestigationView {
  const base = loadFixture('ready-v5');
  return { ...base, synthesis };
}

const structuredSynthesis: SynthesisView = {
  report: 'Legacy prose report.',
  headline_findings: ['Finding A'],
  open_tensions: [],
  sections: [
    {
      area_title: 'Market Dynamics',
      area_summary: 'The market is moving fast. Several signals point to consolidation.',
      key_findings: [
        { content: 'High adoption rate observed ([Source 2024](https://example.com/study)).', confidence: 'high' },
        { content: 'Niche segment still underserved.', confidence: 'medium' },
      ],
    },
    {
      area_title: 'Technical Constraints',
      area_summary: 'Infrastructure lags behind demand. Scaling costs are the bottleneck.',
      key_findings: [
        { content: 'Cost per unit doubles beyond 10k scale.', confidence: 'low' },
      ],
    },
  ],
  tension_points: [
    {
      title: 'Adoption vs. Cost',
      description: 'Rapid adoption conflicts with high marginal cost at scale.',
      sides: [
        { label: 'Optimist', position: 'Economies of scale will bring costs down.' },
        { label: 'Realist', position: 'Current infrastructure cannot absorb growth.' },
      ],
      resolution: null,
    },
  ],
  key_references: [
    {
      url: 'https://example.com/study',
      title: 'Source 2024',
      summary: 'A comprehensive study on market adoption.',
      key_observations: ['Adoption doubled YoY', 'Cost remains volatile'],
    },
  ],
  next_pass_proposals: [
    { topic: 'Infrastructure scaling costs', rationale: 'This gap is the biggest unknown in the synthesis.' },
    { topic: 'Regulatory environment', rationale: 'No regulatory data was found during this run.' },
    { topic: 'Competitive landscape', rationale: 'Only one competitor was examined.' },
  ],
};

const legacySynthesis: SynthesisView = {
  report: 'Legacy flat prose report.',
  headline_findings: ['Finding 1', 'Finding 2'],
  open_tensions: [],
  question_landscape: [
    { territory_id: 't1', territory_name: 'Territory One', questions: [{ question: 'Q?', origin: 'aligned' }] },
  ],
  dead_end_summary: 'No evidence found on topic X.',
};

describe('synthesis leaf renderer — structured path', () => {
  it('renders section titles when sections is present', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    expect(result).not.toBeNull();
    renderBody(result!.body as ReactElement);
    expect(screen.getByText('Market Dynamics')).toBeInTheDocument();
    expect(screen.getByText('Technical Constraints')).toBeInTheDocument();
  });

  it('renders area summaries', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.getByText('The market is moving fast. Several signals point to consolidation.')).toBeInTheDocument();
  });

  it('renders confidence badges for findings', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.getByText('low')).toBeInTheDocument();
  });

  it('renders tension point title and side labels', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.getByText('Adoption vs. Cost')).toBeInTheDocument();
    expect(screen.getByText('Optimist:')).toBeInTheDocument();
    expect(screen.getByText('Realist:')).toBeInTheDocument();
  });

  it('renders clickable anchor for each key_reference URL', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    renderBody(result!.body as ReactElement);
    // Multiple links may match "Source 2024" (inline markdown + key_references anchor).
    // Verify at least one has the correct href.
    const links = screen.getAllByRole('link', { name: /Source 2024/ });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.some((l) => l.getAttribute('href') === 'https://example.com/study')).toBe(true);
  });

  it('renders all next_pass_proposals', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.getByText(/Infrastructure scaling costs/)).toBeInTheDocument();
    expect(screen.getByText(/Regulatory environment/)).toBeInTheDocument();
    expect(screen.getByText(/Competitive landscape/)).toBeInTheDocument();
  });

  it('does not render "Headline findings" heading in structured mode', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.queryByText('Headline findings')).toBeNull();
  });

  it('serializes structured fields to markdown in raw', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(structuredSynthesis));
    expect(result!.raw).toContain('## Market Dynamics');
    expect(result!.raw).toContain('- _(high)_ High adoption rate observed');
    expect(result!.raw).toContain('## Tension points');
    expect(result!.raw).toContain('### Adoption vs. Cost');
    expect(result!.raw).toContain('- **Optimist:**');
    expect(result!.raw).toContain('## Most relevant references');
    expect(result!.raw).toContain('[Source 2024](https://example.com/study)');
    expect(result!.raw).toContain('## Dig deeper — next pass proposals');
    expect(result!.raw).toContain('**Infrastructure scaling costs**');
  });
});

describe('synthesis leaf renderer — legacy fallback', () => {
  it('falls back to legacy prose rendering when sections is absent', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(legacySynthesis));
    expect(result).not.toBeNull();
    renderBody(result!.body as ReactElement);
    expect(screen.getByText('Headline findings')).toBeInTheDocument();
    expect(screen.getByText('· Finding 1')).toBeInTheDocument();
    expect(screen.getByText('· Finding 2')).toBeInTheDocument();
  });

  it('renders question landscape in legacy mode', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(legacySynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.getByText(/Territory One/)).toBeInTheDocument();
  });

  it('renders dead_end_summary in legacy mode', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(legacySynthesis));
    renderBody(result!.body as ReactElement);
    expect(screen.getByText('No evidence found on topic X.')).toBeInTheDocument();
  });

  it('returns null when synthesis is null', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(null));
    expect(result).toBeNull();
  });

  it('falls back to s.report in raw when sections is absent', () => {
    const result = renderLeaf({ kind: 'synthesis' }, viewWithSynthesis(legacySynthesis));
    expect(result!.raw).toContain('Legacy flat prose report.');
    expect(result!.raw).toContain('## Headline findings');
    expect(result!.raw).toContain('- Finding 1');
    expect(result!.raw).toContain('## Dead ends');
  });
});
