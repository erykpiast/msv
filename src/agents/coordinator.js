'use strict';

const { runStructuredCall } = require('../anthropic');
const { COORDINATOR_TERRITORIES } = require('./prompts');
const { appendLog } = require('../storage');
const { pairDistinctnessScore } = require('../diversity');

const TERRITORY_SCHEMA = {
  type: 'object',
  required: ['name', 'description', 'assigned_pair'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      description: 'Short kebab-case label, e.g. "cognitive-load".',
    },
    description: {
      type: 'string',
      minLength: 1,
      description: '1–2 sentences explaining what terrain this covers.',
    },
    rationale: { type: 'string' },
    assigned_pair: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    },
  },
};

const DEFAULT_TARGET_TERRITORY_COUNT = 5;
const MAX_OVERUSE_RETRIES = 2;

// Schema range is built from the scope judge's target T (see scope_judge.js)
// instead of a hardcoded 3-5 — a tight band around T rather than an exact
// count, since forcing the model to hit T precisely produces worse
// territories than letting it land within +/-1.
function emitTerritoriesTool(targetCount = DEFAULT_TARGET_TERRITORY_COUNT) {
  const minItems = Math.max(2, targetCount - 1);
  const maxItems = targetCount + 1;
  return {
    name: 'emit_territories',
    description: `Emit ${minItems}–${maxItems} broad intellectual territories, each paired with two persona ids.`,
    input_schema: {
      type: 'object',
      required: ['territories'],
      additionalProperties: false,
      properties: {
        territories: {
          type: 'array',
          minItems,
          maxItems,
          items: TERRITORY_SCHEMA,
        },
      },
    },
  };
}

function renderPersonaSummary(personas) {
  return personas
    .map(
      (p) =>
        `- ${p.id} · ${p.name}${p.fixed ? ' (universal — may anchor more than two territories)' : ''}\n  tradition: ${p.tradition}\n  stance: ${p.stance}`
    )
    .join('\n');
}

function renderPairScores(personas) {
  const rows = [];
  for (let i = 0; i < personas.length; i += 1) {
    for (let j = i + 1; j < personas.length; j += 1) {
      const score = pairDistinctnessScore(personas[i], personas[j]);
      rows.push(`${personas[i].id} × ${personas[j].id} → ${score}`);
    }
  }
  return rows.join('\n');
}

// Returns true when the tool call is unusable because it was cut off mid-JSON:
// either the forced tool never made it into the response (toolUse === null),
// or it did appear but its required `territories` array is missing/malformed
// — the same "truncated but present" case researcher.js's normalizeReport
// guards against for `findings`.
function isUnrecoverableTruncation({ toolUse, truncated }) {
  if (!truncated) return false;
  if (!toolUse) return true;
  return !Array.isArray(toolUse.input && toolUse.input.territories);
}

// A truncated retry can still carry the previous attempt's tool_use block,
// which has no paired tool_result and would otherwise be rejected by the API
// (see synthesizer.js's malformed-payload retry for the same fix, and
// discovery.js's cleanedContent handling for the origin of this pattern).
function dropToolUseBlock(content, toolName) {
  return (content || []).filter((block) => !(block.type === 'tool_use' && block.name === toolName));
}

function parseTerritories(toolUse, validIds, personas) {
  return (toolUse.input.territories || [])
    .map((t, index) => {
      const cleanedPair = (t.assigned_pair || []).filter((id) => validIds.has(id));
      if (cleanedPair.length !== 2) return null;
      const score = pairDistinctnessScore(
        personas.find((p) => p.id === cleanedPair[0]),
        personas.find((p) => p.id === cleanedPair[1])
      );
      return {
        id: `t_${String(index + 1).padStart(3, '0')}`,
        territory_id: `t_${String(index + 1).padStart(3, '0')}`,
        name: t.name,
        description: t.description,
        rationale: t.rationale || '',
        assigned_pair: cleanedPair,
        pair_distinctness_score: score,
      };
    })
    .filter(Boolean);
}

