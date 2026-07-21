'use strict';

const { runStructuredCall } = require('../anthropic');
const { BREADTH_AREAS } = require('./prompts');
const { appendLog } = require('../storage');

// Realized-breadth metric (validated as a throwaway in issue #26): cluster the
// synthesis findings into distinct areas of inquiry and report how many there
// are. The count discriminates broad from narrow runs and is decoupled from
// finding volume in a way that lexical word-overlap and raw counts are not.

const REPORT_AREAS_TOOL = {
  name: 'report_areas',
  description: 'Report the distinct areas of inquiry the findings cover.',
  input_schema: {
    type: 'object',
    required: ['areas'],
    additionalProperties: false,
    properties: {
      areas: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['label', 'finding_indices'],
          additionalProperties: false,
          properties: {
            label: { type: 'string', minLength: 1, description: 'Short name for the area.' },
            finding_indices: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Indices (from the numbered list) of findings in this area.',
            },
          },
        },
      },
    },
  },
};

// Pool every finding the synthesizer produced: the per-section key findings plus
// the headline findings. Findings only — questions were deliberately excluded
// (noisier, and absent on older runs); see #26.
function collectFindings(synthesis) {
  if (!synthesis) return [];
  const fromSections = (synthesis.sections || []).flatMap((s) =>
    (s.key_findings || []).map((k) => (k && k.content) || '').filter(Boolean)
  );
  const headlines = (synthesis.headline_findings || []).filter(
    (h) => typeof h === 'string' && h.length
  );
  return [...fromSections, ...headlines];
}

// Shannon entropy over area sizes, normalised to 0..1 by log2(n). 1 = perfectly
// even areas; low = one area swallows most findings (narrower than the count
// alone suggests).
function evennessOf(sizes) {
  const nonzero = sizes.filter((n) => n > 0);
  if (nonzero.length < 2) return 0;
  const total = nonzero.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const c of nonzero) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return +(h / Math.log2(nonzero.length)).toFixed(2);
}

// The model occasionally double-encodes the forced-tool payload: input.areas
// arrives as a JSON string holding either [ ... ] or { "areas": [ ... ] }
// (observed in #26). Unwrap defensively before trusting the array.
function extractAreas(toolUse) {
  let input = toolUse && toolUse.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      /* leave */
    }
  }
  let areas = input && input.areas;
  if (typeof areas === 'string') {
    try {
      const parsed = JSON.parse(areas);
      areas = Array.isArray(parsed) ? parsed : parsed && parsed.areas;
    } catch {
      /* leave */
    }
  }
  return Array.isArray(areas) ? areas : null;
}

/**
 * Compute the realized-breadth score for a completed synthesis. Single model
 * call (claude-sonnet-5 in the pipeline). Returns null — never throws — when
 * there is nothing to measure (fewer than 2 findings) or the call comes back
 * malformed/truncated; breadth is a nice-to-have layered on top of a synthesis
 * that already succeeded, so it must never fail the run.
 */
async function runBreadthAnalysis({ client, idea, model, budget, synthesis, bus }) {
  const findings = collectFindings(synthesis);
  if (findings.length < 2) return null;

  const numbered = findings.map((t, i) => `[${i}] ${t}`).join('\n\n');

  await appendLog(idea.id, 'breadth', {
    kind: 'request',
    payload: { finding_count: findings.length },
  });

  const { response, toolUse, usage, truncated } = await runStructuredCall({
    client,
    model,
    budget,
    system: BREADTH_AREAS,
    maxTokens: 4000,
    messages: [{ role: 'user', content: `Findings:\n\n${numbered}` }],
    tools: [REPORT_AREAS_TOOL],
    forceTool: 'report_areas',
  });

  const areas = extractAreas(toolUse);
  if (!areas) {
    await appendLog(idea.id, 'breadth', {
      kind: 'skipped',
      payload: { reason: toolUse ? 'malformed_payload' : 'tool_use_missing', truncated },
    });
    return null;
  }

  const cleaned = areas
    .map((a) => ({
      label: (a && a.label) || '',
      finding_indices: Array.isArray(a && a.finding_indices) ? a.finding_indices : [],
    }))
    .filter((a) => a.label);
  const sizes = cleaned.map((a) => a.finding_indices.length);
  const result = {
    n_areas: cleaned.length,
    evenness: evennessOf(sizes),
    areas: cleaned,
    model,
    computed_at: new Date().toISOString(),
  };

  await appendLog(idea.id, 'breadth', {
    kind: 'response',
    payload: { stop_reason: response.stop_reason, usage, n_areas: result.n_areas },
  });
  if (bus) {
    bus.emit('breadth.computed', { n_areas: result.n_areas, evenness: result.evenness });
  }

  return result;
}

module.exports = {
  runBreadthAnalysis,
  collectFindings,
  evennessOf,
  extractAreas,
};
