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
    // Property order matters: tool-call JSON is generated top-to-bottom, so if the
    // model runs long the most expendable field (the prose `report`) is the one
    // that gets truncated, not the structured payload.
    required: ['headline_findings', 'sections', 'open_tensions', 'report'],
    additionalProperties: false,
    properties: {
      headline_findings: {
        type: 'array',
        minItems: 3,
        maxItems: 5,
        items: { type: 'string', minLength: 1 },
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
                  label: { type: 'string', description: 'Persona display name (the human-readable name, not an id slug) or a short natural-language descriptor of the side. Never use internal identifiers like p_008 or role slugs like "skeptic".' },
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
      open_tensions: {
        type: 'array',
        maxItems: 3,
        items: { type: 'string', minLength: 1 },
      },
      // `report` is intentionally last in the schema so it absorbs any truncation
      // if the tool call hits max_tokens. The structured fields above are the
      // primary deliverable; the prose summarises them, it does not duplicate them.
      report: {
        type: 'string',
        minLength: 100,
        maxLength: 3500,
        description:
          'Concise opinionated prose, max ~400 words. Lead with the gist. Do not re-enumerate sections, tension_points, or key_references — the structured fields above carry that detail. Use this field for a tight overall stance and the connective tissue between sections.',
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
        // source_title is required by RESEARCHER_REPORT_JSON_SCHEMA (post-fix);
        // older runs without it fall back to the URL so the synth still has
        // something to render.
        refs.push({
          url: f.source_url,
          title: (f.source_title || f.source_url).slice(0, 120),
          content: (f.summary || f.content || '').slice(0, 200),
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
    // 10000 is a safety net, not a budget. With the structured fields emitted
    // first and the prose `report` capped at ~400 words / 3500 chars, a typical
    // synthesis lands well under this. We previously ran at 6500 and saw
    // stop_reason: 'max_tokens' truncate the structured payload silently.
    maxTokens: 10_000,
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
    headline_findings: coerceArray(payload.headline_findings) ?? [],
    open_tensions: coerceArray(payload.open_tensions),
    question_landscape: coerceArray(payload.question_landscape),
    dead_end_summary: payload.dead_end_summary || null,
    sections: coerceArray(payload.sections),
    tension_points: coerceArray(payload.tension_points),
    key_references: coerceArray(payload.key_references),
    next_pass_proposals: coerceArray(payload.next_pass_proposals),
    usage,
  };
}

// Sonnet occasionally emits an array-typed tool field as a JSON-encoded string
// (most often when the response is near the max_tokens ceiling). Recover by
// parsing the string; if the result isn't an array, fall back to null so the
// renderer's `Array.isArray` guards take the empty path instead of crashing on
// `.map`. Returns null for any non-array, non-parseable input.
function coerceArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to null
    }
  }
  return null;
}

module.exports = {
  runSynthesizer,
  renderFindings,
  renderFindingsText,
};
