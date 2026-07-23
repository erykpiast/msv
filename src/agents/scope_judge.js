'use strict';

const { runStructuredCall } = require('../anthropic');
const { SCOPE_JUDGE } = require('./prompts');
const { appendLog } = require('../storage');
const { SCOPE_JUDGE_MODEL } = require('../models');

const REPORT_SCOPE_TOOL = {
  name: 'report_scope',
  description: 'Report the requested scope of the topic on a 1-10 scale.',
  input_schema: {
    type: 'object',
    required: ['score'],
    additionalProperties: false,
    properties: {
      score: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description:
          '1 = narrow/specific question, 10 = explicit comprehensive/exhaustive scope request.',
      },
      rationale: { type: 'string' },
    },
  },
};

// Bucket table mapping the judge's 1-10 requested-scope score to a concrete
// territory-count target T for coordinator.js. Kept in code (not the prompt)
// so it's a tunable independent of the judge's own reasoning — see #40 / #27's
// calibration data, which found T=10 sufficient for the top bucket (the
// prototype's T=15 over-scaled).
const SCORE_TO_T = [
  { maxScore: 3, target: 3 }, // narrow, unscoped question
  { maxScore: 6, target: 5 }, // no explicit scope signal
  { maxScore: 10, target: 10 }, // explicit "comprehensive" / "map the state of the art" request
];

// Safe default territory target (the no-signal bucket's value). Used both when
// the judge call is unrecoverable (truncated with no tool_use) and as the
// fallback for a missing or out-of-range score, so a truncated-but-present
// report_scope call defaults to the middle bucket instead of silently landing
// on the largest one — never worth failing or over-scaling the whole pipeline
// over a single cheap classifier call.
const FALLBACK_TARGET = 5;

function bucketScoreToTerritoryTarget(score) {
  const bucket = SCORE_TO_T.find(({ maxScore }) => score <= maxScore);
  return bucket ? bucket.target : FALLBACK_TARGET;
}

async function runScopeJudge({ client, idea, budget }) {
  await appendLog(idea.id, 'scope_judge', { kind: 'request', payload: {} });

  const messages = [
    {
      role: 'user',
      content: `Topic: ${idea.raw_capture}\n\nInvoke report_scope.`,
    },
  ];

  const { toolUse, truncated, usage } = await runStructuredCall({
    client,
    model: SCOPE_JUDGE_MODEL,
    budget,
    system: SCOPE_JUDGE,
    maxTokens: 300,
    messages,
    tools: [REPORT_SCOPE_TOOL],
    forceTool: 'report_scope',
  });

  if (!toolUse) {
    await appendLog(idea.id, 'scope_judge', {
      kind: 'truncated_fallback',
      payload: { target: FALLBACK_TARGET, stop_reason: truncated ? 'max_tokens' : null },
    });
    return { score: null, target: FALLBACK_TARGET, usage };
  }

  const score = toolUse.input.score;
  const target = bucketScoreToTerritoryTarget(score);

  await appendLog(idea.id, 'scope_judge', {
    kind: 'response',
    payload: { score, target, usage },
  });

  return { score, target, usage };
}

module.exports = { runScopeJudge, bucketScoreToTerritoryTarget, SCORE_TO_T, FALLBACK_TARGET };
