'use strict';

/**
 * Joint Researcher sub-agent — bounded ReAct loop using web_search + web_fetch.
 * See spec §6.5 for the full design.
 */

const {
  runStructuredCall,
  webSearchTool,
  webFetchTool,
  extractWebSearches,
} = require('../anthropic');
const { RESEARCHER_TOOL_BUDGET, RESEARCHER_TURN_BUDGET, RESEARCHER_REPORT_JSON_SCHEMA } = require('../moves');
const { RESEARCHER } = require('./prompts');
const { appendLog } = require('../storage');

const EMIT_RESEARCHER_REPORT_TOOL = {
  name: 'emit_researcher_report',
  description: 'Emit your final structured researcher report.',
  input_schema: RESEARCHER_REPORT_JSON_SCHEMA,
};

// Researcher turns chain server-tool calls (web_search + web_fetch) inside a
// single API turn. A typical successful turn observed in production takes
// 90-150s of Anthropic-internal time. The default 60s SDK timeout caused 23 of
// 25 researcher calls in one investigation to time out, yielding pipeline-wide
// dead-ends. 180s comfortably covers the observed envelope with headroom.
const RESEARCHER_TIMEOUT_MS = 180_000;

// Coerce a tool-input field that should be an array. The Anthropic tool-use API
// does not enforce input_schema shape, so the model sometimes returns a JSON
// string instead of an array (observed in production: a 12,163-char stringified
// findings array crashed downstream .map). Try one JSON.parse pass; if it still
// isn't an array, give up and return null.
function coerceArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return null;
}

async function normalizeReport(rawInput, { ideaId, logFile, alignedId }) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const findingsRaw = input.findings;
  const traceRaw = input.search_trace;

  const findings = coerceArray(findingsRaw);
  const searchTrace = coerceArray(traceRaw);

  const issues = [];
  if (findings === null) issues.push('findings');
  if (searchTrace === null) issues.push('search_trace');

  if (issues.length > 0) {
    await appendLog(ideaId, logFile, {
      kind: 'malformed_emit',
      payload: {
        aligned_id: alignedId,
        fields: issues,
        findings_type: Array.isArray(findingsRaw) ? 'array' : typeof findingsRaw,
        search_trace_type: Array.isArray(traceRaw) ? 'array' : typeof traceRaw,
      },
    });
  }

  // Force dead_end when findings are unrecoverable — downstream consumers gate
  // on findings.length, and an empty array with outcome=useful would misreport
  // the territory's state.
  const outcome = findings === null ? 'dead_end' : input.outcome;

  return {
    outcome,
    findings: findings || [],
    search_trace: searchTrace || [],
  };
}

