'use strict';

/**
 * Joint Researcher sub-agent — bounded ReAct loop using web_search + web_fetch.
 * See spec §6.5 for the full design.
 */

const {
  runStructuredCall,
  webSearchTool,
  webFetchTool,
  tokenUsage,
  extractWebSearches,
} = require('../anthropic');
const { RESEARCHER_TOOL_BUDGET, RESEARCHER_TURN_BUDGET, RESEARCHER_REPORT_JSON_SCHEMA } = require('../moves');
const { RESEARCHER } = require('./prompts');
const { appendLog } = require('../storage');
const apiQueue = require('../api_queue');

const EMIT_RESEARCHER_REPORT_TOOL = {
  name: 'emit_researcher_report',
  description: 'Emit your final structured researcher report.',
  input_schema: RESEARCHER_REPORT_JSON_SCHEMA,
};

async function runJointResearcher({
  client,
  idea,
  model,
  budget,
  alignedQuestion,
  territory,
  personaLenses = [],
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

  while (turnIndex < RESEARCHER_TURN_BUDGET) {
    const forceEmit =
      usedToolCalls >= RESEARCHER_TOOL_BUDGET || turnIndex === RESEARCHER_TURN_BUDGET - 1;

    const params = {
      model,
      system: RESEARCHER,
      max_tokens: 4000,
      messages,
      tools,
    };

    if (forceEmit) {
      params.tool_choice = { type: 'tool', name: 'emit_researcher_report' };
      // Append a user prompt only if budget exhausted (not just last turn).
      if (usedToolCalls >= RESEARCHER_TOOL_BUDGET) {
        messages.push({
          role: 'user',
          content:
            'Tool budget exhausted; emit your researcher_report now via emit_researcher_report based on what you have.',
        });
      }
    }

    const response = await apiQueue.enqueue(() => client.messages.create(params));
    const usage = tokenUsage(response);
    if (budget) {
      budget.used_executor_calls = (budget.used_executor_calls || 0) + 1;
      budget.used_total_tokens = (budget.used_total_tokens || 0) + usage.total;
    }

    // Count server-side tool invocations (web_search, web_fetch) toward researcher budget.
    const serverToolUses = (response.content || []).filter((b) => b.type === 'server_tool_use');
    usedToolCalls += serverToolUses.length;
    if (budget) {
      budget.used_researcher_tool_calls =
        (budget.used_researcher_tool_calls || 0) + serverToolUses.length;
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

    // Check for the final report tool call.
    const reportBlock = (response.content || []).find(
      (b) => b.type === 'tool_use' && b.name === 'emit_researcher_report'
    );

    if (reportBlock) {
      await appendLog(idea.id, logFile, {
        kind: 'emit',
        payload: {
          outcome: reportBlock.input?.outcome,
          finding_count: (reportBlock.input?.findings || []).length,
        },
      });
      return reportBlock.input;
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

module.exports = { runJointResearcher };
