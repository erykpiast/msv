'use strict';

const { runStructuredCall } = require('../anthropic');
const { SYNTHESIZER } = require('./prompts');
const { appendLog } = require('../storage');

const EMIT_SYNTHESIS_TOOL = {
  name: 'emit_synthesis',
  description:
    'Emit the user-facing report, headline_findings, open_tensions, question_landscape, and dead_end_summary.',
  input_schema: {
    type: 'object',
    required: ['headline_findings', 'open_tensions', 'report'],
    additionalProperties: false,
    properties: {
      headline_findings: {
        type: 'array',
        minItems: 3,
        maxItems: 5,
        items: { type: 'string', minLength: 1 },
      },
      open_tensions: {
        type: 'array',
        maxItems: 3,
        items: { type: 'string', minLength: 1 },
      },
      report: {
        type: 'string',
        minLength: 200,
        description: 'Opinionated prose, ~800–1500 words.',
      },
      question_landscape: {
        type: 'array',
        description: 'Per-territory question landscape.',
        items: {
          type: 'object',
          properties: {
            territory_name: { type: 'string' },
            territory_id: { type: 'string' },
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string' },
                  origin: { type: 'string' },
                  provenance_note: { type: 'string' },
                },
              },
            },
          },
        },
      },
      dead_end_summary: {
        type: 'string',
        description: '1–3 sentences about what was pursued and not found.',
      },
    },
  },
};

function renderForum(forum) {
  return (forum.nodes || [])
    .map((node) => {
      const reactions = (node.reactions || [])
        .map(
          (r) =>
            `    · ${r.by_persona_id} ${r.type} conf=${r.confidence} — ${r.content}`
        )
        .join('\n');
      return [
        `${node.node_id} [rank ${node.survival_rank}] wg=${node.working_group_id} agg_conf=${node.aggregate_confidence.toFixed(2)}${node.has_open_question ? ' OPEN_QUESTION' : ''}${node.contradiction_with_node_id ? ` contradicts=${node.contradiction_with_node_id}` : ''}`,
        `  claim: ${node.content}`,
        reactions ? `  reactions:\n${reactions}` : '  reactions: (none)',
      ].join('\n');
    })
    .join('\n\n');
}

function renderPersonas(personas) {
  return personas
    .map((p) => `- ${p.id} · ${p.name} — tradition: ${p.tradition}; stance: ${p.stance}`)
    .join('\n');
}

function renderQuestionLandscape(pairDebates) {
  if (!Array.isArray(pairDebates) || pairDebates.length === 0) return '(not available)';
  return pairDebates
    .filter((d) => d.territory_id && (d.aligned_questions || []).length > 0)
    .map((d) => {
      const qList = (d.aligned_questions || [])
        .map((aq) => `  - [${aq.origin}] ${aq.question}`)
        .join('\n');
      return `Territory ${d.territory_id}:\n${qList}`;
    })
    .join('\n\n');
}

function renderDeadEnds(forum) {
  const deadEnds = forum.dead_end_questions || [];
  if (deadEnds.length === 0) return '(none)';
  return deadEnds
    .map((d) => `- [${d.territory_id}] aligned_id=${d.aligned_id}: ${d.outcome_summary}`)
    .join('\n');
}

async function runSynthesizer({ client, idea, model, budget, forum, personas, pairDebates = [], bus }) {
  const forumDump = renderForum(forum);
  const personaDump = renderPersonas(personas);
  const questionLandscape = renderQuestionLandscape(pairDebates);
  const deadEnds = renderDeadEnds(forum);

  await appendLog(idea.id, 'synthesizer', {
    kind: 'request',
    payload: {
      node_count: forum.nodes?.length || 0,
      dead_end_count: (forum.dead_end_questions || []).length,
      persona_count: personas.length,
    },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system: SYNTHESIZER,
    maxTokens: 5000,
    messages: [
      {
        role: 'user',
        content: [
          `Original topic:\n${idea.raw_capture}`,
          `\nPersona roster (for attribution):\n${personaDump}`,
          `\nForum (ranked nodes):\n${forumDump}`,
          `\nQuestion landscape (what each territory investigated):\n${questionLandscape}`,
          `\nDead-end questions (research avenues with no useful findings):\n${deadEnds}`,
          `\nProduce the final report. Invoke emit_synthesis.`,
        ].join('\n'),
      },
    ],
    tools: [EMIT_SYNTHESIS_TOOL],
    forceTool: 'emit_synthesis',
    // The synthesizer consumes the full forum, persona roster, and question
    // landscape in one shot, then emits a 5k-token tool call. Observed wall-clock
    // is 60–120s; the default 60s SDK cap was timing out on rich investigations.
    timeoutMs: 180_000,
  });

  const payload = toolUse.input;

  await appendLog(idea.id, 'synthesizer', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      headline_count: (payload.headline_findings || []).length,
      report_chars: (payload.report || '').length,
    },
  });

  if (bus) bus.emit('synthesizer.done', {
    headline_count: (payload.headline_findings || []).length,
    tension_count: (payload.open_tensions || []).length,
    has_question_landscape: !!(payload.question_landscape),
    has_dead_end_summary: !!(payload.dead_end_summary),
  });

  return {
    produced_at: new Date().toISOString(),
    report: payload.report,
    headline_findings: payload.headline_findings,
    open_tensions: payload.open_tensions,
    question_landscape: payload.question_landscape || null,
    dead_end_summary: payload.dead_end_summary || null,
    usage,
  };
}

module.exports = {
  runSynthesizer,
};
