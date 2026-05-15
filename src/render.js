function renderSteerCard(idea) {
  return [
    '---',
    `Idea: ${idea.id}`,
    `Captured: ${idea.captured_at}`,
    `Status: ${idea.status}`,
    `Topic: ${idea.raw_capture}`,
    'Actions: [r]ead [d]eeper [k]ill [n]otes [q]uit',
    '---',
  ].join('\n');
}

function renderSynthesis(idea) {
  if (!idea.investigation || !idea.investigation.synthesis) {
    return 'No synthesis available yet.';
  }

  const { headline_findings, open_tensions, report } = idea.investigation.synthesis;
  return [
    '=== Synthesis ===',
    '',
    'Headline findings:',
    ...(headline_findings || []).map((item, index) => `${index + 1}. ${item}`),
    '',
    'Open tensions:',
    ...(open_tensions || []).map((item, index) => `${index + 1}. ${item}`),
    '',
    report || '',
  ].join('\n');
}

module.exports = {
  renderSteerCard,
  renderSynthesis,
};
