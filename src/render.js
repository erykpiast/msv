'use strict';

const DIVIDER = '────────────────────────────────────';

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function countMoves(idea) {
  const debates = idea?.investigation?.pair_debates || [];
  return debates.reduce((sum, debate) => sum + (debate.moves?.length || 0), 0);
}

function countTerritories(idea) {
  const territories = idea?.investigation?.coordinator_decisions?.initial?.territories || [];
  // v4 compat
  const subQs = idea?.investigation?.coordinator_decisions?.initial?.sub_questions || [];
  return territories.length || subQs.length;
}

function countAlignedQuestions(idea) {
  const debates = idea?.investigation?.pair_debates || [];
  return debates.reduce((sum, d) => sum + (d.aligned_questions?.length || 0), 0);
}

function countObservations(idea) {
  const debates = idea?.investigation?.pair_debates || [];
  return debates.reduce((sum, d) => sum + (d.observations?.length || 0), 0);
}

function countDeadEnds(idea) {
  return (idea?.investigation?.forum?.dead_end_questions || []).length;
}

function isV5(idea) {
  return idea?.investigation?.schema_version === 'v5';
}

// Render one representative aligned question per territory for the card header.
function renderQuestionsSummary(idea) {
  const debates = idea?.investigation?.pair_debates || [];
  const territories = idea?.investigation?.coordinator_decisions?.initial?.territories || [];
  const lines = [];
  for (const debate of debates) {
    const territory = territories.find(
      (t) => (t.id || t.territory_id) === debate.territory_id
    );
    const name = territory?.name || debate.territory_id || '?';
    const firstQ = debate.aligned_questions?.[0];
    if (firstQ) {
      lines.push(`  · [${name}]   ${truncate(firstQ.question, 70)}`);
    }
  }
  return lines.join('\n');
}

function renderSteerCard(idea) {
  const capturedAt = idea.captured_at || '';
  const topic = truncate(idea.raw_capture || '', 72);
  const synthesis = idea?.investigation?.synthesis || {};
  const headline = (synthesis.headline_findings || []).slice(0, 5);
  const tensions = (synthesis.open_tensions || []).slice(0, 3);
  const budget = idea?.investigation?.budget || {};
  const deadEndCount = countDeadEnds(idea);

  if (isV5(idea)) {
    const territoryCount = countTerritories(idea);
    const questionCount = countAlignedQuestions(idea);
    const observationCount = countObservations(idea);
    const questionsSummary = renderQuestionsSummary(idea);

    const lines = [
      DIVIDER,
      `${capturedAt}  ·  ${topic}`,
      `${territoryCount} territories · ${questionCount} questions · ${observationCount} observations · ${budget.used_total_tokens || 0} tokens`,
      DIVIDER,
      '',
      'QUESTIONS ASKED',
      questionsSummary || '  (none)',
      `                                            [q] expand full list with provenance`,
      '',
      'HEADLINE FINDINGS',
      ...(headline.length ? headline.map((h) => `· ${h}`) : ['(none)']),
      '',
      'OPEN TENSIONS',
      ...(tensions.length ? tensions.map((t) => `· ${t}`) : ['(none)']),
      '',
      deadEndCount > 0
        ? `DEAD ENDS\n${deadEndCount} question(s) researched but yielding no evidence  [e] expand`
        : 'DEAD ENDS\n(none)',
      '',
      DIVIDER,
      '[r]ead full report  [q]uestions  [e]dead ends  [d]eeper (new topic)  [k]ill  [n]otes  [i]nspect',
    ];
    return lines.join('\n');
  }

  // v4 compat card
  const subQCount = idea?.investigation?.coordinator_decisions?.initial?.sub_questions?.length || 0;
  const spawnQCount = idea?.investigation?.coordinator_decisions?.spawn?.sub_questions?.length || 0;
  const lines = [
    DIVIDER,
    `${capturedAt}  ·  ${topic}`,
    `investigation: ${subQCount + spawnQCount} sub-questions · ${countMoves(idea)} moves · ${budget.used_total_tokens || 0} tokens`,
    DIVIDER,
    '',
    'HEADLINE FINDINGS',
    ...(headline.length ? headline.map((h) => `· ${h}`) : ['(none)']),
    '',
    'OPEN TENSIONS',
    ...(tensions.length ? tensions.map((t) => `· ${t}`) : ['(none)']),
    '',
    DIVIDER,
    '[r]ead full report  [d]eeper (new topic)  [k]ill  [n]otes  [i]nspect — open visual transcript',
  ];
  return lines.join('\n');
}

function renderSynthesis(idea) {
  const synthesis = idea?.investigation?.synthesis;
  if (!synthesis) {
    return 'No synthesis available yet.';
  }
  const { headline_findings = [], open_tensions = [], report = '' } = synthesis;
  return [
    DIVIDER,
    'HEADLINE FINDINGS',
    ...headline_findings.map((item, index) => `${index + 1}. ${item}`),
    '',
    'OPEN TENSIONS',
    ...(open_tensions.length
      ? open_tensions.map((item, index) => `${index + 1}. ${item}`)
      : ['(none)']),
    '',
    DIVIDER,
    '',
    report,
  ].join('\n');
}

// v5: render the full question landscape per territory with provenance.
function renderQuestionLandscape(idea) {
  const synthesis = idea?.investigation?.synthesis;
  if (synthesis?.question_landscape && Array.isArray(synthesis.question_landscape)) {
    return synthesis.question_landscape
      .map((territory) => {
        const qs = (territory.questions || [])
          .map((q) => {
            const badge = q.origin === 'aligned' ? '' : ` (minority: ${q.origin.replace('minority_', '')})`;
            return `  · ${q.question}${badge}`;
          })
          .join('\n');
        return `[${territory.territory_name || territory.territory_id}]\n${qs || '  (none)'}`;
      })
      .join('\n\n');
  }

  // Fall back to building from pair_debates.
  const debates = idea?.investigation?.pair_debates || [];
  const territories = idea?.investigation?.coordinator_decisions?.initial?.territories || [];
  if (debates.length === 0) return '(no question landscape available)';

  return debates
    .filter((d) => d.territory_id && d.aligned_questions?.length > 0)
    .map((d) => {
      const territory = territories.find((t) => (t.id || t.territory_id) === d.territory_id);
      const name = territory?.name || d.territory_id;
      const qs = (d.aligned_questions || [])
        .map((aq) => {
          const badge =
            aq.origin === 'aligned' ? '' : ` (minority: ${aq.origin.replace('minority_', '')})`;
          return `  · ${aq.question}${badge}`;
        })
        .join('\n');
      return `[${name}]\n${qs}`;
    })
    .join('\n\n');
}

// v5: render dead-end questions.
function renderDeadEnds(idea) {
  const deadEnds = idea?.investigation?.forum?.dead_end_questions || [];
  if (deadEnds.length === 0) return '(none)';

  const territories = idea?.investigation?.coordinator_decisions?.initial?.territories || [];
  return deadEnds
    .map((d) => {
      const territory = territories.find((t) => (t.id || t.territory_id) === d.territory_id);
      const territoryName = territory?.name || d.territory_id || '?';
      return `[${territoryName}] (originating_persona: ${d.originating_persona_id || '?'}) — ${d.outcome_summary}`;
    })
    .join('\n');
}

module.exports = {
  DIVIDER,
  renderSteerCard,
  renderSynthesis,
  renderQuestionLandscape,
  renderDeadEnds,
};
