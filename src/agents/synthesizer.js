'use strict';

const { runStructuredCall } = require('../anthropic');
const { SYNTHESIZER } = require('./prompts');
const { appendLog } = require('../storage');

const EMIT_SYNTHESIS_TOOL = {
  name: 'emit_synthesis',
  description:
    'Emit the structured report: sections with findings, tension points, key references, and next-pass proposals.',
  input_schema: {
    type: 'object',
    required: ['headline_findings', 'open_tensions', 'report', 'sections'],
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
      sections: {
        type: 'array',
        description: 'Broad thematic areas, each with key findings. List broad areas first, then the most specific/surprising findings within each.',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['area_title', 'area_summary', 'key_findings'],
          additionalProperties: false,
          properties: {
            area_title: { type: 'string' },
            area_summary: { type: 'string', description: '2–3 sentences framing the area.' },
            key_findings: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: {
                type: 'object',
                required: ['content', 'confidence'],
                additionalProperties: false,
                properties: {
                  content: { type: 'string', description: 'One finding. Use inline markdown links [title](url) to cite sources from the provided reference list.' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
          },
        },
      },
      tension_points: {
        type: 'array',
        description: 'The sharpest disagreements between agents or working groups in this investigation.',
        maxItems: 4,
        items: {
          type: 'object',
          required: ['title', 'description', 'sides'],
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            description: { type: 'string', description: 'What the crux of the disagreement is, in 1–3 sentences.' },
            sides: {
              type: 'array',
              minItems: 2,
              items: {
                type: 'object',
                required: ['label', 'position'],
                additionalProperties: false,
                properties: {
                  label: { type: 'string', description: 'Persona name, working group id, or short descriptor.' },
                  position: { type: 'string', description: 'Their position in one sentence.' },
                },
              },
            },
            resolution: { type: ['string', 'null'], description: 'How the tension resolved, or null if genuinely unresolved.' },
          },
        },
      },
      key_references: {
        type: 'array',
        description: 'The most relevant sources cited in the investigation. Only include sources that materially shaped the findings.',
        maxItems: 8,
        items: {
          type: 'object',
          required: ['url', 'title', 'summary', 'key_observations'],
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string', description: '1–2 sentences on what this source says.' },
            key_observations: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string' },
            },
          },
        },
      },
      next_pass_proposals: {
        type: 'array',
        description: 'Specific topics worth investigating in a follow-up pass. Order by relevance, most promising first.',
        minItems: 3,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['topic', 'rationale'],
          additionalProperties: false,
          properties: {
            topic: { type: 'string' },
            rationale: { type: 'string', description: '1–2 sentences on why this is worth the next pass.' },
            territory_hint: { type: 'string', description: 'Which territory this relates to, if applicable.' },
          },
        },
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

const QUALITY_ORDER = { primary: 0, secondary: 1, indirect: 2 };

function renderFindings(pairDebates) {
  const seen = new Set();
  const refs = [];
  for (const pd of (pairDebates || [])) {
    for (const rr of (pd.researcher_reports || [])) {
      for (const f of (rr.findings || [])) {
        if (!f.source_url || seen.has(f.source_url)) continue;
        seen.add(f.source_url);
        refs.push({
          url: f.source_url,
          title: (f.source_title || f.source_url).slice(0, 120),
          content: (f.content || '').slice(0, 200),
          quality: f.quality || 'secondary',
        });
      }
    }
  }
  refs.sort((a, b) => (QUALITY_ORDER[a.quality] ?? 3) - (QUALITY_ORDER[b.quality] ?? 3));
  return refs.slice(0, 30);
}

function renderFindingsText(refs) {
  if (refs.length === 0) return '(no source URLs in this run)';
  return refs
    .map((r) => `- ${r.title} — ${r.url} (quality: ${r.quality})\n  ${r.content}`)
    .join('\n');
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
  const findingRefs = renderFindings(pairDebates);
  const findingsDump = renderFindingsText(findingRefs);

  await appendLog(idea.id, 'synthesizer', {
    kind: 'request',
    payload: {
      node_count: forum.nodes?.length || 0,
      dead_end_count: (forum.dead_end_questions || []).length,
      persona_count: personas.length,
      finding_ref_count: findingRefs.length,
    },
  });

  const { response, toolUse, usage } = await runStructuredCall({
    client,
    model,
    budget,
    system: SYNTHESIZER,
    maxTokens: 6500,
    messages: [
      {
        role: 'user',
        content: [
          `Original topic:\n${idea.raw_capture}`,
          `\nPersona roster (for attribution):\n${personaDump}`,
          `\nForum (ranked nodes):\n${forumDump}`,
          `\nQuestion landscape (what each territory investigated):\n${questionLandscape}`,
          `\nDead-end questions (research avenues with no useful findings):\n${deadEnds}`,
          `\nSource reference list (cite as inline markdown links in findings):\n${findingsDump}`,
          `\nProduce the final report. Invoke emit_synthesis.`,
        ].join('\n'),
      },
    ],
    tools: [EMIT_SYNTHESIS_TOOL],
    forceTool: 'emit_synthesis',
    // The synthesizer consumes the full forum, persona roster, and question
    // landscape in one shot, then emits a 6.5k-token tool call. Observed wall-clock
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
      section_count: (payload.sections || []).length,
    },
  });

  if (bus) bus.emit('synthesizer.done', {
    headline_count: (payload.headline_findings || []).length,
    tension_count: (payload.open_tensions || []).length,
    has_question_landscape: !!(payload.question_landscape),
    has_dead_end_summary: !!(payload.dead_end_summary),
    section_count: (payload.sections || []).length,
  });

  return {
    produced_at: new Date().toISOString(),
    report: payload.report,
    headline_findings: payload.headline_findings,
    open_tensions: payload.open_tensions,
    question_landscape: payload.question_landscape || null,
    dead_end_summary: payload.dead_end_summary || null,
    sections: payload.sections || null,
    tension_points: payload.tension_points || null,
    key_references: payload.key_references || null,
    next_pass_proposals: payload.next_pass_proposals || null,
    usage,
  };
}

module.exports = {
  runSynthesizer,
  renderFindings,
  renderFindingsText,
};
