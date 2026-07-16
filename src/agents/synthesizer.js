'use strict';

const { runStructuredStreamingCall } = require('../anthropic');
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

  const { response, toolUse, usage, truncated } = await runStructuredStreamingCall({
    client,
    model,
    budget,
    system: SYNTHESIZER,
    // thinking/effort dropped: adaptive thinking + xhigh effort was causing
    // the model to drift into XML-style `<parameter name="...">`
    // pseudo-tool-call syntax inside the array fields (see
    // logs/synthesizer.jsonl `malformed_payload` entries for the 175a40f6
    // run — reproduced twice with this config).
    // thinking: { type: 'adaptive' },
    // effort: 'xhigh',
    // Streamed so the SDK's non-streaming timeout ceiling doesn't cap how high
    // maxTokens can go. Raised from 10,000 after observing stop_reason:
    // 'max_tokens' silently truncate the structured payload at that ceiling.
    maxTokens: 32_000,
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
    // landscape in one shot, then emits up to a 32k-token tool call with xhigh
    // effort + adaptive thinking on Opus. 180_000 (195s/210s attempt/wall-clock
    // caps) was tuned for the prior 10k-token Haiku call and was observed
    // timing out under the new profile; raised while we find the real ceiling.
    timeoutMs: 600_000,
  });

  // toolUse is null when the call hit max_tokens before emitting the
  // emit_synthesis block at all; fall back to an empty payload so the
  // coerceArray/|| null fallbacks below produce a well-formed truncated result
  // rather than crashing on `.input` of null.
  const payload = toolUse?.input || {};

  const shapeIssues = diagnosePayloadShape(payload);

  await appendLog(idea.id, 'synthesizer', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      truncated,
      usage,
      headline_count: (payload.headline_findings || []).length,
      report_chars: (payload.report || '').length,
      section_count: (payload.sections || []).length,
      shape_issues: shapeIssues.length ? shapeIssues : undefined,
    },
  });

  // A well-formed tool_use response (not caught by the max_tokens truncation
  // check) can still carry a degenerate payload — e.g. the model closes out
  // the call normally but writes a stray string into an array field. That
  // previously surfaced as silent empty/null results with no trace of what
  // the model actually emitted. Log the raw shape separately so a future
  // occurrence is diagnosable from the log alone, without needing to infer
  // "648 is a string length, not an array length" after the fact.
  if (shapeIssues.length) {
    await appendLog(idea.id, 'synthesizer', {
      kind: 'malformed_payload',
      payload: { stop_reason: response.stop_reason, truncated, usage, issues: shapeIssues },
    });
  }

  if (bus) bus.emit('synthesizer.done', {
    headline_count: (payload.headline_findings || []).length,
    tension_count: (payload.open_tensions || []).length,
    has_question_landscape: !!(payload.question_landscape),
    has_dead_end_summary: !!(payload.dead_end_summary),
    section_count: (payload.sections || []).length,
    truncated,
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
    truncated,
  };
}

// Sonnet occasionally emits an array-typed tool field as a JSON-encoded string
// (most often when the response is near the max_tokens ceiling). Recover by
// parsing the string; if the result isn't an array, fall back to null so the
// renderer's `Array.isArray` guards take the empty path instead of crashing on
// `.map`. Returns null for any non-array, non-parseable input.
const EXPECTED_ARRAY_FIELDS = [
  'headline_findings',
  'sections',
  'open_tensions',
  'question_landscape',
  'tension_points',
  'key_references',
  'next_pass_proposals',
];

function previewValue(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return (str || '').slice(0, 200);
}

// Anthropic doesn't enforce the tool's JSON schema on the model's output, so a
// field can come back the wrong type (e.g. a stray string where an array was
// required) even on a clean, non-truncated tool_use response. Record what was
// actually there — type + short preview — for every field that doesn't match
// what emit_synthesis's schema requires, so a future occurrence is
// diagnosable from the log instead of needing to reverse-engineer bogus
// `.length` counts.
function diagnosePayloadShape(payload) {
  const issues = [];
  for (const field of EXPECTED_ARRAY_FIELDS) {
    const value = payload[field];
    if (value === undefined || Array.isArray(value)) continue;
    issues.push({ field, expected: 'array', actual_type: typeof value, preview: previewValue(value) });
  }
  const report = payload.report;
  if (report !== undefined && (typeof report !== 'string' || report.length < 100)) {
    issues.push({
      field: 'report',
      expected: 'string (minLength 100)',
      actual_type: typeof report,
      preview: previewValue(report),
    });
  }
  return issues;
}

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
