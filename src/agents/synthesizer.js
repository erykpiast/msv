const { runStructuredCall } = require('../anthropic');
const { SYNTHESIZER } = require('./prompts');
const { appendLog } = require('../storage');

const EMIT_SYNTHESIS_TOOL = {
  name: 'emit_synthesis',
  description:
    'Emit the user-facing report along with headline_findings (3–5 items) and open_tensions (≤3 items).',
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
        description:
          'Opinionated prose of roughly 800–1500 words. Structured paragraphs, not heavy bullet lists.',
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
        `${node.node_id} [rank ${node.survival_rank}] working_group=${node.working_group_id} agg_conf=${node.aggregate_confidence.toFixed(
          2
        )}${
          node.has_open_question ? ' OPEN_QUESTION' : ''
        }${
          node.contradiction_with_node_id
            ? ` contradicts=${node.contradiction_with_node_id}`
            : ''
        }`,
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

async function runSynthesizer({ client, idea, model, budget, forum, personas }) {
  const forumDump = renderForum(forum);
  const personaDump = renderPersonas(personas);

  await appendLog(idea.id, 'synthesizer', {
    kind: 'request',
    payload: {
      node_count: forum.nodes?.length || 0,
      persona_count: personas.length,
    },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system: SYNTHESIZER,
    maxTokens: 4000,
    messages: [
      {
        role: 'user',
        content: `Original topic:\n${idea.raw_capture}\n\nPersona roster (for attribution context):\n${personaDump}\n\nForum (ranked nodes):\n${forumDump}\n\nProduce the final report. Invoke emit_synthesis.`,
      },
    ],
    tools: [EMIT_SYNTHESIS_TOOL],
    forceTool: 'emit_synthesis',
  });

  const payload = toolUse.input;

  await appendLog(idea.id, 'synthesizer', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      headline_count: payload.headline_findings.length,
      report_chars: payload.report.length,
    },
  });

  return {
    produced_at: new Date().toISOString(),
    report: payload.report,
    headline_findings: payload.headline_findings,
    open_tensions: payload.open_tensions,
    usage,
  };
}

module.exports = {
  runSynthesizer,
};