// Prompt-only rule (see COORDINATOR_TERRITORIES): topic-specific personas may
// anchor at most two territories; personas marked `fixed` (universal) are
// exempt since the roster is small but the territory count can be high.
function findOverusedPersonas(territories, personas) {
  const fixedIds = new Set(personas.filter((p) => p.fixed).map((p) => p.id));
  const counts = new Map();
  for (const t of territories) {
    for (const id of t.assigned_pair) {
      if (fixedIds.has(id)) counts.set(id, 0);
      else counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count > 2).map(([id]) => id);
}

async function runCoordinatorInitial({
  client,
  idea,
  model,
  budget,
  personas,
  bus,
  targetTerritoryCount = DEFAULT_TARGET_TERRITORY_COUNT,
}) {
  const personaSummary = renderPersonaSummary(personas);
  const pairScores = renderPairScores(personas);
  const validIds = new Set(personas.map((p) => p.id));

  // T <= capacity clamp: a working-group count above what the persona pool
  // can staff can't be assigned distinct pairs, so cap the judge's target
  // before it ever reaches the schema or the prompt. Fixed (universal)
  // personas anchor unlimited territories, so capacity isn't just
  // personas.length — it's driven by the topic-specific personas, each
  // capped at 2 territories (findOverusedPersonas). With no fixed persona
  // available, each territory must pair two topic-specific personas,
  // capping capacity at nonFixedCount (a graph with max degree 2 has at
  // most n edges). With at least one fixed persona available, capacity is
  // nonFixedCount * 2 — but only because COORDINATOR_TERRITORIES and the
  // overuse-retry message below both instruct the model to fall back to a
  // fixed persona once the topic-specific pool is capped out, rather than
  // reusing an over-limit topic-specific persona or pairing two
  // topic-specific personas per territory. Without that fallback, the
  // model's preference for higher-distinctness (often topic-specific ×
  // topic-specific) pairs would burn 2 units of nonFixed capacity per
  // territory instead of 1, blowing this budget well before nonFixedCount * 2
  // territories are emitted.
  const fixedCount = personas.filter((p) => p.fixed).length;
  const nonFixedCount = personas.length - fixedCount;
  const capacity = fixedCount > 0 ? nonFixedCount * 2 : nonFixedCount;
  const effectiveTargetCount = Math.min(targetTerritoryCount, capacity);
  const territoriesTool = emitTerritoriesTool(effectiveTargetCount);

  await appendLog(idea.id, 'coordinator', {
    kind: 'request',
    payload: {
      persona_ids: personas.map((p) => p.id),
      target_territory_count: targetTerritoryCount,
      effective_target_territory_count: effectiveTargetCount,
    },
  });

  const messages = [
    {
      role: 'user',
      content: `Topic: ${idea.raw_capture}\n\nPersona roster:\n${personaSummary}\n\nPair-distinctness scores (higher = more tension):\n${pairScores}\n\nDecompose the topic into approximately ${effectiveTargetCount} broad territories and assign persona pairs. Invoke emit_territories.`,
    },
  ];

  const callArgs = {
    client,
    model,
    budget,
    thinking: { type: 'adaptive' },
    system: COORDINATOR_TERRITORIES(effectiveTargetCount),
    // Bumped from 2400. This call forces a single small structured emit (3-5
    // territories, each a short kebab-case name + 1-2 sentence description +
    // a 2-id pair — nowhere near researcher.js's findings arrays), but it
    // shares the same adaptive-thinking + forced-tool shape that caused
    // silent truncation at persona.js's 1200-token ceiling in production:
    // adaptive thinking competes with the final JSON for the same max_tokens
    // budget, so a tight ceiling can starve the emit even when the emitted
    // payload itself is small. 4000 gives that thinking headroom room without
    // reaching for researcher/synthesizer-sized ceilings this schema doesn't need.
    maxTokens: 4000,
    // Bumped from the 60s default (see api_queue.js's isRetryable fix): this
    // call's adaptive thinking routinely runs close to or past 60s, which
    // left almost no wall-clock budget (default 90s) for the queue to retry
    // a genuine timeout. 120s mirrors discovery.js's precedent for its own
    // thinking-heavy calls.
    timeoutMs: 120_000,
    messages,
    tools: [territoriesTool],
    forceTool: 'emit_territories',
  };

  let result = await runStructuredCall(callArgs);

  // Recoverable max_tokens truncation: give the model exactly one more shot
  // at a shorter, complete emit before treating this early, high-leverage
  // decision as lost. This is a cheap, single-shot call (unlike researcher's
  // multi-turn loop), so a retry here is low-cost; if it also truncates or
  // comes back malformed, we fall through and let the error propagate to
  // run.js, which already classifies/checkpoints thrown errors for resume
  // (see src/commands/run.js's per-idea try/catch) rather than silently
  // continuing with partial/garbage territories.
  if (isUnrecoverableTruncation(result)) {
    await appendLog(idea.id, 'coordinator', {
      kind: 'truncation_retry',
      payload: {
        stop_reason: result.response.stop_reason,
        reason: result.toolUse ? 'territories_missing_or_malformed' : 'tool_use_missing',
      },
    });
    const cleanedContent = dropToolUseBlock(result.response.content, 'emit_territories');
    const retryMessages = [
      ...messages,
      ...(cleanedContent.length > 0 ? [{ role: 'assistant', content: cleanedContent }] : []),
      {
        role: 'user',
        content: `Your previous emit_territories call was cut off by the max_tokens limit before it could finish. Re-emit it now via emit_territories — keep it to ${Math.max(2, effectiveTargetCount - 1)} territories with concise descriptions so it fits within budget this time.`,
      },
    ];
    result = await runStructuredCall({ ...callArgs, messages: retryMessages });
  }

  let { response, toolUse, usage } = result;

  if (isUnrecoverableTruncation(result)) {
    throw new Error(
      `Coordinator emit_territories truncated after retry; got stop_reason=${response.stop_reason}`
    );
  }

  let territories = parseTerritories(toolUse, validIds, personas);

  // "At most twice" is stated in the prompt (COORDINATOR_TERRITORIES) but
  // models drift under high territory counts, so enforce it here too: up to
  // MAX_OVERUSE_RETRIES corrective retries naming the offending persona(s)
  // and exactly which territories they need to give up, then fail loudly
  // rather than silently overloading a persona's continuity across
  // territories they weren't meant to anchor.
  let overused = findOverusedPersonas(territories, personas);
  let overuseRetryCount = 0;
  while (overused.length > 0 && overuseRetryCount < MAX_OVERUSE_RETRIES) {
    overuseRetryCount += 1;
    await appendLog(idea.id, 'coordinator', {
      kind: 'overuse_retry',
      payload: { overused_persona_ids: overused, attempt: overuseRetryCount },
    });
    const cleanedContent = dropToolUseBlock(response.content, 'emit_territories');
    const overuseDetail = overused
      .map((id) => {
        const owned = territories.filter((t) => t.assigned_pair.includes(id));
        const names = owned.map((t) => t.name || t.id).join(', ');
        return `${id} (currently in ${owned.length} territories: ${names})`;
      })
      .join('; ');
    const fixedIds = personas.filter((p) => p.fixed).map((p) => p.id);
    const fixedFallback = fixedIds.length > 0
      ? ` If every topic-specific persona is already at its two-territory limit and none is available to swap in, use a universal persona instead (${fixedIds.join(', ')}) — they are exempt from the cap.`
      : '';
    const retryMessages = [
      ...messages,
      ...(cleanedContent.length > 0 ? [{ role: 'assistant', content: cleanedContent }] : []),
      {
        role: 'user',
        content: `Persona(s) ${overuseDetail} were assigned to more than two territories, which violates the rule that topic-specific personas may anchor at most two. For each overused persona, keep at most two of their current territories and replace their \`assigned_pair\` slot in every other listed territory with a different topic-specific persona from the roster who is not already at their two-territory limit — do not just swap two overused personas with each other, and do not leave any persona over the limit.${fixedFallback} Re-emit the FULL emit_territories call (all territories, not just the changed ones) with corrected \`assigned_pair\`s.`,
      },
    ];
    const retryResult = await runStructuredCall({ ...callArgs, messages: retryMessages });
    if (isUnrecoverableTruncation(retryResult)) {
      throw new Error(
        `Coordinator emit_territories truncated during overuse retry (attempt ${overuseRetryCount}); got stop_reason=${retryResult.response.stop_reason}`
      );
    }
    const retryTerritories = parseTerritories(retryResult.toolUse, validIds, personas);
    ({ response, usage } = retryResult);
    territories = retryTerritories;
    overused = findOverusedPersonas(territories, personas);
  }
  if (overused.length > 0) {
    throw new Error(
      `Coordinator emit_territories still overuses persona(s) ${overused.join(', ')} after ${overuseRetryCount} retries`
    );
  }

  await appendLog(idea.id, 'coordinator', {
    kind: 'response',
    payload: {
      stop_reason: response.stop_reason,
      usage,
      territory_count: territories.length,
    },
  });

  if (bus) bus.emit('coordinator.territories.emitted', {
    count: territories.length,
    names: territories.map((t) => t.name || t.id || t.territory_id),
  });

  return {
    decided_at: new Date().toISOString(),
    territories,
    usage,
  };
}

module.exports = {
  runCoordinatorInitial,
  isUnrecoverableTruncation,
  emitTerritoriesTool,
  findOverusedPersonas,
  DEFAULT_TARGET_TERRITORY_COUNT,
};