async function runJointResearcher({
  client,
  idea,
  model,
  budget,
  alignedQuestion,
  territory,
  personaLenses = [],
  bus,
}) {
  const aqId = alignedQuestion.aligned_id;
  const territoryId = territory.id || territory.territory_id;
  const logFile = `pair-${territoryId}-researcher-${aqId}`;

  const tools = [
    webSearchTool({ maxUses: 4 }),
    webFetchTool({ maxUses: 6 }),
    EMIT_RESEARCHER_REPORT_TOOL,
  ];

  const lensesText =
    personaLenses.length > 0
      ? `The following persona lenses are investigating this question: ${personaLenses.join(', ')}.`
      : '';

  const messages = [
    {
      role: 'user',
      content: [
        `Research question: ${alignedQuestion.question}`,
        `Territory: ${territory.name} — ${territory.description}`,
        lensesText,
        '',
        'Run your research loop. When done, emit your researcher_report via emit_researcher_report.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];

  let usedToolCalls = 0;
  let turnIndex = 0;

  await appendLog(idea.id, logFile, {
    kind: 'request',
    payload: { aligned_id: aqId, question: alignedQuestion.question },
  });

  if (bus) bus.emit('wg.researcher.start', {
    territory_id: territoryId,
    aligned_id: aqId,
    question: alignedQuestion.question,
  });

  while (turnIndex < RESEARCHER_TURN_BUDGET) {
    const forceEmit =
      usedToolCalls >= RESEARCHER_TOOL_BUDGET || turnIndex === RESEARCHER_TURN_BUDGET - 1;

    if (forceEmit && usedToolCalls >= RESEARCHER_TOOL_BUDGET) {
      messages.push({
        role: 'user',
        content:
          'Tool budget exhausted; emit your researcher_report now via emit_researcher_report based on what you have.',
      });
    }

    // Errors from runStructuredCall (SDK timeout, wall-clock cap, or
    // forced-tool-missing) propagate out of this function. working_group.js
    // wraps each researcher in withRetry, so a transient timeout gets one
    // retry attempt and only after both fail does the pair surface a dead_end
    // with the captured error.
    const { response, usage } = await runStructuredCall({
      client,
      system: RESEARCHER,
      messages,
      tools,
      forceTool: forceEmit ? 'emit_researcher_report' : undefined,
      model,
      maxTokens: 4000,
      budget,
      timeoutMs: RESEARCHER_TIMEOUT_MS,
    });

    // Count server-side tool invocations (web_search, web_fetch) toward researcher budget.
    const serverToolUses = (response.content || []).filter((b) => b.type === 'server_tool_use');
    usedToolCalls += serverToolUses.length;
    if (budget) {
      budget.used_researcher_tool_calls =
        (budget.used_researcher_tool_calls || 0) + serverToolUses.length;
    }

    for (const block of serverToolUses) {
      if (block.name === 'web_search' && bus) {
        bus.emit('wg.researcher.web_search', {
          territory_id: territoryId,
          aligned_id: aqId,
          query: block.input?.query || '',
        });
      }
      if (block.name === 'web_fetch' && bus) {
        try {
          const url = new URL(block.input?.url || '');
          bus.emit('wg.researcher.web_fetch', {
            territory_id: territoryId,
            aligned_id: aqId,
            url: url.hostname,
          });
        } catch { /* invalid URL, skip */ }
      }
    }

    await appendLog(idea.id, logFile, {
      kind: 'turn',
      payload: {
        turn_index: turnIndex,
        stop_reason: response.stop_reason,
        usage,
        server_tool_calls: serverToolUses.length,
        forced: forceEmit,
      },
    });

    // Per-search observability: log query + result_count + error per web_search
    // call. Result detail is intentionally omitted — researcher logs span many
    // turns and including full result arrays bloats the on-disk footprint.
    // Findings are captured via the model's eventual emit_researcher_report.
    const turnSearches = extractWebSearches(response);
    for (const s of turnSearches) {
      await appendLog(idea.id, logFile, {
        kind: 'web_search',
        payload: {
          turn_index: turnIndex,
          query: s.query,
          result_count: s.results.length,
          error: s.error,
        },
      });
    }

    if (bus) bus.emit('wg.researcher.turn', {
      territory_id: territoryId,
      aligned_id: aqId,
      turn_index: turnIndex,
      stop_reason: response.stop_reason,
      server_tool_calls: serverToolUses.length,
      forced: forceEmit,
    });

    // Check for the final report tool call.
    const reportBlock = (response.content || []).find(
      (b) => b.type === 'tool_use' && b.name === 'emit_researcher_report'
    );

    if (reportBlock) {
      const normalized = await normalizeReport(reportBlock.input, {
        ideaId: idea.id,
        logFile,
        alignedId: aqId,
      });
      await appendLog(idea.id, logFile, {
        kind: 'emit',
        payload: {
          outcome: normalized.outcome,
          finding_count: normalized.findings.length,
        },
      });
      if (bus) bus.emit('wg.researcher.done', {
        territory_id: territoryId,
        aligned_id: aqId,
        outcome: normalized.outcome,
        finding_count: normalized.findings.length,
      });
      return normalized;
    }

    // Append assistant turn and continue.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      break;
    }

    turnIndex += 1;
  }

  // Fallback if the loop exhausted without an emit.
  await appendLog(idea.id, logFile, {
    kind: 'dead_end_fallback',
    payload: { reason: 'no emit_researcher_report produced in loop' },
  });
  return { outcome: 'dead_end', findings: [], search_trace: [] };
}

module.exports = { runJointResearcher, normalizeReport, coerceArray };
