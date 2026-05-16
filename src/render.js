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

function countSubQuestions(idea) {
  const initial = idea?.investigation?.coordinator_decisions?.initial?.sub_questions || [];
  const spawn = idea?.investigation?.coordinator_decisions?.spawn?.sub_questions || [];
  return initial.length + spawn.length;
}

function renderSteerCard(idea) {
  const capturedAt = idea.captured_at || '';
  const topic = truncate(idea.raw_capture || '', 72);
  const synthesis = idea?.investigation?.synthesis || {};
  const headline = (synthesis.headline_findings || []).slice(0, 5);
  const tensions = (synthesis.open_tensions || []).slice(0, 3);
  const budget = idea?.investigation?.budget || {};

  const lines = [
    DIVIDER,
    `${capturedAt}  ·  ${topic}`,
    `investigation: ${countSubQuestions(idea)} sub-questions · ${countMoves(idea)} moves · ${budget.used_total_tokens || 0} tokens`,
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

module.exports = {
  DIVIDER,
  renderSteerCard,
  renderSynthesis,
};
